// A cascade's rules (PLAN.md § Settings → A cascade's rules): its clear
// threshold and the options of the levels it makes from now on, which decide
// how a pass is judged and so are always the cascade's, on every device. A
// change applies to that cascade alone; the player then offers to use the same
// value for every cascade, and can copy another cascade's rules and own
// settings at once. Neither is a new kind of change: each is the ordinary
// `set_cascade_options` for each cascade that differs, so it works offline and
// syncs like any other. Every new cascade starts with CASCADE_SETTING_DEFAULTS.
import { allCascades } from '$lib/cascades/summary';
import { applyLocally, type NewOp } from '$lib/local/apply';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow, QuizType } from '$lib/local/rows';
import { sameValue } from './layers';
import { cascadePlace } from './places';

export const CASCADE_SETTINGS = ['clear_threshold', 'segment_size', 'progression', 'require_alphabetical'] as const;

export type CascadeSetting = (typeof CASCADE_SETTINGS)[number];
export type CascadeSettings = Partial<Pick<CascadeRow, CascadeSetting>>;

/** The rules that mean something for one kind of cascade only; the others apply to every kind. */
const ONLY_FOR: Partial<Record<CascadeSetting, QuizType>> = {
	require_alphabetical: 'anagram'
};

/** Whether a setting means something for a cascade of this kind. */
export function appliesTo(setting: CascadeSetting, quizType: QuizType): boolean {
	const only = ONLY_FOR[setting];
	return !only || only === quizType;
}

/** The kind of cascade every one of these settings applies to, if they are for one kind only. */
export function kindOf(fields: CascadeSettings): QuizType | null {
	for (const k of Object.keys(fields) as CascadeSetting[]) if (ONLY_FOR[k]) return ONLY_FOR[k]!;
	return null;
}

/** The cascades a change can reach: those not in the Trash, of the kind the settings are for. */
export async function reachable(db: UserDb, fields: CascadeSettings): Promise<CascadeRow[]> {
	const kind = kindOf(fields);
	return (await allCascades(db)).filter((c) => c.trashed_at === null && (!kind || c.quiz_type === kind));
}

/** Of `fields`, those that apply to `c` and differ from what it has. */
function differing(c: CascadeRow, fields: CascadeSettings): CascadeSettings {
	return Object.fromEntries(
		Object.entries(fields).filter(([k, v]) => v !== undefined && appliesTo(k as CascadeSetting, c.quiz_type) && c[k as CascadeSetting] !== v)
	);
}

/** Gives every reachable cascade these values; returns how many changed. The caller syncs (`afterLocalWrite`). */
export async function applyToAll(db: UserDb, fields: CascadeSettings): Promise<number> {
	let changed = 0;
	for (const c of await reachable(db, fields)) {
		const diff = differing(c, fields);
		if (!Object.keys(diff).length) continue;
		await applyLocally(db, { type: 'set_cascade_options', cascade_id: c.id, ...diff } as NewOp);
		changed++;
	}
	return changed;
}

/** The other cascades whose settings `c` could copy: not in the Trash, most recently studied first. */
export async function copySources(db: UserDb, c: CascadeRow): Promise<CascadeRow[]> {
	return (await allCascades(db))
		.filter((o) => o.id !== c.id && o.trashed_at === null)
		.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
}

/**
 * Gives `to` every rule of `from` that applies to both, and the same own
 * settings (the "This cascade" place) as `from`, in one change; returns how
 * many differed. The caller syncs.
 */
export async function copySettings(db: UserDb, from: CascadeRow, to: CascadeRow): Promise<number> {
	const fields = Object.fromEntries(
		CASCADE_SETTINGS.filter((k) => appliesTo(k, from.quiz_type)).map((k) => [k, from[k]])
	) as CascadeSettings;
	const diff: Record<string, unknown> = differing(to, fields);
	const mine = cascadePlace(to);
	const theirs = cascadePlace(from);
	const own: Record<string, unknown> = {};
	for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
		if (!sameValue(mine[k], theirs[k])) own[k] = k in theirs ? theirs[k] : null;
	}
	const n = Object.keys(diff).length + Object.keys(own).length;
	if (Object.keys(own).length) diff.settings = own;
	if (n) await applyLocally(db, { type: 'set_cascade_options', cascade_id: to.id, ...diff } as NewOp);
	return n;
}

/** One way to widen a change, as the offer under a setting shows it. */
export interface Widening {
	key: string;
	/** The link: "all 12 cascades". */
	label: string;
	/** What it says once done: "Used for all 12 cascades". */
	done: string;
	run: () => Promise<void>;
}
