import { describe, expect, it } from 'vitest';
import { clampSetting, cleanFont, fontStack, textStyle } from './display';

describe('display settings', () => {
	it('clamps a number to its bounds and step, and defaults what is not a number', () => {
		expect(clampSetting('size_px', 1000)).toBe(200);
		expect(clampSetting('border_px', -3)).toBe(0);
		expect(clampSetting('repeat_guard_ms', 'abc')).toBe(0);
		expect(clampSetting('spacing_em', '0.1')).toBe(0.1);
		expect(clampSetting('mobile_row_px', 5)).toBe(32);
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
