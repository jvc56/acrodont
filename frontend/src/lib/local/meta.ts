// The `meta` store (PLAN.md § On the device → IndexedDB stores): identity,
// this device's id and next `device_seq`, the sync cursor, what
// `/api/auth/me` last reported, last-open times, the settings changes this
// device holds (PLAN.md § Settings → Where a setting applies), the presets,
// the server's clock against this one's, and the budget-dropped ids. All per
// device and user.
import type { IDBPTransaction } from 'idb';
import type { Entries } from '$lib/settings/layers';
import type { Preset } from '$lib/settings/presets';
import type { LexiconInfo } from '$lib/filters';
import type { SavedSearch } from '$lib/search/state.svelte';
import type { StoreName, UserDb, UserSchema } from './db';

export interface MetaValues {
	identity: { user_id: string; username: string };
	/** `device_id` is made once per device and user; `device_seq` counts from 1. */
	device: { device_id: string; next_device_seq: number };
	/** `upgrade_required`: a 426 was the last answer; cleared by a sync that succeeds. */
	sync: { cursor: number | null; last_sync_at: string | null; upgrade_required?: boolean };
	/**
	 * What the server last reported: from /api/auth/me, and the account's
	 * storage from every sync response too (PLAN.md § Storage limit).
	 */
	server: { trash_retention_days: number; max_quiz_questions: number; storage_bytes?: number; max_storage_bytes?: number };
	/** When this device last opened each cascade (ISO time). */
	opens: Record<string, string>;
	budget_dropped: string[];
	/**
	 * Cascades whose last replay held operations back (PLAN.md § Applying a pull
	 * on the device, step 4): each with the quiz whose question rows the replay
	 * was waiting for. The operations are in the outbox and not in the overlay.
	 */
	held: Record<string, string>;
	/**
	 * Changes for all cascades on all devices (lib/settings/everywhere): the
	 * account's as the last sync response carried them, and those made here and
	 * not yet sent. A value of null is the setting's default.
	 */
	account_settings: { values: Entries; pending: Entries };
	/** Changes for all cascades on this device. */
	device_scope: Entries;
	/** Changes for one cascade on this device alone, by cascade. */
	cascade_device_scope: Record<string, Entries>;
	/**
	 * The server's clock less this device's, in ms, from the last sync
	 * response's `server_time`: settings changes are stamped by the server's
	 * clock (PLAN.md § Settings → Clocks).
	 */
	clock: { offset_ms: number };
	/**
	 * The account's presets (lib/settings/presets) as the last sync response
	 * that carried them had them, and their version, sent with every sync.
	 */
	presets: { version: string | null; list: Preset[] };
	/** The preset the builder used last on this device, which it starts at; null for Defaults. */
	last_preset_id: string | null;
	/** Bytes of each cascade's question keys and answers, measured as they were written. */
	sizes: Record<string, { key_bytes: number; answer_bytes: number }>;
	/** `GET /api/lexicons` as it last answered, so Search lists the lexicons offline. */
	lexicons: LexiconInfo[];
	/** The Search page's search, as it was left (PLAN.md § Search page). */
	search_state: SavedSearch | null;
}
export type MetaKey = keyof MetaValues;

export const META_DEFAULTS: { [K in MetaKey]: () => MetaValues[K] } = {
	identity: () => ({ user_id: '', username: '' }),
	device: () => ({ device_id: crypto.randomUUID(), next_device_seq: 1 }),
	sync: () => ({ cursor: null, last_sync_at: null }),
	server: () => ({ trash_retention_days: 30, max_quiz_questions: 300_000 }),
	opens: () => ({}),
	budget_dropped: () => [],
	held: () => ({}),
	account_settings: () => ({ values: {}, pending: {} }),
	device_scope: () => ({}),
	cascade_device_scope: () => ({}),
	clock: () => ({ offset_ms: 0 }),
	presets: () => ({ version: null, list: [] }),
	last_preset_id: () => null,
	sizes: () => ({}),
	lexicons: () => [],
	search_state: () => null
};

type Tx = IDBPTransaction<UserSchema, StoreName[], 'readwrite' | 'readonly'>;

export async function readMeta<K extends MetaKey>(tx: Tx, key: K): Promise<MetaValues[K]> {
	const v = (await tx.objectStore('meta').get(key)) as MetaValues[K] | undefined;
	return v ?? META_DEFAULTS[key]();
}

export async function writeMeta<K extends MetaKey>(
	tx: IDBPTransaction<UserSchema, StoreName[], 'readwrite'>,
	key: K,
	value: MetaValues[K]
) {
	await tx.objectStore('meta').put(value, key);
}

export async function getMeta<K extends MetaKey>(db: UserDb, key: K): Promise<MetaValues[K]> {
	return readMeta(db.transaction(['meta']) as unknown as Tx, key);
}

/** Records who this database belongs to and makes the device id on first open. */
export async function initMeta(db: UserDb, userId: string, username: string): Promise<MetaValues['device']> {
	const tx = db.transaction(['meta'], 'readwrite');
	const meta = tx.objectStore('meta');
	const identity = (await meta.get('identity')) as MetaValues['identity'] | undefined;
	if (!identity || (username && identity.username !== username)) {
		await meta.put({ user_id: userId, username: username || identity?.username || '' }, 'identity');
	}
	let device = (await meta.get('device')) as MetaValues['device'] | undefined;
	if (!device) {
		device = META_DEFAULTS.device();
		await meta.put(device, 'device');
	}
	await tx.done;
	return device;
}

/** Marks a cascade opened now, clearing its budget-dropped mark (§ Downloads). */
export async function recordOpen(tx: IDBPTransaction<UserSchema, StoreName[], 'readwrite'>, cascadeId: string, at: string) {
	const opens = await readMeta(tx, 'opens');
	opens[cascadeId] = at;
	await writeMeta(tx, 'opens', opens);
	const dropped = await readMeta(tx, 'budget_dropped');
	if (dropped.includes(cascadeId)) {
		await writeMeta(
			tx,
			'budget_dropped',
			dropped.filter((id) => id !== cascadeId)
		);
	}
}
