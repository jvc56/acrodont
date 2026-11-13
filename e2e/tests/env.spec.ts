import { test, expect, type Page } from '@playwright/test';
import { createCascade, login, newUser, playLevel, press } from './support';

// PLAN.md § End-to-end tests: the journeys that need the stack configured
// through the same --env flag a developer uses. Each tag runs in its own pass
// of `make test-e2e`, with its own stack (see the Makefile).

async function ready(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
}

// Session expiry while offline (SESSION_TTL_SECONDS short; PQ-016).
test('@env @ttl session expiry while offline', async ({ page, context }) => {
	test.setTimeout(180_000);
	const { username } = await newUser(page, 'ttl');
	const player = await createCascade(page, { name: 'Expiring' });
	await page.goto('/cascades');
	await expect(page.getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	await ready(page);
	await context.setOffline(true);
	await page.goto(player);
	// The first card first: a key pressed before the player has loaded is lost.
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	await press(page, 'Space');
	await press(page, 'Space');
	await press(page, 'Space');
	await expect(page.getByText('3 / 18')).toBeVisible();
	// Past the session's life, reconnect: Log in to sync, the work kept.
	await page.waitForTimeout(Number(process.env.E2E_TTL_WAIT_MS ?? 25_000));
	await context.setOffline(false);
	await page.goto('/cascades');
	await expect(page.getByText('Log in to sync')).toBeVisible({ timeout: 60_000 });
	await login(page, username);
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 60_000 });
	// The work reached the server: a fresh browser sees it.
	const fresh = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin });
	const p2 = await fresh.newPage();
	await login(p2, username);
	await p2.goto(player);
	await expect(p2.getByText('3 / 18')).toBeVisible({ timeout: 60_000 });
	await fresh.close();
});

// Trash and purge (TRASH_RETENTION_DAYS=0 with a short purge interval).
test('@env @purge a cleared quiz is purged and the tombstone removes it from a second browser', async ({ page, browser, baseURL }) => {
	test.setTimeout(240_000);
	const { username } = await newUser(page, 'purge');
	const player = await createCascade(page, { name: 'Purged' });
	const other = await browser.newContext({ baseURL });
	const p2 = await other.newPage();
	await login(p2, username);
	await p2.goto(player);
	await expect(p2.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	// The second browser clears the quiz itself, so it holds the cleared quiz
	// before the purge can run: with a retention of 0 days the purge follows
	// within seconds, sooner than another browser's next pull would bring it.
	expect(await playLevel(p2, (i) => i < 2)).toMatch(/^Level 1/);
	expect(await playLevel(p2, () => false)).toMatch(/^Level 2 cleared/);
	await p2.goto('/trash');
	await expect(p2.getByText(/Purged/).first()).toBeVisible({ timeout: 60_000 });
	// The purge task takes it, and the next pull's tombstone removes it.
	await expect
		.poll(
			async () => {
				await p2.goto('/trash');
				// Read once the Trash has loaded, not while it is still being read.
				await expect(p2.locator('#trash[data-loaded]')).toBeVisible({ timeout: 15_000 });
				return await p2.getByText('The Trash is empty.').isVisible();
			},
			{ timeout: 120_000, intervals: [3000] }
		)
		.toBe(true);
	await other.close();
});
