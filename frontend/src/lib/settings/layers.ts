// Where a setting applies (PLAN.md § Settings → Where a setting applies).
// Every setting but a cascade's four rules can be set in four places, and the
// first of them that holds a value is the one used:
//
//   1. this cascade on this device  ('both': this device's meta store)
//   2. this cascade                 ('cascade': the cascade row's `settings`, synced)
//   3. this device                  ('device': this device's meta store)
//   4. everywhere                   ('all': the account's shared settings, synced)
//
// and Acrodont's default after them. A cascade's own value beats a device's,
// so a cascade can ask for something wherever it is studied; one device can
// still differ for one cascade, in the first place. A value from another build
// that this one cannot read is passed over, as if that place held none.
import type { AnswerMode } from '$lib/local/rows';
import { DEFAULT_BINDINGS, normalizeBindings, type Binding } from '$lib/player/bindings';
import { clampSetting, FONTS, type LimitKey } from '$lib/player/display';

export type Place = 'both' | 'cascade' | 'device' | 'all';
/** The places in the order they are read: the first holding a value wins. */
export const PLACES: Place[] = ['both', 'cascade', 'device', 'all'];

export type Values = Record<string, unknown>;
export type Layers = Record<Place, Values>;

export const emptyLayers = (): Layers => ({ both: {}, cascade: {}, device: {}, all: {} });

/** What every setting of the four places holds once resolved. */
export interface Settings {
	/** Anagram cascades: flashcard or typed. */
	answer_mode: AnswerMode;
	/** The grade a reveal gives before any toggle: correct (true) or missed. */
	reveal_correct: boolean;
	show_definitions: boolean;
	show_hooks: boolean;
	/** Typed mode's "3 of 9 found" in the status bar. */
	show_found_count: boolean;
	show_probability: boolean;
	/** A definition in a column of its own beside its word, or centred under it. */
	definition_column: boolean;
	/** Leave Value cascades: decimal places, 0 to 3. */
	leave_value_decimals: number;
	question_font: string;
	answer_font: string;
	definition_font: string;
	question_size_px: number;
	answer_size_px: number;
	definition_size_px: number;
	/** Extra letter spacing in em; 0 is the browser's normal. */
	question_spacing: number;
	answer_spacing: number;
	definition_spacing: number;
	question_top_px: number;
	border_px: number;
	border_correct: boolean;
	border_missed: boolean;
	status_bar_hidden: boolean;
	sync_status_hidden: boolean;
	/** 0 lets a definition's column take all the room there is. */
	definition_width_px: number;
	hook_size_px: number;
	/** On a phone: three tap columns, or three rows of buttons. */
	mobile_buttons: 'columns' | 'rows';
	mobile_row_px: number;
	/** The same action again within this many ms counts once; 0 is off. */
	repeat_guard_ms: number;
	/** The keys, buttons and wheel directions of the three actions, as one setting. */
	bindings: Binding[];
}
export type SettingKey = keyof Settings;

/** The answer settings: what a revealed answer holds and how it is graded. */
export type AnswerSettings = Pick<
	Settings,
	'answer_mode' | 'reveal_correct' | 'show_definitions' | 'show_hooks' | 'show_found_count' | 'show_probability' | 'definition_column' | 'leave_value_decimals'
>;

interface Definition<T> {
	default: T;
	/** A stored value made valid, or undefined when it cannot be read. */
	clean: (v: unknown) => T | undefined;
	/** The value as a row of Settings shows it, in a few words. */
	text: (v: T) => string;
}

const flag = (def: boolean, on = 'On', off = 'Off'): Definition<boolean> => ({
	default: def,
	clean: (v) => (typeof v === 'boolean' ? v : undefined),
	text: (v) => (v ? on : off)
});
const number = (limit: LimitKey, unit: string, def?: number): Definition<number> => ({
	default: def ?? clampSetting(limit, undefined),
	clean: (v) => (typeof v === 'number' && Number.isFinite(v) ? clampSetting(limit, v) : undefined),
	text: (v) => `${v}${unit}`
});
const font = (): Definition<string> => ({
	default: 'Inter',
	clean: (v) => (FONTS.some((f) => f.value === v) ? (v as string) : undefined),
	text: (v) => FONTS.find((f) => f.value === v)?.label.replace(' (default)', '') ?? v
});
const choice = <T extends string>(def: T, labels: Record<T, string>): Definition<T> => ({
	default: def,
	clean: (v) => (typeof v === 'string' && v in labels ? (v as T) : undefined),
	text: (v) => labels[v]
});

export const DEFINITIONS: { [K in SettingKey]: Definition<Settings[K]> } = {
	answer_mode: choice<AnswerMode>('flashcard', { flashcard: 'Flashcard', typed: 'Typed' }),
	reveal_correct: flag(true, 'Correct', 'Missed'),
	show_definitions: flag(true),
	show_hooks: flag(true),
	show_found_count: flag(false),
	show_probability: flag(false),
	definition_column: flag(true),
	leave_value_decimals: {
		default: 0,
		clean: (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined),
		text: (v) => String(v)
	},
	question_font: font(),
	answer_font: font(),
	definition_font: font(),
	question_size_px: number('size_px', ' px'),
	answer_size_px: number('size_px', ' px'),
	definition_size_px: number('definition_size_px', ' px'),
	question_spacing: number('spacing_em', ' em'),
	answer_spacing: number('spacing_em', ' em'),
	definition_spacing: number('spacing_em', ' em'),
	question_top_px: number('question_top_px', ' px'),
	border_px: number('border_px', ' px'),
	border_correct: flag(false),
	border_missed: flag(true),
	status_bar_hidden: flag(false, 'Hidden', 'Shown'),
	sync_status_hidden: flag(false, 'Hidden', 'Shown'),
	definition_width_px: number('definition_width_px', ' px'),
	hook_size_px: number('hook_size_px', ' px'),
	mobile_buttons: choice<'columns' | 'rows'>('columns', { columns: 'Columns', rows: 'Rows' }),
	mobile_row_px: number('mobile_row_px', ' px'),
	repeat_guard_ms: number('repeat_guard_ms', ' ms'),
	bindings: {
		default: DEFAULT_BINDINGS,
		clean: (v) => (Array.isArray(v) ? normalizeBindings(v) : undefined),
		text: (v) => (sameValue(v, DEFAULT_BINDINGS) ? 'The defaults' : `${v.length} bindings`)
	}
};

export const SETTING_KEYS = Object.keys(DEFINITIONS) as SettingKey[];

export function isSettingKey(k: string): k is SettingKey {
	return Object.prototype.hasOwnProperty.call(DEFINITIONS, k);
}

/** Whether two values are the same setting value (bindings are lists, compared whole). */
export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The value `place` holds for `key`, made valid, or undefined when it holds none it can read. */
export function valueIn<K extends SettingKey>(layers: Layers, place: Place, key: K): Settings[K] | undefined {
	const held = layers[place];
	if (!Object.prototype.hasOwnProperty.call(held, key)) return undefined;
	return DEFINITIONS[key].clean(held[key]) as Settings[K] | undefined;
}

/** The value used for `key`, and the place it comes from. */
export function resolve<K extends SettingKey>(layers: Layers, key: K): { value: Settings[K]; from: Place | 'default' } {
	for (const place of PLACES) {
		const v = valueIn(layers, place, key);
		if (v !== undefined) return { value: v, from: place };
	}
	const d = DEFINITIONS[key].default;
	return { value: (Array.isArray(d) ? d.map((b) => ({ ...b })) : d) as Settings[K], from: 'default' };
}

/** Every setting's value. */
export function resolveAll(layers: Layers): Settings {
	return Object.fromEntries(SETTING_KEYS.map((k) => [k, resolve(layers, k).value])) as unknown as Settings;
}

export function settingText<K extends SettingKey>(key: K, v: Settings[K]): string {
	return DEFINITIONS[key].text(v);
}

/** Each place's name, as a row's source and the 2×2 say it. */
export const PLACE_NAMES: Record<Place | 'default', string> = {
	both: 'This cascade on this device',
	cascade: 'This cascade',
	device: 'This device',
	all: 'Everywhere',
	default: 'Default'
};

/** The places a change made here can be moved to, as the offer under it names them. */
export const WIDER_NAMES: Record<Exclude<Place, 'both'>, string> = {
	cascade: 'This cascade, every device',
	device: 'This device, every cascade',
	all: 'Everywhere'
};

/** What the offer says once a change is in a place. */
export const SAVED_IN: Record<Place, string> = {
	both: 'Saved for this cascade on this device',
	cascade: 'Now used for this cascade on every device',
	device: 'Now used for every cascade on this device',
	all: 'Now used everywhere'
};

/** The places narrower than `place`: the ones read before it, whose values hide its own. */
export function narrowerThan(place: Place): Place[] {
	return PLACES.slice(0, PLACES.indexOf(place));
}

/** The places wider than `place`, nearest first. */
export function widerThan(place: Place): Exclude<Place, 'both'>[] {
	return PLACES.slice(PLACES.indexOf(place) + 1) as Exclude<Place, 'both'>[];
}
