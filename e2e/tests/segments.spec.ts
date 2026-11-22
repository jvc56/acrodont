import { test, expect, type Page } from '@playwright/test';
import { apiCascade, lengths, newUser, openPlayerSettings, playLevel, press } from './support';

// PLAN.md § End-to-end tests → Segments and progression.

async function settingsDialog(page: Page) {
	await openPlayerSettings(page);
	return page.getByRole('dialog', { name: 'Settings' });
}

/** The cascade's own section of Settings, which holds its quiz options: every level reads them. */
async function settings(page: Page) {
	return (await settingsDialog(page)).getByRole('region', { name: 'This Cascade' });
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
	await expect(d.getByText('✓ Saved for this cascade')).toBeVisible();
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
	// What the bar shows: on a phone the pass is in the name, and its own cell is hidden.
	const bar = () => rows.locator('p').evaluateAll((ps) => ps.filter((p) => p.checkVisibility()).map((p) => (p as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
	await expect.poll(bar, { timeout: 30_000 }).toEqual(['Level 1 of 1', 'Pass 1', '1 / 18 (0.00%)', '0 ✓ 0 ✗', 'Segment 1 of 4', 'Pass 1', '1 / 5 (0.00%)', '0 ✓ 0 ✗']);
	// One card graded: the level's percentage is coloured by its threshold, and the
	// segment's own, now shown, carries no colour: a segment has no threshold.
	await expect(page.locator('[data-grade="correct"], [data-grade="missed"]')).toHaveCount(0);
	await press(page, 'Space');
	await expect(page.locator('[data-grade="correct"], [data-grade="missed"]')).toBeVisible();
	await press(page, 'Space');
	const segmentGrades = rows.locator('[data-status-row="segment"] ~ p').last();
	await expect(segmentGrades).toContainText('1 ✓ 0 ✗ (100.00%)');
	await expect(rows.locator('[data-on-track]')).toHaveCount(1);
	await expect(segmentGrades.locator('[data-on-track]')).toHaveCount(0);
	// Segment 1 with two misses: they are drilled at once, as the segment's second pass. The
	// Level row stays on Level 1, waiting at the next segment's first card, with the segment's grades.
	expect(await playLevel(page, (i) => i < 2)).toBe('Segment 1 of 4 done, 2 missed. Now drilling them.');
	await expect
		.poll(bar)
		.toEqual(['Level 1 of 2', 'Pass 1', '6 / 18 (27.78%)', '3 ✓ 2 ✗ (60.00%)', 'Segment 1 of 4', 'Pass 2', '1 / 2 (0.00%)', '0 ✓ 0 ✗']);
	// Cleared down to nothing: back to segment 2 at the right question.
	expect(await playLevel(page, () => false)).toBe('Drill done. Back to Level 1, segment 2 of 4.');
	await expect(page.getByText('6 / 18')).toBeVisible();
	await expect
		.poll(bar)
		.toEqual(['Level 1 of 1', 'Pass 1', '6 / 18 (27.78%)', '3 ✓ 2 ✗ (60.00%)', 'Segment 2 of 4', 'Pass 1', '1 / 5 (0.00%)', '0 ✓ 0 ✗']);
	// On a phone each row's name, with its pass, takes a line of its own, and the position
	// and grades share the line under it; on a screen too narrow for both, the grades go
	// under the position. Either way the figures stay in columns and nothing runs off the
	// bar. The resize swaps the desktop layout for the phone's, which renders the status bar
	// again: measured mid-swap, a row is detached and has no box, so the check is retried.
	for (const [width, stacked] of [
		[360, false],
		[240, true]
	] as const) {
		await page.setViewportSize({ width, height: 740 });
		await expect(async () => {
			expect(await bar()).toEqual(['Level 1 of 1 · Pass 1', '6 / 18 (27.78%)', '3 ✓ 2 ✗ (60.00%)', 'Segment 2 of 4 · Pass 1', '1 / 5 (0.00%)', '0 ✓ 0 ✗']);
			const [levelName, levelAt, levelGrades, segmentName, segmentAt, segmentGrades, footer] = await Promise.all(
				[
					rows.locator('[data-status-row="level"]'),
					rows.locator('[data-status-row="level"] + p + p'),
					rows.locator('[data-status-row="level"] + p + p + p'),
					rows.locator('[data-status-row="segment"]'),
					rows.locator('[data-status-row="segment"] + p + p'),
					rows.locator('[data-status-row="segment"] + p + p + p'),
					rows.locator('xpath=ancestor::footer')
				].map((l) => l.boundingBox({ timeout: 1_000 }))
			);
			if (!levelName || !levelAt || !levelGrades || !segmentName || !segmentAt || !segmentGrades || !footer) throw new Error('a status row has no box yet');
			const below = (a: typeof levelName, b: typeof levelName) => expect(a.y).toBeGreaterThan(b.y + b.height / 2);
			below(levelAt, levelName);
			if (stacked) {
				below(levelGrades, levelAt);
				expect(levelGrades.x).toBe(levelAt.x);
			} else {
				expect(levelGrades.y).toBe(levelAt.y);
				expect(levelGrades.x).toBeGreaterThan(levelAt.x + levelAt.width);
			}
			below(segmentName, levelGrades);
			below(segmentAt, segmentName);
			expect(segmentAt.x).toBe(levelAt.x);
			expect(segmentGrades.x).toBe(levelGrades.x);
			for (const b of [levelName, levelAt, levelGrades, segmentName, segmentAt, segmentGrades]) expect(b.x + b.width).toBeLessThanOrEqual(footer.x + footer.width);
			// Only at a real phone's width: at 240px the rest of the player is not made to fit.
			if (width === 360) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			// The banner, still up until Show, follows the question instead of covering it.
			const [question, banner] = await Promise.all(
				[page.locator('[data-question]'), page.getByRole('status').filter({ hasText: 'Drill done' })].map((l) => l.boundingBox({ timeout: 1_000 }))
			);
			if (!question || !banner) throw new Error('the question or the banner has no box yet');
			expect(banner.y).toBeGreaterThanOrEqual(question.y + question.height);
		}).toPass({ timeout: 10_000 });
	}
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

	// The cascade on Drill: the level in progress follows it at once; finished below the threshold, it is replaced at the same level.
	let d = await settings(page);
	await d.getByLabel('When a quiz is finished below the clear threshold').selectOption('drill');
	// Saved as soon as it is changed, like every rule of the cascade; with no
	// other cascade, there is no offer to use it for all of them.
	await expect(d.getByText('✓ Saved for this cascade')).toBeVisible();
	await expect(d.getByText('Also use for:')).toHaveCount(0);
	await close(page);
	expect(await playLevel(page, (i) => i === 0)).toBe('Level 2: 50%. Replaced with its 1 missed question.');
	await expect(page.getByText('Level 2 of 2')).toBeVisible();
	// The Cascades page's options summary says so.
	const player = new URL(page.url()).pathname;
	await page.goto('/cascades');
	await expect(page.getByTitle(/· drill/).first()).toBeAttached();
	await page.goto(player);
	// Ladder again: every level follows it, the replacement made under Drill too.
	d = await settings(page);
	await expect(d.getByLabel('When a quiz is finished below the clear threshold')).toHaveValue('drill');
	await d.getByLabel('When a quiz is finished below the clear threshold').selectOption('ladder');
	await expect(d.getByText('✓ Saved for this cascade')).toBeVisible();
	await close(page);
	expect(await playLevel(page, () => false)).toBe('Level 2 cleared with 100%. Back to Level 1.');
	expect(await playLevel(page, (i) => i < 3)).toMatch(/^Level 1: \d+%\. Reshuffled, and its 3 missed questions are now Level 2\.$/);
	expect(await playLevel(page, (i) => i < 2)).toMatch(
		/^Level 2: [\d.]+%, and 80% is needed to clear\. Level 2 is reshuffled and waiting\. Down to Level 3 with 2 missed questions\.$/
	);
});
