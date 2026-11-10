// The download manager (PLAN.md § On the device → Downloads, the budget,
// eviction and the quota path; § Frontend → lib/sync). After every pull it
// fetches, for the cascades in the window or kept offline: missing
// distributions, missing index lists (deepest level first), the graded rows
// of every pending quiz, then every cascade's question keys, then answers.
// It drops what has left the window, holds rows and keys under
// ROW_STORAGE_BUDGET in two tiers, evicts answers above the soft limit, and
// yields to a page the player needs. A 429 pauses until Retry-After and the
// same page is fetched again.
import { deleteCascadeKeyed, deleteQuizKeyed } from '$lib/local/ranges';
import { ApiError, api } from '$lib/api';
import { questionsHash } from '$lib/cascade/order';
import type { UserDb } from '$lib/local/db';
import { getMeta, readMeta, writeMeta } from '$lib/local/meta';
import type { CardRow, CascadeRow, QuestionRow, QuizRow, WordHooks } from '$lib/local/rows';
import { preferencesView } from '$lib/local/preferences';
import type { RwTx } from '$lib/local/view';
import { ANSWER_STORAGE_SOFT_LIMIT_BYTES, ROW_STORAGE_BUDGET } from './config';
import { policy, type Policy } from './policy';
import { withPositions } from './rebase';

/** Page sizes: the endpoints' own limits. */
export const INDEX_PAGE = 50_000;
export const KEYS_PAGE = 100_000;
export const CARDS_PAGE = 10_000;
/**
 * Rows written per IndexedDB transaction. A page is written in chunks, each
 * its own transaction, because the player's reads and writes queue behind any
 * transaction over the stores they touch (every operation writes `meta`): one
 * 100,000-key transaction held them for over ten seconds after a large cascade
 * was created. At ~7,500 rows a second a chunk takes about 30 milliseconds,
 * and a background download starts no chunk while the player is acting
 * (`whilePlayerActs`), so an action waits for one chunk at most.
 */
export const WRITE_CHUNK = 250;
/**
 * Bytes a base question row with its position costs, for the budget: the
 * middle of PLAN.md's "roughly 100–200 bytes per question per level", which
 * puts forty 300,000-question cascades over ROW_STORAGE_BUDGET (PQ-017).
 */
export const ROW_BYTES = 150; // PQ-017
/** Bytes a key costs beyond its characters. */
export const KEY_OVERHEAD = 40;

export interface GradesPage {
	attempt: number;
	shuffle_seed: string;
	question_idx: number[];
	grade: ('correct' | 'missed')[];
	graded_at: string[];
}

/** The endpoints the manager reads; tests replace them. */
export interface DownloadApi {
	questions(cascade: string, quiz: string, from: number, limit: number): Promise<number[]>;
	grades(cascade: string, quiz: string, from: number, limit: number): Promise<GradesPage>;
	keys(cascade: string, from: number, limit: number): Promise<{ from: number; keys: string[] }>;
	cards(
		cascade: string,
		from: number,
		limit: number,
		hooks: boolean,
		definitions: boolean
	): Promise<WireCard[]>;
	/** Cards named one by one (at most MAX_CARDS_BY_IDX): the player's read-ahead. */
	cardsByIdx?(cascade: string, idx: number[], hooks: boolean, definitions: boolean): Promise<WireCard[]>;
	distribution(name: string): Promise<{ name: string; tiles: never[] }>;
}

/** A card as the server sends it: a Definition card asked with hooks carries its word's. */
export type WireCard = { idx: number; key: string; answer: unknown; word?: WordHooks };

/**
 * Whether a cascade's cards are fetched with hooks: an Anagram cascade's when
 * the preference asks, and always a Definition cascade's, whose answer shows
 * its word with hooks above the definition.
 */
export function wantsHooks(quizType: string, prefs: { anagram_show_hooks: boolean }): boolean {
	return quizType === 'definition' || (quizType === 'anagram' && prefs.anagram_show_hooks);
}

/** The server's cap on cards named with `idx=`. */
export const MAX_CARDS_BY_IDX = 1_000;

const q = (params: Record<string, string | number | boolean>) =>
	Object.entries(params)
		.filter(([, v]) => v !== false)
		.map(([k, v]) => `${k}=${v === true ? 1 : v}`)
		.join('&');

export const httpApi: DownloadApi = {
	questions: (c, qz, from, limit) => api.get(`/api/cascades/${c}/quizzes/${qz}/questions?${q({ from, limit })}`),
	grades: (c, qz, from, limit) => api.get(`/api/cascades/${c}/quizzes/${qz}/grades?${q({ from, limit })}`),
	keys: (c, from, limit) => api.get(`/api/cascades/${c}/cards?${q({ from, limit, keys: true })}`),
	cards: (c, from, limit, hooks, definitions) =>
		api.get(`/api/cascades/${c}/cards?${q({ from, limit, hooks, definitions })}`),
	cardsByIdx: (c, idx, hooks, definitions) =>
		api.get(`/api/cascades/${c}/cards?${q({ idx: idx.join(','), hooks, definitions })}`),
	distribution: (name) => api.get(`/api/letter-distributions/${encodeURIComponent(name)}`, { bindUser: false })
};

export interface DownloadOptions {
	api?: DownloadApi;
	/** A sync before a grades fetch (§ Downloads: "The device syncs before that fetch"). */
	sync?: () => Promise<void>;
	wait?: (seconds: number) => Promise<void>;
	now?: () => Date;
	onProgress?: (cascadeId: string) => void;
	/** Cascades whose player is open in some tab (Web Locks), or null where Web Locks is missing. */
	openElsewhere?: () => Promise<Set<string> | null>;
	/** The cascade this tab's own player has open. */
	openHere?: () => string | null;
	/** ROW_STORAGE_BUDGET and the answer soft limit; tests shrink them. */
	rowBudget?: number;
	answerLimit?: number;
	/** Figures for the Account page's storage line. */
	onTotals?: (t: { rows: number; keys: number; answer_bytes: number; over_budget_by_user_kept: boolean }) => void;
}

const isQuota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError';

export class DownloadManager {
	/** Pages the player needs now: the manager starts nothing while any is outstanding. */
	private priority = 0;
	private readonly api: DownloadApi;
	private readonly wait: (s: number) => Promise<void>;
	private readonly now: () => Date;
	private readonly rowBudget: number;
	private readonly answerLimit: number;
	private running: Promise<void> | null = null;
	noRoom = false;

	constructor(
		private readonly db: UserDb,
		private readonly opts: DownloadOptions = {}
	) {
		this.api = opts.api ?? httpApi;
		this.wait = opts.wait ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
		this.now = opts.now ?? (() => new Date());
		this.rowBudget = opts.rowBudget ?? ROW_STORAGE_BUDGET;
		this.answerLimit = opts.answerLimit ?? ANSWER_STORAGE_SOFT_LIMIT_BYTES;
	}

	/** A fetch the player needs on the current card; the manager yields while it runs. */
	async forPlayer<T>(fn: () => Promise<T>): Promise<T> {
		if (this.priority++ === 0) this.idle = new Promise((r) => (this.wake = r));
		try {
			return await this.call(fn);
		} finally {
			if (--this.priority === 0) this.wake?.();
		}
	}

	/**
	 * A player action (a reveal, Next, Previous): background downloads start
	 * no new chunk until it is done, so its own reads and writes never queue
	 * behind one chunk after another. Writes the action itself causes (a card
	 * fetched for it) do not wait.
	 */
	async whilePlayerActs<T>(fn: () => Promise<T>): Promise<T> {
		if (this.acting++ === 0) this.actsDone = new Promise((r) => (this.actsWake = r));
		try {
			return await fn();
		} finally {
			if (--this.acting === 0) this.actsWake?.();
		}
	}

	private acting = 0;
	private actsDone: Promise<void> = Promise.resolve();
	private actsWake: (() => void) | null = null;

	/**
	 * Before a background chunk: let a player action finish first, waiting a
	 * second at most, since an action can itself wait on a download (a level
	 * whose rows are not here yet) and must never wait on its own yield.
	 */
	private async yieldToActs() {
		if (this.acting === 0) return;
		await Promise.race([this.actsDone, new Promise((r) => setTimeout(r, 1_000))]);
	}

	/** Resolves when no page the player needs is outstanding. */
	private idle: Promise<void> = Promise.resolve();
	private wake: (() => void) | null = null;

	/** One request, waiting out any 429 and trying the same page again. */
	private async call<T>(fn: () => Promise<T>): Promise<T> {
		for (;;) {
			try {
				return await fn();
			} catch (e) {
				if (e instanceof ApiError && e.status === 429) {
					await this.wait(e.retryAfterSeconds ?? 5);
					continue;
				}
				throw e;
			}
		}
	}

	private async yieldToPlayer() {
		while (this.priority > 0) await this.idle;
	}

	private async page<T>(fn: () => Promise<T>): Promise<T> {
		await this.yieldToPlayer();
		return this.call(fn);
	}

	/** A unit of work; a QuotaExceededError runs the drop pass, then eviction, and retries once. */
	private async unit<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (!isQuota(e)) throw e;
			await this.dropPass(await policy(this.db, this.now()), { force: true });
			await this.evict({ force: true });
			try {
				return await fn();
			} catch (e2) {
				if (isQuota(e2)) this.noRoom = true;
				throw e2;
			}
		}
	}

	// -------------------------------------------------------------------------
	// After every pull
	// -------------------------------------------------------------------------

	/** One pass at a time; a call during a pass waits for it. */
	run(): Promise<void> {
		if (!this.running) {
			this.running = this.pass().finally(() => (this.running = null));
		}
		return this.running;
	}

	private async pass(): Promise<void> {
		await this.dropPass(await policy(this.db, this.now()));
		// Judged again after the pass, so a cascade the budget just dropped is not fetched back.
		const pol = await policy(this.db, this.now());
		const wanted = [...pol.wanted];
		for (const id of wanted) await this.distributionFor(id);
		for (const id of wanted) await this.questionRows(id);
		// Keys come before any cascade's answers: they make every level playable.
		for (const id of wanted) await this.keys(id);
		for (const id of wanted) await this.cards(id);
		await this.evict();
		await this.totals(pol);
	}

	/** Everything one cascade needs, now: a first open, Keep offline, a restore (§ Downloads). */
	async ensureCascade(cascadeId: string): Promise<void> {
		await this.distributionFor(cascadeId);
		await this.questionRows(cascadeId);
		await this.keys(cascadeId);
		await this.cards(cascadeId);
	}

	// -------------------------------------------------------------------------
	// Distributions
	// -------------------------------------------------------------------------

	private async distributionFor(cascadeId: string) {
		const c = await this.db.get('cascades', cascadeId);
		if (!c || (await this.db.getKey('distributions', c.letter_distribution))) return;
		const d = await this.page(() => this.api.distribution(c.letter_distribution));
		await this.unit(() => this.db.put('distributions', { name: d.name, tiles: d.tiles }));
	}

	// -------------------------------------------------------------------------
	// Index lists, grades, positions
	// -------------------------------------------------------------------------

	/** Active quizzes deepest level first, so the next quiz played is ready first. */
	private async activeQuizzes(cascadeId: string): Promise<QuizRow[]> {
		const quizzes = await this.db.getAllFromIndex('quizzes', 'cascade_id', cascadeId);
		return quizzes.filter((x) => x.status === 'active').sort((a, b) => b.level - a.level);
	}

	private async questionRows(cascadeId: string) {
		const cascade = await this.db.get('cascades', cascadeId);
		if (!cascade) return;
		for (const quiz of await this.activeQuizzes(cascadeId)) {
			if (await this.complete(quiz)) continue;
			await this.materialiseQuiz(cascade, quiz);
			this.opts.onProgress?.(cascadeId);
		}
	}

	/** All rows here with positions, and none pending. */
	private async complete(quiz: QuizRow): Promise<boolean> {
		if (quiz.pending) return false;
		// Positions are written for a quiz's whole set in one transaction, and the
		// rebase marks a quiz pending when it removes single rows, so the row at
		// the last position witnesses the set: one key lookup, where a count would
		// walk every row of every active quiz on every pass.
		const n = quiz.question_count;
		return n > 0 && (await this.db.getKeyFromIndex('quiz_questions', 'quiz_position', [quiz.id, n - 1])) !== undefined;
	}

	/**
	 * The full sequence for one quiz: index list, graded rows (for a pending
	 * quiz), positions, hash check; the pending flag is cleared only by all of
	 * it, and only when the grades fetched number `correct_count + missed_count`.
	 */
	async materialiseQuiz(cascade: CascadeRow, quiz: QuizRow, force = false): Promise<boolean> {
		const seq = (await getMeta(this.db, 'sync')).cursor ?? 0;
		// 1. The index list (a Source quiz's is implied).
		let idx: number[];
		if (quiz.origin === 'source') {
			idx = Array.from({ length: quiz.question_count }, (_, i) => i);
		} else {
			const have = await this.db.getAllFromIndex('quiz_questions', 'quiz_id', quiz.id);
			if (have.length === quiz.question_count) {
				idx = have.map((r) => r.question_idx);
			} else {
				idx = [];
				for (let from = 0; from < quiz.question_count; from += INDEX_PAGE) {
					idx.push(...(await this.page(() => this.api.questions(cascade.id, quiz.id, from, INDEX_PAGE))));
				}
			}
		}
		idx.sort((a, b) => a - b);
		if (questionsHash(idx).toString() !== quiz.questions_hash) return false;
		// 2. The graded rows of a pending quiz, for its current attempt.
		let grades: Map<number, { grade: 'correct' | 'missed'; graded_at: string }> | null = null;
		let current = quiz;
		const graded = quiz.correct_count + quiz.missed_count;
		if ((quiz.pending || force) && graded > 0) {
			for (let tries = 0; tries < 2 && !grades; tries++) {
				await this.opts.sync?.();
				current = (await this.db.get('quizzes', quiz.id)) ?? quiz;
				// A restore or an export fetches a cleared quiz's rows too.
				if (current.status !== 'active' && !force) return false;
				const fetched = new Map<number, { grade: 'correct' | 'missed'; graded_at: string }>();
				let mismatch = false;
				for (let from = 0; from < cascade.question_count && !mismatch; from += INDEX_PAGE) {
					const p = await this.page(() => this.api.grades(cascade.id, quiz.id, from, INDEX_PAGE));
					// A fetch whose attempt differs from the quiz row is discarded; the device syncs again.
					if (p.attempt !== current.attempt || p.shuffle_seed !== current.shuffle_seed) mismatch = true;
					p.question_idx.forEach((i, k) => fetched.set(i, { grade: p.grade[k], graded_at: p.graded_at[k] }));
				}
				if (mismatch) continue;
				// Checked for completeness too: a fetch that stopped early leaves the quiz pending.
				if (fetched.size === current.correct_count + current.missed_count) grades = fetched;
			}
			if (!grades) return false;
		}
		// 3. Positions from the seed over the rows, grades laid on; one transaction.
		return this.unit(async () => {
			const tx = this.db.transaction(['quizzes', 'quiz_questions'], 'readwrite');
			const row = await tx.objectStore('quizzes').get(quiz.id);
			if (!row || row.attempt !== current.attempt || row.shuffle_seed !== current.shuffle_seed) {
				await tx.done;
				return false;
			}
			const store = tx.objectStore('quiz_questions');
			const existing = new Map((await store.index('quiz_id').getAll(quiz.id)).map((r) => [r.question_idx, r]));
			let rows: QuestionRow[] = idx.map(
				(i) =>
					existing.get(i) ?? {
						quiz_id: quiz.id,
						question_idx: i,
						cascade_id: cascade.id,
						position: null,
						grade: null,
						graded_at: null,
						seq
					}
			);
			if (grades) {
				rows = rows.map((r) => {
					const g = grades!.get(r.question_idx);
					return g ? { ...r, grade: g.grade, graded_at: g.graded_at, seq } : { ...r, grade: null, graded_at: null };
				});
			}
			rows = withPositions(rows, row.shuffle_seed);
			await Promise.all(rows.map((r) => store.put(r)));
			const next = { ...row };
			delete next.pending;
			await tx.objectStore('quizzes').put(next);
			await tx.done;
			return true;
		});
	}

	// -------------------------------------------------------------------------
	// Keys and answers
	// -------------------------------------------------------------------------

	private async missingRanges(store: 'questions' | 'cards', cascade: CascadeRow, pageSize: number): Promise<number[]> {
		const froms: number[] = [];
		for (let from = 0; from < cascade.question_count; from += pageSize) {
			const want = Math.min(pageSize, cascade.question_count - from);
			const have = await this.db.count(store, IDBKeyRange.bound([cascade.id, from], [cascade.id, from + want - 1]));
			if (have < want) froms.push(from);
		}
		return froms;
	}

	private async keys(cascadeId: string) {
		const c = await this.db.get('cascades', cascadeId);
		if (!c) return;
		for (const from of await this.missingRanges('questions', c, KEYS_PAGE)) {
			const p = await this.page(() => this.api.keys(c.id, from, KEYS_PAGE));
			for (let at = 0; at < p.keys.length; at += WRITE_CHUNK) {
				const part = p.keys.slice(at, at + WRITE_CHUNK);
				await this.yieldToActs();
				await this.unit(async () => {
					const tx = this.db.transaction(['questions', 'meta'], 'readwrite');
					let bytes = 0;
					for (const k of part) bytes += k.length * 2 + KEY_OVERHEAD;
					// Issued together: IndexedDB pipelines a transaction's requests.
					const store = tx.objectStore('questions');
					await Promise.all(part.map((key, i) => store.put({ cascade_id: c.id, idx: p.from + at + i, key })));
					await addSize(tx as unknown as RwTx, c.id, bytes, 0);
					await tx.done;
				});
			}
			this.opts.onProgress?.(cascadeId);
		}
	}

	private async cards(cascadeId: string) {
		const c = await this.db.get('cascades', cascadeId);
		if (!c) return;
		const prefs = await preferencesView(this.db);
		const hooks = wantsHooks(c.quiz_type, prefs);
		const definitions = c.quiz_type === 'anagram' && prefs.anagram_show_definitions;
		// Cards record which extras they hold; a preference asking for more refetches them.
		let froms = await this.missingRanges('cards', c, CARDS_PAGE);
		if (hooks || definitions) {
			const lacking = new Set(froms);
			for (let from = 0; from < c.question_count; from += CARDS_PAGE) {
				const first = await this.db.get('cards', [c.id, from]);
				// Hooks fetched before inner hooks were sent lack them: those pages come again.
				if (first && ((hooks && (!first.hooks || !first.inner)) || (definitions && !first.definitions))) lacking.add(from);
			}
			froms = [...lacking].sort((a, b) => a - b);
		}
		for (const from of froms) {
			const page = await this.page(() => this.api.cards(c.id, from, CARDS_PAGE, hooks, definitions));
			await this.writeCards(c, page, hooks, definitions, true);
			this.opts.onProgress?.(cascadeId);
		}
	}

	/**
	 * What the player needs on the current card, ahead of any download: the
	 * manager starts nothing while it is outstanding (§ Downloads). With
	 * `ahead`, the next cards in the quiz's own order come in the same small
	 * request rather than the current card's 10,000-card page: a new quiz's
	 * order is a shuffle, so consecutive cards fall in different pages.
	 */
	async fetchForPlayer(cascadeId: string, idx: number, ahead: number[] = []): Promise<void> {
		const c = await this.db.get('cascades', cascadeId);
		if (!c) return;
		const prefs = await preferencesView(this.db);
		const hooks = wantsHooks(c.quiz_type, prefs);
		const definitions = c.quiz_type === 'anagram' && prefs.anagram_show_definitions;
		if (this.api.cardsByIdx) {
			const want = [idx, ...(await this.missingCards(c.id, ahead))].slice(0, MAX_CARDS_BY_IDX);
			const cards = await this.forPlayer(() => this.api.cardsByIdx!(c.id, want, hooks, definitions));
			await this.writeCards(c, cards, hooks, definitions);
			return;
		}
		const from = Math.floor(idx / CARDS_PAGE) * CARDS_PAGE;
		const page = await this.forPlayer(() => this.api.cards(c.id, from, CARDS_PAGE, hooks, definitions));
		await this.writeCards(c, page, hooks, definitions);
	}

	/**
	 * The player's read-ahead: the named cards this device lacks, in one small
	 * request, so the next cards are here before they are shown while the
	 * cascade's pages are still downloading.
	 */
	async fetchAhead(cascadeId: string, idx: number[]): Promise<void> {
		if (!this.api.cardsByIdx || idx.length === 0) return;
		const c = await this.db.get('cascades', cascadeId);
		if (!c) return;
		const want = (await this.missingCards(c.id, idx)).slice(0, MAX_CARDS_BY_IDX);
		if (want.length === 0) return;
		const prefs = await preferencesView(this.db);
		const hooks = wantsHooks(c.quiz_type, prefs);
		const definitions = c.quiz_type === 'anagram' && prefs.anagram_show_definitions;
		const cards = await this.forPlayer(() => this.api.cardsByIdx!(c.id, want, hooks, definitions));
		await this.writeCards(c, cards, hooks, definitions);
	}

	private async missingCards(cascadeId: string, idx: number[]): Promise<number[]> {
		if (idx.length === 0) return [];
		const store = this.db.transaction('cards').objectStore('cards');
		const have = await Promise.all(idx.map((i) => store.getKey([cascadeId, i])));
		return idx.filter((_, k) => have[k] === undefined);
	}

	/** `background`: a download pass, which lets a player action go first between chunks. */
	private async writeCards(
		c: CascadeRow,
		all: WireCard[],
		hooks: boolean,
		definitions: boolean,
		background = false
	) {
		for (let at = 0; at < all.length; at += WRITE_CHUNK) {
			const page = all.slice(at, at + WRITE_CHUNK);
			if (background) await this.yieldToActs();
			await this.unit(async () => {
				const tx = this.db.transaction(['cards', 'questions', 'meta'], 'readwrite');
				let answerBytes = 0;
				let keyBytes = 0;
				const cards = tx.objectStore('cards');
				const questions = tx.objectStore('questions');
				// The page's reads, then its writes, each issued together.
				const [before, haveKey] = await Promise.all([
					Promise.all(page.map((card) => cards.get([c.id, card.idx]))),
					Promise.all(page.map((card) => questions.getKey([c.id, card.idx])))
				]);
				const writes: Promise<unknown>[] = [];
				page.forEach((card, i) => {
					const row: CardRow = { cascade_id: c.id, idx: card.idx, answer: card.answer, definitions, hooks, inner: hooks };
					if (card.word) row.word = card.word;
					if (before[i]) answerBytes -= JSON.stringify(before[i]!.answer).length;
					answerBytes += JSON.stringify(card.answer).length;
					writes.push(cards.put(row));
					if (!haveKey[i]) {
						keyBytes += card.key.length * 2 + KEY_OVERHEAD;
						writes.push(questions.put({ cascade_id: c.id, idx: card.idx, key: card.key }));
					}
				});
				await Promise.all(writes);
				await addSize(tx as unknown as RwTx, c.id, keyBytes, answerBytes);
				await tx.done;
			});
		}
	}

	// -------------------------------------------------------------------------
	// The drop pass, the budget and eviction
	// -------------------------------------------------------------------------

	private async protectedIds(): Promise<Set<string>> {
		const out = new Set<string>();
		for (const e of await this.db.getAll('outbox')) if (e.cascade_id) out.add(e.cascade_id);
		const open = await this.opts.openElsewhere?.();
		if (open) for (const id of open) out.add(id);
		const here = this.opts.openHere?.();
		if (here) out.add(here);
		return out;
	}

	private async rowBytes(cascadeId: string): Promise<number> {
		const rows = await this.db.countFromIndex('quiz_questions', 'cascade_id', cascadeId);
		const sizes = await getMeta(this.db, 'sizes');
		return rows * ROW_BYTES + (sizes[cascadeId]?.key_bytes ?? 0);
	}

	/** Drops everything the device can fetch or recompute again, keeping cascade, quiz and attempt rows. */
	async dropCascade(cascadeId: string, budget: boolean) {
		const tx = this.db.transaction(['quizzes', 'quiz_questions', 'questions', 'cards', 'meta'], 'readwrite');
		await deleteQuizKeyed(tx.objectStore('quiz_questions'), cascadeId);
		await deleteCascadeKeyed(tx.objectStore('questions'), cascadeId);
		await deleteCascadeKeyed(tx.objectStore('cards'), cascadeId);
		for (const quiz of await tx.objectStore('quizzes').index('cascade_id').getAll(cascadeId)) {
			// A played active quiz waits for its graded rows; an unplayed one needs only its list.
			if (quiz.status === 'active' && quiz.correct_count + quiz.missed_count > 0) {
				await tx.objectStore('quizzes').put({ ...quiz, pending: true });
			} else if (quiz.pending) {
				const next = { ...quiz };
				delete next.pending;
				await tx.objectStore('quizzes').put(next);
			}
		}
		const rtx = tx as unknown as RwTx;
		const sizes = await readMeta(rtx, 'sizes');
		delete sizes[cascadeId];
		await writeMeta(rtx, 'sizes', sizes);
		if (budget) {
			const dropped = await readMeta(rtx, 'budget_dropped');
			if (!dropped.includes(cascadeId)) await writeMeta(rtx, 'budget_dropped', [...dropped, cascadeId]);
		}
		await tx.done;
	}

	private async holdsData(cascadeId: string): Promise<boolean> {
		return (
			(await this.db.countFromIndex('quiz_questions', 'cascade_id', cascadeId)) > 0 ||
			(await this.db.countFromIndex('questions', 'cascade_id', cascadeId)) > 0 ||
			(await this.db.countFromIndex('cards', 'cascade_id', cascadeId)) > 0
		);
	}

	/**
	 * Cascades that left the window, then — over ROW_STORAGE_BUDGET, or on the
	 * quota path — the least recently opened unkept cascades, then the
	 * automatically kept ones, never a user-kept one, one with pending
	 * operations, or one with its player open.
	 */
	async dropPass(pol: Policy, o: { force?: boolean } = {}): Promise<{ overByUserKept: boolean }> {
		const guard = await this.protectedIds();
		for (const id of await this.db.getAllKeys('cascades')) {
			if (!pol.wanted.has(id) && !guard.has(id) && (await this.holdsData(id))) await this.dropCascade(id, false);
		}
		const opens = await getMeta(this.db, 'opens');
		const ids = await this.db.getAllKeys('cascades');
		let total = 0;
		const size = new Map<string, number>();
		for (const id of ids) {
			const b = await this.rowBytes(id);
			size.set(id, b);
			total += b;
		}
		const over = () => total > this.rowBudget || (o.force === true && total > 0);
		const byAge = (list: string[]) => list.sort((a, b) => (opens[a] ?? '').localeCompare(opens[b] ?? ''));
		const tier1 = byAge(ids.filter((id) => !pol.userKept.has(id) && !pol.autoKept.has(id)));
		const tier2 = byAge(ids.filter((id) => pol.autoKept.has(id)));
		let dropped = false;
		for (const id of [...tier1, ...tier2]) {
			if (!over() || (o.force && dropped)) break;
			if (guard.has(id) || !size.get(id)) continue;
			await this.dropCascade(id, true);
			total -= size.get(id)!;
			dropped = true;
		}
		return { overByUserKept: total > this.rowBudget };
	}

	/** Answers above the soft limit, least recently opened first; never a user-kept cascade's or one with pending operations. */
	async evict(o: { force?: boolean } = {}) {
		const sizes = await getMeta(this.db, 'sizes');
		const opens = await getMeta(this.db, 'opens');
		const keep = new Set(await getMeta(this.db, 'keep_offline'));
		const guard = new Set<string>();
		for (const e of await this.db.getAll('outbox')) if (e.cascade_id) guard.add(e.cascade_id);
		let total = Object.values(sizes).reduce((n, s) => n + s.answer_bytes, 0);
		const candidates = Object.keys(sizes)
			.filter((id) => sizes[id].answer_bytes > 0 && !keep.has(id) && !guard.has(id))
			.sort((a, b) => (opens[a] ?? '').localeCompare(opens[b] ?? ''));
		let evicted = false;
		for (const id of candidates) {
			if (total <= this.answerLimit && !(o.force && !evicted)) break;
			const tx = this.db.transaction(['cards', 'meta'], 'readwrite');
			await deleteCascadeKeyed(tx.objectStore('cards'), id);
			const s = await readMeta(tx as unknown as RwTx, 'sizes');
			total -= s[id]?.answer_bytes ?? 0;
			if (s[id]) s[id] = { ...s[id], answer_bytes: 0 };
			await writeMeta(tx as unknown as RwTx, 'sizes', s);
			await tx.done;
			evicted = true;
		}
	}

	private async totals(pol: Policy) {
		const sizes = await getMeta(this.db, 'sizes');
		const rows = (await this.db.count('quiz_questions')) * ROW_BYTES;
		const keys = Object.values(sizes).reduce((n, s) => n + s.key_bytes, 0);
		const answer_bytes = Object.values(sizes).reduce((n, s) => n + s.answer_bytes, 0);
		let userKept = 0;
		for (const id of pol.userKept) userKept += await this.rowBytes(id);
		this.opts.onTotals?.({ rows, keys, answer_bytes, over_budget_by_user_kept: userKept > this.rowBudget });
	}

	// -------------------------------------------------------------------------
	// What the badges show
	// -------------------------------------------------------------------------

	/** Available offline: index lists, positions, keys and cards all here, and nothing pending. */
	async availableOffline(cascadeId: string): Promise<boolean> {
		const c = await this.db.get('cascades', cascadeId);
		if (!c) return false;
		for (const quiz of await this.activeQuizzes(cascadeId)) if (!(await this.complete(quiz))) return false;
		const keys = await this.db.countFromIndex('questions', 'cascade_id', cascadeId);
		const cards = await this.db.countFromIndex('cards', 'cascade_id', cascadeId);
		const dist = await this.db.getKey('distributions', c.letter_distribution);
		return keys === c.question_count && cards === c.question_count && dist !== undefined;
	}
}

async function addSize(tx: RwTx, cascadeId: string, keyBytes: number, answerBytes: number) {
	const sizes = await readMeta(tx, 'sizes');
	const s = sizes[cascadeId] ?? { key_bytes: 0, answer_bytes: 0 };
	sizes[cascadeId] = { key_bytes: s.key_bytes + keyBytes, answer_bytes: s.answer_bytes + answerBytes };
	await writeMeta(tx, 'sizes', sizes);
}

/** Cascades whose player holds its Web Lock in any tab, or null where Web Locks is missing. */
export async function openPlayers(): Promise<Set<string> | null> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) return null;
	const state = await locks.query();
	const out = new Set<string>();
	for (const l of state.held ?? []) {
		if (l.name?.startsWith(PLAYER_LOCK)) out.add(l.name.slice(PLAYER_LOCK.length));
	}
	return out;
}

/** Each player tab holds a Web Lock named for its cascade (§ On the device → Local size). */
export const PLAYER_LOCK = 'wordfall-player-';
