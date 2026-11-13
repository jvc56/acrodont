// PLAN.md § Unit tests → Frontend, the player's cases: the three actions,
// Previous and run boundaries, a card whose key never arrived, a card whose
// answer is gone (typed falls back to flashcard mode), typed mode, a missing
// distribution, the quota path on applyLocally, and a segmented attempt
// played through as the player emits it.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { storeCreated } from '$lib/local/created';
import { openUserDb, type UserDb } from '$lib/local/db';
import { initMeta } from '$lib/local/meta';
import { applyLocally } from '$lib/local/apply';
import * as view from '$lib/local/view';
import { questionsHash } from '$lib/cascade/order';
import { AHEAD, AHEAD_LOW, Player } from './controller';
import { bind, inputOwns, actionFor, Debounce, DEFAULT_BINDINGS, normalizeBindings } from './bindings';
import { finishBanner } from './banner';
import { emptyTyped, isAnagramOf, submitTyped, typedGrade } from './typed';
import { Distribution } from '$lib/tiles';

const C = 'c1000000-0000-4000-8000-000000000000';
const Q = 'a1000000-0000-4000-8000-000000000000';
const T0 = '2026-01-01T00:00:00.000Z';
const WORDS = ['AB', 'BA'];

let db: UserDb;

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	db = await openUserDb('u');
	await initMeta(db, 'u', 'u');
});

async function cascade(
	count: number,
	o: {
		segment_size?: number;
		keys?: boolean;
		cards?: boolean;
		dist?: boolean;
		quiz_type?: 'anagram' | 'definition';
		answer_mode?: 'flashcard' | 'typed';
		reveal_correct?: boolean;
	} = {}
) {
	const idx = Array.from({ length: count }, (_, i) => i);
	const opts = { segment_size: o.segment_size ?? 0, progression: 'ladder', require_alphabetical: false };
	await storeCreated(db, {
		cascade: {
			id: C, name: 'x', quiz_type: o.quiz_type ?? 'anagram', lexicon: 'EN', letter_distribution: 'english', clear_threshold: 80, ...opts,
			options_changed_at: T0, options_seq: '1', options_device_id: 'd', question_count: count, depth: 1, peak_depth: 1,
			attempts_since_completion: 0, created_at: T0, last_activity_at: T0, completed_at: null, trashed_at: null, updated_seq: '1',
			answer_mode: o.answer_mode ?? 'flashcard', show_definitions: true, show_hooks: true,
			reveal_correct: o.reveal_correct ?? true, leave_value_decimals: 1
		},
		source_quiz: {
			id: Q, cascade_id: C, level: 1, origin: 'source', origin_quiz_id: null, origin_attempt: null, origin_segment_end: null,
			status: 'active', segment_chain: false, ...opts, options_changed_at: T0, options_seq: '1', options_device_id: 'd',
			attempt: 1, shuffle_seed: '12345', questions_hash: questionsHash(idx).toString(), question_count: count, correct_count: 0,
			missed_count: 0, cursor: 0, cursor_moved_at: null, cursor_device_id: null, run_start: 0, created_at: T0, created_seq: '1',
			last_activity_at: T0, cleared_at: null, updated_seq: '1'
		},
		sync_seq: '1'
	});
	for (const i of idx) {
		if (o.keys !== false) await db.put('questions', { cascade_id: C, idx: i, key: 'AB' });
		if (o.cards !== false) {
			await db.put('cards', { cascade_id: C, idx: i, answer: WORDS.map((word) => ({ word })), definitions: false, hooks: false });
		}
	}
	if (o.dist !== false) await putDistribution();
}

async function putDistribution() {
	const tiles = [{ letter: '?', blank_letter: '?', count: 2, value: 0, is_vowel: false }];
	for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') tiles.push({ letter: L, blank_letter: L.toLowerCase(), count: 2, value: 1, is_vowel: 'AEIOU'.includes(L) });
	await db.put('distributions', { name: 'english', tiles });
}

/** The cascade made typed, as the player's settings would. */
async function makeTyped() {
	const c = (await db.get('cascades', C))!;
	await db.put('cascades', { ...c, answer_mode: 'typed' });
}

function player() {
	return new Player(db, C, { ensure: async () => undefined, seed: () => '777' });
}

const ops = async () => (await db.getAll('outbox')).map((e) => e.op.type);

describe('the player', () => {
	it('Next shows the next card before its writes are saved, from the cards held in memory', async () => {
		await cascade(5);
		let saved = 0;
		const p = new Player(db, C, { ensure: async () => undefined, seed: () => '777', afterWrite: () => saved++ });
		await p.load();
		await new Promise((r) => setTimeout(r, 50)); // the background cache fill
		let savedWhenShown = -1;
		p.subscribe((v) => {
			if (v.card?.pos === 1 && savedWhenShown < 0) savedWhenShown = saved;
		});
		await p.showNext(); // the reveal: no writes
		await p.showNext();
		// Card 1 appeared before either write (the grade, the cursor) was saved,
		// with the score and cursor those writes leave.
		expect(savedWhenShown).toBe(0);
		expect(saved).toBe(2);
		expect([p.v.quiz!.cursor, p.v.quiz!.correct_count]).toEqual([1, 1]);
		expect(await ops()).toEqual(['grade', 'move_cursor']);
	});

	it('a reload arriving between a Next and its writes keeps the new card and the grade', async () => {
		await cascade(5);
		const p = player();
		await p.load();
		await p.showNext();
		// A sync's refresh lands while Next's writes are still queued.
		await Promise.all([p.showNext(), p.load(true)]);
		expect(p.v.card!.pos).toBe(1);
		expect(p.v.quiz!.correct_count).toBe(1);
		// The grade is remembered: Previous shows card 0 graded.
		await p.previous();
		expect([p.v.card!.pos, p.v.card!.revealed, p.v.card!.saved]).toEqual([0, true, 'correct']);
	});

	it('a reveal marks the card correct, or missed when the cascade’s setting says so; Toggle flips either', async () => {
		await cascade(5, { reveal_correct: false });
		const p = player();
		await p.load();
		await p.showNext();
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'missed']);
		await p.toggle();
		expect(p.v.card!.grade).toBe('correct');
		await cascade(5);
		const q = player();
		await q.load();
		await q.showNext();
		expect(q.v.card!.grade).toBe('correct');
	});

	it('Show and Toggle act at once during a slow reload, which keeps them; Next waits for it', async () => {
		await cascade(5);
		let hold: Promise<void> | null = null;
		const p = player();
		// The reload's reads wait on `hold`.
		const inner = p as unknown as { loadNow: (keep: boolean) => Promise<void> };
		const loadNow = inner.loadNow.bind(p);
		inner.loadNow = async (keep) => {
			await hold;
			return loadNow(keep);
		};
		await p.load();
		let release!: () => void;
		hold = new Promise((r) => (release = r));
		// A sync's reload (just after a cascade is created, say) is slow to read.
		const reload = p.load(true);
		void p.showNext();
		expect([p.v.card!.pos, p.v.card!.revealed]).toEqual([0, true]);
		void p.toggle();
		expect(p.v.card!.grade).toBe('missed');
		const next = p.showNext();
		await new Promise((r) => setTimeout(r, 20));
		expect(p.v.card!.pos).toBe(0); // Next waits its turn behind the reload
		release();
		await reload;
		await next;
		expect(p.v.card!.pos).toBe(1);
		expect(p.v.quiz!.missed_count).toBe(1);
	});

	it('a download landing while the answer is shown keeps it shown', async () => {
		await cascade(5);
		const p = player();
		await p.load();
		// The answer is refetched with a definition; the player reads the new row…
		await db.put('cards', { ...(await db.get('cards', [C, p.v.card!.idx]))!, answer: [{ word: 'AB', definition: 'new' }] });
		const refresh = p.refreshCard();
		void p.showNext(); // …while Show reveals the card
		await refresh;
		expect(p.v.card!.revealed).toBe(true);
		expect(p.v.card!.answer).toEqual([{ word: 'AB', definition: 'new' }]);
	});

	it('presses in quick succession all count, in order, and the writes follow them', async () => {
		await cascade(5);
		const p = player();
		await p.load();
		// Reveal, Next, Reveal, Toggle, Next: none awaited.
		const all = [p.showNext(), p.showNext(), p.showNext(), p.toggle(), p.showNext()];
		await Promise.all(all);
		expect(p.v.card!.pos).toBe(2);
		// The outbox keeps only the latest cursor move per quiz.
		expect(await ops()).toEqual(['grade', 'grade', 'move_cursor']);
		const q = (await db.get('overlay_quizzes', Q))!;
		expect([q.cursor, q.correct_count, q.missed_count]).toEqual([2, 1, 1]);
	});

	it('reads ahead the next cards in its own order, one request whenever fewer than AHEAD_LOW are covered', async () => {
		await cascade(AHEAD * 2, { cards: false });
		const asked: number[][] = [];
		const fetched: number[] = [];
		const p = new Player(db, C, {
			ensure: async () => undefined,
			seed: () => '777',
			fetchCard: async (_c, idx, ahead) => {
				fetched.push(idx);
				asked.push(ahead);
				for (const i of [idx, ...ahead]) {
					await db.put('cards', { cascade_id: C, idx: i, answer: WORDS.map((word) => ({ word })), definitions: false, hooks: false });
				}
			},
			fetchAhead: async (_c, idx) => {
				asked.push(idx);
			}
		});
		await p.load();
		// The first card's fetch brought the AHEAD after it, in the quiz's order.
		const order = (await db.getAllFromIndex('quiz_questions', 'quiz_id', Q)).sort((a, b) => a.position! - b.position!).map((r) => r.question_idx);
		expect(fetched).toEqual([order[0]]);
		expect(asked).toEqual([order.slice(1, 1 + AHEAD)]);
		expect(p.v.card!.answer).not.toBeNull();
		// No new request while more than AHEAD_LOW are covered.
		for (let i = 0; i < AHEAD - AHEAD_LOW; i++) {
			await p.showNext();
			await p.showNext();
		}
		expect(asked).toHaveLength(1);
		await p.showNext();
		await p.showNext();
		await new Promise((r) => setTimeout(r, 0));
		expect(asked).toHaveLength(2);
		expect(asked[1]).toEqual(order.slice(1 + AHEAD, Math.min(order.length, 2 + AHEAD + AHEAD_LOW)));
		expect(fetched).toHaveLength(1);
	});

	it('a created cascade is stored whole, in chunks, reporting progress after each', async () => {
		const chunk = 100;
		const n = chunk * 2 + 7;
		const seen: number[] = [];
		await cascade(n, { keys: false, cards: false, dist: false });
		// Every row is there, positions 0 … n − 1 once each.
		const rows = await db.getAllFromIndex('quiz_questions', 'quiz_id', Q);
		expect(rows).toHaveLength(n);
		expect(new Set(rows.map((r) => r.position)).size).toBe(n);
		// Progress was reported per chunk, ending at 1.
		await db.clear('quiz_questions');
		const created = await db.get('cascades', C);
		expect(created).toBeTruthy();
		await storeCreated(db, {
			cascade: { ...(created as unknown as Record<string, unknown>), question_count: n, updated_seq: '1' },
			source_quiz: { ...((await db.get('quizzes', Q)) as unknown as Record<string, unknown>), created_seq: '1', updated_seq: '1' },
			sync_seq: '1'
		}, new Date(), (f) => seen.push(f), chunk);
		expect(seen).toEqual([0, chunk / n, (2 * chunk) / n, 1]);
	});

	it('Show / Next reveals Correct, Toggle flips it, and Show / Next saves the grade and moves the cursor', async () => {
		await cascade(3);
		const p = player();
		await p.load();
		expect(p.v.card!.revealed).toBe(false);
		await p.showNext();
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'correct']);
		await p.toggle();
		expect(p.v.card!.grade).toBe('missed');
		await p.showNext();
		expect(await ops()).toEqual(['grade', 'move_cursor']);
		expect(p.v.card!.pos).toBe(1);
		expect(p.v.card!.revealed).toBe(false);
	});

	it('Toggle before the reveal does nothing; Previous shows the earlier card with its saved grade and discards the unsaved reveal', async () => {
		await cascade(3);
		const p = player();
		await p.load();
		await p.toggle();
		expect([p.v.card!.revealed, p.v.card!.toggled]).toEqual([false, false]);
		await p.showNext();
		expect(p.v.card!.grade).toBe('correct');
		await p.toggle();
		expect(p.v.card!.grade).toBe('missed');
		await p.showNext();
		await p.showNext(); // reveal card 2
		await p.previous();
		expect(p.v.card!.pos).toBe(0);
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'missed']);
		// Previous does nothing on the first card, and says why when it cannot.
		await p.previous();
		expect(p.v.card!.pos).toBe(0);
	});

	it('the last card finishes the attempt with its banner', async () => {
		await cascade(2);
		const p = player();
		await p.load();
		await p.showNext();
		await p.showNext();
		await p.showNext();
		await p.toggle();
		await p.showNext();
		expect((await ops()).at(-1)).toBe('finish');
		expect(p.v.banner).toBe('Level 1: 50%. Reshuffled, and its 1 missed questions are now Level 2.');
		expect(p.v.quiz!.level).toBe(2);
	});

	it('a segmented attempt played as the player emits it: runs, drills and the finish, with no rejection', async () => {
		await cascade(10, { segment_size: 5 });
		const p = player();
		await p.load();
		const banners: string[] = [];
		// The status bar's rows, as each card is first shown: the level the Level row is on, then the Segment row.
		const bars: string[] = [];
		const bar = () => {
			const b = p.v.bar!;
			const s = b.segment!;
			return `L${b.level.level}${b.played ? '' : ' (waiting)'} · segment ${s.segment}/${s.total} pass ${s.pass} · ${s.position}/${s.length} · ${s.correct}✓ ${s.missed}✗`;
		};
		for (let step = 0; step < 60 && p.v.status === 'ready'; step++) {
			const q = p.v.quiz!;
			if (p.v.bar?.segment) bars.push(bar());
			await p.showNext();
			// Miss the first card of each Level 1 run.
			if (q.level === 1 && p.v.card!.pos % 5 === 0) await p.toggle();
			await p.showNext();
			if (p.v.banner) banners.push(p.v.banner);
			if (p.v.banner?.startsWith('Level 1:')) break;
		}
		expect(banners).toEqual([
			'Segment 1 of 2 done, 1 missed. Now drilling them.',
			'Drill done. Back to Level 1, segment 2 of 2.',
			'Level 1: 80%. Reshuffled, and its 2 missed questions are now Level 2.'
		]);
		// The Segment row counts within the segment; the drill of its one miss is the segment's
		// second pass, with the Level row still on Level 1, which waits at the next segment.
		expect(bars).toEqual([
			'L1 · segment 1/2 pass 1 · 1/5 · 0✓ 0✗',
			'L1 · segment 1/2 pass 1 · 2/5 · 0✓ 1✗',
			'L1 · segment 1/2 pass 1 · 3/5 · 1✓ 1✗',
			'L1 · segment 1/2 pass 1 · 4/5 · 2✓ 1✗',
			'L1 · segment 1/2 pass 1 · 5/5 · 3✓ 1✗',
			'L1 (waiting) · segment 1/2 pass 2 · 1/1 · 0✓ 0✗',
			'L1 · segment 2/2 pass 1 · 1/5 · 0✓ 0✗',
			'L1 · segment 2/2 pass 1 · 2/5 · 0✓ 1✗',
			'L1 · segment 2/2 pass 1 · 3/5 · 1✓ 1✗',
			'L1 · segment 2/2 pass 1 · 4/5 · 2✓ 1✗',
			'L1 · segment 2/2 pass 1 · 5/5 · 3✓ 1✗'
		]);
	});

	it('a card whose key never arrived needs a connection, emits nothing, and the run cannot finish', async () => {
		await cascade(3, { keys: false });
		await db.put('questions', { cascade_id: C, idx: 0, key: 'AB' });
		await db.put('questions', { cascade_id: C, idx: 2, key: 'AB' });
		const p = player();
		await p.load();
		// Walk through: the card without a key is moved past with no operation.
		for (let i = 0; i < 6; i++) {
			if (p.v.card!.key === null) {
				expect(p.v.card!.key).toBeNull();
				const before = (await ops()).length;
				await p.showNext();
				expect((await ops()).length).toBe(before);
			} else {
				await p.showNext();
				await p.showNext();
			}
		}
		expect(await ops()).not.toContain('finish');
		expect(p.v.message).toMatch(/^Some questions in this segment still need a connection \(1\)\.$/);
	});

	it('a typed card whose answer is gone falls back to flashcard mode: Correct to start, Toggle decides, with the reveal saying so', async () => {
		await cascade(2, { cards: false });
		await makeTyped();
		const p = player();
		await p.load();
		expect(p.v.card!.typed).toBeNull();
		expect(p.v.card!.answer).toBeNull();
		await p.showNext();
		expect(p.v.card!.grade).toBe('correct');
		await p.toggle();
		await p.showNext();
		expect((await db.getAll('outbox'))[0].op.grade).toBe('missed');
	});

	it('typed mode: found, already entered, not an anagram; all found waits for Enter', async () => {
		await cascade(2);
		await makeTyped();
		const p = player();
		await p.load();
		expect((await p.enter('ab'))!.kind).toBe('found');
		expect((await p.enter('AB'))!.kind).toBe('already');
		// Not the question's tiles: rejected, with a note, and no effect on the grade.
		expect((await p.enter('ABAB'))!.kind).toBe('not_anagram');
		expect(p.v.card!.note).toBe('Not an anagram of the question');
		expect((await p.enter('AA'))!.kind).toBe('not_anagram');
		expect((await p.enter('XY'))!.kind).toBe('not_anagram');
		expect((await p.enter('A1'))!.kind).toBe('not_anagram');
		expect((await p.enter('BA'))!.kind).toBe('found');
		// Every answer found, but the card waits: the user may have more to try.
		expect(p.v.card!.revealed).toBe(false);
		expect((await p.enter(''))!.kind).toBe('empty');
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'correct']);
	});

	it('typed entries: only an anagram of the question can be wrong', () => {
		const tiles = [{ letter: '?', blank_letter: '?', count: 2, value: 0, is_vowel: false }];
		for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') tiles.push({ letter: L, blank_letter: L.toLowerCase(), count: 2, value: 1, is_vowel: 'AEIOU'.includes(L) });
		const dist = new Distribution('english', tiles);
		const abc = dist.parseMagpie('ABC', true);
		const submit = (text: string, question = abc, answers = ['CAB']) => submitTyped(emptyTyped(), text, answers, question, dist, false);
		// ABC: AB and ABD are not anagrams, so they are rejected; BCA is one, and not a word, so it is wrong.
		expect(submit('AB').result.kind).toBe('not_anagram');
		expect(submit('ABD').result.kind).toBe('not_anagram');
		expect(submit('ABCC').result.kind).toBe('not_anagram');
		expect(submit('AB').state.wrong).toEqual([]);
		const bca = submit('bca');
		expect(bca.result.kind).toBe('wrong');
		expect(typedGrade(bca.state, ['CAB'])).toBe('missed');
		expect(submit('CAB').result.kind).toBe('found');
		// A blank stands for any one tile: AB? takes ABD, and not AXY.
		const blank = dist.parseMagpie('AB?', true);
		expect(isAnagramOf(dist.parseTyped('DAB', false), blank)).toBe(true);
		expect(isAnagramOf(dist.parseTyped('AXY', false), blank)).toBe(false);
		expect(submit('BAD', blank, ['ABS']).result.kind).toBe('wrong');
	});

	it('typed mode, every answer found and nothing wrong: Enter on an empty input reveals it correct', async () => {
		await cascade(2);
		await makeTyped();
		const p = player();
		await p.load();
		await p.enter('AB');
		await p.enter('BA');
		expect(p.v.card!.revealed).toBe(false);
		await p.enter('');
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'correct']);
	});

	it("the cascade's own answer mode decides", async () => {
		await cascade(2, { answer_mode: 'typed' });
		const p = player();
		await p.load();
		expect(p.v.card!.typed).not.toBeNull();
		await cascade(2, { answer_mode: 'flashcard' });
		const q = player();
		await q.load();
		expect(q.v.card!.typed).toBeNull();
	});

	it('set_cascade_options carries the answer mode, and nothing but flashcard or typed', async () => {
		await cascade(2);
		await applyLocally(db, { type: 'set_cascade_options', cascade_id: C, answer_mode: 'typed' });
		const read = async () => (await view.cascade(db.transaction(view.VIEW_STORES) as never, C))!.answer_mode;
		expect(await read()).toBe('typed');
		await expect(applyLocally(db, { type: 'set_cascade_options', cascade_id: C, answer_mode: 'spoken' as never })).rejects.toThrow();
	});

	it('typed mode is for anagram quizzes only', async () => {
		await cascade(2, { quiz_type: 'definition' });
		await makeTyped();
		const p = player();
		await p.load();
		expect(p.v.card!.typed).toBeNull();
		expect(await p.enter('AB')).toBeNull();
	});

	it('typed mode with alphabetical order: an entry that skips an earlier answer misses the card at once', async () => {
		await cascade(2);
		const q = (await db.get('quizzes', Q))!;
		await db.put('quizzes', { ...q, require_alphabetical: true });
		await makeTyped();
		const p = player();
		await p.load();
		// BA skips AB: out of order, and the card is missed there and then.
		expect((await p.enter('BA'))!.kind).toBe('out_of_order');
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'missed']);
	});

	it('typed mode with alphabetical order: answers in order are found', async () => {
		await cascade(2);
		const q = (await db.get('quizzes', Q))!;
		await db.put('quizzes', { ...q, require_alphabetical: true });
		await makeTyped();
		const p = player();
		await p.load();
		expect((await p.enter('AB'))!.kind).toBe('found');
		expect((await p.enter('BA'))!.kind).toBe('found');
		expect(p.v.card!.revealed).toBe(false);
		await p.enter('');
		expect([p.v.card!.revealed, p.v.card!.grade]).toEqual([true, 'correct']);
	});

	it('typed mode on a cascade whose distribution is missing needs a connection and falls back', async () => {
		await cascade(2, { dist: false });
		await makeTyped();
		const p = player();
		await p.load();
		expect(p.v.distributionMissing).toBe(true);
		expect(p.v.card!.typed).toBeNull();
	});

	it('typed mode fetches a missing distribution as the card is shown, online', async () => {
		await cascade(2, { dist: false });
		await makeTyped();
		let fetched = 0;
		const p = new Player(db, C, {
			ensure: async () => undefined,
			seed: () => '777',
			fetchDistribution: async () => {
				fetched++;
				await putDistribution();
			}
		});
		await p.load();
		expect(fetched).toBe(1);
		expect(p.v.distributionMissing).toBe(false);
		expect(p.v.card!.typed).not.toBeNull();
	});

	it('a distribution the download brings later turns the flashcard it fell back to into a typed card', async () => {
		await cascade(2, { dist: false });
		await makeTyped();
		const p = player();
		await p.load();
		expect(p.v.card!.typed).toBeNull();
		await putDistribution();
		await p.refreshCard();
		expect(p.v.distributionMissing).toBe(false);
		expect(p.v.card!.typed).not.toBeNull();
	});

	it('a QuotaExceededError from applyLocally keeps the card with the storage message until space is freed', async () => {
		await cascade(3);
		const p = player();
		await p.load();
		await p.showNext();
		const real = db.transaction.bind(db);
		let full = true;
		(db as unknown as { transaction: typeof real }).transaction = ((...a: Parameters<typeof real>) => {
			if (full && a[1] === 'readwrite') throw new DOMException('full', 'QuotaExceededError');
			return real(...a);
		}) as typeof real;
		await p.showNext();
		expect(p.v.storage).toBe(true);
		expect(p.v.card!.pos).toBe(0);
		expect(await db.count('outbox')).toBe(0);
		await p.showNext(); // Show / Next advances nothing
		expect(p.v.card!.pos).toBe(0);
		full = false;
		await p.retryStorage();
		expect(p.v.storage).toBe(false);
		expect(await ops()).toEqual(['grade', 'move_cursor']);
		expect(p.v.card!.pos).toBe(1);
	});
});

describe('controls', () => {
	it('matches strokes with their exact modifiers and protects typing', () => {
		const key = (code: string, extra: Partial<KeyboardEvent> = {}) =>
			({ code, key: code === 'Space' ? ' ' : code.replace('Key', '').toLowerCase(), ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...extra }) as KeyboardEvent;
		const s = { kind: 'key' as const, code: 'Space', ctrl: false, shift: false, alt: false, meta: false };
		expect(actionFor(DEFAULT_BINDINGS, s)).toBe('show_next');
		expect(actionFor(DEFAULT_BINDINGS, { ...s, ctrl: true })).toBeNull();
		expect(inputOwns(key('KeyT', { shiftKey: true }))).toBe(true);
		expect(inputOwns(key('Enter', { key: 'Enter' }))).toBe(true);
		expect(inputOwns(key('KeyT', { ctrlKey: true }))).toBe(false);
		expect(inputOwns(key('Escape', { key: 'Escape' }))).toBe(false);
		expect(inputOwns(key('ArrowLeft', { key: 'ArrowLeft' }))).toBe(false);
	});

	it('a stroke belongs to one action, every action keeps one binding, and Escape cannot be bound', () => {
		const x = { kind: 'key' as const, code: 'KeyX', ctrl: false, shift: false, alt: false, meta: false };
		// Enter is Show / Next by default, beside Space.
		expect(actionFor(DEFAULT_BINDINGS, { ...x, code: 'Enter' })).toBe('show_next');
		// An action holds any number: a stroke of another action moves to a fourth.
		const moved = bind(DEFAULT_BINDINGS, 'previous', x);
		expect(moved.refused).toBe(false);
		expect(moved.moved).toBe('toggle_grade');
		expect(moved.bindings.filter((b) => b.action === 'previous')).toHaveLength(4);
		expect(moved.bindings.filter((b) => b.code === 'KeyX').map((b) => b.action)).toEqual(['previous']);
		const esc = bind(DEFAULT_BINDINGS, 'previous', { ...x, code: 'Escape' });
		expect(esc.refused).toBe(true);
	});

	it('the same action twice within the repeat guard counts once', () => {
		const d = new Debounce(120);
		expect(d.pass('show_next', 1000)).toBe(true);
		expect(d.pass('show_next', 1100)).toBe(false);
		expect(d.pass('show_next', 1121)).toBe(true);
	});

	it('the repeat guard follows the setting as it changes, and 0 turns it off', () => {
		let ms = 50;
		const d = new Debounce(() => ms);
		expect(d.pass('show_next', 1000)).toBe(true);
		expect(d.pass('show_next', 1040)).toBe(false);
		expect(d.pass('show_next', 1051)).toBe(true);
		ms = 0;
		expect(d.pass('show_next', 1052)).toBe(true);
		expect(d.pass('show_next', 1052)).toBe(true);
	});
});

describe('banners', () => {
	it('say what finishing did', () => {
		const base = { level: 2, correct: 87, count: 100, misses: 13, threshold: 80, progression: 'ladder' as const, segmentChain: false };
		expect(finishBanner({ ...base, outcome: 'cleared' })).toBe('Level 2 cleared with 87%. Its 13 missed questions are now Level 2.');
		expect(finishBanner({ ...base, correct: 64, misses: 36, outcome: 'descended' })).toBe(
			'Level 2: 64%, and 80% is needed to clear. Level 2 is reshuffled and waiting. Down to Level 3 with 36 missed questions.'
		);
		expect(finishBanner({ ...base, correct: 64, misses: 36, outcome: 'replaced' })).toBe('Level 2: 64%. Replaced with its 36 missed questions.');
		expect(finishBanner({ ...base, correct: 0, outcome: 'reshuffled' })).toBe('Level 2: 0%. Reshuffled. Try again.');
		expect(finishBanner({ ...base, correct: 100, misses: 0, outcome: 'cleared' })).toBe('Level 2 cleared with 100%. Back to Level 1.');
		expect(finishBanner({ ...base, level: 1, correct: 100, misses: 0, outcome: 'completed', completion: { levels: 4, attempts: 9 } })).toBe(
			'Level 1: 100%. Cascade complete after 4 levels and 9 passes.'
		);
	});
});
