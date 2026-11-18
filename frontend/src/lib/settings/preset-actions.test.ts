// PLAN.md § Settings → Presets: a preset's name and what a failed change says,
// as a cascade's Settings, the Cascades page and the preset editor say them.
import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api';
import { nextFreeName, presetFailure, presetNameError } from './preset-actions';
import { defaultsPreset, presetValues, type Preset } from './presets';

const p = (id: string, name: string): Preset => ({ id, name, settings: {}, clear_threshold: 90, segment_size: 0, progression: 'ladder' });

describe('preset names', () => {
	it('suggests a copy the next free number, as Duplicate names a cascade', () => {
		const presets = [defaultsPreset(), p('a', 'Phone'), p('b', 'Phone (2)')];
		expect(nextFreeName('Phone', presets)).toBe('Phone (3)');
		expect(nextFreeName('Phone (2)', presets)).toBe('Phone (3)');
		expect(nextFreeName('Desk', presets)).toBe('Desk (2)');
		expect(nextFreeName('Defaults', presets)).toBe('Defaults (2)');
	});

	it('refuses an empty name, Defaults, and, for a rename, another preset’s name', () => {
		const presets = [defaultsPreset(), p('a', 'Phone'), p('b', 'Desk')];
		expect(presetNameError('', null, presets)).toBe('A preset needs a name.');
		expect(presetNameError(' defaults', null, presets)).toBe('“Defaults” is the built-in preset’s name.');
		expect(presetNameError('Desk', 'a', presets)).toBe('You already have a preset with that name.');
		expect(presetNameError('Phone', 'a', presets)).toBeNull();
		// A new preset's taken name is the caller's to ask about (Replace) or refuse.
		expect(presetNameError('Desk', null, presets)).toBeNull();
	});

	it('says what a refusal or a lost connection means', () => {
		expect(presetFailure(new ApiError(409, { error: 'name_taken' }, null), 'Copying a preset', 'copied')).toBe('You already have a preset with that name.');
		expect(presetFailure(new ApiError(409, { error: 'preset_limit' }, null), 'Copying a preset', 'copied')).toMatch(/^You have 50 presets/);
		expect(presetFailure(new TypeError('fetch failed'), 'Copying a preset', 'copied')).toBe('Copying a preset needs a connection.');
		expect(presetFailure(new ApiError(400, { error: 'invalid' }, null), 'Copying a preset', 'copied')).toBe('The preset could not be copied. Try again.');
	});
});

describe('a preset’s values', () => {
	it('are every setting, the default for one it does not hold, holds as null, or holds as something unreadable', () => {
		const v = presetValues({ settings: { mobile_buttons: 'rows', show_hooks: null, question_font: 'Not a font', question_size_px: 900 } });
		expect(v.mobile_buttons).toBe('rows');
		expect(v.show_hooks).toBe(true);
		expect(v.question_font).toBe('Inter');
		expect(v.question_size_px).toBe(200);
		expect(v.answer_mode).toBe('flashcard');
	});
});
