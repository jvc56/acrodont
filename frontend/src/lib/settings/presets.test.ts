// PLAN.md § Settings → Presets: Defaults is built in, first in every list, and
// its name is no other preset's; the account's presets come with a sync
// response when this device's version is not the account's; the builder starts
// at the preset used last here, or at Defaults once that one is gone; a
// cascade's starting settings are the preset's values, none for Defaults.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { CASCADE_SETTING_DEFAULTS } from '$lib/local/rows';
import { resolveAll, emptyLayers, SETTING_KEYS } from './layers';
import {
	defaultsPreset,
	DEFAULTS_ID,
	isDefaultsName,
	presetFrom,
	presetList,
	presetsVersion,
	rememberPreset,
	startingPreset,
	startingSettings,
	takePresets
} from './presets';

async function fresh(): Promise<UserDb> {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	return db;
}

const phone = { id: 'p1', name: 'Phone', settings: { mobile_buttons: 'rows', question_size_px: 48 }, clear_threshold: 95, segment_size: 50, progression: 'drill' };
const desk = { id: 'p2', name: 'Desk', settings: {}, clear_threshold: 80, segment_size: 0, progression: 'ladder' };

describe('presets', () => {
	it('Defaults holds every setting at its default and the rules a new cascade starts with', () => {
		const d = defaultsPreset();
		expect(d.id).toBe(DEFAULTS_ID);
		expect(Object.keys(d.settings)).toHaveLength(SETTING_KEYS.length);
		expect(Object.values(d.settings).every((v) => v === null)).toBe(true);
		expect({ clear_threshold: d.clear_threshold, segment_size: d.segment_size, progression: d.progression }).toEqual(CASCADE_SETTING_DEFAULTS);
		expect(startingSettings(d)).toBeUndefined();
		expect([isDefaultsName(' defaults '), isDefaultsName('DEFAULTS'), isDefaultsName('Default')]).toEqual([true, true, false]);
	});

	it("keeps the account's list when a response carries it, and asks again when a version moved without one", async () => {
		const db = await fresh();
		expect(await presetsVersion(db)).toBeNull();
		expect(await takePresets(db, '3', [phone, desk, { name: 'no id' }])).toBe(true);
		expect(await presetsVersion(db)).toBe('3');
		expect((await presetList(db)).map((p) => p.name)).toEqual(['Defaults', 'Desk', 'Phone']);
		// The same list again: nothing changed.
		expect(await takePresets(db, '3', [phone, desk])).toBe(false);
		// The version alone, unchanged: nothing to do.
		expect(await takePresets(db, '3', undefined)).toBe(false);
		expect(await presetsVersion(db)).toBe('3');
		// A version that moved without its list: forgotten, so the next sync asks for it.
		await takePresets(db, '4', undefined);
		expect(await presetsVersion(db)).toBeNull();
		expect((await getMeta(db, 'presets')).list).toHaveLength(2);
	});

	it('the builder starts at the preset used last on this device, or Defaults once it is gone', async () => {
		const db = await fresh();
		await takePresets(db, '1', [phone, desk]);
		expect((await startingPreset(db, await presetList(db))).id).toBe(DEFAULTS_ID);
		await rememberPreset(db, 'p1');
		expect((await startingPreset(db, await presetList(db))).id).toBe('p1');
		await takePresets(db, '2', [desk]);
		expect((await startingPreset(db, await presetList(db))).id).toBe(DEFAULTS_ID);
		await rememberPreset(db, DEFAULTS_ID);
		expect(await getMeta(db, 'last_preset_id')).toBeNull();
	});

	it("is made from what a cascade shows on this device, and starts a new cascade with its values", () => {
		const shown = { ...resolveAll(emptyLayers()), mobile_buttons: 'rows' as const };
		const p = presetFrom('p9', 'Mine', shown, { clear_threshold: 70, segment_size: 20, progression: 'drill' });
		expect(Object.keys(p.settings)).toHaveLength(SETTING_KEYS.length);
		expect(p.settings.mobile_buttons).toBe('rows');
		expect([p.clear_threshold, p.segment_size, p.progression]).toEqual([70, 20, 'drill']);
		expect(startingSettings({ ...p, settings: { mobile_buttons: 'rows', show_hooks: null } })).toEqual({ mobile_buttons: 'rows' });
	});
});
