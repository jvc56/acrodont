import { test, expect, type Page } from '@playwright/test';
import { apiCascade, lengths, newUser, openPlayerSettings, playLevel, press } from './support';

// PLAN.md § End-to-end tests → Segments and progression.

async function settingsDialog(page: Page) {
	await openPlayerSettings(page);
	return page.getByRole('dialog', { name: 'Settings' });
}

/** The options of the level being studied, in Settings. */
async function settings(page: Page) {
	return (await settingsDialog(page)).getByRole('group', { name: /the level you are studying/ });
}

async function setSegment(page: Page, size: number) {
	const d = await settings(page);
	if (size === 0) await d.getByLabel('Study in segments').uncheck();
	else {
		await d.getByLabel('Study in segments').check();
		await d.getByLabel('Segment size', { exact: true }).fill(String(size));
		await d.getByLabel('Segment size', { exact: true }).press('Enter');
	}
	// Saved as soon as it is changed: no Save button.
	await expect(d.locator('[data-level-saved]')).toBeVisible();
	await close(page);
}

async function close(page: Page) {
	await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();
	await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
}

test('segments and progression', async ({ page }) => {
	test.setTimeout(300_000);
	await newUser(page, 'seg');
	await page.goto(await apiCascade(page, { name: 'Segments', filters: lengths(7, 7), segment_size: 5 }));
	// The status bar's two rows (PLAN.md § Desktop layout): the level, and under it the segment,
	// each as its name, pass, card and share graded, and grades.
	const rows = page.locator('[data-status-rows]');
	const bar = async () => (await rows.locator('p').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
	await expect.poll(bar, { timeout: 30_000 }).toEqual(['Level 1 of 1', 'Pass 1', '1 / 18 (0.00%)', '0 ✓ 0 ✗', 'Segment 1 of 4', 'Pass 1', '1 / 5 (0.00%)', '0 ✓ 0 ✗']);
	// Segment 1 with two misses: they are drilled at once, as the segment's second pass. The
	// Level row stays on Level 1, waiting at the next segment's first card, with the segment's grades.
	expect(await playLevel(page, (i) => i < 2)).toBe('Segment 1 of 4 done, 2 missed. Now drilling them.');
	await expect
		.poll(bar)
		.toEqual(['Level 1 of 2', 'Pass 1', '6 / 18 (27.78%)', '3 ✓ 2 ✗ (60.00%)', 'Segment 1 of 4', 'Pass 2', '1 / 2 (0.00%)', '0 ✓ 0 ✗']);
	// The segment's own percentage carries no colour: a segment has no threshold.
	await expect(rows.locator('[data-status-row="segment"] ~ p [data-on-track]')).toHaveCount(0);
	// Cleared down to nothing: back to segment 2 at the right question.
	expect(await playLevel(page, () => false)).toBe('Drill done. Back to Level 1, segment 2 of 4.');
	await expect(page.getByText('6 / 18')).toBeVisible();
	await expect
		.poll(bar)
		.toEqual(['Level 1 of 1', 'Pass 1', '6 / 18 (27.78%)', '3 ✓ 2 ✗ (60.00%)', 'Segment 2 of 4', 'Pass 1', '1 / 5 (0.00%)', '0 ✓ 0 ✗']);
	// On a phone the two names take a line each and the figures stay in columns under them.
	await page.setViewportSize({ width: 360, height: 740 });
	const [levelName, levelPass, segmentName, segmentPass] = await Promise.all(
		['[data-status-row="level"]', '[data-status-row="level"] + p', '[data-status-row="segment"]', '[data-status-row="segment"] + p'].map(async (s) => (await rows.locator(s).boundingBox())!)
	);
	expect(levelPass.y).toBeGreaterThan(levelName.y + levelName.height / 2);
	expect(segmentName.y).toBeGreaterThan(levelPass.y + levelPass.height / 2);
	expect(segmentPass.y).toBeGreaterThan(segmentName.y + segmentName.height / 2);
	expect(segmentPass.x).toBe(levelPass.x);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.setViewportSize({ width: 1280, height: 720 });
	// Previous refuses to go back into segment 1.
	await press(page, 'Backspace');
	await expect(page.getByText('6 / 18')).toBeVisible();
	// A new size mid-attempt moves the next boundary.
	await setSegment(page, 10);
	await expect(rows.getByText('Segment 1 of 2')).toBeVisible();
	await expect(rows.getByText('1 / 5')).toBeVisible();
	// Size 0: no Segment row, and Previous still refuses, with the reason.
	await setSegment(page, 0);
	await expect(rows).toHaveCount(0);
	await expect(page.getByText(/^Segment \d/)).toHaveCount(0);
	await press(page, 'Backspace');
	await expect(page.getByText('You have already finished this part of the pass.')).toBeVisible();
	// Finish the quiz: the run's misses still count.
	for (let i = 6; i <= 18; i++) {
		await expect(page.getByText(`${i} / 18`)).toBeVisible();
		// Ready once it shows unrevealed (as playLevel waits): the progress can change a moment before.
		await expect(page.locator('[data-grade="correct"], [data-grade="missed"]')).toHaveCount(0);
		await press(page, 'Space');
		await expect(page.locator('[data-grade="correct"], [data-grade="missed"]')).toBeVisible();
		await press(page, 'Space');
	}
	await expect(page.getByText('Level 1: 88%. Reshuffled, and its 2 missed questions are now Level 2.')).toBeVisible();

	// This quiz on Drill: finished below the threshold, it is replaced at the same level.
	let d = await settings(page);
	await d.getByLabel('When a quiz is finished below the clear threshold').selectOption('drill');
	await expect(d.locator('[data-level-saved]')).toBeVisible();
	await close(page);
	expect(await playLevel(page, (i) => i === 0)).toBe('Level 2: 50%. Replaced with its 1 missed questions.');
	await expect(page.getByText('Level 2 of 2')).toBeVisible();

	// The cascade on Drill: the quiz in progress keeps its own; the next new one takes it.
	const player = new URL(page.url()).pathname;
	const dialog = await settingsDialog(page);
	const levels = dialog.getByRole('group', { name: 'Levels made from now on' });
	await levels.getByLabel('When a quiz is finished below the clear threshold').selectOption('drill');
	// Saved as soon as it is changed, like every setting of the cascade; with no
	// other cascade, there is no offer to use it for all of them.
	await expect(levels.getByText('✓ Saved for this cascade')).toBeVisible();
	await expect(levels.getByText('Also use for:')).toHaveCount(0);
	await close(page);
	await expect(dialog).toHaveCount(0);
	// Written once the Cascades page's options summary says so.
	await page.goto('/cascades');
	await expect(page.getByTitle(/· drill/).first()).toBeAttached();
	await page.goto(player);
	d = await settings(page);
	await expect(d.getByLabel('When a quiz is finished below the clear threshold')).toHaveValue('ladder');
	await close(page);
	expect(await playLevel(page, () => false)).toBe('Level 2 cleared with 100%. Back to Level 1.');
	expect(await playLevel(page, (i) => i < 3)).toMatch(/^Level 1: \d+%\. Reshuffled, and its 3 missed questions are now Level 2\.$/);
	d = await settings(page);
	await expect(d.getByLabel('When a quiz is finished below the clear threshold')).toHaveValue('drill');
});
