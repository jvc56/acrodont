// How the player's text and layout are drawn: the typefaces offered, each
// number setting's bounds, and the text styles the player builds from them.
// Which value each setting takes is lib/settings/layers' to say;
// this module only says what a valid value is and how it is drawn.
//
// Every value is a number the user types (pixels, em, milliseconds), but for
// the typeface, which is one of a few that every device has (Inter is bundled).

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
	repeat_guard_ms: { min: 0, max: 1000, step: 5, default: 0 },
	// The window width below which the player shows its buttons, as on a phone.
	buttons_below_px: { min: 0, max: 8000, step: 1, default: 900 }
} as const;
export type LimitKey = keyof typeof LIMITS;

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
