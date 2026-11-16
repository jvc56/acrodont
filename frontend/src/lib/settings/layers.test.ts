// PLAN.md § Settings → Where a setting applies: four places, read in order —
// this cascade on this device, this cascade, this device, everywhere — and the
// default after them; a value another build wrote that this one cannot read is
// passed over.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '$lib/player/bindings';
import { emptyLayers, narrowerThan, resolve, resolveAll, settingText, widerThan, type Layers } from './layers';

const layers = (l: Partial<Layers>): Layers => ({ ...emptyLayers(), ...l });

describe('where a setting applies', () => {
	it('starts every setting at its default: answers like the question, near the top, a red border on a miss only', () => {
		const d = resolveAll(emptyLayers());
		expect(d.answer_font).toBe(d.question_font);
		expect(d.answer_size_px).toBe(d.question_size_px);
		expect([d.question_spacing, d.answer_spacing]).toEqual([0, 0]);
		expect([d.question_top_px, d.border_px, d.repeat_guard_ms]).toEqual([8, 10, 0]);
		expect([d.status_bar_hidden, d.sync_status_hidden, d.definition_width_px, d.hook_size_px]).toEqual([false, false, 0, 27]);
		expect([d.mobile_buttons, d.mobile_row_px]).toEqual(['columns', 64]);
		expect([d.border_correct, d.border_missed]).toEqual([false, true]);
		expect([d.answer_mode, d.reveal_correct, d.show_definitions, d.show_hooks]).toEqual(['flashcard', true, true, true]);
		expect([d.show_found_count, d.show_probability, d.definition_column, d.leave_value_decimals]).toEqual([false, false, true, 0]);
		expect(d.bindings).toEqual(DEFAULT_BINDINGS);
		// A Definition card shows its word in the answer; the buttons show on a touch screen or below 900 px.
		expect([d.hooks_on_question, d.player_buttons, d.buttons_below_px]).toEqual([false, 'auto', 900]);
	});

	it('takes the first place that holds a value: this cascade on this device, this cascade, this device, everywhere', () => {
		const l = layers({ all: { question_size_px: 40 } });
		expect(resolve(l, 'question_size_px')).toEqual({ value: 40, from: 'all' });
		l.device = { question_size_px: 48 };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 48, from: 'device' });
		// A cascade's own value beats a device's.
		l.cascade = { question_size_px: 30 };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 30, from: 'cascade' });
		l.both = { question_size_px: 52 };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 52, from: 'both' });
		expect(resolve(l, 'border_px')).toEqual({ value: 10, from: 'default' });
	});

	it('passes over a value it cannot read, and clamps a number to its bounds', () => {
		const l = layers({ both: { answer_mode: 'spoken', question_size_px: 'big', show_hooks: 1 }, device: { answer_mode: 'typed', question_size_px: 900 } });
		expect(resolve(l, 'answer_mode')).toEqual({ value: 'typed', from: 'device' });
		expect(resolve(l, 'question_size_px')).toEqual({ value: 200, from: 'device' });
		expect(resolve(l, 'show_hooks')).toEqual({ value: true, from: 'default' });
		expect(resolve(layers({ all: { question_font: 'Georgia' } }), 'question_font').from).toBe('default');
		expect(resolve(layers({ cascade: { leave_value_decimals: 4 } }), 'leave_value_decimals').from).toBe('default');
	});

	it('says a value in a few words, and orders the places', () => {
		expect(settingText('status_bar_hidden', true)).toBe('Hidden');
		expect(settingText('reveal_correct', false)).toBe('Missed');
		expect(settingText('answer_spacing', 0.1)).toBe('0.1 em');
		expect(settingText('question_font', 'system-ui')).toBe('System');
		expect(settingText('bindings', DEFAULT_BINDINGS)).toBe('The defaults');
		expect(narrowerThan('device')).toEqual(['both', 'cascade']);
		expect(widerThan('both')).toEqual(['cascade', 'device', 'all']);
		expect(widerThan('all')).toEqual([]);
	});
});
