import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiCascade, confirm, createCascade, idb, login, newUser, openPlayerSettings, playLevel, playerSetting, press } from './support';

// PLAN.md § End-to-end tests: the shorter journeys.

async function ready(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
}

test('leave decimals at 3 render a leave answer to three places, with no plus sign', async ({ page }) => {
	await newUser(page, 'leave');
	const player = await apiCascade(page, {
		name: 'Leaves',
		quiz_type: 'leave_value',
		filters: { op: 'and', children: [{ type: 'leave_value', negated: false, min: 30.0, max: null }] }
	});
	await page.goto(player);
	await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible({ timeout: 30_000 });
	await playerSetting(page, 'Round leave values to (decimal places)', '3');
	await press(page, 'Space');
	// A positive value has no '+'.
	await expect(page.getByText(/^\d+\.\d{3}$/)).toBeVisible();
});

test('hooks read Zyzzyva-style in lower case, and a Catalan multi-character hook reads NY', async ({ page }) => {
	await newUser(page, 'hooks');
	const port = await apiCascade(page, { name: 'Port', filters: { op: 'and', children: [{ type: 'anagram_match', negated: false, pattern: 'O P R T' }] } });
	await page.goto(port);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await playerSetting(page, 'Show hooks', true);
	await playerSetting(page, 'Show definitions', true);
	await press(page, 'Space');
	await expect(page.getByText('a harbour')).toBeVisible({ timeout: 30_000 });
	const li = page.getByRole('listitem').filter({ hasText: /PORT/ });
	await expect(li).toContainText('s');
	await expect(li).not.toContainText('SPORT');
	const catalan = await apiCascade(page, {
		name: 'Catalan',
		lexicon: 'CA-FIX',
		filters: { op: 'and', children: [{ type: 'length', negated: false, min: 1, max: 1 }] }
	});
	await page.goto(catalan);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	const a = page.getByRole('listitem').filter({ hasText: /NY/ });
	await expect(a).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('listitem').filter({ hasText: /ny/ })).toHaveCount(0);
});

test('a word row is probability, front hooks, word, back hooks, definition; the cascade and the device choose what shows', async ({ page }) => {
	await newUser(page, 'columns');
	const port = await apiCascade(page, { name: 'Port', filters: { op: 'and', children: [{ type: 'anagram_match', negated: false, pattern: 'O P R T' }] } });
	await page.goto(port);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	const word = page.locator('[data-answer]').filter({ hasText: /^\W*PORT\W*$/ });
	const definition = page.locator('[data-definition]').filter({ hasText: 'a harbour' });
	const probability = page.getByRole('listitem').filter({ hasText: /PORT/ }).locator('[data-probability]');
	const backHooks = page.getByRole('listitem').filter({ hasText: /PORT/ }).locator('[data-hooks="back"]');
	const frontHooks = page.getByRole('listitem').filter({ hasText: /PORT/ }).locator('[data-hooks="front"]');
	await expect(definition).toBeVisible({ timeout: 30_000 });
	const box = async (l: typeof word) => (await l.boundingBox())!;
	// By default the definition is a column of its own, after the back hooks on the word's line.
	let [w, d, b] = [await box(word), await box(definition), await box(backHooks)];
	expect(d.x).toBeGreaterThanOrEqual(b.x + b.width);
	// The back hooks' column is as wide as the hooks, so the definition starts just after them, centred on the word's line.
	expect(d.x - (b.x + b.width)).toBeLessThan(20);
	expect(b.width).toBeLessThan(w.width);
	expect(Math.abs(d.y + d.height / 2 - (w.y + w.height / 2))).toBeLessThan(6);
	// The word stays in the middle of the quiz area, whatever sits either side of it.
	// (Measured afresh each time: opening Settings shows the menu, which narrows the area.)
	const offCentre = async () => {
		const [word_, area] = [await box(word), (await page.locator('[data-fit-area]').first().boundingBox())!];
		return Math.abs(word_.x + word_.width / 2 - (area.x + area.width / 2));
	};
	expect(await offCentre()).toBeLessThan(3);
	// No probability order until the cascade asks for it; then it sits before the front hooks.
	await expect(probability).toHaveText('');
	await playerSetting(page, 'Show each word’s probability order', true);
	await expect(probability).toHaveText(/^\s*\d+\s*$/);
	const [p, f] = [await box(probability), await box(frontHooks)];
	expect(p.x + p.width).toBeLessThanOrEqual(f.x);
	expect(await offCentre()).toBeLessThan(3);
	// Turned off, the definition is centred under the word.
	await playerSetting(page, 'Definitions in their own column', false);
	[w, d] = [await box(word), await box(definition)];
	expect(d.y).toBeGreaterThanOrEqual(w.y + w.height - 1);
	expect(Math.abs(d.x + d.width / 2 - (w.x + w.width / 2))).toBeLessThan(3);
	await playerSetting(page, 'Definitions in their own column', true);
	// The probability order is the cascade's setting: another cascade has its own, off.
	// Its definition has a line for each part of speech, centred as a whole on the word's line.
	const exit = await apiCascade(page, { name: 'Exit', filters: { op: 'and', children: [{ type: 'anagram_match', negated: false, pattern: 'E I T X' }] } });
	await page.goto(exit);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	const parts = page.getByRole('listitem').filter({ hasText: /EXIT/ }).locator('[data-definition]');
	await expect(parts.locator('span')).toHaveText(['a way out [n -S]', 'to go out [v -ED, -ING, -S]'], { timeout: 30_000 });
	await expect(page.getByRole('listitem').filter({ hasText: /EXIT/ }).locator('[data-probability]')).toHaveText('');
	const [x, lines] = [await box(page.locator('[data-answer]').filter({ hasText: /EXIT/ })), await box(parts)];
	expect(Math.abs(lines.y + lines.height / 2 - (x.y + x.height / 2))).toBeLessThan(6);
	// Each hook column is as wide as its own widest hooks, the same for every row, and the two differ:
	// AT has front hooks enopqrv and back hook e, TA front hook e and back hooks noprx.
	const at = await apiCascade(page, { name: 'At', filters: { op: 'and', children: [{ type: 'anagram_match', negated: false, pattern: 'A T' }] } });
	await page.goto(at);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	const cell = (w: RegExp, side: string) => box(page.getByRole('listitem').filter({ has: page.locator('[data-answer]').filter({ hasText: w }) }).locator(`[data-hooks="${side}"]`));
	await expect(page.locator('[data-answer]')).toHaveCount(2, { timeout: 30_000 });
	const [atFront, taFront, atBack, taBack] = [await cell(/^\W*AT\W*$/, 'front'), await cell(/^\W*TA\W*$/, 'front'), await cell(/^\W*AT\W*$/, 'back'), await cell(/^\W*TA\W*$/, 'back')];
	expect(Math.abs(atFront.width - taFront.width)).toBeLessThan(1);
	expect(Math.abs(atBack.width - taBack.width)).toBeLessThan(1);
	expect(Math.abs(atBack.x - taBack.x)).toBeLessThan(1);
	expect(atFront.width).toBeGreaterThan(atBack.width + 10);
	// The words are still in the middle, though the hooks either side are not equally wide.
	const [ta, area] = [await box(page.locator('[data-answer]').filter({ hasText: /^\W*TA\W*$/ })), (await page.locator('[data-fit-area]').first().boundingBox())!];
	expect(Math.abs(ta.x + ta.width / 2 - (area.x + area.width / 2))).toBeLessThan(3);

	// The two sections of Settings carry no "Synced" / "Not synced" badge.
	await openPlayerSettings(page);
	const dialog = page.getByRole('dialog', { name: 'Settings' });
	await expect(dialog.getByRole('heading', { name: 'Device Settings' })).toBeVisible();
	await expect(dialog.getByText('Not synced', { exact: true })).toHaveCount(0);
	await expect(dialog.getByText('Synced', { exact: true })).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Close' }).click();
	// The sync status shows by default; hiding the status bar hides it too, and it has a setting of its own.
	const synced = page.getByText('Synced', { exact: true });
	await expect(synced).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Hide status bar' }).click();
	await expect(synced).toHaveCount(0);
	await page.getByRole('button', { name: 'Show status bar' }).click();
	await expect(synced).toBeVisible();
	await playerSetting(page, 'Show the sync status below the quiz', false);
	await expect(synced).toHaveCount(0);
	await expect(page.getByText('1 / 1')).toBeVisible();
});

test('a cascade trashed offline is listed in the Trash with "deleted forever 30 days after this syncs"', async ({ page, context }) => {
	await newUser(page, 'trashoff');
	await createCascade(page, { name: 'Offline trash' });
	await page.goto('/cascades');
	await expect(page.getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	await ready(page);
	await context.setOffline(true);
	await page.getByRole('button', { name: 'Move to Trash' }).click();
	await confirm(page, 'Move to Trash');
	await expect(page.getByRole('link', { name: 'Offline trash' })).toHaveCount(0);
	await page.goto('/trash');
	await expect(page.getByText('Offline trash (cascade in the Trash)')).toBeVisible();
	await expect(page.getByText('deleted forever 30 days after this syncs')).toBeVisible();
	await context.setOffline(false);
	await page.goto('/trash');
	await expect(page.getByText(/^deleted forever on \d/).first()).toBeVisible({ timeout: 30_000 });
});

test('Delete forever is on a trashed cascade, not on the quizzes listed under it', async ({ page }) => {
	test.setTimeout(180_000);
	await newUser(page, 'delfor');
	await createCascade(page, { name: 'Delete forever' });
	expect(await playLevel(page, (i) => i < 2)).toMatch(/^Level 1/);
	expect(await playLevel(page, () => false)).toMatch(/^Level 2 cleared/);
	await page.goto('/cascades');
	await page.getByRole('button', { name: 'Move to Trash' }).click();
	await confirm(page, 'Move to Trash');
	await expect(page.getByRole('button', { name: 'Move to Trash' })).toHaveCount(0);
	await page.goto('/trash');
	await page.getByRole('button', { name: /Delete forever \(cascade in the Trash\)/ }).click();
	const cascadeEntry = page.getByRole('listitem').filter({ hasText: /^The whole cascade/ });
	const quizEntry = page.getByRole('listitem').filter({ hasText: /^Level 2/ });
	await expect(cascadeEntry.getByRole('button', { name: 'Delete forever' })).toBeVisible();
	await expect(quizEntry.getByRole('button', { name: 'Delete forever' })).toHaveCount(0);
	await expect(quizEntry.getByRole('button', { name: 'Restore' })).toBeVisible();
});

test('offline, restoring a quiz of a cascade never opened here downloads when online, without opening it', async ({ page, browser, baseURL }) => {
	test.setTimeout(180_000);
	const { username } = await newUser(page, 'restore');
	await createCascade(page, { name: 'Never opened' });
	expect(await playLevel(page, (i) => i < 2)).toMatch(/^Level 1/);
	expect(await playLevel(page, () => false)).toMatch(/^Level 2 cleared/);
	await page.goto('/cascades');
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 });
	const other = await browser.newContext({ baseURL });
	const p2 = await other.newPage();
	await login(p2, username);
	await expect(p2.getByText('Not downloaded on this device, open to download')).toBeVisible({ timeout: 30_000 });
	await ready(p2);
	await other.setOffline(true);
	await p2.goto('/trash');
	// A group of one entry is rendered expanded.
	await expect(p2.getByText('Downloads when online.')).toBeVisible();
	await p2.getByRole('button', { name: 'Restore' }).first().click();
	await expect(p2.getByText('The Trash is empty.')).toBeVisible();
	await other.setOffline(false);
	await p2.goto('/cascades');
	await expect(p2.getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	await other.close();
});

test('keys before answers: three cascades, offline before their answers arrive, every question playable', async ({ page, context }) => {
	test.setTimeout(180_000);
	await newUser(page, 'keys');
	const players: string[] = [];
	for (const [n, len] of [['K1', 5], ['K2', 6], ['K3', 7]] as const) players.push(await createCascade(page, { name: n, min: len, max: len }));
	await ready(page);
	// Every question has arrived — the keys, first — while the answers may still be on their way.
	await expect
		.poll(() => idb<number>(page, `return (await req(db.transaction('questions').objectStore('questions').getAll())).length;`), { timeout: 60_000 })
		.toBeGreaterThanOrEqual(3);
	await expect.poll(async () => {
		let missing = 0;
		for (const p of players) {
			const id = p.split('/').pop();
			missing += await idb<number>(page, `const c = await req(db.transaction('cascades').objectStore('cascades').get(arg)); const k = await req(db.transaction('questions').objectStore('questions').index('cascade_id').count(arg)); return c.question_count - k;`, id);
		}
		return missing;
	}, { timeout: 60_000 }).toBe(0);
	await context.setOffline(true);
	for (const p of players) {
		await page.goto(p);
		await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText('This question needs a connection.')).toHaveCount(0);
		await press(page, 'Space');
		await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	}
	await context.setOffline(false);
});

test('a browser restarted with a live session syncs rather than failing CSRF', async ({ baseURL }) => {
	test.setTimeout(120_000);
	const dir = mkdtempSync(path.join(tmpdir(), 'acrodont-restart-'));
	try {
		let ctx = await chromium.launchPersistentContext(dir, { baseURL });
		let page = ctx.pages()[0] ?? (await ctx.newPage());
		await newUser(page, 'restart');
		const player = await createCascade(page, { name: 'Restart' });
		await press(page, 'Space');
		await press(page, 'Space');
		await ctx.close();
		ctx = await chromium.launchPersistentContext(dir, { baseURL });
		page = ctx.pages()[0] ?? (await ctx.newPage());
		await page.goto(player);
		await press(page, 'Space');
		await press(page, 'Space');
		await page.goto('/cascades');
		await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 });
		await ctx.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a reveal marks the card correct by default, or missed when set; settings explain themselves', async ({ page }) => {
	await newUser(page, 'reveal');
	await createCascade(page, { name: 'Reveal' });
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	await press(page, 'Space');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	await playerSetting(page, 'When an answer is revealed, mark it', 'missed');
	await press(page, 'Space');
	await expect(page.getByText('2 / 18')).toBeVisible();
	await press(page, 'Space');
	await expect(page.locator('[data-grade="missed"]')).toBeVisible();
	// Each setting says what it does behind an ⓘ beside its name: hovering shows it,
	// leaving hides it, and a click keeps it open until a click elsewhere.
	await openPlayerSettings(page);
	const settings = page.getByRole('dialog', { name: 'Settings' });
	const text = 'The score a pass needs to clear a level of this cascade';
	await expect(settings.getByText(text, { exact: false })).toHaveCount(0);
	const tip = settings.locator(`[data-info^="${text}"]`);
	await tip.hover();
	await expect(page.getByRole('tooltip')).toContainText(text);
	await settings.getByRole('heading', { name: 'Settings', exact: true }).hover();
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await tip.click();
	await settings.getByRole('heading', { name: 'Settings', exact: true }).hover();
	await expect(page.getByRole('tooltip')).toContainText(text);
	// Nothing else is written under a setting or a heading: the rest is behind ⓘs too.
	for (const more of ['drill what you missed before going on', 'come back up to clear it', 'Levels it already has keep their own']) {
		await expect(settings.getByText(more, { exact: false })).toHaveCount(0);
		await expect(settings.locator(`[data-info*="${more}"]`).first()).toBeAttached();
	}
});

