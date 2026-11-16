// The "Everywhere" place (PLAN.md § Settings → Where a setting applies): the
// account's own settings, for every cascade on every device. The server keeps
// them in `users.device_settings`, an object of setting name to
// `{ value, at }`, `at` being when the value was set there; a value of null
// takes the setting out of the place. A change made here waits in this
// device's `meta` store (`shared_device.pending`) until a sync carries it in
// the request's `device_settings`; the server merges it in, the later `at`
// winning per setting, so two devices changing the same setting agree on the
// last one. Every sync response carries the account's whole map, which this
// device keeps (`shared_device.values`); what the place holds is, per setting,
// the later of that and any change still pending here.
import type { UserDb } from '$lib/local/db';
import { readMeta, writeMeta } from '$lib/local/meta';
import { isSettingKey, sameValue, type Values } from './layers';

/** A setting's value in the place and when it was set; a null value is a setting taken out. */
export type SharedSetting = { value: unknown; at: string };
export type SharedSettings = Record<string, SharedSetting>;

const time = (e: SharedSetting | undefined) => (e && typeof e.at === 'string' ? Date.parse(e.at) : NaN);

/** The place's settings: each the later of the account's value and a change pending here. */
export function everywhereValues(st: { values?: SharedSettings; pending?: SharedSettings }): Values {
	const out: Values = {};
	const values = st.values ?? {};
	const pending = st.pending ?? {};
	for (const k of new Set([...Object.keys(values), ...Object.keys(pending)])) {
		if (!isSettingKey(k)) continue;
		const a = values[k];
		const p = pending[k];
		const e = p && !(time(a) > time(p)) ? p : a;
		if (e && e.value !== null && e.value !== undefined) out[k] = e.value;
	}
	return out;
}

/**
 * Sets (or, with null, clears) settings in the place. They go with the next
 * sync; the caller asks for one (`afterLocalWrite`).
 */
export async function setEverywhere(db: UserDb, fields: Record<string, unknown>, now = new Date()): Promise<void> {
	const at = now.toISOString();
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	for (const [k, value] of Object.entries(fields)) {
		if (!isSettingKey(k)) continue;
		st.pending[k] = { value: value === undefined ? null : value, at };
	}
	await writeMeta(tx, 'shared_device', st);
	await tx.done;
}

/** The changes this device has not sent yet, for the next sync request. */
export async function pendingShares(db: UserDb): Promise<SharedSettings> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	await tx.done;
	return st.pending;
}

/**
 * After a sync: the changes `sent` are no longer pending (unless changed
 * again since), and the account's map as the response carried it is kept.
 * True when what the place holds changed.
 */
export async function takeShared(db: UserDb, shared: SharedSettings, sent: SharedSettings): Promise<boolean> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'shared_device');
	const before = everywhereValues(st);
	for (const [k, e] of Object.entries(sent)) if (st.pending[k]?.at === e.at) delete st.pending[k];
	const values: SharedSettings = {};
	for (const [k, e] of Object.entries(shared ?? {})) {
		if (e && typeof e === 'object' && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at))) values[k] = { value: e.value, at: e.at };
	}
	st.values = values;
	await writeMeta(tx, 'shared_device', st);
	await tx.done;
	const after = everywhereValues(st);
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].some((k) => !sameValue(before[k], after[k]));
}
