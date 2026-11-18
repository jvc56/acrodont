// A cascade's rules (PLAN.md § Settings → A cascade's rules): its clear
// threshold and its quiz options (segment size and progression), which every
// level reads, the one being studied included. They decide how a pass is
// judged and so are always the cascade's, on every device. A change applies to
// that cascade alone; the player then offers to use the same value for every
// cascade, and a preset applied to the cascade sets them too. Neither is a new
// kind of change: each is the ordinary `set_cascade_options` for each cascade
// that differs, so it works offline and syncs like any other. Every new
// cascade starts with CASCADE_SETTING_DEFAULTS, or its preset's rules.
import { allCascades } from '$lib/cascades/summary';
import { applyLocally, type NewOp } from '$lib/local/apply';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow } from '$lib/local/rows';

export const CASCADE_SETTINGS = ['clear_threshold', 'segment_size', 'progression'] as const;

export type CascadeSetting = (typeof CASCADE_SETTINGS)[number];
export type CascadeSettings = Partial<Pick<CascadeRow, CascadeSetting>>;

/** The cascades a change can reach: those not in the Trash. */
export async function reachable(db: UserDb): Promise<CascadeRow[]> {
	return (await allCascades(db)).filter((c) => c.trashed_at === null);
}

/** Of `fields`, those that differ from what `c` has. */
function differing(c: CascadeRow, fields: CascadeSettings): CascadeSettings {
	return Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && c[k as CascadeSetting] !== v));
}

/** Gives every reachable cascade these values; returns how many changed. The caller syncs (`afterLocalWrite`). */
export async function applyToAll(db: UserDb, fields: CascadeSettings): Promise<number> {
	let changed = 0;
	for (const c of await reachable(db)) {
		const diff = differing(c, fields);
		if (!Object.keys(diff).length) continue;
		await applyLocally(db, { type: 'set_cascade_options', cascade_id: c.id, ...diff } as NewOp);
		changed++;
	}
	return changed;
}

/** Of a preset's rules, those that differ from what `c` has, as one `set_cascade_options` carries them. */
export function rulesToApply(c: CascadeRow, p: Pick<CascadeRow, CascadeSetting>): CascadeSettings {
	return differing(c, Object.fromEntries(CASCADE_SETTINGS.map((k) => [k, p[k]])) as CascadeSettings);
}

/** One way to widen a change, as the offer under a setting shows it. */
export interface Widening {
	key: string;
	/** The link: "all 12 cascades". */
	label: string;
	/** What it says once done: "Used for all 12 cascades". */
	done: string;
	run: () => Promise<void>;
	/** The other offers this one covers, marked done with it: "all cascades on all devices" covers the narrower two. */
	covers?: string[];
}
