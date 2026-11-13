// How the player looks and responds on this device: the question's and the
// answers' typefaces, sizes and letter spacing, how far down the question
// sits, the grade border's width, whether the player's status bar and sync
// status are hidden, whether a definition has a column of its own and how wide
// it may be, the hooks' size, a phone's tap zones (columns or rows), and the
// repeat guard against an accidental double press.
// Kept in the user's `meta` store, per device and user like the other `meta`
// values: what suits a laptop is wrong on a phone. A change stays on its
// device unless the user then shares it with all of them (lib/settings/device).
//
// Every value is a number the user types (pixels, em, milliseconds), but for
// the typeface, which is one of a few that every device has (Inter is bundled).
// The menu beside the quiz is not a setting: a cascade always opens with it
// hidden.
import type { UserDb } from '$lib/local/db';
import { getMeta, type MetaValues } from '$lib/local/meta';
import { shareSettings } from '$lib/settings/device';

/** The typefaces offered: Inter is bundled, and the rest are the device's own, so all work offline. */
export const FONTS: { value: string; label: string }[] = [
	{ value: 'Inter', label: 'Inter (default)' },
	{ value: 'system-ui', label: 'System' },
	{ value: 'serif', label: 'Serif' },
	{ value: 'monospace', label: 'Monospace' }
];
export const DEFAULT_FONT = 'Inter';

/** A setting's bounds and default; out-of-range values are clamped, unreadable ones take the default. */
export const LIMITS = {
	size_px: { min: 8, max: 200, step: 1, default: 36 },
	definition_size_px: { min: 8, max: 200, step: 1, default: 20 },
	// Three quarters of the answers' default size.
	hook_size_px: { min: 6, max: 200, step: 1, default: 27 },
	// 0: no limit, the column takes all the room there is.
	definition_width_px: { min: 0, max: 4000, step: 1, default: 0 },
	spacing_em: { min: -0.2, max: 2, step: 0.01, default: 0 },
	question_top_px: { min: 0, max: 800, step: 1, default: 8 },
	border_px: { min: 0, max: 40, step: 1, default: 10 },
	mobile_row_px: { min: 32, max: 200, step: 1, default: 64 },
	repeat_guard_ms: { min: 0, max: 1000, step: 5, default: 0 }
} as const;
export type LimitKey = keyof typeof LIMITS;

export type Display = MetaValues['display'];

export function defaultDisplay(): Display {
	return {
		question_font: DEFAULT_FONT,
		answer_font: DEFAULT_FONT,
		question_size_px: LIMITS.size_px.default,
		answer_size_px: LIMITS.size_px.default,
		definition_font: DEFAULT_FONT,
		definition_size_px: LIMITS.definition_size_px.default,
		definition_spacing: LIMITS.spacing_em.default,
		question_spacing: LIMITS.spacing_em.default,
		answer_spacing: LIMITS.spacing_em.default,
		question_top_px: LIMITS.question_top_px.default,
		border_px: LIMITS.border_px.default,
		repeat_guard_ms: LIMITS.repeat_guard_ms.default,
		border_correct: false,
		border_missed: true,
		status_bar_hidden: false,
		sync_status_hidden: false,
		definition_column: true,
		definition_width_px: LIMITS.definition_width_px.default,
		hook_size_px: LIMITS.hook_size_px.default,
		mobile_buttons: 'columns',
		mobile_row_px: LIMITS.mobile_row_px.default,
		version: DISPLAY_VERSION
	};
}

/**
 * Bumped when a default changes in a way stored values should follow: 2 made
 * the repeat guard 0 by default, so a stored 50 — the old default, which a
 * user who never touched it still has saved — becomes 0.
 */
export const DISPLAY_VERSION = 2;

/** A number within a setting's bounds (to its step), or its default when it is not a number. */
export function clampSetting(key: LimitKey, v: unknown): number {
	const l = LIMITS[key];
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return l.default;
	const stepped = Math.round(n / l.step) * l.step;
	// Rounded to the step's decimals, so 0.1 stays 0.1 and not 0.10000000000000001.
	const decimals = String(l.step).split('.')[1]?.length ?? 0;
	return Math.min(l.max, Math.max(l.min, Number(stepped.toFixed(decimals))));
}

/** One of the offered typefaces; anything else (a name a past build let the user type) is the default. */
export function cleanFont(v: unknown): string {
	return FONTS.some((f) => f.value === v) ? (v as string) : DEFAULT_FONT;
}

/** The earlier builds' preset keys and units, read into today's values. */
const OLD_FONTS: Record<string, string> = { sans: 'Inter', system: 'system-ui', serif: 'serif', mono: 'monospace' };
type Stored = Partial<Display> & { question_size?: number; answer_size?: number; question_top?: number; version?: number };

/** A stored value from an older or newer build, made whole and valid. */
export function normalizeDisplay(stored: Stored | undefined): Display {
	const d = stored ?? {};
	const font = (f: unknown) => cleanFont(typeof f === 'string' && f in OLD_FONTS ? OLD_FONTS[f] : f);
	// Sizes were rem presets; the question's position was rem beyond an 8 px margin.
	const size = (px: unknown, rem: unknown) => clampSetting('size_px', px ?? (typeof rem === 'number' ? rem * 16 : undefined));
	return {
		question_font: font(d.question_font),
		answer_font: font(d.answer_font),
		question_size_px: size(d.question_size_px, d.question_size),
		answer_size_px: size(d.answer_size_px, d.answer_size),
		definition_font: font(d.definition_font),
		definition_size_px: clampSetting('definition_size_px', d.definition_size_px),
		definition_spacing: clampSetting('spacing_em', d.definition_spacing),
		question_spacing: clampSetting('spacing_em', d.question_spacing),
		answer_spacing: clampSetting('spacing_em', d.answer_spacing),
		question_top_px: clampSetting(
			'question_top_px',
			d.question_top_px ?? (typeof d.question_top === 'number' && d.question_top <= 8 ? 8 + d.question_top * 16 : undefined)
		),
		border_px: clampSetting('border_px', d.border_px),
		repeat_guard_ms: clampSetting(
			'repeat_guard_ms',
			(d.version ?? 1) < 2 && d.repeat_guard_ms === 50 ? 0 : d.repeat_guard_ms
		),
		border_correct: d.border_correct === undefined ? false : !!d.border_correct,
		border_missed: d.border_missed === undefined ? true : !!d.border_missed,
		status_bar_hidden: !!d.status_bar_hidden,
		sync_status_hidden: !!d.sync_status_hidden,
		definition_column: d.definition_column === undefined ? true : !!d.definition_column,
		definition_width_px: clampSetting('definition_width_px', d.definition_width_px),
		hook_size_px: clampSetting('hook_size_px', d.hook_size_px),
		mobile_buttons: d.mobile_buttons === 'rows' ? 'rows' : 'columns',
		mobile_row_px: clampSetting('mobile_row_px', d.mobile_row_px),
		version: DISPLAY_VERSION
	};
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']);

/** The CSS font stack for a typeface name, falling back to the bundled Inter. */
export function fontStack(name: string): string {
	const n = cleanFont(name);
	const first = n === 'Inter' ? "'Inter Variable'" : GENERIC.has(n) ? n : `"${n.replace(/["\\]/g, '')}"`;
	return `${first}, 'Inter Variable', ui-sans-serif, system-ui, sans-serif`;
}

/** The style attribute for question or answer text; spacing 0 leaves the browser's normal. */
export function textStyle(font: string, px: number, spacing = 0): string {
	const letters = spacing ? ` letter-spacing: ${spacing}em;` : ' letter-spacing: normal;';
	return `font-family: ${fontStack(font)}; font-size: ${px}px; line-height: 1.2;${letters}`;
}

class DisplayState {
	value = $state<Display>(defaultDisplay());
	#db: UserDb | null = null;

	async load(db: UserDb) {
		this.#db = db;
		this.value = normalizeDisplay((await getMeta(db, 'display')) as Stored);
	}

	/** Reads the stored settings again, after a sync took shared ones (lib/settings/device). */
	async reload() {
		if (this.#db) await this.load(this.#db);
	}

	/** Uses these settings, which this device already has, for all of the account's devices. */
	async share(fields: (keyof Display)[]) {
		if (!this.#db) return;
		await shareSettings(this.#db, Object.fromEntries(fields.map((f) => [f, $state.snapshot(this.value[f])])));
	}

	async set(patch: Partial<Display>) {
		this.value = normalizeDisplay({ ...this.value, ...patch });
		if (!this.#db) return;
		const tx = this.#db.transaction(['meta'], 'readwrite');
		await tx.objectStore('meta').put($state.snapshot(this.value), 'display');
		await tx.done;
	}
}

export const display = new DisplayState();
