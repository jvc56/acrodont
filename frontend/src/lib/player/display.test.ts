import { describe, expect, it } from 'vitest';
import { clampSetting, cleanFont, defaultDisplay, fontStack, normalizeDisplay, textStyle } from './display.svelte';

describe('display settings', () => {
	it('answers match the question by default, near the top, with a thick border and no repeat guard', () => {
		const d = defaultDisplay();
		expect(d.answer_font).toBe(d.question_font);
		expect(d.answer_size_px).toBe(d.question_size_px);
		expect([d.question_spacing, d.answer_spacing]).toEqual([0, 0]);
		expect([d.question_top_px, d.border_px, d.repeat_guard_ms]).toEqual([8, 10, 0]);
		expect(d.status_bar_hidden).toBe(false);
		// Typed mode's found count hints at how many are left: off unless asked for.
		expect(d.mobile_buttons).toBe('columns');
		// A missed answer shows its red border; a correct one shows none.
		expect([d.border_correct, d.border_missed]).toEqual([false, true]);
	});

	it('takes any number within bounds, clamps the rest, and defaults what is not a number', () => {
		expect(normalizeDisplay(undefined)).toEqual(defaultDisplay());
		const d = normalizeDisplay({ question_size_px: 41, answer_spacing: 0.13, question_top_px: 0, border_px: 22, repeat_guard_ms: 35 });
		expect([d.question_size_px, d.answer_spacing, d.question_top_px, d.border_px, d.repeat_guard_ms]).toEqual([41, 0.13, 0, 22, 35]);
		expect(clampSetting('size_px', 1000)).toBe(200);
		expect(clampSetting('border_px', -3)).toBe(0);
		expect(clampSetting('repeat_guard_ms', 'abc')).toBe(0);
		expect(clampSetting('spacing_em', '0.1')).toBe(0.1);
	});

	it("follows the repeat guard's new default, and keeps a value the user chose", () => {
		// Saved before version 2 with the old default, 50: now 0.
		expect(normalizeDisplay({ repeat_guard_ms: 50 }).repeat_guard_ms).toBe(0);
		// A value other than the old default was chosen: kept.
		expect(normalizeDisplay({ repeat_guard_ms: 80 }).repeat_guard_ms).toBe(80);
		// Saved under version 2: kept, 50 included.
		expect(normalizeDisplay({ repeat_guard_ms: 50, version: 2 }).repeat_guard_ms).toBe(50);
	});

	it("reads the earlier builds' presets: font keys, rem sizes, the rem position", () => {
		const d = normalizeDisplay({ question_font: 'mono', answer_font: 'serif', question_size: 3, question_top: 2 } as never);
		expect([d.question_font, d.answer_font, d.question_size_px, d.question_top_px]).toEqual(['monospace', 'serif', 48, 40]);
	});

	it('keeps the typeface to the ones offered', () => {
		expect(cleanFont('serif')).toBe('serif');
		// A name a past build let the user type, or anything else, is the default.
		expect(cleanFont('Georgia')).toBe('Inter');
		expect(cleanFont('Evil"; color: red')).toBe('Inter');
		expect(fontStack('Inter')).toMatch(/^'Inter Variable'/);
		expect(fontStack('monospace')).toMatch(/^monospace,/);
	});

	it('styles text with the chosen face, size and spacing', () => {
		expect(textStyle('monospace', 48)).toContain('font-size: 48px');
		expect(textStyle('Inter', 36)).toContain('letter-spacing: normal');
		expect(textStyle('Inter', 36, 0.1)).toContain('letter-spacing: 0.1em');
	});
});
