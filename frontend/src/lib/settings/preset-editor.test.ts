// PLAN.md § Settings → Presets, the preset editor: each change is saved to the
// preset at once, one save after another, the whole preset each time; offline,
// or refused, it says why and the preset goes back to what was last saved.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api';
import { openUserDb } from '$lib/local/db';
import { initMeta } from '$lib/local/meta';
import type { Preset } from './presets';

const saved: Preset[] = [];
let refuse: unknown = null;
vi.mock('./presets', async (original) => {
	const m = await original<typeof import('./presets')>();
	return {
		...m,
		savePreset: async (_db: unknown, p: Preset) => {
			await new Promise((r) => setTimeout(r, 5));
			if (refuse) throw refuse;
			saved.push(JSON.parse(JSON.stringify(p)));
			return p;
		}
	};
});
const { PresetEditor } = await import('./preset-editor.svelte');

const phone: Preset = { id: 'p1', name: 'Phone', settings: { mobile_buttons: 'rows' }, clear_threshold: 90, segment_size: 0, progression: 'ladder' };

async function editor() {
	globalThis.indexedDB = new IDBFactory();
	const db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
	const e = new PresetEditor();
	e.load(db, phone);
	return e;
}

describe('the preset editor', () => {
	beforeEach(() => {
		saved.length = 0;
		refuse = null;
		vi.stubGlobal('navigator', { onLine: true });
	});
	afterEach(() => vi.unstubAllGlobals());

	it('saves each change at once, in order, the whole preset each time', async () => {
		const e = await editor();
		expect(e.value.mobile_buttons).toBe('rows');
		const a = e.change('question_size_px', 40);
		const b = e.setRules({ clear_threshold: 95 });
		const c = e.rename('Tablet');
		// Not "Saved" while any change is still out.
		expect([e.pending, e.saved]).toEqual([3, false]);
		expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
		// One save each, never two at once, each the whole preset as it is when it runs:
		// changes made while one is out go with the next.
		expect(saved).toHaveLength(3);
		expect([saved[2].name, saved[2].settings.question_size_px, saved[2].clear_threshold]).toEqual(['Tablet', 40, 95]);
		expect(saved.every((p) => p.settings.mobile_buttons === 'rows' && p.id === 'p1')).toBe(true);
		// One change alone is saved alone.
		await e.change('border_px', 3);
		expect(saved.at(-1)?.settings.border_px).toBe(3);
		expect([e.pending, e.saved, e.error]).toEqual([0, true, null]);
		// Not a cascade's: no offer, no scope.
		expect(e.scoped).toBe(false);
	});

	it('offline or refused, says why and goes back to what was last saved', async () => {
		const e = await editor();
		await e.change('border_px', 4);
		vi.stubGlobal('navigator', { onLine: false });
		expect(await e.change('border_px', 6)).toBe(false);
		expect(e.error).toBe('Changing a preset needs a connection.');
		expect(e.value.border_px).toBe(4);
		expect(e.reverts).toBe(1);
		vi.stubGlobal('navigator', { onLine: true });
		refuse = new ApiError(409, { error: 'name_taken' }, null);
		expect(await e.rename('Desk')).toBe(false);
		expect(e.error).toBe('You already have a preset with that name.');
		expect(e.preset.name).toBe('Phone');
	});
});
