// PLAN.md § Settings → Where a setting applies: every cascade on every device
// has its own settings. A change is made in one of four scopes, and a
// setting's value is the latest change covering the cascade on the device; a
// change for all cascades made before the cascade was created does not reach
// it; null is the default; a value another build wrote that this one cannot
// read is passed over.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '$lib/player/bindings';
import { emptyLayers, entriesOf, resolve, resolveAll, settingText, stamp, type Entries, type Layers } from './layers';

const layers = (l: Partial<Layers>): Layers => ({ ...emptyLayers(), ...l });
const at = (h: number) => `2026-11-17T${String(h).padStart(2, '0')}:00:00.000Z`;
const e = (value: unknown, h: number): Entries[string] => ({ value, at: at(h) });

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

	it('takes the latest change covering the cascade on this device, whatever its scope', () => {
		const l = layers({ all: { question_size_px: e(40, 1) } });
		expect(resolve(l, 'question_size_px')).toEqual({ value: 40, from: 'all' });
		l.both = { question_size_px: e(30, 2) };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 30, from: 'both' });
		// A wider change made later wins over a narrower one made earlier.
		l.device = { question_size_px: e(48, 3) };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 48, from: 'device' });
		l.cascade = { question_size_px: e(52, 4) };
		expect(resolve(l, 'question_size_px')).toEqual({ value: 52, from: 'cascade' });
		expect(resolve(l, 'border_px')).toEqual({ value: 10, from: 'default' });
		// Two changes made at the same time: the narrower wins.
		expect(resolve(layers({ both: { border_px: e(4, 5) }, all: { border_px: e(6, 5) } }), 'border_px')).toEqual({ value: 4, from: 'both' });
	});

	// The plan's worked example (SETTINGS_PLAN.md § The model): c1 on a phone and
	// a laptop, then c2 and c3 on the phone.
	it('behaves as if each cascade on each device held its own copy', () => {
		const created = at(0);
		const c1Phone = layers({});
		const c1Laptop = layers({});
		// t1: on the phone, c1, this cascade on this device.
		c1Phone.both = { question_size_px: e(30, 1) };
		expect(resolve(c1Phone, 'question_size_px', created).value).toBe(30);
		expect(resolve(c1Laptop, 'question_size_px', created).value).toBe(36);
		// t2: on the laptop, c1, this cascade on all devices: both copies take it.
		c1Phone.cascade = c1Laptop.cascade = { question_size_px: e(24, 2) };
		expect(resolve(c1Phone, 'question_size_px', created).value).toBe(24);
		expect(resolve(c1Laptop, 'question_size_px', created).value).toBe(24);
		// t3: on the phone, all cascades on this device: c1 and c2 on the phone, not the laptop.
		const phone = { question_size_px: e(40, 3) };
		c1Phone.device = phone;
		const c2Phone = layers({ device: phone });
		expect(resolve(c1Phone, 'question_size_px', created).value).toBe(40);
		expect(resolve(c2Phone, 'question_size_px', created).value).toBe(40);
		expect(resolve(c1Laptop, 'question_size_px', created).value).toBe(24);
		// t4: c3 created on the phone with Defaults: the change at t3 came before it.
		const c3Phone = layers({ device: phone });
		expect(resolve(c3Phone, 'question_size_px', at(4))).toEqual({ value: 36, from: 'default' });
		// A cascade created with a preset: its values are its own changes at creation, and win over older ones.
		const c4 = layers({ cascade: { question_size_px: e(60, 5) }, all: { question_size_px: e(20, 1) } });
		expect(resolve(c4, 'question_size_px', at(5)).value).toBe(60);
	});

	it('reads null as the default, a change like any other', () => {
		const l = layers({ all: { show_hooks: e(false, 1) }, both: { show_hooks: e(null, 2) } });
		expect(resolve(l, 'show_hooks')).toEqual({ value: true, from: 'both' });
		l.cascade = { show_hooks: e(false, 3) };
		expect(resolve(l, 'show_hooks')).toEqual({ value: false, from: 'cascade' });
	});

	it('passes over a value it cannot read, and clamps a number to its bounds', () => {
		const l = layers({
			both: { answer_mode: e('spoken', 2), question_size_px: e('big', 2), show_hooks: e(1, 2) },
			device: { answer_mode: e('typed', 1), question_size_px: e(900, 1) }
		});
		expect(resolve(l, 'answer_mode')).toEqual({ value: 'typed', from: 'device' });
		expect(resolve(l, 'question_size_px')).toEqual({ value: 200, from: 'device' });
		expect(resolve(l, 'show_hooks')).toEqual({ value: true, from: 'default' });
		expect(resolve(layers({ all: { question_font: e('Georgia', 1) } }), 'question_font').from).toBe('default');
		expect(resolve(layers({ cascade: { leave_value_decimals: e(4, 1) } }), 'leave_value_decimals').from).toBe('default');
		// An entry this build cannot compare is no change at all.
		expect(entriesOf({ a: { value: 1, at: 'yesterday' }, b: 3, c: { value: 2, at: at(1) } })).toEqual({ c: { value: 2, at: at(1) } });
	});

	it('stamps changes, and says a value in a few words', () => {
		expect(stamp({ a: e(1, 1) }, { a: 2, b: undefined }, at(3))).toEqual({ a: e(2, 3), b: e(null, 3) });
		expect(settingText('status_bar_hidden', true)).toBe('Hidden');
		expect(settingText('reveal_correct', false)).toBe('Missed');
		expect(settingText('answer_spacing', 0.1)).toBe('0.1 em');
		expect(settingText('question_font', 'system-ui')).toBe('System');
		expect(settingText('bindings', DEFAULT_BINDINGS)).toBe('The defaults');
	});
});
