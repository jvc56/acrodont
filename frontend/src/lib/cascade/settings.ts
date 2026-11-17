// A cascade's settings changes as the rules check them (PLAN.md § Settings →
// Where a setting applies), the same checks as the server's
// `cascade::settings`: a setting's name, the range of the settings whose
// values the server knows, and the bounds of the whole; and the same merge,
// per setting, the later change winning. What any other value means is read
// where it is used (lib/settings/layers), which passes over one it cannot read.
import { Rejected } from './rules';

/** At most this many settings on one cascade, each name this long, and this many bytes of them. */
export const MAX_SETTINGS = 64;
export const MAX_NAME = 40;
export const MAX_BYTES = 16 * 1024;

export function validName(k: string): boolean {
	return k.length > 0 && k.length <= MAX_NAME && /^[a-z_]+$/.test(k);
}

const hasNul = (v: unknown): boolean =>
	typeof v === 'string'
		? v.includes('\0')
		: Array.isArray(v)
			? v.some(hasNul)
			: v !== null && typeof v === 'object'
				? Object.entries(v).some(([k, e]) => k.includes('\0') || hasNul(e))
				: false;

const FLAGS = new Set(['show_definitions', 'show_hooks', 'reveal_correct', 'show_found_count', 'require_alphabetical', 'show_probability', 'definition_column']);

/** One change to a setting: null is the default; a value the server knows must be in its range. */
export function checkSetting(name: string, v: unknown) {
	if (!validName(name) || v === undefined || hasNul(v)) throw new Rejected('invalid');
	if (v === null) return;
	const ok =
		name === 'answer_mode'
			? v === 'flashcard' || v === 'typed'
			: FLAGS.has(name)
				? typeof v === 'boolean'
				: name === 'leave_value_decimals'
					? typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3
					: true;
	if (!ok) throw new Rejected('invalid');
}

type Entry = { value: unknown; at: string };
const timeOf = (e: unknown) => (typeof e === 'object' && e !== null && typeof (e as Entry).at === 'string' ? Date.parse((e as Entry).at) : NaN);

/**
 * `current` with `changes` (name to value) made at `at`: per setting, the
 * later change is kept, the new one when they are equal. An empty change,
 * or one past the bounds, is `invalid`.
 */
export function mergeCascadeSettings(current: Record<string, unknown>, changes: unknown, at: string): Record<string, unknown> {
	if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw new Rejected('invalid');
	const entries = Object.entries(changes);
	if (!entries.length || entries.length > MAX_SETTINGS) throw new Rejected('invalid');
	const out = { ...current };
	const t = Date.parse(at);
	for (const [k, v] of entries) {
		checkSetting(k, v);
		const old = timeOf(out[k]);
		if (!(old > t)) out[k] = { value: v, at };
	}
	if (Object.keys(out).length > MAX_SETTINGS || new TextEncoder().encode(JSON.stringify(out)).length > MAX_BYTES) throw new Rejected('invalid');
	return out;
}
