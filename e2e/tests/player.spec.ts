import { test, expect, type Page } from '@playwright/test';
import { createCascade, newUser } from './support';

// PLAN.md § Taking a quiz, § Saving progress, § Offline and Sync: study a new
// cascade with the default keys, go offline, keep studying, reload with no
// connection and resume at the current card.

/** A key press at a person's pace: the same action twice within the repeat guard (50 ms by default) counts once. */
async function press(page: Page, key: string) {
	await page.waitForTimeout(150);
	await page.keyboard.press(key);
}

test('the player studies with the default keys, offline too', async ({ page, context }) => {
	await page.goto('/login');
	await page.getByLabel('Username').fill('dev');
	await page.getByLabel('Password').fill('correct-tile-rack-bingo');
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page).toHaveURL(/\/cascades$/);
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
	await page.goto(url);
	await expect(page.getByText('3 / 18')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('1 ✓ 1 ✗')).toBeVisible();
	await context.setOffline(false);
	// Back online, the outbox drains.
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 40_000 });
});

test('the question stays put at the top, the menu hides, and display settings apply', async ({ page }) => {
	await newUser(page, 'layout');
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

	// Answers are drawn like the question by default; each can be changed.
	const answer = area.locator('[data-answer]').first();
	expect(await answer.evaluate((e) => getComputedStyle(e).fontSize)).toBe(await question.evaluate((e) => getComputedStyle(e).fontSize));
	// A cascade opens with the menu hidden; ☰ shows it.
	await expect(page.getByRole('navigation', { name: 'Player menu' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show menu' }).click();
	await page.getByRole('navigation', { name: 'Player menu' }).getByRole('button', { name: 'Preferences' }).click();
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

	// The ladder is one click away in the menu.
	await page.getByRole('button', { name: 'Levels' }).click();
	await expect(page.getByRole('list', { name: 'Ladder' })).toBeVisible();
});
