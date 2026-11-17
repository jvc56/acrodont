// The wire form of POST /api/sync (PLAN.md § API → Cascades and sync).
import type { Grade } from '$lib/cascade/rules';

export interface SyncResult {
	op_id: string;
	status: 'applied' | 'rejected';
	reason?: string;
	outcome?: string;
	new_quiz_question_count?: number;
	new_quiz_questions_hash?: string;
}

/** A quiz's graded rows in one page, with the lowest `updated_seq` among them. */
export interface QuestionGroup {
	quiz_id: string;
	question_idx: number[];
	grade: Grade[];
	graded_at: string[];
	min_updated_seq: string;
}

export interface Tombstone {
	entity: 'cascade' | 'quiz';
	entity_id: string;
	seq: string;
}

export type WireRow = Record<string, unknown>;

export interface Changes {
	cascades: WireRow[];
	quizzes: WireRow[];
	quiz_attempts: WireRow[];
	quiz_questions: QuestionGroup[];
	tombstones: Tombstone[];
}

export interface SyncResponse {
	results: SyncResult[];
	changes?: Changes;
	sync_seq: string;
	next_page_token?: string;
	resync_required?: boolean;
	/** The account's storage and its limit, in bytes, on every response (PLAN.md § Storage limit). */
	storage?: { used: number; limit: number };
	/** The account's changes for all cascades on all devices, on every response (lib/settings/everywhere). */
	settings?: Record<string, { value: unknown; at: string }>;
	/** The account's presets' version, on every response (lib/settings/presets). */
	presets_version?: string;
	/** The account's presets, when the request's `presets_version` was not the account's. */
	presets?: unknown[];
	/** The server's time, by which settings changes are stamped (lib/settings/clock). */
	server_time?: string;
}

export interface SyncRequest {
	device_id: string;
	app_version: number;
	cursor: number | null;
	page_token?: string;
	question_rows_for: string[];
	ops?: unknown[];
	/** Changes for all cascades on all devices made here and not yet sent (lib/settings/everywhere). */
	settings?: Record<string, { value: unknown; at: string }>;
	/** The presets' version this device holds; null or absent, and the response carries the list. */
	presets_version?: string | null;
}

/** One HTTP exchange: the status, the parsed body and any Retry-After. */
export interface Reply {
	status: number;
	body: unknown;
	retryAfter: number | null;
}

export type Transport = (req: SyncRequest) => Promise<Reply>;

/** Pushes are sent in batches of up to this many operations. */
export const BATCH_OPS = 500;
