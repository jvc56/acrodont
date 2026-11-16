// PLAN.md § Settings → Where a setting applies: a change from Settings saves
// for this cascade on this device; moving it wider sets it there and takes it
// out of the narrower places, saying what it replaced; Clear takes a place's
// value out, and the next place holding one is used.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { pendingShares } from './everywhere';
import { settings } from './store.svelte';

const C = 'c1';

async function fresh(own: Record<string, unknown> = {}) {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	const cascadeWrites: Record<string, unknown>[] = [];
	const changed: string[][] = [];
	let row = { id: C, settings: { ...own } };
	await settings.open(db, row, {
		writeCascade: async (changes) => {
			cascadeWrites.push(changes);
			const next = { ...row.settings };
			for (const [k, v] of Object.entries(changes)) {
				if (v === null) delete next[k];
				else next[k] = v;
			}
			row = { id: C, settings: next };
			settings.setCascade(row);
			return true;
		},
		afterChange: (keys) => {
			changed.push(keys);
		}
	});
	settings.resetOffers();
	return { db: db as UserDb, cascadeWrites, changed };
}

describe('the settings of the open cascade', () => {
	it('a change saves for this cascade on this device, and offers the wider places', async () => {
		const { db, changed } = await fresh();
		await settings.change('question_size_px', 44);
		expect(settings.value.question_size_px).toBe(44);
		expect(settings.sourceOf('question_size_px')).toBe('both');
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toEqual({ question_size_px: 44 });
		expect(settings.offers.question_size_px?.place).toBe('both');
		expect(changed).toEqual([['question_size_px']]);
	});

	it('moving a value wider sets it there and takes it out of the narrower places, naming what it replaced', async () => {
		const { db, cascadeWrites } = await fresh({ question_size_px: 30 });
		await settings.change('question_size_px', 44);
		await settings.moveTo('question_size_px', 'device');
		expect(settings.sourceOf('question_size_px')).toBe('device');
		expect(await getMeta(db, 'device_settings')).toEqual({ question_size_px: 44 });
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toBeUndefined();
		// The cascade's own 30 would still win here: taken out, and said so.
		expect(cascadeWrites).toEqual([{ question_size_px: null }]);
		expect(settings.offers.question_size_px?.replaced).toEqual(['this cascade’s 30 px']);
		await settings.moveTo('question_size_px', 'all');
		expect(await pendingShares(db)).toMatchObject({ question_size_px: { value: 44 } });
		expect((await getMeta(db, 'device_settings')).question_size_px).toBeUndefined();
		expect([settings.value.question_size_px, settings.sourceOf('question_size_px')]).toEqual([44, 'all']);
	});

	it('Clear takes one place\'s value out; the next place holding one is used', async () => {
		const { db } = await fresh({ show_hooks: false });
		await settings.change('show_hooks', true);
		expect(settings.value.show_hooks).toBe(true);
		await settings.clearIn('show_hooks', 'both');
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([false, 'cascade']);
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toBeUndefined();
		expect(settings.offers.show_hooks).toBeUndefined();
	});
});
