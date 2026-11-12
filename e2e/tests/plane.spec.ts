import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCascade, idb, login, newUser, playLevel, press } from './support';

// PLAN.md § End-to-end tests → The plane: Available offline, a reload offline,
// the browser closed and reopened offline (the signed_in pointer), several
// finishes, a restore from the Trash, Synced on return, and the same state in
// a fresh browser.
test('the plane', async ({ baseURL }) => {
	test.setTimeout(300_000);
	const dir = mkdtempSync(path.join(tmpdir(), 'acrodont-plane-'));
	try {
		let context = await chromium.launchPersistentContext(dir, { baseURL });
		let page = context.pages()[0] ?? (await context.newPage());
		const { username } = await newUser(page, 'plane');
		const player = await createCascade(page, { name: 'Plane' });
		// 1. Available offline.
		await page.goto('/cascades');
		await expect(page.getByText('Available offline')).toBeVisible({ timeout: 60_000 });
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await page.reload();
		// 2. Offline, a reload.
		await context.setOffline(true);
		await page.goto(player);
		await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 20_000 });
		// 3. The browser closed and reopened, still offline: the cascade, not the login page.
		await context.close();
		context = await chromium.launchPersistentContext(dir, { baseURL, offline: true });
		page = context.pages()[0] ?? (await context.newPage());
		await page.goto('/');
		await page.goto(player);
		await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 20_000 });
		// 4. Finishes: a descent, then Level 2 cleared.
		expect(await playLevel(page, (i) => i < 2)).toMatch(/^Level 1: \d+%\. Reshuffled, and its 2 missed questions are now Level 2\.$/);
		expect(await playLevel(page, () => false)).toBe('Level 2 cleared with 100%. Back to Level 1.');
		// 5. Restore Level 2 from the Trash.
		await page.goto('/trash');
		// A group of one entry is rendered expanded.
		await page.getByRole('button', { name: 'Restore' }).first().click();
		await expect(page.getByText('The Trash is empty.')).toBeVisible();
		await page.goto(player);
		await expect(page.getByText('Level 2 of 2')).toBeVisible({ timeout: 20_000 });
		await press(page, 'Space');
		await expect(page.locator('[data-grade="correct"]')).toBeVisible();
		// The newest operation in the outbox (a cursor move replaces the pending one, so counts can stay put).
		const newest = () =>
			idb<number>(page, `const all = await req(db.transaction('outbox').objectStore('outbox').getAll()); return Math.max(0, ...all.filter((e) => e.op.type === 'move_cursor').map((e) => e.device_seq));`);
		const before = await newest();
		await press(page, 'Space');
		// The screen moves before the write is saved: leave only once this cursor move is in the outbox.
		await expect(page.getByText('2 / 2')).toBeVisible();
		await expect.poll(newest, { timeout: 10_000 }).toBeGreaterThan(before);
		// 6. Online again: Synced.
		await context.setOffline(false);
		await page.goto('/cascades');
		await expect(page.getByText('Synced')).toBeVisible({ timeout: 60_000 });
		await page.goto(player);
		await expect(page.getByText('2 / 2')).toBeVisible({ timeout: 30_000 });
		const card = await page.locator('[data-question]').first().textContent();
		await page.goto('/cascades');
		// The ladder is the last line of the cascade row's tooltip.
		const state = (await page.getByTitle(/\nL1 · 18/).getAttribute('title'))!.split('\n')[2];
		await context.close();
		// 7. A fresh browser: the same state, grades and order.
		const fresh = await chromium.launch();
		const ctx = await fresh.newContext({ baseURL });
		const p2 = await ctx.newPage();
		await login(p2, username);
		await p2.goto(player);
		await expect(p2.getByText('Level 2 of 2')).toBeVisible({ timeout: 30_000 });
		await expect(p2.getByText('2 / 2')).toBeVisible();
		// The same question order: the same card at the same place.
		await expect(p2.locator('[data-question]').first()).toHaveText(card!);
		await p2.goto('/cascades');
		const ladder = async () => (await p2.getByTitle(/\nL1 · /).getAttribute('title'))?.split('\n')[2];
		await expect.poll(ladder, { timeout: 60_000 }).toBe(state);
		await fresh.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
