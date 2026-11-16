// PLAN.md § Settings → Where a setting applies: a row's two switches show
// the place its value comes from, or, with none, start at this cascade on this
// device; a change saves where they point; switching moves the value, taking
// it out of where it was and of the narrower places, saying what it replaced;
// Reset takes it out of its place, and the next place holding one is used.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { pendingShares } from './everywhere';
import { writeLocalPlace } from './places';
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
	settings.resetRows();
	return { db: db as UserDb, cascadeWrites, changed };
}

describe('the settings of the open cascade', () => {
	it('with no value, the switches start at this cascade on this device, and a change saves there', async () => {
		const { db, changed } = await fresh();
		expect([settings.sourceOf('question_size_px'), settings.placeOf('question_size_px')]).toEqual(['default', 'both']);
		await settings.change('question_size_px', 44);
		expect(settings.value.question_size_px).toBe(44);
		expect(settings.sourceOf('question_size_px')).toBe('both');
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toEqual({ question_size_px: 44 });
		expect(changed).toEqual([['question_size_px']]);
	});

	it('switched with no value, they point the next change elsewhere, and Settings opening again starts them over', async () => {
		const { db } = await fresh();
		await settings.moveTo('border_px', 'device');
		expect([settings.sourceOf('border_px'), settings.placeOf('border_px')]).toEqual(['default', 'device']);
		await settings.change('border_px', 4);
		expect(await getMeta(db, 'device_settings')).toEqual({ border_px: 4 });
		settings.resetRows();
		expect(settings.placeOf('show_hooks')).toBe('both');
	});

	it('a change to a value held wider is saved there', async () => {
		const { cascadeWrites } = await fresh({ show_hooks: false });
		expect(settings.placeOf('show_hooks')).toBe('cascade');
		await settings.change('show_hooks', true);
		expect(cascadeWrites).toEqual([{ show_hooks: true }]);
		expect(settings.sourceOf('show_hooks')).toBe('cascade');
	});

	it('moving a value wider sets it there and takes it out of where it was', async () => {
		const { db, cascadeWrites } = await fresh();
		await settings.change('question_size_px', 44);
		await settings.moveTo('question_size_px', 'device');
		expect(settings.sourceOf('question_size_px')).toBe('device');
		expect(await getMeta(db, 'device_settings')).toEqual({ question_size_px: 44 });
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toBeUndefined();
		expect(cascadeWrites).toEqual([]);
		await settings.moveTo('question_size_px', 'all');
		expect(await pendingShares(db)).toMatchObject({ question_size_px: { value: 44 } });
		expect((await getMeta(db, 'device_settings')).question_size_px).toBeUndefined();
		expect([settings.value.question_size_px, settings.sourceOf('question_size_px')]).toEqual([44, 'all']);
		expect(settings.replaced.question_size_px).toBeUndefined();
	});

	it('moving narrower sets it there and takes it out of where it was', async () => {
		const { db, cascadeWrites } = await fresh({ show_hooks: false });
		await settings.moveTo('show_hooks', 'both');
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([false, 'both']);
		expect(cascadeWrites).toEqual([{ show_hooks: null }]);
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toEqual({ show_hooks: false });
	});

	it('a value moved past a narrower place takes that one out too, and names it', async () => {
		// The cascade's own 30 is in use; this device's 48, read after it, is hidden.
		const { db, cascadeWrites } = await fresh({ question_size_px: 30 });
		await writeLocalPlace(db, 'device', null, { question_size_px: 48 });
		await settings.reload();
		expect([settings.value.question_size_px, settings.sourceOf('question_size_px')]).toEqual([30, 'cascade']);
		await settings.moveTo('question_size_px', 'all');
		expect(cascadeWrites).toEqual([{ question_size_px: null }]);
		expect((await getMeta(db, 'device_settings')).question_size_px).toBeUndefined();
		expect(settings.replaced.question_size_px).toBe('Replaced this device’s 48 px');
		expect([settings.value.question_size_px, settings.sourceOf('question_size_px')]).toEqual([30, 'all']);
	});

	it('Reset takes the value out of its place; the next place holding one is used, else the default, the switches staying put', async () => {
		const { db } = await fresh({ show_hooks: false });
		await writeLocalPlace(db, 'both', C, { show_hooks: true });
		await settings.reload();
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([true, 'both']);
		await settings.reset('show_hooks');
		expect((await getMeta(db, 'cascade_device_settings'))[C]).toBeUndefined();
		expect([settings.value.show_hooks, settings.placeOf('show_hooks')]).toEqual([false, 'cascade']);
		await settings.reset('show_hooks');
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks'), settings.placeOf('show_hooks')]).toEqual([true, 'default', 'cascade']);
	});
});
