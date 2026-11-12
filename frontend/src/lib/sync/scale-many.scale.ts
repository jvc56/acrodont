// PLAN.md § Scale tests: an account with no cascade count limit (PLAN.md §
// Storage limit). Nothing paginated the Cascades page or the Trash while
// twenty was the most an account could hold: with 500 cascades, all on the
// device, the page's summaries and the Trash's groups are each read within a
// budget, so neither page waits on a long list.
import { describe, expect, it } from 'vitest';
import { cascadeSummaries, trashGroups } from '$lib/cascades/summary';
import { FakeServer } from './testing/fake-server';
import { ids, report, ScaleDev, timed } from './testing/scale';

const MANY = 500;
const SIZE = 200;
const SUMMARIES_BUDGET_MS = 10_000;
const TRASH_BUDGET_MS = 10_000;

describe('an account of 500 cascades', () => {
	it('the Cascades page and the Trash read them within budget', async () => {
		const server = new FakeServer();
		const all = Array.from({ length: MANY }, (_, i) => ids(i + 1));
		for (const { cascade, source } of all) server.create({ id: cascade, source_id: source, count: SIZE });
		const d = await ScaleDev.make(server);
		await d.open(...all.map((c) => c.cascade));
		await d.sync();
		expect(await d.count('cascades')).toBe(MANY);

		const [list, ms] = await timed(() => cascadeSummaries(d.db, true));
		report('Cascades page summaries, 500 cascades', ms, SUMMARIES_BUDGET_MS, `${list.length} rows`);
		expect(list).toHaveLength(MANY);
		expect(list.every((s) => s.cascade.storage_bytes > 0)).toBe(true);
		expect(ms).toBeLessThan(SUMMARIES_BUDGET_MS);

		const [groups, tms] = await timed(() => trashGroups(d.db));
		report('Trash groups, 500 cascades', tms, TRASH_BUDGET_MS, `${groups.length} groups`);
		expect(tms).toBeLessThan(TRASH_BUDGET_MS);
	}, 600_000);
});
