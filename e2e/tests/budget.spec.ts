import { test, expect, type Page } from '@playwright/test';
import { createCascade, idb, newUser, plainCascade } from './support';

// PLAN.md § End-to-end tests: the answer limit with two automatic keeps, and
// ROW_STORAGE_BUDGET "lowered with a test constant". Each runs on its own
// stack whose frontend is built with lowered limits (the Makefile's
// ACRODONT_TEST_LIMITS passes): automatic keep above 30 rows, and either a
// 2,000-byte answer limit (@answers) or a 5,000-byte row budget (@budget).

/** A cascade's entry on the Cascades page. */
const entry = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });

const countFor = (page: Page, store: string, cascade: string) =>
	idb<number>(page, `return await req(db.transaction('${store}').objectStore('${store}').index('cascade_id').count(arg));`, cascade);

const idOf = (path: string) => path.split('/').pop()!;

test('over the answer limit with two automatic keeps @env @answers', async ({ page, context }) => {
	test.setTimeout(300_000);
	await newUser(page, 'ans');
	// Two cascades above the automatic keep, their answers together over the limit:
	// 83 questions (about 1.7 KB of answers) opened first, then 37 (about 0.9 KB).
	// The sizes are of answers without hooks or definitions, which are on by default.
	const a = idOf(await plainCascade(page, 'Answers A', 2, 4));
	await page.goto(`/cascades/${a}`);
	await expect(page.getByText('1 / 83')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades');
	await expect(entry(page, 'Answers A').getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	await page.goto(await plainCascade(page, 'Answers B', 5, 15));
	await expect(page.getByText('1 / 37')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades');
	await expect(entry(page, 'Answers B').getByText('Available offline')).toBeVisible({ timeout: 60_000 });

	// Over the limit, the pass frees the least recently opened one's answers,
	// kept automatically or not, and its questions stay (PQ-018).
	await expect.poll(() => countFor(page, 'cards', a), { timeout: 60_000 }).toBe(0);
	expect(await countFor(page, 'questions', a)).toBe(83);

	// The Account page lists both, with answer and key sizes.
	await page.goto('/account');
	await expect(page.getByRole('heading', { name: 'Cascades on this device' })).toBeVisible({ timeout: 30_000 });
	for (const name of ['Answers A', 'Answers B']) {
		const row = page.getByRole('row').filter({ hasText: name });
		await expect(row).toBeVisible({ timeout: 30_000 });
		await expect(row.getByRole('cell').filter({ hasText: /^\d+\.\d (KB|MB)$/ })).toHaveCount(2);
	}
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});

	// Offline: "answers need a connection", not a bar at nothing.
	await context.setOffline(true);
	await page.goto('/cascades');
	await expect(entry(page, 'Answers A').getByText('Answers need a connection')).toBeVisible();

	// Back online: progress again.
	await context.setOffline(false);
	await page.goto('/cascades');
	await expect(entry(page, 'Answers A').getByText(/^Downloading \d+%$/)).toBeVisible({ timeout: 60_000 });

	// Its questions still show in the player, the answer needing a connection.
	// Last, and offline: opening it makes it the most recently opened, and the
	// limit would then take the other cascade's answers instead.
	await context.setOffline(true);
	await entry(page, 'Answers A').getByRole('link', { name: 'Answers A' }).click();
	await expect(page.getByText('1 / 83')).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press('Space');
	await expect(page.getByText('Answer needs a connection.')).toBeVisible();
	await context.setOffline(false);
});

test('over ROW_STORAGE_BUDGET: unkept first, then the automatic keeps; drops stay dropped @env @budget', async ({ page, context }) => {
	test.setTimeout(420_000);
	await newUser(page, 'bud');
	// Unkept and opened first: 18 questions, about 3.7 KB of rows and keys, under the 5,000-byte budget.
	const u = idOf(await createCascade(page, { name: 'Budget U', min: 7, max: 7 }));
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades');
	await expect(entry(page, 'Budget U').getByText('Available offline')).toBeVisible({ timeout: 60_000 });

	// An automatic keep (83 questions), over the budget alone. The unkept cascade
	// goes first, before its window is out; the automatic keep holds its rows
	// while its player is open, which the pass never drops.
	const a1 = idOf(await createCascade(page, { name: 'Budget A1', min: 2, max: 4 }));
	await expect(page.getByText('1 / 83')).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => countFor(page, 'quiz_questions', u), { timeout: 60_000 }).toBe(0);
	expect(await countFor(page, 'quiz_questions', a1)).toBe(83);

	// A second automatic keep (37 questions): still over with nothing unkept left,
	// the oldest automatic keep goes once its player closes, then the next.
	await createCascade(page, { name: 'Budget A2', min: 5, max: 15 });
	await expect(page.getByText('1 / 37')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades');
	for (const name of ['Budget U', 'Budget A1', 'Budget A2']) {
		await expect(entry(page, name).getByText('Not downloaded on this device, open to download')).toBeVisible({ timeout: 60_000 });
	}

	// The storage line: the total against the lowered budget, and no cascade listed with nothing behind it.
	await page.goto('/account');
	const total = page.getByText(/^Rows and question keys: /);
	await expect(page.getByText(/^Rows and question keys: [\d.]+ KB of 4\.9 KB\.$/)).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: /Budget/ })).toHaveCount(0);
	const steady = await total.textContent();

	// Several sync cycles online: they stay dropped, the total steady, no progress coming back.
	await page.goto('/cascades');
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(10_000);
		for (const name of ['Budget U', 'Budget A1', 'Budget A2']) {
			await expect(entry(page, name).getByText('Not downloaded on this device, open to download')).toBeVisible();
			await expect(entry(page, name).getByText(/^Downloading/)).toHaveCount(0);
		}
	}
	await page.goto('/account');
	await expect(total).toHaveText(steady!);

	// Open one: it comes back whole, and while its player is open it is listed again.
	await page.goto('/cascades');
	await entry(page, 'Budget A2').getByRole('link', { name: 'Budget A2' }).click();
	await expect(page.getByText('1 / 37')).toBeVisible({ timeout: 30_000 });
	const other = await context.newPage();
	await other.goto('/cascades');
	await expect(entry(other, 'Budget A2').getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	await other.goto('/account');
	await expect(other.getByRole('row').filter({ hasText: 'Budget A2' })).toBeVisible({ timeout: 30_000 });
});
