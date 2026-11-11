import { test, expect, type Page } from '@playwright/test';
import { createCascade, newUser, openPlayerSettings, playLevel, press } from './support';

// PLAN.md § End-to-end tests → Segments and progression.

async function prefs(page: Page) {
	await openPlayerSettings(page);
	return page.getByRole('dialog', { name: 'Preferences' });
}

/** The options of the level being studied, in Preferences. */
async function settings(page: Page) {
	return (await prefs(page)).getByRole('group', { name: /the level you are studying/ });
}

async function setSegment(page: Page, size: number) {
	const d = await settings(page);
	if (size === 0) await d.getByLabel('Study in segments').uncheck();
	else {
		await d.getByLabel('Study in segments').check();
		await d.getByLabel('Segment size', { exact: true }).fill(String(size));
	}
	await d.getByRole('button', { name: 'Save this level’s options' }).click();
}

test('segments and progression', async ({ page }) => {
	test.setTimeout(300_000);
	await newUser(page, 'seg');
	await createCascade(page, { name: 'Segments', segment: 5 });
	await expect(page.getByRole('paragraph').filter({ hasText: /^run 1 of 4 · 1 of 5$/ })).toBeVisible({ timeout: 30_000 });
	// Run 1 with two misses: the drill level.
	expect(await playLevel(page, (i) => i < 2)).toBe('Run 1 of 4 done, 2 missed. Down to Level 2 to drill them.');
	await expect(page.getByText('Level 2 of 2')).toBeVisible();
	// Cleared down to nothing: back to run 2 at the right question.
	expect(await playLevel(page, () => false)).toBe('Level 2 done. Back to Level 1, run 2 of 4.');
	await expect(page.getByText('6 / 18')).toBeVisible();
	await expect(page.getByRole('paragraph').filter({ hasText: /^run 2 of 4 · 1 of 5$/ })).toBeVisible();
	// Previous refuses to go back into run 1.
	await press(page, 'Backspace');
	await expect(page.getByText('6 / 18')).toBeVisible();
	// A new size mid-attempt moves the next boundary.
	await setSegment(page, 10);
	await expect(page.getByRole('paragraph').filter({ hasText: /^run 1 of 2 · 1 of 5$/ })).toBeVisible();
	// Size 0: no run indicator, and Previous still refuses, with the reason.
	await setSegment(page, 0);
	await expect(page.getByText(/^run \d/)).toHaveCount(0);
	await press(page, 'Backspace');
	await expect(page.getByText('You have already finished this part of the pass.')).toBeVisible();
	// Finish the quiz: the run's misses still count.
	for (let i = 6; i <= 18; i++) {
		await expect(page.getByText(`${i} / 18`)).toBeVisible();
		await press(page, 'Space');
		await press(page, 'Space');
	}
	await expect(page.getByText('Level 1: 88%. Reshuffled, and its 2 missed questions are now Level 2.')).toBeVisible();

	// This quiz on Drill: finished below the threshold, it is replaced at the same level.
	let d = await settings(page);
	await d.getByLabel('When a quiz is finished below the clear threshold').selectOption('drill');
	await d.getByRole('button', { name: 'Save this level’s options' }).click();
	expect(await playLevel(page, (i) => i === 0)).toBe('Level 2: 50%. Replaced with its 1 missed questions.');
	await expect(page.getByText('Level 2 of 2')).toBeVisible();

	// The cascade on Drill: the quiz in progress keeps its own; the next new one takes it.
	const player = new URL(page.url()).pathname;
	const dialog = await prefs(page);
	const levels = dialog.getByRole('group', { name: 'Levels made from now on' });
	await levels.getByLabel('When a quiz is finished below the clear threshold').selectOption('drill');
	await levels.getByRole('button', { name: 'Save options for new levels' }).click();
	// The dialog stays open once the change is written, offering to use it more widely.
	await expect(levels.getByText('✓ Saved for this cascade')).toBeVisible();
	await expect(levels.getByRole('button', { name: 'new cascades' })).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
	// Written once the Cascades page's options summary says so.
	await page.goto('/cascades');
	await expect(page.getByText(/· drill/).first()).toBeVisible();
	await page.goto(player);
	d = await settings(page);
	await expect(d.getByLabel('When a quiz is finished below the clear threshold')).toHaveValue('ladder');
	await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Close' }).click();
	expect(await playLevel(page, () => false)).toBe('Level 2 cleared with 100%. Back to Level 1.');
	expect(await playLevel(page, (i) => i < 3)).toMatch(/^Level 1: \d+%\. Reshuffled, and its 3 missed questions are now Level 2\.$/);
	d = await settings(page);
	await expect(d.getByLabel('When a quiz is finished below the clear threshold')).toHaveValue('drill');
});
