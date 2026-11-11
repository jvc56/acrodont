// Where a setting applies (PLAN.md § Preferences → Where a setting applies).
// A cascade's own settings — its clear threshold, its answer mode and the
// options its new levels start with — change for that cascade alone; the
// player then offers to use the same value for new cascades (the account's
// default for it) or for every cascade at once, and the Preferences page
// offers the same for a default it has just changed. "Every cascade" is no
// new kind of change: it is the ordinary `set_cascade_options` for each
// cascade that differs, so it works offline and syncs like any other.
import { allCascades } from '$lib/cascades/summary';
import { applyLocally, type NewOp } from '$lib/local/apply';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow, PreferencesRow } from '$lib/local/rows';

export type CascadeFields = Partial<Pick<CascadeRow, 'clear_threshold' | 'answer_mode' | 'segment_size' | 'progression' | 'require_alphabetical'>>;
export type CascadeField = keyof CascadeFields;

/** The account default each cascade setting starts a new cascade with. */
export const DEFAULT_OF = {
	clear_threshold: 'default_clear_threshold',
	answer_mode: 'anagram_answer_mode',
	segment_size: 'default_segment_size',
	progression: 'default_progression',
	require_alphabetical: 'default_require_alphabetical'
} as const satisfies Record<CascadeField, keyof PreferencesRow>;

/** The cascade setting an account default is for, if it is one. */
export function fieldOfDefault(pref: keyof PreferencesRow): CascadeField | null {
	const hit = (Object.entries(DEFAULT_OF) as [CascadeField, string][]).find(([, p]) => p === pref);
	return hit ? hit[0] : null;
}

/** The cascades a change can reach: those not in the Trash, and only anagram cascades for the answer mode. */
export async function reachable(db: UserDb, fields: CascadeFields): Promise<CascadeRow[]> {
	const anagramOnly = fields.answer_mode !== undefined;
	return (await allCascades(db)).filter((c) => c.trashed_at === null && (!anagramOnly || c.quiz_type === 'anagram'));
}

/** Gives every reachable cascade these values; returns how many changed. The caller syncs (`afterLocalWrite`). */
export async function applyToAll(db: UserDb, fields: CascadeFields): Promise<number> {
	let changed = 0;
	for (const c of await reachable(db, fields)) {
		const diff = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && c[k as CascadeField] !== v));
		if (!Object.keys(diff).length) continue;
		await applyLocally(db, { type: 'set_cascade_options', cascade_id: c.id, ...diff } as NewOp);
		changed++;
	}
	return changed;
}

/** Makes these values the defaults new cascades start with. The caller syncs. */
export async function applyAsDefault(db: UserDb, fields: CascadeFields): Promise<void> {
	const op: Record<string, unknown> = { type: 'set_preferences' };
	for (const [k, v] of Object.entries(fields)) if (v !== undefined) op[DEFAULT_OF[k as CascadeField]] = v;
	if (Object.keys(op).length > 1) await applyLocally(db, op as NewOp);
}

/** One way to widen a change, as the offer under a setting shows it. */
export interface Widening {
	key: string;
	/** The link: "new cascades", "all 12 cascades and new ones". */
	label: string;
	/** What it says once done: "Used for new cascades". */
	done: string;
	/** Other offers this one includes, marked done with it. */
	includes?: string[];
	run: () => Promise<void>;
}
