import { test, expect, type Page } from '@playwright/test';
import { AEINRST, AEINRST_WORDS, apiCascade, createCascade, lengths, newUser, playerSetting, press } from './support';

// PLAN.md § End-to-end tests: typed mode, and alphabetical order.

async function open(page: Page, player: string) {
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
}

async function type(page: Page, text: string) {
	const input = page.getByLabel('Type an answer');
	await input.fill(text);
	await input.press('Enter');
}

/**
 * Moves on from the revealed card of a one-question cascade. A correct card
 * finishes the Source quiz with no misses, so "Cascade complete" follows and is
 * dismissed; a missed one reshuffles it.
 */
async function next(page: Page, completes: boolean) {
	const input = page.getByLabel('Type an answer');
	if (await input.count()) await input.blur();
	await press(page, 'Space');
	const keep = page.getByRole('button', { name: 'Keep studying' });
	if (completes) {
		await keep.click({ timeout: 15_000 });
		await expect(keep).toHaveCount(0);
	}
	await expect(page.locator('[data-grade="correct"], [data-grade="missed"]')).toHaveCount(0);
	await expect(page.getByText('1 / 1')).toBeVisible();
	// The next card's input is focused, so its first answer can be typed with no click.
	if (await input.count()) await expect(input).toBeFocused();
}

test('typed mode', async ({ page }) => {
	test.setTimeout(240_000);
	await newUser(page, 'typed');
	const player = await apiCascade(page, { name: 'AEINRST', filters: AEINRST });
	await open(page, player);
	await playerSetting(page, 'Answer mode', 'typed');
	// Closing Settings gives the card's input the focus.
	await expect(page.getByLabel('Type an answer')).toBeFocused();
	// The found count hints at how many are left, so it is off until asked for, then sits in the status bar.
	await expect(page.getByLabel('Type an answer')).toBeVisible();
	await expect(page.getByText(/of 9 found/)).toHaveCount(0);
	await playerSetting(page, 'Show how many anagrams are found in typed mode', true);
	await expect(page.locator('footer').getByText('0 of 9 found')).toBeVisible();
	// The input sits at the bottom of the page, below the question.
	const box = (await page.getByLabel('Type an answer').boundingBox())!;
	expect(box.y).toBeGreaterThan(page.viewportSize()!.height * 0.6);

	// A word that is not an anagram of the question is rejected and left in the input to fix.
	await type(page, 'RETAINX');
	await expect(page.getByText('Not an anagram of the question')).toBeVisible();
	await expect(page.getByLabel('Type an answer')).toHaveValue('RETAINX');
	await expect(page.getByLabel('Type an answer')).not.toHaveAttribute('data-wrong');
	// It is not taken, so nothing shows as the last entry.
	const last = page.locator('[data-last-entry]');
	await expect(last).toHaveCount(0);
	// An anagram that is not an answer is wrong: the input turns red, and the word shows under it in red.
	await type(page, 'EINARST');
	await expect(page.getByLabel('Type an answer')).toHaveAttribute('data-wrong', 'true');
	await expect(page.getByLabel('Type an answer')).toHaveValue('');
	await expect(last).toHaveAttribute('data-last-entry', 'wrong');
	await expect(last).toContainText('EINARST');
	await expect(last).toHaveClass(/text-red-600/);
	// Typing again clears the red input; the last entry stays until the next one.
	await page.getByLabel('Type an answer').pressSequentially('R');
	await expect(page.getByLabel('Type an answer')).not.toHaveAttribute('data-wrong');
	await expect(last).toContainText('EINARST');
	await page.getByLabel('Type an answer').fill('');
	// Enter on an empty input reveals: missed, and the wrong word goes with the input.
	await type(page, '');
	await expect(page.locator('[data-grade="missed"]')).toBeVisible();
	await expect(page.getByText('EINARST')).toHaveCount(0);
	await next(page, false);

	// A found word shows in the answer space, bare: no hooks, inner hooks or definitions until the reveal.
	await type(page, 'retains');
	const typing = page.locator('[data-typing]');
	await expect(typing.getByRole('listitem')).toHaveCount(1);
	await expect(typing.getByRole('listitem')).toHaveText(/^\W*RETAINS\W*$/);
	await expect(page.locator('[data-answer]')).toHaveCount(1);
	// It shows under the input in green, and is the green one in the answer space.
	await expect(last).toHaveAttribute('data-last-entry', 'correct');
	await expect(last).toContainText('RETAINS');
	await expect(last).toHaveClass(/text-green-600/);
	await expect(typing.locator('[data-latest]')).toHaveText(/RETAINS/);
	// A repeated entry is ignored; two words on one line are not an anagram, and stay in the input.
	await type(page, 'RETAINS');
	await expect(page.getByText('Already entered')).toBeVisible();
	await page.getByLabel('Type an answer').fill('RETAINS NASTIER');
	await page.getByLabel('Type an answer').press('Enter');
	await expect(page.getByText('Not an anagram of the question')).toBeVisible();
	await expect(page.getByLabel('Type an answer')).toHaveValue('RETAINS NASTIER');
	// Every anagram found: the card waits for Enter on an empty input, then is correct.
	for (const w of AEINRST_WORDS.filter((w) => w !== 'RETAINS')) await type(page, w);
	await expect(page.getByText('9 of 9 found')).toBeVisible();
	// The word typed last is the green one; there is only ever one.
	await expect(typing.locator('[data-latest]')).toHaveCount(1);
	await expect(typing.locator('[data-latest]')).toHaveText(/STEARIN/);
	await expect(last).toContainText('STEARIN');
	await expect(page.locator('[data-grade]')).toHaveCount(0);
	await type(page, '');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	await next(page, true);

	// Before the reveal, a right click (Toggle) does nothing; a left click only focuses the input.
	await page.getByLabel('Type an answer').blur();
	const area = page.getByRole('application', { name: 'Quiz area' });
	await area.click({ button: 'right', position: { x: 200, y: 300 } });
	await expect(page.locator('[data-grade]')).toHaveCount(0);
	await area.click({ position: { x: 200, y: 300 } });
	await expect(page.getByLabel('Type an answer')).toBeFocused();
	await expect(page.locator('[data-grade="correct"]')).toHaveCount(0);
	// Switching modes mid-card clears the entries.
	await type(page, 'RETAINS');
	await expect(page.getByText('1 of 9 found')).toBeVisible();
	await playerSetting(page, 'Answer mode', 'flashcard');
	await playerSetting(page, 'Answer mode', 'typed');
	await expect(page.getByText('0 of 9 found')).toBeVisible();
});

test('alphabetical order in typed mode', async ({ page }) => {
	test.setTimeout(180_000);
	await newUser(page, 'alpha');
	const ordered = await apiCascade(page, { name: 'Ordered', filters: AEINRST, alphabetical: true });
	await open(page, ordered);
	await playerSetting(page, 'Answer mode', 'typed');
	// In order: correct, once Enter on an empty input finishes it.
	for (const w of AEINRST_WORDS) await type(page, w);
	await type(page, '');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
	await next(page, true);
	// Out of order: an answer that skips an earlier one misses the card at once, and says which.
	await type(page, 'ANESTRI');
	await expect(page.locator('[data-grade]')).toHaveCount(0);
	await type(page, 'NASTIER');
	await expect(page.locator('[data-grade="missed"]')).toBeVisible();
	await expect(page.getByText('Out of order: NASTIER')).toBeVisible();
	await expect(page.getByLabel('Type an answer')).toHaveCount(0);
	await next(page, false);
	// With the option off, the same sequence grades correct. This cascade is made typed: each keeps its own mode.
	const plain = await apiCascade(page, { name: 'Plain', filters: AEINRST, answer_mode: 'typed' });
	await open(page, plain);
	for (const w of ['NASTIER', 'ANTSIER', 'RATINES', 'ANESTRI', 'RETAINS', 'RETINAS', 'RETSINA', 'STAINER', 'STEARIN']) await type(page, w);
	await type(page, '');
	await expect(page.locator('[data-grade="correct"]')).toBeVisible();
});

test('a cascade made typed opens typed, with its tiles, and keeps its mode apart from the others', async ({ page }) => {
	test.setTimeout(180_000);
	await newUser(page, 'madetyped');
	const typed = await apiCascade(page, { name: 'Typed', filters: lengths(7, 7), answer_mode: 'typed' });
	await page.goto(typed);
	await expect(page.getByLabel('Type an answer')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/needs a connection/)).toHaveCount(0);
	// Every new cascade starts the same way, with flashcards.
	await createCascade(page, { name: 'Flash' });
	await expect(page.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByLabel('Type an answer')).toHaveCount(0);
	// Switching this one leaves the first typed.
	await playerSetting(page, 'Answer mode', 'typed');
	await expect(page.getByLabel('Type an answer')).toBeVisible();
	await playerSetting(page, 'Answer mode', 'flashcard');
	await page.goto(typed);
	await expect(page.getByLabel('Type an answer')).toBeVisible({ timeout: 30_000 });
});

test('an answer too tall for the screen is shrunk to fit it, definitions and all', async ({ page }) => {
	await newUser(page, 'fit');
	const player = await apiCascade(page, { name: 'Fit', filters: AEINRST });
	await page.setViewportSize({ width: 1000, height: 500 });
	await open(page, player);
	await press(page, 'Space');
	await expect(page.locator('[data-answer]')).toHaveCount(9);
	const fit = await page.locator('[data-fit-area]').evaluate((el) => ({
		scrolls: el.scrollHeight > el.clientHeight + 1,
		size: parseFloat(getComputedStyle(el.querySelector('[data-answer]')!).fontSize)
	}));
	expect(fit.scrolls).toBe(false);
	// Smaller than the 36 px it is drawn at when it fits.
	expect(fit.size).toBeLessThan(36);
});
