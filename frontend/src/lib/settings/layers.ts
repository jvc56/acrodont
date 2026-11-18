// Where a setting applies (PLAN.md § Settings → Where a setting applies).
// Every cascade on every device has its own settings. A change is made in one
// of four scopes, and kept as `{ value, at }`, `at` being when it was made:
//
//   'both'     this cascade on this device   (this device's meta store)
//   'cascade'  this cascade on all devices   (the cascade row's `settings`, synced)
//   'device'   all cascades on this device   (this device's meta store)
//   'all'      all cascades on all devices   (the account's settings, synced)
//
// A setting's value for a cascade on this device is the latest change among
// the four that cover it. A change for all cascades ('device', 'all') made
// before the cascade was created is passed over: a new cascade starts from
// its preset, or the defaults. A null value is the setting's default, and a
// value from another build that this one cannot read is passed over, as if
// that change had not been made. With no change left, the default is used.
import type { AnswerMode } from '$lib/local/rows';
import { DEFAULT_BINDINGS, normalizeBindings, type Binding } from '$lib/player/bindings';
import { clampSetting, FONTS, type LimitKey } from '$lib/player/display';

export type Scope = 'both' | 'cascade' | 'device' | 'all';
/** The scopes, narrowest first: of two changes made at the same time, the narrower wins. */
export const SCOPES: Scope[] = ['both', 'cascade', 'device', 'all'];
/** The scopes that cover every cascade, whose changes before a cascade was created do not reach it. */
const ALL_CASCADES = new Set<Scope>(['device', 'all']);

/** A change to a setting: its value (null: the default) and when it was made. */
export type Entry = { value: unknown; at: string };
export type Entries = Record<string, Entry>;
export type Layers = Record<Scope, Entries>;
export type Values = Record<string, unknown>;

export const emptyLayers = (): Layers => ({ both: {}, cascade: {}, device: {}, all: {} });

/** Whether `e` is an entry this build can compare: an object with a parseable `at`. */
export function isEntry(e: unknown): e is Entry {
	return typeof e === 'object' && e !== null && 'value' in e && typeof (e as Entry).at === 'string' && Number.isFinite(Date.parse((e as Entry).at));
}

/** `entries` as plain entries, each one this build can compare; anything else is dropped. */
export function entriesOf(v: unknown): Entries {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
	const out: Entries = {};
	for (const [k, e] of Object.entries(v)) if (isEntry(e)) out[k] = { value: e.value, at: e.at };
	return out;
}

/** Every setting's value for a cascade on this device, once resolved. */
export interface Settings {
	/** Anagram cascades: flashcard or typed. */
	answer_mode: AnswerMode;
	/** The grade a reveal gives before any toggle: correct (true) or missed. */
	reveal_correct: boolean;
	show_definitions: boolean;
	show_hooks: boolean;
	/** Typed mode's "3 of 9 found" in the status bar. */
	show_found_count: boolean;
	/** Typed mode: each anagram must be typed after the ones before it alphabetically. */
	require_alphabetical: boolean;
	show_probability: boolean;
	/** A definition in a column of its own beside its word, or centred under it. */
	definition_column: boolean;
	/** Leave Value cascades: decimal places, 0 to 3. */
	leave_value_decimals: number;
	/**
	 * Definition cascades: the revealed question shows the word's hooks and
	 * inner hooks, and the answer is the definition alone, so the word shows once.
	 */
	hooks_on_question: boolean;
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
	/** The widest a definition may be, in its own column or under its word; 0: all the room it has. */
	definition_width_px: number;
	hook_size_px: number;
	/** On a phone: three tap columns, or three rows of buttons. */
	mobile_buttons: 'columns' | 'rows';
	/**
	 * When the player has its Previous, Toggle and Show / Next buttons (the
	 * touch layout): on a touch screen or below `buttons_below_px` ('auto'), or always.
	 */
	player_buttons: 'auto' | 'always';
	/** The window width below which 'auto' shows the buttons. */
	buttons_below_px: number;
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
	| 'answer_mode'
	| 'reveal_correct'
	| 'show_definitions'
	| 'show_hooks'
	| 'show_found_count'
	| 'require_alphabetical'
	| 'show_probability'
	| 'definition_column'
	| 'leave_value_decimals'
	| 'hooks_on_question'
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
	require_alphabetical: flag(false),
	show_probability: flag(false),
	definition_column: flag(true),
	leave_value_decimals: {
		default: 0,
		clean: (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined),
		text: (v) => String(v)
	},
	hooks_on_question: flag(false),
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
	player_buttons: choice<'auto' | 'always'>('auto', { auto: 'Touch screen or narrow window', always: 'Always' }),
	buttons_below_px: number('buttons_below_px', ' px'),
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

/** The default of `key`, a fresh copy. */
export function defaultOf<K extends SettingKey>(key: K): Settings[K] {
	const d = DEFINITIONS[key].default;
	return (Array.isArray(d) ? d.map((b) => ({ ...b })) : d) as Settings[K];
}

/**
 * The value used for `key` and the scope of the change it comes from: the
 * latest change covering it, with a change for all cascades made before
 * `createdAt` passed over, and one whose value cannot be read passed over too.
 */
export function resolve<K extends SettingKey>(
	layers: Layers,
	key: K,
	createdAt: string | null = null
): { value: Settings[K]; from: Scope | 'default' } {
	const born = createdAt ? Date.parse(createdAt) : NaN;
	const found: { scope: Scope; t: number; rank: number; value: unknown }[] = [];
	SCOPES.forEach((scope, rank) => {
		const held = layers[scope];
		if (!Object.prototype.hasOwnProperty.call(held, key)) return;
		const e = held[key];
		if (!isEntry(e)) return;
		const t = Date.parse(e.at);
		if (ALL_CASCADES.has(scope) && t < born) return;
		found.push({ scope, t, rank, value: e.value });
	});
	found.sort((a, b) => b.t - a.t || a.rank - b.rank);
	for (const f of found) {
		if (f.value === null || f.value === undefined) return { value: defaultOf(key), from: f.scope };
		const v = DEFINITIONS[key].clean(f.value) as Settings[K] | undefined;
		if (v !== undefined) return { value: v, from: f.scope };
	}
	return { value: defaultOf(key), from: 'default' };
}

/** Every setting's value. */
export function resolveAll(layers: Layers, createdAt: string | null = null): Settings {
	return Object.fromEntries(SETTING_KEYS.map((k) => [k, resolve(layers, k, createdAt).value])) as unknown as Settings;
}

export function settingText<K extends SettingKey>(key: K, v: Settings[K]): string {
	return DEFINITIONS[key].text(v);
}

/** `entries` with every one of `values` made a change at `at`. */
export function stamp(entries: Entries, values: Values, at: string): Entries {
	const out = { ...entries };
	for (const [k, v] of Object.entries(values)) out[k] = { value: v === undefined ? null : v, at };
	return out;
}
