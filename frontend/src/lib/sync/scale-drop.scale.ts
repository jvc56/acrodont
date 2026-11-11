// PLAN.md § Scale tests: the drop pass on a 130,000-question cascade, which
// is over AUTO_KEEP_OFFLINE_ROWS and so kept automatically once opened (it
// never leaves the window by age), dropped whole by the quota path, the base
// left holding only its cascade, quiz and attempt rows. Then the pass on many
// such cascades all inside the window, every one automatically kept: it
// brings the base's rows and keys under ROW_STORAGE_BUDGET within budget,
// oldest last-open first and no more than needed, the newest still whole, and
// one more pull refetches nothing. The heavy cascade also holds five cleared
// levels inside the window: the row count before the pass counts them and the
// pass removes them too. See PQ-017 for what "still whole" is taken to mean.
//
// The single cascade runs at the plan's size. The many-cascade case runs as
// many cascades as an account may hold (MAX_CASCADES_PER_USER, 20) against
// ROW_STORAGE_BUDGET and AUTO_KEEP_OFFLINE_ROWS at a tenth (PQ-019): 56,000-
// question cascades, the heavy one with five cleared 28,000-question levels.
// At the 130,000-question cap, 20 full cascades come to well under the real
// budget, so no account reaches the pass by size alone. The size is chosen so
// the question rows alone (22.5 × SIZE rows at ROW_BYTES) stay under the tenth
// and the keys the final download adds (about 54 bytes each) take the total
// over it: then only the measured pass drops anything, as the plan's case has
// it. Rows alone over the tenth (from about 63,600) would be dropped by the
// final download's own first pass; rows and keys under it (below about
// 47,000) would give the pass nothing to do.
import { describe, expect, it, vi } from 'vitest';
import { getMeta } from '$lib/local/meta';
import { ROW_STORAGE_BUDGET, AUTO_KEEP_OFFLINE_ROWS } from './config';
import { ROW_BYTES } from './downloads';
import { policy } from './policy';
import { FakeServer } from './testing/fake-server';
import { DAY, ids, QUESTIONS, report, ScaleDev, ServerPlayer, timed } from './testing/scale';

// A tenth of the plan's limits for this file (see above).
vi.mock('./config', async (original) => {
	const c = await original<typeof import('./config')>();
	return { ...c, ROW_STORAGE_BUDGET: c.ROW_STORAGE_BUDGET / 10, AUTO_KEEP_OFFLINE_ROWS: c.AUTO_KEEP_OFFLINE_ROWS / 10 };
});

const ONE_DROP_BUDGET_MS = 120_000;
const MANY_DROP_BUDGET_MS = 120_000;
/** MAX_CASCADES_PER_USER. */
const MANY = 20;
/** See above: rows alone under a tenth of the budget, rows and keys over it. */
const SIZE = 56_000;
const CLEARED_LEVELS = 5;
const HOUR = 3_600_000;

/** The drop pass's total: rows by estimate, keys by measurement. */
async function total(d: ScaleDev) {
	const sizes = await getMeta(d.db, 'sizes');
	const keys = Object.values(sizes).reduce((n, s) => n + s.key_bytes, 0);
	return (await d.count('quiz_questions')) * ROW_BYTES + keys;
}

describe('the drop pass at 130,000 questions', () => {
	it('the quota path drops an automatically kept cascade, leaving its cascade, quiz and attempt rows', async () => {
		const server = new FakeServer();
		const { cascade, source } = ids(1);
		server.create({ id: cascade, source_id: source, count: QUESTIONS });
		const d = await ScaleDev.make(server);
		await d.open(cascade);
		await d.sync();
		expect(await d.countFor('quiz_questions', cascade)).toBe(QUESTIONS);
		// Fifteen days on it is still wanted: kept automatically for its size.
		d.now += 15 * DAY;
		const pol = await policy(d.db, new Date(d.now));
		expect(pol.autoKept.has(cascade) && pol.wanted.has(cascade)).toBe(true);
		const [, ms] = await timed(async () => d.dl.dropPass(pol, { force: true }));
		report('drop pass, one automatically kept cascade on the quota path', ms, ONE_DROP_BUDGET_MS, `${QUESTIONS} rows, keys and answers`);
		for (const s of ['quiz_questions', 'questions', 'cards'] as const) expect(await d.countFor(s, cascade)).toBe(0);
		expect(await d.db.get('cascades', cascade)).toBeDefined();
		expect(await d.db.get('quizzes', source)).toBeDefined();
		expect(await getMeta(d.db, 'budget_dropped')).toEqual([cascade]);
		expect(ms).toBeLessThanOrEqual(ONE_DROP_BUDGET_MS);
	});

	it('brings twenty automatically kept cascades under ROW_STORAGE_BUDGET, oldest first, and nothing is refetched (56,000 questions each, a tenth of the limits)', async () => {
		const server = new FakeServer();
		const all = Array.from({ length: MANY }, (_, i) => ids(i + 1));
		for (const { cascade, source } of all) server.create({ id: cascade, source_id: source, count: SIZE });
		const d = await ScaleDev.make(server);
		// Answers are beside the point here, and twenty cascades' would pass the soft limit.
		d.refuse = (c) => c.kind === 'cards';
		const t0 = d.now;
		// Opened an hour apart, the first oldest.
		for (let i = 0; i < MANY; i++) {
			d.now = t0 - (MANY - i) * HOUR;
			await d.open(all[i].cascade);
		}
		d.now = t0;
		await d.engine.sync();

		// The second-oldest also holds five cleared 150,000-question levels.
		const heavy = all[1];
		const other = new ServerPlayer(server);
		for (let l = 0; l < CLEARED_LEVELS; l++) {
			const level2 = `b0000000-0000-4000-8000-${l.toString(16).padStart(12, '0')}`;
			other.grade(heavy.cascade, heavy.source, (p) => p % 2 === 1);
			other.finish(heavy.cascade, heavy.source, BigInt(100 + l), level2);
			other.grade(heavy.cascade, level2, () => false);
			await d.engine.sync();
			await d.dl.materialiseQuiz((await d.db.get('cascades', heavy.cascade))!, (await d.db.get('quizzes', level2))!);
			other.finish(heavy.cascade, level2, BigInt(200 + l), `e0000000-0000-4000-8000-${l.toString(16).padStart(12, '0')}`);
			await d.engine.sync();
		}
		// Everything downloaded: every cascade's rows and keys.
		await d.dl.run().catch(() => undefined);
		const pol = await policy(d.db, new Date(d.now));
		expect(pol.autoKept.size).toBe(MANY);
		for (const { cascade } of all) expect(await d.countFor('questions', cascade)).toBe(SIZE);
		const heavyRows = await d.countFor('quiz_questions', heavy.cascade);
		expect(heavyRows).toBe(SIZE + CLEARED_LEVELS * (SIZE / 2));
		const sizesBefore = await getMeta(d.db, 'sizes');
		const sizeOf = new Map<string, number>();
		for (const { cascade } of all) sizeOf.set(cascade, (await d.countFor('quiz_questions', cascade)) * ROW_BYTES + (sizesBefore[cascade]?.key_bytes ?? 0));
		const over = await total(d);
		report('before the pass', 0, null, `${await d.count('quiz_questions')} rows, ${(over / 2 ** 30).toFixed(2)} GiB of ${(ROW_STORAGE_BUDGET / 2 ** 30).toFixed(2)} GiB`);
		expect(over).toBeGreaterThan(ROW_STORAGE_BUDGET);
		expect(SIZE).toBeGreaterThan(AUTO_KEEP_OFFLINE_ROWS);

		const [, ms] = await timed(async () => d.dl.dropPass(await policy(d.db, new Date(d.now))));
		const dropped = await getMeta(d.db, 'budget_dropped');
		const after = await total(d);
		report('drop pass, twenty cascades', ms, MANY_DROP_BUDGET_MS, `${dropped.length} dropped, ${(after / 2 ** 30).toFixed(2)} GiB left`);
		expect(after).toBeLessThanOrEqual(ROW_STORAGE_BUDGET);
		// Oldest last-open first, none exempt, and no more than needed:
		// the oldest, then the heavy one, then the next-oldest, until under budget.
		expect(dropped).toEqual(all.slice(0, dropped.length).map((x) => x.cascade));
		expect(after + sizeOf.get(dropped.at(-1)!)!).toBeGreaterThan(ROW_STORAGE_BUDGET);
		// The newest opened is whole.
		const newest = all[MANY - 1].cascade;
		expect(dropped).not.toContain(newest);
		expect(await d.countFor('quiz_questions', newest)).toBe(SIZE);
		expect(await d.countFor('questions', newest)).toBe(SIZE);
		// The cleared levels went with their cascade.
		expect(await d.countFor('quiz_questions', heavy.cascade)).toBe(0);
		expect(ms).toBeLessThanOrEqual(MANY_DROP_BUDGET_MS);

		// One more pull: nothing dropped is refetched, and the total stays under.
		d.calls = [];
		const before = d.requests.length;
		await d.sync().catch(() => undefined);
		const holding = [];
		for (const { cascade } of all) if ((await d.countFor('quiz_questions', cascade)) > 0) holding.push(cascade);
		expect(d.calls.filter((c) => dropped.includes(c.cascade))).toEqual([]);
		expect(d.requests[before].question_rows_for).toEqual([...holding].sort());
		expect(holding).toEqual(all.slice(dropped.length).map((x) => x.cascade));
		for (const id of dropped) expect(holding).not.toContain(id);
		expect(await getMeta(d.db, 'budget_dropped')).toEqual(dropped);
		expect(await total(d)).toBeLessThanOrEqual(ROW_STORAGE_BUDGET);
	});
});
