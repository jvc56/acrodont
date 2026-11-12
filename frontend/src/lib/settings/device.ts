// A device setting used for all of the account's devices (PLAN.md § Settings →
// This device, or all of them). Each device keeps its own display settings and
// controls; "Also use for: all your devices" under one shares its value. The
// account holds the shared values on the server, each with the time it was
// shared: a sync sends the values shared here and not yet sent, and every sync
// response carries the account's shared values, which a device takes when one
// is newer than the last it took for that setting. A new device takes them all
// on its first sync. A later change on one device stays on that device, until
// it or another shares again.
import type { UserDb } from '$lib/local/db';
import { readMeta, writeMeta, type MetaValues } from '$lib/local/meta';
import { normalizeBindings } from '$lib/player/bindings';
import { normalizeDisplay } from '$lib/player/display.svelte';

/** A setting's shared value and when it was shared (ISO time). */
export type SharedSetting = { value: unknown; at: string };
export type SharedSettings = Record<string, SharedSetting>;

/** The display settings that can be shared, each by its own name, and the controls as one: `bindings`. */
export const SHAREABLE = new Set<string>([
	'question_font',
	'answer_font',
	'question_size_px',
	'answer_size_px',
	'definition_font',
	'definition_size_px',
	'definition_spacing',
	'question_spacing',
	'answer_spacing',
	'question_top_px',
	'border_px',
	'repeat_guard_ms',
	'border_correct',
	'border_missed',
	'status_bar_hidden',
	'sync_status_hidden',
	'definition_column',
	'show_probability',
	'mobile_buttons',
	'mobile_row_px',
	'bindings'
]);

type Display = MetaValues['display'];

/**
 * Shares settings this device already has: they go with the next sync, and
 * this device counts them as taken, so their echo changes nothing here.
 */
export async function shareSettings(db: UserDb, fields: Record<string, unknown>, now = new Date()): Promise<void> {
	const at = now.toISOString();
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	for (const [k, value] of Object.entries(fields)) {
		if (!SHAREABLE.has(k)) continue;
		st.pending[k] = { value, at };
		st.applied[k] = at;
	}
	await writeMeta(tx, 'shared_device', st);
	await tx.done;
}

/** The shared values this device has not sent yet, for the next sync request. */
export async function pendingShares(db: UserDb): Promise<SharedSettings> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	await tx.done;
	return st.pending;
}

/**
 * After a sync: the values `sent` are no longer pending (unless shared again
 * since), and each of the account's shared values newer than the one this
 * device last took is taken. True when a display setting or the controls changed.
 */
export async function takeShared(db: UserDb, shared: SharedSettings, sent: SharedSettings): Promise<boolean> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	for (const [k, e] of Object.entries(sent)) if (st.pending[k]?.at === e.at) delete st.pending[k];
	let display: Display | null = null;
	let bindings: unknown = undefined;
	for (const [k, e] of Object.entries(shared)) {
		if (!SHAREABLE.has(k) || !e || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) continue;
		const mine = st.applied[k];
		if (mine && Date.parse(mine) >= Date.parse(e.at)) continue;
		st.applied[k] = e.at;
		if (k === 'bindings') bindings = e.value;
		else {
			display ??= { ...(await readMeta(tx, 'display')) };
			(display as Record<string, unknown>)[k] = e.value;
		}
	}
	// Values from another build are made valid here as they are on load.
	if (display) await writeMeta(tx, 'display', normalizeDisplay(display));
	if (bindings !== undefined) await writeMeta(tx, 'bindings', normalizeBindings(bindings));
	await writeMeta(tx, 'shared_device', st);
	await tx.done;
	return display !== null || bindings !== undefined;
}
