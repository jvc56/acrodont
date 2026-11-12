import { test, expect, type Page } from '@playwright/test';
import { createCascade, cursorSaved, login, newUser } from './support';

// PLAN.md § Taking a quiz, § Saving progress, § Offline and Sync: study a new
// cascade with the default keys, go offline, keep studying, reload with no
// connection and resume at the current card.

/** A key press at a person's pace: the same action twice within the repeat guard (50 ms by default) counts once. */
async function press(page: Page, key: string) {
	await page.waitForTimeout(150);
	await page.keyboard.press(key);
}

test('the player studies with the default keys, offline too', async ({ page, context }) => {
	// Its own account rather than the seeded admin: the journeys run side by side.
	await newUser(page, 'player');
	await page.goto('/cascades/new');
	await page.getByLabel('Lexicon').selectOption('EN-FIX');
	await page.getByLabel('Minimum').first().fill('7');
	await page.getByLabel('Maximum').first().fill('7');
	await expect(page.getByText('18 questions')).toBeVisible({ timeout: 15_000 });
	await page.getByRole('button', { name: 'Create Cascade' }).click();
	await expect(page).toHaveURL(/\/cascades\/[0-9a-f-]{36}$/);
	const url = page.url();

	// The first card, then its answer, with the default grade.
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 20_000 });
	await press(page, 'Space');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	await press(page, 'KeyX');
	await expect(page.locator('[data-grade="missed"]')).toBeVisible();
	await press(page, 'Space');
	await expect(page.getByText('2 / 18')).toBeVisible();
	await expect(page.getByText('0 ✓ 1 ✗')).toBeVisible();

	// Offline: studying continues, and a reload resumes at the current card.
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	await context.setOffline(true);
	await press(page, 'Space');
	await press(page, 'Space');
	await expect(page.getByText('3 / 18')).toBeVisible();
	await cursorSaved(page, 3);
	await page.goto(url);
	await expect(page.getByText('3 / 18')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('1 ✓ 1 ✗')).toBeVisible();
	await context.setOffline(false);
	// Back online, the outbox drains.
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 40_000 });
});

test('the question stays put at the top, the menu hides, and display settings apply', async ({ page, browser, baseURL }) => {
	const { username } = await newUser(page, 'layout');
	const path = await createCascade(page, { name: 'Layout' });
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 20_000 });
	const area = page.getByRole('application', { name: 'Quiz area' });
	const question = area.locator('[data-question]');
	const before = await question.boundingBox();
	// Near the top of the window, and unmoved by the reveal.
	expect(before!.y).toBeLessThan(page.viewportSize()!.height / 4);
	await press(page, 'Space');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	expect(await question.boundingBox()).toEqual(before);

	// Answers are drawn like the question by default; each can be changed. An
	// answer too tall for the screen is scaled by the player's --fit factor (the
	// cascade's shuffle can put AEINRST's nine anagrams first), so compare at it.
	const answer = area.locator('[data-answer]').first();
	const drawn = await answer.evaluate((e) => {
		const s = getComputedStyle(e);
		return { size: parseFloat(s.fontSize), fit: Number(s.getPropertyValue('--fit') || 1) };
	});
	const questionSize = parseFloat(await question.evaluate((e) => getComputedStyle(e).fontSize));
	expect(drawn.size).toBeCloseTo(questionSize * drawn.fit, 1);
	// A cascade opens with the menu hidden; ☰ shows it.
	await expect(page.getByRole('navigation', { name: 'Player menu' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show menu' }).click();
	await page.getByRole('navigation', { name: 'Player menu' }).getByRole('button', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Settings' });
	// The typeface is a choice; sizes are typed, and take effect when the field is left.
	await settings.getByRole('group', { name: 'Answers' }).getByLabel('Font').selectOption('monospace');
	await settings.getByRole('group', { name: 'Question' }).getByLabel('Size').fill('48');
	await settings.getByRole('group', { name: 'Question' }).getByLabel('Size').press('Tab');
	await page.keyboard.press('Escape');
	await expect(settings).toHaveCount(0);
	expect(await answer.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('monospace');
	expect(await question.evaluate((e) => getComputedStyle(e).fontSize)).toBe('48px');

	// The menu hides with «, and is hidden again whenever the cascade opens.
	await page.getByRole('button', { name: 'Hide menu' }).click();
	await expect(page.getByRole('navigation', { name: 'Player menu' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show menu' }).click();
	await page.goto(path);
	await expect(page.getByRole('button', { name: 'Show menu' })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole('navigation', { name: 'Player menu' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show menu' }).click();

	// Settings is the one dialog: the menu has no Levels, and the ladder is in its Cascade Settings,
	// apart from the Device Settings, each saying where it applies. There are no other kinds, and no index of them.
	const menu = page.getByRole('navigation', { name: 'Player menu' });
	await expect(menu.getByRole('link')).toHaveText(['Acrodont', 'Account']);
	await expect(menu.getByRole('button', { name: 'Levels' })).toHaveCount(0);
	await menu.getByRole('button', { name: 'Settings' }).click();
	const dialog = page.getByRole('dialog', { name: 'Settings' });
	await expect(dialog.getByRole('navigation')).toHaveCount(0);
	for (const name of ['Cascade Settings', 'Device Settings']) {
		await expect(dialog.getByRole('region', { name })).toBeVisible();
	}
	await expect(dialog.getByRole('region')).toHaveCount(2);
	// This device's controls are here too, and their reset says it is theirs alone.
	const device = dialog.getByRole('region', { name: 'Device Settings' });
	await expect(device.locator('#controls')).toBeVisible();
	await expect(device.getByRole('button', { name: 'Reset controls to defaults' })).toBeVisible();
	const levels = dialog.getByRole('region', { name: 'Cascade Settings' });
	await expect(levels.getByText(/Your other cascades keep their own/)).toBeVisible();
	await expect(device.getByText(/not synced/)).toBeVisible();
	await expect(levels.getByRole('table', { name: 'Ladder' })).toBeVisible();
	await expect(levels.getByRole('columnheader')).toHaveText(['Level', 'Questions', 'Pass', 'Last pass', 'Status', 'Actions']);
	// The clear threshold changes there, for the pass in progress too; out of range is put back.
	const threshold = levels.getByLabel('Clear threshold (%)', { exact: true });
	await expect(threshold).toHaveValue('90');
	await threshold.fill('0');
	await threshold.press('Tab');
	await expect(threshold).toHaveValue('90');
	await threshold.fill('55');
	await threshold.press('Tab');
	await expect(levels.getByText(/at least\s+55%\s+correct/)).toBeVisible();
	// Saved for this cascade alone; with no other cascade, there is no offer to use it for all of them.
	await expect(levels.getByText('✓ Saved for this cascade')).toBeVisible();
	await expect(levels.getByText('Also use for:')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
	// It syncs to another device.
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 });
	const other = await browser.newContext({ baseURL });
	const p2 = await other.newPage();
	await login(p2, username);
	await expect(p2.getByText(/clear at 55%/)).toBeVisible({ timeout: 30_000 });
	await other.close();

	// Hiding the status bar leaves the quiz area, and so its grade border, where it was.
	const quizArea = page.getByRole('application', { name: 'Quiz area' });
	const box = await quizArea.boundingBox();
	await page.getByRole('button', { name: 'Hide status bar' }).click();
	await expect(page.getByText(/^Level \d+ of \d+$/)).toHaveCount(0);
	expect(await quizArea.boundingBox()).toEqual(box);
	await page.getByRole('button', { name: 'Show status bar' }).click();
	await expect(page.getByText(/^Level \d+ of \d+$/)).toBeVisible();
	expect(await quizArea.boundingBox()).toEqual(box);
});
