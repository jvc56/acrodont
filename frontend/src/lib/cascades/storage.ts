// The account's storage (PLAN.md § Storage limit): what each cascade holds on
// the server, and the one limit an account has. A module of its own, with no
// imports, so the session can read it without pulling in the local stores.
//
// The server keeps each cascade's figure (`cascades.storage_bytes`) and the
// account's total; the device shows them and never counts them itself, except
// for one level's share, from the same per-row costs the server uses
// (contract-fixtures/storage.json, which a test keeps this copy equal to).

export const STORAGE_COSTS = {
	cascade_row: 380,
	question_row: 94,
	quiz_row: 420,
	quiz_question_row: 188,
	attempt_row: 176,
	spec_row: 380,
	spec_word_row: 100
};

/** MAX_STORAGE_BYTES_PER_USER's default, used until the server has reported the account's own. */
export const DEFAULT_STORAGE_LIMIT = 100_000_000;

/** From this share of the limit, the page says the account is almost full. */
export const ALMOST_FULL = 0.9;

/** What one level of `questionCount` questions holds: its quiz row and one row per question. */
export function levelBytes(questionCount: number): number {
	return STORAGE_COSTS.quiz_row + questionCount * STORAGE_COSTS.quiz_question_row;
}

export type StorageState = 'ok' | 'almost' | 'over';

export function storageState(used: number, limit: number): StorageState {
	if (used > limit) return 'over';
	return used >= limit * ALMOST_FULL ? 'almost' : 'ok';
}

/** Bytes in decimal units, as the limit is stated: "4.2 MB", "860 KB", "1.2 GB". */
export function formatBytes(b: number): string {
	if (b < 1000) return `${Math.max(0, Math.round(b))} B`;
	const [unit, d] = b < 1e6 ? ['KB', 1e3] : b < 1e9 ? ['MB', 1e6] : ['GB', 1e9];
	const v = b / d;
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
}
