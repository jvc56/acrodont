// PLAN.md § Settings → Where a setting applies: a change is made for this
// cascade on this device, stamped by the server's clock; the offer under it
// makes the same change, at a fresh time, for this cascade on all devices, all
// cascades on this device, or all cascades on all devices; a preset applied is
// one change of many settings, offered the same way.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { getMeta, initMeta } from '$lib/local/meta';
import { pendingShares } from './everywhere';
import { SETTING_KEYS, type Entries } from './layers';
import { writeLocalScope } from './places';
import { settings } from './store.svelte';

const C = 'c1';
const CREATED = '2026-01-01T00:00:00.000Z';

async function fresh(own: Entries = {}, offsetMs = 0) {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	if (offsetMs) await db.put('meta', { offset_ms: offsetMs }, 'clock');
	const cascadeWrites: { values: Record<string, unknown>; at: Date }[] = [];
	const changed: string[][] = [];
	let row = { id: C, settings: { ...own } as Record<string, unknown>, created_at: CREATED };
	await settings.open(db, row, {
		writeCascade: async (values, at) => {
			cascadeWrites.push({ values, at });
			const next = { ...row.settings };
			for (const [k, v] of Object.entries(values)) next[k] = { value: v, at: at.toISOString() };
			row = { ...row, settings: next };
			settings.setCascade(row);
			return true;
		},
		afterChange: (keys) => {
			changed.push(keys);
		}
	});
	settings.resetOffers();
	settings.reach = 3;
	return { db: db as UserDb, cascadeWrites, changed };
}

describe('the settings of the open cascade', () => {
	it('a change is saved for this cascade on this device, and offered more widely', async () => {
		const { db, changed, cascadeWrites } = await fresh();
		expect(settings.sourceOf('question_size_px')).toBe('default');
		await settings.change('question_size_px', 44);
		expect(settings.value.question_size_px).toBe(44);
		expect(settings.sourceOf('question_size_px')).toBe('both');
		expect((await getMeta(db, 'cascade_device_scope'))[C]).toMatchObject({ question_size_px: { value: 44 } });
		expect(changed).toEqual([['question_size_px']]);
		expect(cascadeWrites).toEqual([]);
		expect(settings.offers.question_size_px.values).toEqual({ question_size_px: 44 });
		// A second change starts a fresh offer.
		const first = settings.offers.question_size_px.serial;
		await settings.change('question_size_px', 46);
		expect(settings.offers.question_size_px.serial).toBeGreaterThan(first);
	});

	it('the offer makes the same change for this cascade on all devices, all cascades on this device, or everywhere', async () => {
		const { db, cascadeWrites } = await fresh();
		await settings.change('border_px', 4);
		expect(await settings.widen('border_px', 'cascade')).toBe(true);
		expect(cascadeWrites.map((w) => w.values)).toEqual([{ border_px: 4 }]);
		expect(settings.sourceOf('border_px')).toBe('cascade');
		await settings.widen('border_px', 'device');
		expect(await getMeta(db, 'device_scope')).toMatchObject({ border_px: { value: 4 } });
		expect(settings.sourceOf('border_px')).toBe('device');
		await settings.widen('border_px', 'all');
		expect(await pendingShares(db)).toMatchObject({ border_px: { value: 4 } });
		expect([settings.value.border_px, settings.sourceOf('border_px')]).toEqual([4, 'all']);
		// No change made, no offer to take.
		expect(await settings.widen('show_hooks', 'all')).toBe(false);
	});

	it('a later change here wins over an earlier one made more widely', async () => {
		const { db } = await fresh({ show_hooks: { value: false, at: '2026-02-01T00:00:00.000Z' } });
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([false, 'cascade']);
		await settings.change('show_hooks', true);
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([true, 'both']);
		// Another tab's change for all cascades on this device, made later still, is read in.
		await writeLocalScope(db, 'device', null, { show_hooks: false }, new Date(Date.now() + 60_000).toISOString());
		await settings.reload();
		expect([settings.value.show_hooks, settings.sourceOf('show_hooks')]).toEqual([false, 'device']);
	});

	it("stamps a change by the server's clock", async () => {
		const ahead = 3 * 60 * 60 * 1000;
		const { db } = await fresh({}, ahead);
		const before = Date.now();
		await settings.change('border_px', 6);
		const at = Date.parse((await getMeta(db, 'cascade_device_scope'))[C].border_px.at);
		expect(at - before).toBeGreaterThanOrEqual(ahead - 1000);
		expect(at - before).toBeLessThan(ahead + 60_000);
	});

	it('a preset applied is one change of every setting, null for the default, and says how many now differ', async () => {
		const { db } = await fresh();
		await settings.change('question_size_px', 44);
		const values = Object.fromEntries(SETTING_KEYS.map((k) => [k, null as unknown]));
		values.mobile_buttons = 'rows';
		values.border_px = 10;
		// question_size_px back to its default, mobile_buttons to rows; border_px was 10 already.
		expect(await settings.applyValues('preset', values)).toBe(2);
		expect([settings.value.question_size_px, settings.value.mobile_buttons]).toEqual([36, 'rows']);
		expect(Object.keys((await getMeta(db, 'cascade_device_scope'))[C])).toHaveLength(SETTING_KEYS.length);
		await settings.widen('preset', 'device');
		expect((await getMeta(db, 'device_scope')).mobile_buttons.value).toBe('rows');
		expect(await settings.applyValues('preset', values)).toBe(0);
	});
});
