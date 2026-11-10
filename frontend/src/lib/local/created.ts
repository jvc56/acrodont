// A cascade this device created (PLAN.md § Downloads: "A cascade starts
// downloading the moment it is created"). The creation response's rows go
// into the base stamped with its `sync_seq`, so a full pull in flight never
// deletes them, with the Source quiz's rows made here (idx 0 … count − 1,
// positions from its seed), and the creation counts as an open.
import { shuffle } from '$lib/cascade/order';
import type { UserDb } from './db';
import { recordOpen } from './meta';
import { cascadeFromWire, quizFromWire } from './rows';
import type { RwTx } from './view';

export interface Created {
	cascade: Record<string, unknown>;
	source_quiz: Record<string, unknown>;
	sync_seq: string;
}

/**
 * Question rows written per transaction while a new cascade is stored: few
 * enough commits that storing stays quick (each costs more than its rows), and
 * enough steps for the progress bar (13 for a 130,000-question cascade).
 */
export const CREATE_CHUNK = 10_000;

/**
 * Stores a created cascade. The Source quiz's rows are written in chunks, in
 * position order, so the row at the last position — which witnesses that a
 * quiz's whole set is here (lib/sync/downloads `complete`) — lands in the last
 * one: until then the quiz reads as incomplete, as it is, and anything that
 * finds it so (a download pass after a closed tab) rebuilds the same rows.
 * One transaction for 100,000 rows held the device's stores for many seconds
 * with no way to show progress. `onProgress` gets the fraction written.
 */
export async function storeCreated(
	db: UserDb,
	created: Created,
	now = new Date(),
	onProgress?: (done: number) => void,
	chunk = CREATE_CHUNK
) {
	const seq = Number(created.sync_seq);
	const c = cascadeFromWire(created.cascade, seq);
	const q = quizFromWire(created.source_quiz, seq);
	const first = db.transaction(['cascades', 'quizzes', 'meta'], 'readwrite');
	await first.objectStore('cascades').put(c);
	await first.objectStore('quizzes').put(q);
	await recordOpen(first as unknown as RwTx, c.id, now.toISOString());
	await first.done;
	const n = q.question_count;
	const order = shuffle(
		Array.from({ length: n }, (_, i) => i),
		BigInt(q.shuffle_seed)
	);
	onProgress?.(0);
	for (let from = 0; from < n; from += chunk) {
		const tx = db.transaction(['quiz_questions'], 'readwrite');
		const store = tx.objectStore('quiz_questions');
		const end = Math.min(n, from + chunk);
		const writes: Promise<unknown>[] = [];
		for (let p = from; p < end; p++) {
			writes.push(store.put({ quiz_id: q.id, question_idx: order[p], cascade_id: c.id, position: p, grade: null, graded_at: null, seq }));
		}
		await Promise.all(writes);
		await tx.done;
		onProgress?.(end / n);
	}
}
