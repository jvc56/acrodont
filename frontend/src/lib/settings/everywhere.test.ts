// PLAN.md § Settings → Where a setting applies, the "Everywhere" place: a
// change made here goes with the next sync and stops being pending once sent;
// every response carries the account's map, which the device keeps; per
// setting the later of the account's value and a change still pending here is
// what the place holds, and null takes a setting out of it.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { SyncEngine } from '$lib/sync/engine';
import type { SyncRequest } from '$lib/sync/protocol';
import { everywhereValues, pendingShares, setEverywhere, takeShared } from './everywhere';
import { resolve } from './layers';
import { readPlaces } from './places';

async function fresh(): Promise<UserDb> {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	return db;
}

const T1 = '2026-11-11T10:00:00.000Z';
const T2 = '2026-11-11T11:00:00.000Z';
const held = async (db: UserDb) => everywhereValues(await getMeta(db, 'shared_device'));

describe('the Everywhere place', () => {
	it('a change is pending until a sync sends it, and its echo changes nothing here', async () => {
		const db = await fresh();
		await setEverywhere(db, { answer_size_px: 48, not_a_setting: 1 }, new Date(T1));
		const sent = await pendingShares(db);
		expect(sent).toEqual({ answer_size_px: { value: 48, at: T1 } });
		expect(await held(db)).toEqual({ answer_size_px: 48 });
		expect(await takeShared(db, { answer_size_px: { value: 48, at: T1 } }, sent)).toBe(false);
		expect(await pendingShares(db)).toEqual({});
		expect(await held(db)).toEqual({ answer_size_px: 48 });
	});

	it("keeps the account's map, the later value winning over a change still pending, and null taking one out", async () => {
		const db = await fresh();
		expect(
			await takeShared(
				db,
				{ answer_size_px: { value: 5000, at: T1 }, mobile_buttons: { value: 'rows', at: T1 }, show_hooks: { value: null, at: T1 } },
				{}
			)
		).toBe(true);
		expect(await held(db)).toEqual({ answer_size_px: 5000, mobile_buttons: 'rows' });
		// A value is made valid where it is read: clamped to the setting's bounds.
		expect(resolve(await readPlaces(db, null), 'answer_size_px')).toEqual({ value: 200, from: 'all' });
		// The same map again: nothing changed.
		expect(await takeShared(db, { answer_size_px: { value: 5000, at: T1 }, mobile_buttons: { value: 'rows', at: T1 } }, {})).toBe(false);
		// A change made here after the account's value wins until the account's is newer.
		await setEverywhere(db, { mobile_buttons: null }, new Date(T2));
		expect(await held(db)).toEqual({ answer_size_px: 5000 });
		await takeShared(db, { mobile_buttons: { value: 'columns', at: '2026-11-11T12:00:00.000Z' } }, {});
		expect((await held(db)).mobile_buttons).toBe('columns');
	});

	it('a change made while a sync was out stays pending', async () => {
		const db = await fresh();
		await setEverywhere(db, { border_px: 4 }, new Date(T1));
		const sent = await pendingShares(db);
		await setEverywhere(db, { border_px: 6 }, new Date(T2));
		await takeShared(db, { border_px: { value: 4, at: T1 } }, sent);
		expect(await pendingShares(db)).toEqual({ border_px: { value: 6, at: T2 } });
		expect(await held(db)).toEqual({ border_px: 6 });
	});

	it("the sync engine sends pending changes and keeps the account's", async () => {
		const db = await fresh();
		await setEverywhere(db, { question_top_px: 100 }, new Date(T1));
		const seen: SyncRequest[] = [];
		let changed = 0;
		const engine = new SyncEngine(
			db,
			{ onDeviceSettings: () => changed++ },
			{
				transport: async (r) => {
					seen.push(JSON.parse(JSON.stringify(r)));
					return {
						status: 200,
						retryAfter: null,
						body: {
							results: [],
							sync_seq: '1',
							changes: { cascades: [], quizzes: [], quiz_attempts: [], quiz_questions: [], tombstones: [] },
							device_settings: { question_top_px: { value: 100, at: T1 }, border_px: { value: 3, at: T2 } }
						}
					};
				},
				wait: async () => undefined
			}
		);
		await engine.sync();
		expect(seen[0].device_settings).toEqual({ question_top_px: { value: 100, at: T1 } });
		expect(await pendingShares(db)).toEqual({});
		expect(await held(db)).toEqual({ question_top_px: 100, border_px: 3 });
		expect(changed).toBe(1);
		// Nothing pending: the next request carries none.
		await engine.sync();
		expect(seen[1].device_settings).toBeUndefined();
		engine.stop();
	});
});
