// PLAN.md § Settings → This device, or all of them: a device setting shared
// with every device goes with the next sync and stops being pending once sent;
// a device takes each of the account's shared values newer than the last it
// took, made valid as on load, and leaves alone what it already has.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { SyncEngine } from '$lib/sync/engine';
import type { SyncRequest } from '$lib/sync/protocol';
import { pendingShares, shareSettings, takeShared } from './device';

async function fresh(): Promise<UserDb> {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	return db;
}

const T1 = '2026-11-11T10:00:00.000Z';
const T2 = '2026-11-11T11:00:00.000Z';

describe('shared device settings', () => {
	it('a share is pending until a sync sends it, and its echo changes nothing here', async () => {
		const db = await fresh();
		await shareSettings(db, { answer_size_px: 48, not_a_setting: 1 }, new Date(T1));
		const sent = await pendingShares(db);
		expect(sent).toEqual({ answer_size_px: { value: 48, at: T1 } });
		expect(await takeShared(db, { answer_size_px: { value: 48, at: T1 } }, sent)).toBe(false);
		expect(await pendingShares(db)).toEqual({});
	});

	it('takes newer values, ignores older ones, and makes them valid', async () => {
		const db = await fresh();
		expect(
			await takeShared(
				db,
				{
					answer_size_px: { value: 5000, at: T1 },
					mobile_buttons: { value: 'rows', at: T1 },
					bindings: { value: 'nonsense', at: T1 },
					unknown_field: { value: 1, at: T1 }
				},
				{}
			)
		).toBe(true);
		let d = await getMeta(db, 'display');
		// Clamped to the setting's bounds, as a stored value from another build is.
		expect([d.answer_size_px, d.mobile_buttons]).toEqual([200, 'rows']);
		expect((await getMeta(db, 'bindings')).length).toBeGreaterThan(0);
		// The same values again, or older ones: nothing to take.
		expect(await takeShared(db, { answer_size_px: { value: 30, at: '2026-11-11T09:00:00.000Z' } }, {})).toBe(false);
		expect(await takeShared(db, { mobile_buttons: { value: 'columns', at: T1 } }, {})).toBe(false);
		expect(await takeShared(db, { answer_size_px: { value: 30, at: T2 } }, {})).toBe(true);
		d = await getMeta(db, 'display');
		expect([d.answer_size_px, d.mobile_buttons]).toEqual([30, 'rows']);
	});

	it('a share made while a sync was out stays pending', async () => {
		const db = await fresh();
		await shareSettings(db, { border_px: 4 }, new Date(T1));
		const sent = await pendingShares(db);
		await shareSettings(db, { border_px: 6 }, new Date(T2));
		await takeShared(db, { border_px: { value: 4, at: T1 } }, sent);
		expect(await pendingShares(db)).toEqual({ border_px: { value: 6, at: T2 } });
	});

	it('the sync engine sends pending shares and takes the account’s', async () => {
		const db = await fresh();
		await shareSettings(db, { question_top_px: 100 }, new Date(T1));
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
		expect((await getMeta(db, 'display')).border_px).toBe(3);
		expect(changed).toBe(1);
		// Nothing pending: the next request carries none.
		await engine.sync();
		expect(seen[1].device_settings).toBeUndefined();
		engine.stop();
	});
});
