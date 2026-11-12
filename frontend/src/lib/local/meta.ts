// The `meta` store (PLAN.md § On the device → IndexedDB stores): identity,
// this device's id and next `device_seq`, the sync cursor, what
// `/api/auth/me` last reported, last-open times, this device's controls and
// display settings, and the budget-dropped
// ids. All per device and user.
import type { IDBPTransaction } from 'idb';
import type { StoreName, UserDb, UserSchema } from './db';
import { DEFAULT_BINDINGS, type Binding } from '$lib/player/bindings';

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
	 * Device settings used for all of the account's devices (lib/settings/device):
	 * when this device last took each shared value, and the values it shared and
	 * has not yet sent.
	 */
	shared_device: { applied: Record<string, string>; pending: Record<string, { value: unknown; at: string }> };
	/** Bytes of each cascade's question keys and answers, measured as they were written. */
	sizes: Record<string, { key_bytes: number; answer_bytes: number }>;
	/** The player's controls on this device (lib/player/controls.svelte.ts); shared with other devices only when asked (shared_device). */
	bindings: Binding[];
	/** How the player looks and responds on this device (lib/player/display.svelte.ts); shared with other devices only when asked (shared_device). */
	display: {
		/** One of lib/player/display's FONTS; Inter by default. */
		question_font: string;
		answer_font: string;
		question_size_px: number;
		answer_size_px: number;
		/** Definitions: a Definition quiz's answer, and the line under each anagram. */
		definition_font: string;
		definition_size_px: number;
		definition_spacing: number;
		/** Extra letter spacing in em; 0 is the browser's normal. */
		question_spacing: number;
		answer_spacing: number;
		/** The question's distance from the top of the quiz area, in px. */
		question_top_px: number;
		/** The grade border's width, in px. */
		border_px: number;
		/** The repeat guard: the same action twice within this many ms counts once; 0 is off. */
		repeat_guard_ms: number;
		/** Whether the grade border shows for a correct answer (off by default) and for a missed one (on). */
		border_correct: boolean;
		border_missed: boolean;
		/** The player's status bar along the bottom is hidden; the sync status goes quiet with it. */
		status_bar_hidden: boolean;
		/** The sync status at the player's bottom right is quiet: only what needs attention shows. */
		sync_status_hidden: boolean;
		/** A word's definition sits in a column of its own after the back hooks (the default), not centred under the word. */
		definition_column: boolean;
		/** A word's probability order shows in a column of its own before the front hooks. */
		show_probability: boolean;
		/** On a phone, the three actions' tap zones: three columns (the default) or three rows. */
		mobile_buttons: 'columns' | 'rows';
		/** In the rows layout, each row's height, in px. */
		mobile_row_px: number;
		/** Which defaults the stored values were saved under (lib/player/display DISPLAY_VERSION). */
		version: number;
	};
}
export type MetaKey = keyof MetaValues;

export const META_DEFAULTS: { [K in MetaKey]: () => MetaValues[K] } = {
	identity: () => ({ user_id: '', username: '' }),
	device: () => ({ device_id: crypto.randomUUID(), next_device_seq: 1 }),
	sync: () => ({ cursor: null, last_sync_at: null }),
	server: () => ({ trash_retention_days: 30, max_quiz_questions: 300_000 }),
	opens: () => ({}),
	budget_dropped: () => [],
	shared_device: () => ({ applied: {}, pending: {} }),
	sizes: () => ({}),
	bindings: () => DEFAULT_BINDINGS.map((b) => ({ ...b })),
	display: () => ({
		question_font: 'Inter',
		answer_font: 'Inter',
		question_size_px: 36,
		answer_size_px: 36,
		definition_font: 'Inter',
		definition_size_px: 20,
		definition_spacing: 0,
		question_spacing: 0,
		answer_spacing: 0,
		question_top_px: 8,
		border_px: 10,
		repeat_guard_ms: 0,
		border_correct: false,
		border_missed: true,
		status_bar_hidden: false,
		sync_status_hidden: false,
		definition_column: true,
		show_probability: false,
		mobile_buttons: 'columns',
		mobile_row_px: 64,
		version: 2
	})
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
