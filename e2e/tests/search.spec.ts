import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { AEINRST, AEINRST_WORDS, apiCascade, newUser, playerSetting, press } from './support';

// PLAN.md § Search page: the builder's lexicon and filter rows, listing the
// words that match on this device instead of making a cascade; downloading
// the list; searching offline once the lexicon is here; and going to it from a
// quiz with Q (Alt+Q while typing) and back, the quiz as it was left.

const pattern = (page: Page) => page.locator('[data-search]').getByLabel('Pattern').first();
const count = (page: Page) => page.locator('[data-search-count]');
const words = (page: Page) => page.locator('[data-result-word]');
/** The words listed, without the inner-hook dots drawn (hidden or not) either side. */
const listed = (page: Page) => words(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-result-word')));

test('signed out, Search is the login page, and the lexicon packs are refused', async ({ page }) => {
	await page.goto('/search');
	await expect(page).toHaveURL(/\/login$/);
	const r = await page.request.get('/api/lexicons/EN-FIX/pack');
	expect(r.status()).toBe(401);
	expect((await page.request.get('/api/lexicons/EN-FIX/pack/definitions')).status()).toBe(401);
});

test('Search lists the words that match, sorted and downloadable, and searches on offline', async ({ page, context }) => {
	test.setTimeout(120_000);
	await newUser(page, 'search');
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).click();
	await expect(page).toHaveURL(/\/search$/);
	// One Anagram Match row, its pattern empty and focused, and no error on it yet.
	await expect(page.locator('[data-search] [data-row-key]')).toHaveCount(1);
	await expect(pattern(page)).toBeFocused({ timeout: 30_000 });
	await expect(page.locator('[data-search]').getByText('Fill in each row to search.')).toBeVisible();
	// The first lexicon by name is chosen at first, as in the builder: CA-FIX on this stack.
	await page.locator('#search-lexicon').selectOption('EN-FIX');
	await pattern(page).fill('aeinrst');
	await expect(count(page)).toContainText('9 words', { timeout: 60_000 });
	// Alphagram order: one set of anagrams, alphabetical within it.
	await expect.poll(() => listed(page)).toEqual(AEINRST_WORDS);
	// Hooks and definitions, as an answer row has them.
	const retains = page.locator('[data-result-row]').filter({ has: page.locator('[data-result-word="RETAINS"]') });
	await expect(retains.locator('[data-result-definition]')).not.toBeEmpty({ timeout: 60_000 });
	// Another order keeps the words.
	await page.locator('[data-search-sort]').selectOption('probability');
	await expect(words(page)).toHaveCount(9);
	await page.locator('[data-search-sort]').selectOption('alphagram');

	// The whole list as CSV, with the columns chosen.
	await page.getByRole('button', { name: 'Download…' }).click();
	const box = page.getByRole('group', { name: 'Download' });
	await box.getByLabel('CSV').check();
	const [download] = await Promise.all([page.waitForEvent('download'), box.getByRole('button', { name: 'Download' }).click()]);
	expect(download.suggestedFilename()).toMatch(/^EN-FIX.*\.csv$/);
	const csv = readFileSync((await download.path())!, 'utf8');
	const lines = csv.trimEnd().split('\r\n');
	expect(lines[0]).toBe('word,probability_order,front_hooks,back_hooks,definition');
	expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(AEINRST_WORDS);

	// The lexicon is kept on the device: Account lists it, definitions and all.
	await expect(async () => {
		const kept = await page.evaluate(async () => {
			const dbs = await indexedDB.databases();
			const name = dbs.find((d) => d.name?.startsWith('acrodont-user-'))?.name;
			if (!name) return null;
			return new Promise<string[]>((resolve) => {
				const req = indexedDB.open(name);
				req.onsuccess = () => {
					const all = req.result.transaction('lexicon_packs').objectStore('lexicon_packs').getAllKeys();
					all.onsuccess = () => resolve(all.result as string[]);
				};
			});
		});
		expect(kept).toEqual(['EN-FIX']);
	}).toPass({ timeout: 30_000 });

	// Offline, the next search still runs: the search is on this device.
	await context.setOffline(true);
	await pattern(page).fill('aet');
	await expect(count(page)).toContainText('4 words');
	await expect.poll(() => listed(page)).toEqual(['ATE', 'EAT', 'ETA', 'TEA']);
	// ? is any single tile too, as Zyzzyva and a rack write the blank: the same words as with a dot.
	for (const any of ['ae.', 'ae?']) {
		await pattern(page).fill(any);
		await expect(count(page)).toContainText('7 words');
		await expect.poll(() => listed(page)).toEqual(['SEA', 'ATE', 'EAT', 'ETA', 'TEA', 'EAU', 'ZEA']);
	}
	await pattern(page).fill('aet');
	await expect(count(page)).toContainText('4 words');
	await context.setOffline(false);

	// The search is remembered across a reload, once it is kept.
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const name = (await indexedDB.databases()).find((d) => d.name?.startsWith('acrodont-user-'))?.name;
				return new Promise<string>((resolve) => {
					const req = indexedDB.open(name!);
					req.onsuccess = () => {
						const get = req.result.transaction('meta').objectStore('meta').get('search_state');
						get.onsuccess = () => resolve(JSON.stringify(get.result ?? null));
					};
				});
			})
		)
		.toContain('"pattern":"aet"');
	await page.reload();
	await expect(pattern(page)).toHaveValue(/aet/i, { timeout: 30_000 });
	await expect(count(page)).toContainText('4 words', { timeout: 30_000 });
	// New cascade from this search: the builder, with this lexicon and these filters, under Definition.
	await page.getByRole('button', { name: 'New cascade from this search' }).click();
	await expect(page).toHaveURL(/\/cascades\/new$/);
	await expect(page.getByRole('radio', { name: 'Definition' })).toBeChecked({ timeout: 30_000 });
	await expect(page.locator('#lexicon')).toHaveValue('EN-FIX');
	await expect(page.getByLabel('Pattern')).toHaveValue(/aet/i);
	await page.goto('/account');
	await expect(page.locator('[data-lexicon-packs]')).toContainText('EN-FIX');
	await expect(page.locator('[data-lexicon-packs]')).toContainText('with definitions');
});

test('from a quiz, Q opens the Search page with its lexicon, and Alt+Q, its button or Back return to the card as it was', async ({ page }) => {
	test.setTimeout(120_000);
	await newUser(page, 'searchq');
	const player = await apiCascade(page, { name: 'Retains', filters: AEINRST });
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	// Shown, not yet moved past: only the screen holds that, until Show / Next saves it.
	await press(page, 'Space');
	const answers = page.locator('[data-answer]');
	await expect(answers).toHaveCount(9);

	await press(page, 'q');
	// The one Search page, as the header's link opens it, told which quiz it came from.
	await expect(page).toHaveURL(/\/search\?from=/);
	await expect(page.locator('#search-lexicon')).toHaveValue('EN-FIX');
	// Straight to typing: a plain Q in the pattern box is a letter, not the way back.
	await expect(pattern(page)).toBeFocused({ timeout: 30_000 });
	await page.keyboard.type('aetq');
	await expect(pattern(page)).toHaveValue('aetq');
	await pattern(page).fill('aet');
	await expect(count(page)).toContainText('4 words', { timeout: 60_000 });
	// Alt+Q goes back from inside a box: the card as it was left, its answer still shown.
	await page.keyboard.press('Alt+q');
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await expect(answers).toHaveCount(9, { timeout: 30_000 });
	await expect(page.getByText('1 / 1')).toBeVisible();
	// Again: the search as it was left; its button goes back too.
	await press(page, 'q');
	await expect(page.locator('[data-search-layer]')).toBeVisible();
	await expect(count(page)).toContainText('4 words', { timeout: 30_000 });
	await page.getByRole('button', { name: 'Back to the quiz' }).click();
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await expect(answers).toHaveCount(9, { timeout: 30_000 });
	// And the browser's Back.
	await press(page, 'q');
	await expect(page).toHaveURL(/\/search\?from=/);
	await page.goBack();
	await expect(answers).toHaveCount(9, { timeout: 30_000 });
	// Keys pressed in Search never reached the quiz.
	await expect(page.locator('[data-grade="missed"]')).toHaveCount(0);
	// From the header there is no quiz to go back to.
	await page.goto('/search');
	await expect(pattern(page)).toBeFocused({ timeout: 30_000 });
	await expect(page.getByRole('button', { name: 'Back to the quiz' })).toHaveCount(0);
});

test('in typed mode, Alt+Q goes to Search and back with the words typed so far kept', async ({ page }) => {
	test.setTimeout(120_000);
	await newUser(page, 'searcht');
	const player = await apiCascade(page, { name: 'Retains', filters: AEINRST });
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await playerSetting(page, 'Answer mode', 'typed');
	const input = page.getByLabel('Type an answer');
	await input.focus();
	await page.keyboard.type('retains');
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-answer]').filter({ hasText: 'RETAINS' })).toBeVisible();
	// A plain Q is the answer's letter.
	await page.keyboard.press('q');
	await expect(input).toHaveValue('q');
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await input.fill('');
	await page.keyboard.press('Alt+q');
	await expect(page).toHaveURL(/\/search\?from=/);
	await expect(pattern(page)).toBeFocused({ timeout: 30_000 });
	await page.keyboard.press('Alt+q');
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await expect(page.locator('[data-answer]').filter({ hasText: 'RETAINS' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-answer]')).toHaveCount(1);
});

test('on a phone, Search is in the menu and behind a button, and Back returns to the quiz', async ({ page }) => {
	test.setTimeout(120_000);
	await newUser(page, 'searchp');
	const player = await apiCascade(page, { name: 'Retains', filters: AEINRST });
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Show menu' }).click();
	await page.getByRole('navigation', { name: 'Player menu' }).getByRole('button', { name: 'Search' }).click();
	await expect(page).toHaveURL(/\/search\?from=/);
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
	// The 🔍 button opens it too, and its button comes back.
	await page.locator('[data-open-search]').click();
	await expect(page).toHaveURL(/\/search\?from=/);
	await page.getByRole('button', { name: 'Back to the quiz' }).click();
	await expect(page).toHaveURL(new RegExp(`${player}$`));
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
});
