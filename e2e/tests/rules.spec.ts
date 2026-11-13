import { test, expect } from '@playwright/test';
import { createCascade, newUser, playLevel } from './support';

// PLAN.md § End-to-end tests → The journeys: "Register, confirm, log in, create
// an anagram cascade with a 90% threshold, and see every cascade rule applied
// as expected".
test('every cascade rule, from a new account', async ({ page }) => {
	test.setTimeout(180_000);
	await newUser(page, 'rules');
	await createCascade(page, { name: 'Rules' });
	// Level 1 (18 questions) below the threshold: down to Level 2 with the 10 misses.
	expect(await playLevel(page, (i) => i < 10)).toBe('Level 1: 44%. Reshuffled, and its 10 missed questions are now Level 2.');
	// Level 2 cleared with a miss: replaced at Level 2.
	expect(await playLevel(page, (i) => i === 0)).toBe('Level 2 cleared with 90%. Its 1 missed questions are now Level 2.');
	// Cleared with no misses: back up to Level 1's reshuffled quiz.
	expect(await playLevel(page, () => false)).toBe('Level 2 cleared with 100%. Back to Level 1.');
	// Level 1 with no misses: the completion screen.
	expect(await playLevel(page, () => false)).toBe('Level 1: 100%. Cascade complete after 2 levels and 4 passes.');
	await expect(page.getByRole('dialog', { name: 'Cascade complete' })).toBeVisible();
	await page.getByRole('button', { name: 'Start over' }).click();
	await expect(page.getByText('Level 1 of 1')).toBeVisible();
	await expect(page.getByText('1 / 18')).toBeVisible();
	await expect(page.getByRole('paragraph').filter({ hasText: /^Pass 3$/ })).toBeVisible();
});
