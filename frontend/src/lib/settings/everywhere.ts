// Changes for all cascades on all devices (PLAN.md § Settings → Where a
// setting applies): the account's own settings. The server keeps them in
// `users.settings`, an object of setting name to `{ value, at }`, `at` being
// when the change was made; a value of null is the setting's default. A
// change made here waits in this device's `meta` store
// (`account_settings.pending`) until a sync carries it in the request's
// `settings`; the server merges it in, the later `at` winning per setting, so
// two devices changing the same setting agree on the last one. Every sync
// response carries the account's whole map, which this device keeps
// (`account_settings.values`); the scope holds, per setting, the later of that
// and any change still pending here.
import type { UserDb } from '$lib/local/db';
import { readMeta, writeMeta } from '$lib/local/meta';
import { entriesOf, isSettingKey, sameValue, type Entries, type Entry, type Values } from './layers';

const time = (e: Entry | undefined) => (e && typeof e.at === 'string' ? Date.parse(e.at) : NaN);

/** The scope's changes: each setting's later of the account's and one pending here. */
export function everywhereEntries(st: { values?: Entries; pending?: Entries }): Entries {
	const out: Entries = {};
	const values = entriesOf(st.values);
	const pending = entriesOf(st.pending);
	for (const k of new Set([...Object.keys(values), ...Object.keys(pending)])) {
		if (!isSettingKey(k)) continue;
		const a = values[k];
		const p = pending[k];
		const e = p && !(time(a) > time(p)) ? p : a;
		if (e) out[k] = e;
	}
	return out;
}

/**
 * Makes `fields` changes for all cascades on all devices at `at`. They go
 * with the next sync; the caller asks for one (`afterLocalWrite`).
 */
export async function setEverywhere(db: UserDb, fields: Values, at: string): Promise<void> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'account_settings');
	for (const [k, value] of Object.entries(fields)) {
		if (!isSettingKey(k)) continue;
		st.pending[k] = { value: value === undefined ? null : value, at };
	}
	await writeMeta(tx, 'account_settings', st);
	await tx.done;
}

/** The changes this device has not sent yet, for the next sync request. */
export async function pendingShares(db: UserDb): Promise<Entries> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'account_settings');
	await tx.done;
	return st.pending;
}

/**
 * After a sync: the changes `sent` are no longer pending (unless changed
 * again since), and the account's map as the response carried it is kept.
 * True when what the scope holds changed.
 */
export async function takeShared(db: UserDb, shared: unknown, sent: Entries): Promise<boolean> {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'account_settings');
	const before = everywhereEntries(st);
	for (const [k, e] of Object.entries(sent)) if (st.pending[k]?.at === e.at) delete st.pending[k];
	st.values = entriesOf(shared);
	await writeMeta(tx, 'account_settings', st);
	await tx.done;
	const after = everywhereEntries(st);
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].some((k) => !sameValue(before[k], after[k]));
}
