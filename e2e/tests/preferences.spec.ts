import { test, expect, type Page } from '@playwright/test';
import { AEINRST, apiCascade, newUser, openPlayerSettings } from './support';

// PLAN.md § Preferences → Where a setting applies: a cascade's own setting
// changes for it alone, then offers to be used for new cascades or for every
// cascade; a default changed on the Preferences page offers the cascades you
// already have the same value. The Preferences page is in the header, apart
// from the Account page.

async function openPlayer(page: Page, player: string) {
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
}

async function setThreshold(page: Page, n: number) {
	await openPlayerSettings(page);
	const here = page.getByRole('dialog', { name: 'Preferences' }).getByRole('region', { name: 'This cascade' });
	const box = here.getByLabel('Clear threshold (%)', { exact: true });
	await box.fill(String(n));
	await box.press('Tab');
	await expect(here.getByText('✓ Saved for this cascade')).toBeVisible();
	return here;
}

async function closeSettings(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Preferences' });
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
}

test('where a setting applies', async ({ page }) => {
	test.setTimeout(240_000);
	await newUser(page, 'scope');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	await apiCascade(page, { name: 'Beta', filters: AEINRST });

	// Preferences is its own page in the header; the Account page has none.
	await page.goto('/cascades');
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Preferences' }).click();
	await expect(page).toHaveURL(/\/preferences$/);
	for (const name of ['Every cascade', 'New cascades', 'This device']) await expect(page.getByRole('region', { name })).toBeVisible();
	await expect(page.getByRole('region', { name: 'This device' }).getByRole('button', { name: 'Add binding' }).first()).toBeVisible();
	await page.goto('/account');
	await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
	await expect(page.getByLabel('Show definitions with anagrams')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add binding' })).toHaveCount(0);

	// This cascade alone, then new cascades too: the other cascade keeps its own.
	await openPlayer(page, alpha);
	const here = await setThreshold(page, 60);
	await here.getByRole('button', { name: 'new cascades' }).click();
	await expect(here.getByText('✓ Used for new cascades')).toBeVisible();
	await closeSettings(page);
	await page.goto('/preferences');
	await expect(page.getByLabel('Default clear threshold (%)')).toHaveValue('60');
	await page.goto('/cascades');
	await expect(page.getByText(/clear at 60%/)).toHaveCount(1);
	await expect(page.getByText(/clear at 80%/)).toHaveCount(1);

	// Every cascade, which takes in new ones too.
	await openPlayer(page, alpha);
	const again = await setThreshold(page, 70);
	await again.getByRole('button', { name: 'all 2 cascades and new ones' }).click();
	await expect(again.getByText('✓ Used for all 2 cascades and new ones')).toBeVisible();
	await expect(again.getByRole('button', { name: 'new cascades' })).toHaveCount(0);
	await closeSettings(page);
	await page.goto('/cascades');
	await expect(page.getByText(/clear at 70%/)).toHaveCount(2);
	await page.goto('/preferences');
	await expect(page.getByLabel('Default clear threshold (%)')).toHaveValue('70');

	// A default changed on the Preferences page offers the cascades you already have the same value.
	const defaults = page.getByRole('region', { name: 'New cascades' });
	await defaults.getByLabel('Default answer mode for new anagram cascades').selectOption('typed');
	await expect(defaults.getByText('✓ Saved for new cascades')).toBeVisible();
	await defaults.getByRole('button', { name: 'all 2 anagram cascades you have' }).click();
	await expect(defaults.getByText('✓ Used for all 2 anagram cascades')).toBeVisible();
	await openPlayer(page, alpha);
	await expect(page.getByLabel('Type an answer')).toBeVisible();
});
