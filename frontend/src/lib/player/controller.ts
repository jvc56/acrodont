// The player's state machine (PLAN.md § Taking a quiz, § Finishing a quiz,
// § Segments, § On the device). It reads the local view and writes only
// through `applyLocally`. Moving between cards never waits for IndexedDB: the
// next card comes from an in-memory cache read ahead of it, and the grade and
// cursor writes go to a queue that saves them in order behind the screen
// (§ Taking a quiz → Instant at any size). Show / Next saves the grade and moves the cursor,
// or, at the last card of a run or of the attempt, emits only
// `finish_segment` or `finish`; Previous moves back, never below
// `run_start`. A card whose key never arrived reads "this question needs a
// connection" and is moved past with nothing emitted; a card whose answer is
// gone still grades, and a typed card falls back to flashcard mode.
import { applyLocally, APPLY_STORES, quizState, type LocalResult, type NewOp } from '$lib/local/apply';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow, PreferencesRow, QuestionRow, QuizRow, WordHooks } from '$lib/local/rows';
import * as view from '$lib/local/view';
import type { RwTx } from '$lib/local/view';
import { nextBoundary, Rejected, runIndicator, type Grade } from '$lib/cascade/rules';
import { Distribution } from '$lib/tiles';
import { finishBanner, runBanner } from './banner';
import { allFound, emptyTyped, submitTyped, typedGrade, type Submit, type TypedState } from './typed';

export interface Card {
	pos: number;
	idx: number;
	/** The question key, or null: "this question needs a connection". */
	key: string | null;
	/** The answer, or null: "answer needs a connection". */
	answer: unknown | null;
	/** A Definition card's word with its hooks, shown above the definition; null otherwise or until it arrives. */
	word: WordHooks | null;
	revealed: boolean;
	grade: Grade;
	/** Marked missed in advance, before the reveal. */
	toggled: boolean;
	saved: Grade | null;
	/** Typed mode on this card; null in flashcard mode or when falling back. */
	typed: TypedState | null;
	/** The last typed entry's note: already entered, one word at a time, out of order. */
	note: string | null;
}

export type Status = 'loading' | 'downloading' | 'needs_connection' | 'ready' | 'trashed' | 'gone';

export interface PlayerView {
	status: Status;
	cascade: CascadeRow | null;
	quizzes: QuizRow[];
	quiz: QuizRow | null;
	card: Card | null;
	banner: string | null;
	/** A line in place of an action that could not act. */
	message: string | null;
	/** The storage message: the action waits for space (§ the quota path). */
	storage: boolean;
	completion: { levels: number; attempts: number } | null;
	/** Typed mode on a cascade whose distribution is missing. */
	distributionMissing: boolean;
	/** The card to show is being fetched: the player shows that, not the card before. */
	fetchingCard: boolean;
}

export interface PlayerOptions {
	prefs: () => Promise<PreferencesRow>;
	/** Runs the full fetch sequence for the cascade (first open). */
	ensure: (cascadeId: string) => Promise<void>;
	afterWrite?: () => void;
	/** Fetches the card `idx`, with the cards `ahead` the device lacks, ahead of any download (online only). */
	fetchCard?: (cascadeId: string, idx: number, ahead: number[]) => Promise<void>;
	/** Fetches the named cards the device lacks, in the background (online only). */
	fetchAhead?: (cascadeId: string, idx: number[]) => Promise<void>;
	seed?: () => string;
	uuid?: () => string;
}

const STORAGE = 'Not enough room on this device to save this answer.';

/**
 * The read-ahead: the next AHEAD cards in the quiz's order are fetched in one
 * request whenever fewer than AHEAD_LOW of them have been asked for, so while
 * a new cascade's pages are still downloading the card shown next is already
 * here. A person cannot get through a hundred cards in the time one request takes.
 */
export const AHEAD = 200;
export const AHEAD_LOW = 100;
/** Cards held in memory ahead of the current one, read from IndexedDB in the background. */
export const CACHE_AHEAD = 50;

function randomSeed(): string {
	const a = new BigUint64Array(1);
	crypto.getRandomValues(a);
	return a[0].toString();
}

const isQuota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError';

export class Player {
	v: PlayerView = {
		status: 'loading',
		cascade: null,
		quizzes: [],
		quiz: null,
		card: null,
		banner: null,
		message: null,
		storage: false,
		completion: null,
		distributionMissing: false,
		fetchingCard: false
	};
	/** Keys and answers of the cards around the current one, by idx: Next and Previous draw from here. */
	private cache = new Map<number, { key: string; answer: unknown; word: WordHooks | null }>();
	private filling = false;
	/** The user's preferences as last read; typed mode depends on them. */
	private prefsNow: PreferencesRow | null = null;
	/** The writes behind the screen, applied one at a time in order. */
	private queue: Promise<void> = Promise.resolve();
	/** Set by a failed write: later queued writes are held, not applied. */
	private halted = false;
	/** A write that failed for want of space, and those queued after it, for retryStorage. */
	private waiting: NewOp[] = [];
	/** Counts failed writes, so a transition that waited on the queue knows one happened. */
	private failures = 0;
	/** Actions run one at a time up to the point their card is shown, never to the end of their writes. */
	private fg: Promise<void> = Promise.resolve();
	/** The last position a read-ahead has covered; -1 for none (a new order). */
	private aheadTo = -1;
	private aheadRun: Promise<void> | null = null;
	private order: number[] = [];
	private rows = new Map<number, QuestionRow>();
	private dist: Distribution | null = null;
	private retry: (() => Promise<void>) | null = null;
	private listeners = new Set<(v: PlayerView) => void>();
	private readonly seed: () => string;
	private readonly uuid: () => string;

	constructor(
		private readonly db: UserDb,
		readonly cascadeId: string,
		private readonly opts: PlayerOptions
	) {
		this.seed = opts.seed ?? randomSeed;
		this.uuid = opts.uuid ?? (() => crypto.randomUUID());
	}

	subscribe(fn: (v: PlayerView) => void): () => void {
		this.listeners.add(fn);
		fn(this.v);
		return () => this.listeners.delete(fn);
	}

	private emit() {
		this.v = { ...this.v };
		for (const fn of this.listeners) fn(this.v);
	}

	private tx() {
		return this.db.transaction(APPLY_STORES) as unknown as RwTx;
	}

	// -------------------------------------------------------------------------
	// Loading
	// -------------------------------------------------------------------------

	/**
	 * Reads the deepest level and the card at its cursor; `keep` keeps an
	 * in-progress card. It takes its turn with the actions and waits for their
	 * queued writes, so what it reads is what the screen already shows: a
	 * reload (after every sync) read between an action and its writes would see
	 * an older score, take the slow path, and lose the action's grade from memory.
	 */
	load(keep = false): Promise<void> {
		return this.serial(() => this.reload(keep));
	}

	/** `load` from inside an action, which already holds the turn. */
	private async reload(keep = false): Promise<void> {
		await this.flush();
		await this.loadNow(keep);
	}

	/** A preference changed what an answer holds (definitions, hooks): the cards in memory go. */
	prefsChanged() {
		this.cache.clear();
	}

	/** Resolves once every queued write has been applied (or held after a failure). */
	async flush(): Promise<void> {
		let q: Promise<void>;
		do {
			q = this.queue;
			await q;
		} while (q !== this.queue);
	}

	private async loadNow(keep: boolean): Promise<void> {
		this.prefsNow = await this.opts.prefs();
		const tx = this.tx();
		const cascade = (await view.cascade(tx, this.cascadeId)) ?? null;
		if (!cascade) {
			this.v = { ...this.v, status: 'gone', cascade: null };
			return this.emit();
		}
		const quizzes = await view.quizzesOf(tx, this.cascadeId);
		this.v.cascade = cascade;
		this.v.quizzes = quizzes;
		if (cascade.trashed_at !== null) {
			this.v.status = 'trashed';
			return this.emit();
		}
		const quiz = quizzes.find((q) => q.status === 'active' && q.level === cascade.depth) ?? null;
		if (!quiz) {
			this.v.status = 'gone';
			return this.emit();
		}
		// The light path, for a sync that settled this device's own operations:
		// the same attempt, its rows already in memory and the same score, so no
		// grade changed elsewhere. Reading every question row again would cost a
		// large quiz a noticeable pause on each sync.
		const was = this.v.quiz;
		if (
			keep &&
			was &&
			this.v.status === 'ready' &&
			sameAttempt(was, quiz) &&
			!quiz.pending &&
			this.rows.size === quiz.question_count &&
			quiz.correct_count === was.correct_count &&
			quiz.missed_count === was.missed_count
		) {
			this.v.quiz = quiz;
			await this.ensureDistribution(cascade);
			const pos = this.v.card ? Math.max(this.v.card.pos, quiz.cursor) : quiz.cursor;
			if (this.v.card && this.v.card.pos === pos) return this.emit();
			return this.loadCard(pos);
		}
		let rows = await view.questionsOf(tx, quiz.id);
		if (quiz.pending || rows.length !== quiz.question_count || rows.some((r) => r.position === null)) {
			this.v.status = 'downloading';
			this.v.quiz = quiz;
			this.emit();
			try {
				await this.opts.ensure(this.cascadeId);
			} catch {
				this.v.status = 'needs_connection';
				return this.emit();
			}
			const again = this.tx();
			const q2 = await view.quiz(again, quiz.id);
			rows = await view.questionsOf(again, quiz.id);
			if (!q2 || q2.pending || rows.length !== q2.question_count || rows.some((r) => r.position === null)) {
				this.v.status = 'needs_connection';
				return this.emit();
			}
		}
		const prev = this.v.quiz;
		const same = keep && prev && sameAttempt(prev, quiz);
		this.v.quiz = quiz;
		this.rows = new Map(rows.map((r) => [r.question_idx, r]));
		const order = [...rows].sort((a, b) => a.position! - b.position!).map((r) => r.question_idx);
		if (!same) this.aheadTo = -1;
		this.order = order;
		this.dist = null;
		await this.ensureDistribution(cascade);
		this.v.status = 'ready';
		const pos = same && this.v.card ? Math.max(this.v.card.pos, quiz.cursor) : quiz.cursor;
		if (same && this.v.card && this.v.card.pos === pos) {
			this.v.card = { ...this.v.card, saved: this.rows.get(this.v.card.idx)?.grade ?? null };
			return this.emit();
		}
		await this.loadCard(pos);
	}

	/** The tiles typed mode splits words with; fetched by the download manager, so possibly after the first load. */
	private async ensureDistribution(cascade: CascadeRow) {
		if (this.dist?.name === cascade.letter_distribution) return;
		const d = await this.db.get('distributions', cascade.letter_distribution);
		this.dist = d ? new Distribution(d.name, d.tiles) : null;
	}

	private async loadCard(pos: number) {
		const idx = this.order[pos];
		let key = (await this.db.get('questions', [this.cascadeId, idx]))?.key ?? null;
		let card = await this.db.get('cards', [this.cascadeId, idx]);
		if ((key === null || !card) && this.opts.fetchCard) {
			// While online, the player fetches what it needs on demand, with the
			// cards after it; meanwhile it shows that it is fetching, not the last card.
			this.v.fetchingCard = true;
			this.emit();
			try {
				const end = Math.min(this.order.length, pos + 1 + AHEAD);
				await this.opts.fetchCard(this.cascadeId, idx, this.order.slice(pos + 1, end));
				this.aheadTo = Math.max(this.aheadTo, end - 1);
				key = (await this.db.get('questions', [this.cascadeId, idx]))?.key ?? null;
				card = await this.db.get('cards', [this.cascadeId, idx]);
			} catch {
				// Offline: the card shows what the device holds.
			} finally {
				this.v.fetchingCard = false;
			}
		}
		this.prefsNow = await this.opts.prefs();
		if (key !== null && card) this.cache.set(idx, { key, answer: card.answer, word: card.word ?? null });
		this.present(pos, idx, key, card ? card.answer : null, card?.word ?? null);
	}

	/** Shows the card at `pos` from what is in hand: no IndexedDB, so it costs one redraw. */
	private present(pos: number, idx: number, key: string | null, answer: unknown | null, word: WordHooks | null) {
		const saved = this.rows.get(idx)?.grade ?? null;
		const prefs = this.prefsNow;
		const typedWanted = this.v.cascade!.quiz_type === 'anagram' && prefs?.anagram_answer_mode === 'typed';
		this.v.distributionMissing = typedWanted && !this.dist;
		// A card with no answer, or no distribution to split typed text, falls back to flashcard mode.
		const typed = typedWanted && answer !== null && this.dist && key && saved === null ? emptyTyped() : null;
		this.v.card = {
			pos,
			idx,
			key,
			answer,
			word,
			revealed: saved !== null,
			grade: saved ?? 'correct',
			toggled: false,
			saved,
			typed,
			note: null
		};
		this.v.message = null;
		this.emit();
		this.readAhead(pos);
		this.fillCache(pos);
	}

	/** The card at `pos`: from the cache at once, else read (and fetched if need be). */
	private async showCard(pos: number) {
		const idx = this.order[pos];
		const hit = this.prefsNow ? this.cache.get(idx) : undefined;
		if (hit) this.present(pos, idx, hit.key, hit.answer, hit.word);
		else await this.loadCard(pos);
	}

	/**
	 * Reads the cards from one behind to CACHE_AHEAD ahead that the cache lacks,
	 * in one read-only transaction, in the background. Only cards with both a
	 * key and an answer are cached; the others are read when shown.
	 */
	private fillCache(pos: number) {
		if (this.filling) return;
		const want: number[] = [];
		for (let p = Math.max(0, pos - 1); p <= pos + CACHE_AHEAD && p < this.order.length; p++) {
			const idx = this.order[p];
			if (!this.cache.has(idx)) want.push(idx);
		}
		if (want.length === 0) return;
		this.filling = true;
		void (async () => {
			try {
				const tx = this.db.transaction(['questions', 'cards']);
				const qs = tx.objectStore('questions');
				const cs = tx.objectStore('cards');
				const [keys, cards] = await Promise.all([
					Promise.all(want.map((i) => qs.get([this.cascadeId, i]))),
					Promise.all(want.map((i) => cs.get([this.cascadeId, i])))
				]);
				want.forEach((i, k) => {
					const key = keys[k]?.key;
					const card = cards[k];
					if (key !== undefined && card) this.cache.set(i, { key, answer: card.answer, word: card.word ?? null });
				});
				if (this.cache.size > CACHE_AHEAD * 8) this.pruneCache();
			} catch {
				// A read that failed leaves those cards to be read when shown.
			} finally {
				this.filling = false;
			}
		})();
	}

	private pruneCache() {
		const pos = this.v.card?.pos ?? 0;
		const keep = new Set(this.order.slice(Math.max(0, pos - 1), pos + CACHE_AHEAD + 1));
		for (const idx of this.cache.keys()) if (!keep.has(idx)) this.cache.delete(idx);
	}

	/** Asks for the next AHEAD cards once fewer than AHEAD_LOW are covered; one request at a time. */
	private readAhead(pos: number) {
		if (!this.opts.fetchAhead || this.aheadRun || this.aheadTo >= pos + AHEAD_LOW) return;
		const from = Math.max(pos + 1, this.aheadTo + 1);
		const to = Math.min(this.order.length, pos + 1 + AHEAD);
		if (from >= to) return;
		const order = this.order;
		this.aheadRun = this.opts
			.fetchAhead(this.cascadeId, order.slice(from, to))
			.then(() => {
				// A new order meanwhile (a finish, a rebase) starts its own read-ahead.
				if (this.order === order) this.aheadTo = Math.max(this.aheadTo, to - 1);
			})
			.catch(() => undefined)
			.finally(() => (this.aheadRun = null));
	}

	// -------------------------------------------------------------------------
	// Writes
	// -------------------------------------------------------------------------

	/**
	 * Queues a write to be applied behind the screen, after those before it.
	 * A failure halts the queue: a full device holds the write and those after
	 * it for retryStorage, a rejection drops them, and either way the player
	 * reloads what the device actually holds.
	 */
	private enqueue(op: NewOp) {
		this.queue = this.queue.then(async () => {
			if (this.halted) {
				this.waiting.push(op);
				return;
			}
			try {
				await applyLocally(this.db, op);
				this.v.storage = false;
				this.opts.afterWrite?.();
			} catch (e) {
				this.halted = true;
				this.failures++;
				if (isQuota(e)) this.waiting = [op];
				// Run after the ops queued behind this one have been held.
				this.queue = this.queue.then(() => this.recover(e));
			}
		});
	}

	private async recover(e: unknown) {
		const shown = this.v.card;
		this.halted = false;
		this.cache.clear();
		if (isQuota(e)) {
			// Nothing of these writes reached the device: back to the card they came from.
			const held = this.waiting;
			await this.loadNow(false);
			const g = held[0];
			if (g?.type === 'grade' && this.v.card && this.v.card.idx === g.question_idx) {
				this.v.card = { ...this.v.card, revealed: true, grade: g.grade as Grade };
			}
			this.v.storage = true;
			this.v.message = STORAGE;
			this.emit();
			return;
		}
		this.waiting = [];
		await this.loadNow(false);
		if (!(e instanceof Rejected)) {
			console.error('the player could not save', e);
			this.v.message = 'That answer could not be saved on this device.';
			if (shown) this.emit();
		}
	}

	/** Runs an action up to the point its card is shown; the next waits only for that. */
	private serial(fn: () => Promise<void>): Promise<void> {
		const run = this.fg.then(fn);
		this.fg = run.catch(() => undefined);
		return run;
	}

	private async write(op: NewOp): Promise<LocalResult | null> {
		try {
			const { result } = await applyLocally(this.db, op);
			this.v.storage = false;
			this.opts.afterWrite?.();
			return result;
		} catch (e) {
			if (isQuota(e)) {
				// The action reached neither the overlay nor the outbox: stay on this card.
				this.v.storage = true;
				this.v.message = STORAGE;
				this.emit();
				return null;
			}
			if (e instanceof Rejected) {
				await this.reload();
				return null;
			}
			throw e;
		}
	}

	/** "Keep studying": the completion screen closes and stays closed. */
	dismissCompletion() {
		this.v.completion = null;
		this.emit();
	}

	/** After the user frees space: writes what waited, then carries on from where it left. */
	async retryStorage() {
		const held = this.waiting;
		this.waiting = [];
		if (held.length) {
			this.v.storage = false;
			this.v.message = null;
			const before = this.failures;
			for (const op of held) this.enqueue(op);
			await this.flush();
			if (this.failures === before) await this.load(true);
			return;
		}
		const r = this.retry;
		this.retry = null;
		if (r) await r();
	}

	// -------------------------------------------------------------------------
	// The three actions
	// -------------------------------------------------------------------------

	private runEnd(q: QuizRow): number {
		return nextBoundary(quizState(q)) ?? q.question_count;
	}

	/** Show / Next. Resolves once its writes are saved; the screen changes before that. */
	async showNext(): Promise<void> {
		await this.serial(() => this.showNextNow());
		await this.flush();
	}

	private async showNextNow(): Promise<void> {
		const card = this.v.card;
		const q = this.v.quiz;
		if (!card || !q || this.v.status !== 'ready' || this.v.storage) return;
		this.v.banner = null;
		if (card.key === null) {
			// Moved past with nothing emitted; the end of a run waits for its keys.
			if (card.pos + 1 < this.runEnd(q)) await this.showCard(card.pos + 1);
			else this.needsConnection(q);
			return;
		}
		if (!card.revealed) {
			this.v.card = {
				...card,
				revealed: true,
				grade: card.typed && card.answer ? typedGrade(card.typed, this.words(card)) : card.toggled ? 'missed' : 'correct'
			};
			return this.emit();
		}
		const act = async () => this.saveAndAdvance(card, q);
		this.retry = act;
		await act();
	}

	private needsConnection(q: QuizRow) {
		const start = q.run_start;
		const end = this.runEnd(q);
		let missing = 0;
		for (let p = start; p < end; p++) if (!this.rows.get(this.order[p])?.grade) missing++;
		this.v.message = `Some questions in this run still need a connection (${Math.max(missing, 1)}).`;
		this.emit();
	}

	private async saveAndAdvance(card: Card, q: QuizRow) {
		this.retry = null;
		let quiz = q;
		if (card.saved !== card.grade) {
			this.enqueue({
				type: 'grade',
				quiz_id: q.id,
				attempt: q.attempt,
				attempt_seed: q.shuffle_seed,
				question_idx: card.idx,
				grade: card.grade
			});
			// The score as the write will leave it, so the screen need not wait for it.
			const d = (g: Grade | null, v: Grade) => (g === v ? 1 : 0);
			quiz = {
				...quiz,
				correct_count: quiz.correct_count - d(card.saved, 'correct') + d(card.grade, 'correct'),
				missed_count: quiz.missed_count - d(card.saved, 'missed') + d(card.grade, 'missed')
			};
			this.rows.set(card.idx, { ...this.rows.get(card.idx)!, grade: card.grade });
		}
		const end = this.runEnd(q);
		const next = card.pos + 1;
		if (next < end) {
			this.enqueue({ type: 'move_cursor', quiz_id: q.id, attempt: q.attempt, attempt_seed: q.shuffle_seed, position: next });
			this.setQuiz({ ...quiz, cursor: next });
			await this.showCard(next);
			return;
		}
		// The last card of a run or of the attempt: its writes first, then every
		// question in it must be graded.
		const before = this.failures;
		await this.flush();
		if (this.failures !== before) return;
		const start = end === q.question_count ? 0 : q.run_start;
		for (let p = start; p < end; p++) {
			if (!this.rows.get(this.order[p])?.grade) return this.needsConnection(q);
		}
		const current = (await view.quiz(this.tx(), q.id))!;
		const facts = {
			level: q.level,
			correct: current.correct_count,
			count: q.question_count,
			misses: current.missed_count,
			threshold: this.v.cascade!.clear_threshold,
			progression: q.progression,
			segmentChain: q.segment_chain
		};
		if (end === q.question_count) {
			const r = await this.write({
				type: 'finish',
				quiz_id: q.id,
				attempt: q.attempt,
				attempt_seed: q.shuffle_seed,
				shuffle_seed: this.seed(),
				new_quiz_id: this.uuid()
			});
			if (!r) return;
			await this.reload();
			let back: { level: number; run: number; runs: number } | undefined;
			if (q.segment_chain && this.v.quiz) {
				const ri = runIndicator(quizState(this.v.quiz));
				if (ri) back = { level: this.v.quiz.level, run: ri.run, runs: ri.total };
			}
			this.v.banner = finishBanner({ ...facts, outcome: r.outcome!, completion: r.completion, back });
			if (r.completion) this.v.completion = r.completion;
			return this.emit();
		}
		const ri = runIndicator(quizState(q))!;
		let runMisses = 0;
		for (let p = q.run_start; p < end; p++) if (this.rows.get(this.order[p])?.grade === 'missed') runMisses++;
		const r = await this.write({
			type: 'finish_segment',
			quiz_id: q.id,
			attempt: q.attempt,
			attempt_seed: q.shuffle_seed,
			segment_end: end,
			shuffle_seed: this.seed(),
			new_quiz_id: this.uuid()
		});
		if (!r) return;
		await this.reload();
		this.v.banner = runBanner({ outcome: r.outcome!, run: ri.run, runs: ri.total, misses: runMisses, level: q.level });
		this.emit();
	}

	toggle(): Promise<void> {
		return this.serial(async () => {
			const card = this.v.card;
			// Before the answer is shown there is no grade to toggle: nothing happens.
			if (!card || card.key === null || this.v.status !== 'ready' || !card.revealed) return;
			this.v.card = { ...card, grade: card.grade === 'correct' ? 'missed' : 'correct' };
			this.emit();
		});
	}

	/** The quiz row as this device's queued writes will leave it. */
	private setQuiz(quiz: QuizRow) {
		this.v.quiz = quiz;
		this.v.quizzes = this.v.quizzes.map((q) => (q.id === quiz.id ? quiz : q));
	}

	/** Previous. Resolves once its write is saved; the screen changes before that. */
	async previous(): Promise<void> {
		await this.serial(() => this.previousNow());
		await this.flush();
	}

	private async previousNow(): Promise<void> {
		const card = this.v.card;
		const q = this.v.quiz;
		if (!card || !q || this.v.status !== 'ready' || this.v.storage) return;
		const target = card.pos - 1;
		if (target < q.run_start) {
			// A blocked Previous always has a visible cause.
			if (card.pos > 0 && !runIndicator(quizState(q))) this.v.message = 'You have already finished this part of the pass.';
			return this.emit();
		}
		// Going back discards this card's unsaved reveal and toggle.
		if (q.cursor !== target) {
			this.enqueue({ type: 'move_cursor', quiz_id: q.id, attempt: q.attempt, attempt_seed: q.shuffle_seed, position: target });
			this.setQuiz({ ...q, cursor: target });
		}
		await this.showCard(target);
	}

	// -------------------------------------------------------------------------
	// Typed mode
	// -------------------------------------------------------------------------

	words(card: Card): string[] {
		return Array.isArray(card.answer) ? (card.answer as { word: string }[]).map((a) => a.word) : [];
	}

	/** Enter in the typed input; returns what happened for the input to show. */
	async enter(text: string): Promise<Submit | null> {
		const card = this.v.card;
		if (!card?.typed || card.revealed || !this.dist || !card.key) return null;
		const words = this.words(card);
		const { state, result } = submitTyped(
			card.typed,
			text,
			words,
			this.dist.parseMagpie(card.key, true).length,
			this.dist,
			this.v.quiz!.require_alphabetical
		);
		if (result.kind === 'empty') {
			await this.showNext();
			return result;
		}
		const notes: Record<string, string> = {
			already: 'Already entered',
			one_word: 'Type one word at a time',
			out_of_order: 'Out of order'
		};
		this.v.card = { ...card, typed: state, note: notes[result.kind] ?? null };
		if (allFound(state, words)) {
			this.v.card = { ...this.v.card, revealed: true, grade: typedGrade(state, words) };
		}
		this.emit();
		return result;
	}

	/**
	 * A download landed: the current card takes the key or answer it lacked, or
	 * the answer refetched with the definitions or hooks a preference now asks
	 * for, keeping its state.
	 */
	async refreshCard() {
		const card = this.v.card;
		if (!card) return;
		const key = (await this.db.get('questions', [this.cascadeId, card.idx]))?.key ?? null;
		const row = await this.db.get('cards', [this.cascadeId, card.idx]);
		const answer = row?.answer ?? null;
		const word = row?.word ?? null;
		if (card.key === null && key !== null) return this.serial(() => this.loadCard(card.pos));
		if (JSON.stringify(answer) === JSON.stringify(card.answer) && JSON.stringify(word) === JSON.stringify(card.word)) return;
		// Answers were refetched with new extras: the cards in memory are older.
		this.cache.clear();
		this.v.card = { ...card, answer, word };
		this.emit();
	}

	/** Switching answer modes in the middle of a card resets its typed entries. */
	async modeChanged() {
		this.cache.clear();
		if (this.v.card) await this.serial(() => this.loadCard(this.v.card!.pos));
	}
}

/** The same quiz, attempt and shuffle: question positions are unchanged. */
function sameAttempt(a: QuizRow, b: QuizRow): boolean {
	return a.id === b.id && a.attempt === b.attempt && a.shuffle_seed === b.shuffle_seed;
}
