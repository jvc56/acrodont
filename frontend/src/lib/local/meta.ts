// The `meta` store (PLAN.md § On the device → IndexedDB stores): identity,
// this device's id and next `device_seq`, the sync cursor, what
// `/api/auth/me` last reported, last-open times, and the Keep offline,
// automatic-keep opt-out and budget-dropped ids. All per device and user.
import type { IDBPTransaction } from 'idb';
import type { StoreName, UserDb, UserSchema } from './db';

export interface MetaValues {
	identity: { user_id: string; username: string };
	/** `device_id` is made once per device and user; `device_seq` counts from 1. */
	device: { device_id: string; next_device_seq: number };
	/** `upgrade_required`: a 426 was the last answer; cleared by a sync that succeeds. */
	sync: { cursor: number | null; last_sync_at: string | null; upgrade_required?: boolean };
	server: { trash_retention_days: number; max_quiz_questions: number; max_cascades_per_user?: number };
	/** When this device last opened each cascade (ISO time). */
	opens: Record<string, string>;
	keep_offline: string[];
	auto_keep_optout: string[];
	budget_dropped: string[];
	/** Bytes of each cascade's question keys and answers, measured as they were written. */
	sizes: Record<string, { key_bytes: number; answer_bytes: number }>;
	/** How the player looks and responds on this device (lib/player/display.svelte.ts); never synced. */
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
		/** The desktop player's status bar along the bottom is hidden. */
		status_bar_hidden: boolean;
		/** Typed mode's "3 of 9 found" count shows in the status bar (off by default: it hints). */
		show_found_count: boolean;
		/** Which defaults the stored values were saved under (lib/player/display DISPLAY_VERSION). */
		version: number;
	};
}
export type MetaKey = keyof MetaValues;

export const META_DEFAULTS: { [K in MetaKey]: () => MetaValues[K] } = {
	identity: () => ({ user_id: '', username: '' }),
	device: () => ({ device_id: crypto.randomUUID(), next_device_seq: 1 }),
	sync: () => ({ cursor: null, last_sync_at: null }),
	server: () => ({ trash_retention_days: 30, max_quiz_questions: 130_000, max_cascades_per_user: 20 }),
	opens: () => ({}),
	keep_offline: () => [],
	auto_keep_optout: () => [],
	budget_dropped: () => [],
	sizes: () => ({}),
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
		show_found_count: false,
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
