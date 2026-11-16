import { test, expect, type Page } from '@playwright/test';
import { AEINRST, apiCascade, createCascade, login, newUser, openPlayerSettings } from './support';

// PLAN.md § Settings: two kinds only, a cascade's and this device's, both in
// the cascade's Settings in the player and nowhere else. A change to a
// cascade's setting is saved for it alone, then offers to be used for every
// cascade; another cascade's settings can be copied in one go. A new cascade
// starts with the same settings as every other, and the builder says where to
// change them.

async function openPlayer(page: Page, player: string) {
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
}

/** The Cascade Settings section of an open Settings. */
const cascadeSettings = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Cascade Settings' });

async function setThreshold(page: Page, n: number) {
	await openPlayerSettings(page);
	const here = cascadeSettings(page);
	const box = here.getByLabel('Clear threshold (%)', { exact: true });
	await box.fill(String(n));
	await box.press('Tab');
	await expect(here.getByText('✓ Saved for this cascade')).toBeVisible();
	return here;
}

async function closeSettings(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Settings' });
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
}

test('a cascade’s settings: for it alone, for all cascades, or copied from another', async ({ page }) => {
	test.setTimeout(240_000);
	await newUser(page, 'scope');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	const beta = await apiCascade(page, { name: 'Beta', filters: AEINRST });

	// No settings outside a cascade: none in the header, none on the Account page,
	// and the builder only says where they are.
	await page.goto('/cascades');
	// The header is up (its account link), so a Settings link would be too.
	await expect(page.locator('header a[href="/account"]')).toBeVisible();
	await expect(page.getByRole('link', { name: /Settings|Preferences/ })).toHaveCount(0);
	await page.goto('/account');
	await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
	await expect(page.getByLabel('Show definitions')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add binding' })).toHaveCount(0);
	await page.goto('/cascades/new');
	await expect(page.locator('[data-settings-note]')).toContainText('in its Settings once it is created');
	await expect(page.getByLabel('Clear threshold (%)')).toHaveCount(0);
	await expect(page.getByLabel('Answer mode')).toHaveCount(0);
	await expect(page.getByLabel('Study in segments')).toHaveCount(0);

	// This cascade alone: the other keeps its own, and the offer is left untaken.
	await openPlayer(page, alpha);
	const here = await setThreshold(page, 60);
	await expect(here.getByRole('button', { name: 'all 2 cascades' })).toBeVisible();
	await expect(here.getByRole('button', { name: 'new cascades' })).toHaveCount(0);
	await closeSettings(page);
	await page.goto('/cascades');
	await expect(page.getByTitle(/clear at 60%/)).toHaveCount(1);
	await expect(page.getByTitle(/clear at 80%/)).toHaveCount(1);

	// Every cascade, one tap.
	await openPlayer(page, alpha);
	const again = await setThreshold(page, 70);
	await again.getByRole('button', { name: 'all 2 cascades' }).click();
	await expect(again.getByText('✓ Used for all 2 cascades')).toBeVisible();
	await closeSettings(page);
	await page.goto('/cascades');
	await expect(page.getByTitle(/clear at 70%/)).toHaveCount(2);

	// A setting only anagram cascades have offers the anagram cascades.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await cascadeSettings(page).getByLabel('Show hooks', { exact: true }).uncheck();
	await expect(cascadeSettings(page).getByText('✓ Saved for this cascade')).toBeVisible();
	await expect(cascadeSettings(page).getByRole('button', { name: 'all 2 anagram cascades' })).toBeVisible();
	// Typed, for Alpha alone.
	await cascadeSettings(page).getByLabel('Answer mode', { exact: true }).selectOption('typed');
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();

	// Beta copies Alpha's settings in one go: typed, and hooks off.
	await openPlayer(page, beta);
	await expect(page.getByLabel('Type an answer')).toHaveCount(0);
	await openPlayerSettings(page);
	const b = cascadeSettings(page);
	await expect(b.getByLabel('Show hooks', { exact: true })).toBeChecked();
	await b.getByLabel('Cascade to copy from').selectOption({ label: 'Alpha' });
	await b.getByRole('button', { name: 'Copy settings' }).click();
	await expect(b.getByText('✓ Copied 2 settings from “Alpha”.')).toBeVisible();
	await expect(b.getByLabel('Show hooks', { exact: true })).not.toBeChecked();
	await expect(b.getByLabel('Answer mode', { exact: true })).toHaveValue('typed');
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();
	// Copying again changes nothing, and says so.
	await openPlayerSettings(page);
	await cascadeSettings(page).getByLabel('Cascade to copy from').selectOption({ label: 'Alpha' });
	await cascadeSettings(page).getByRole('button', { name: 'Copy settings' }).click();
	await expect(cascadeSettings(page).getByText('✓ “Alpha” already has the same settings.')).toBeVisible();
});

// PLAN.md § Settings → Name: a cascade is renamed in its Settings, online
// only. A name another cascade has is refused under the field, as is a
// rename with no connection; a rename shows at once on this device and
// reaches the account's other device with no reload.
test('renaming a cascade, refused for a taken name and offline, reaches the other device', async ({ browser, baseURL }) => {
	test.setTimeout(180_000);
	const a = await browser.newContext({ baseURL });
	const b = await browser.newContext({ baseURL });
	const pa = await a.newPage();
	const pb = await b.newPage();
	const { username } = await newUser(pa, 'ren');
	await apiCascade(pa, { name: 'Already mine', filters: AEINRST });
	await createCascade(pa, { name: 'Rename me' });
	await expect(pa.getByText('1 / 18')).toBeVisible({ timeout: 30_000 });
	await login(pb, username);
	await expect(pb.getByText('Rename me', { exact: true })).toBeVisible({ timeout: 30_000 });

	await openPlayerSettings(pa);
	const here = cascadeSettings(pa);
	const box = here.getByLabel('Name', { exact: true });
	await expect(box).toHaveValue('Rename me');
	// Another cascade's name, the server's refusal under the field.
	await box.fill('Already mine');
	await box.press('Enter');
	await expect(here.getByText(/^You already have a cascade named “Already mine”\./)).toBeVisible({ timeout: 15_000 });
	// No connection: nothing is sent.
	await a.setOffline(true);
	await box.fill('Offline name');
	await box.press('Enter');
	await expect(here.getByText('Renaming a cascade needs a connection.')).toBeVisible();
	await a.setOffline(false);
	// Renamed.
	await box.fill('  Renamed sevens  ');
	await box.press('Enter');
	await expect(here.getByText('✓ Renamed')).toBeVisible({ timeout: 15_000 });
	await expect(box).toHaveValue('Renamed sevens');
	await closeSettings(pa);
	await pa.goto('/cascades');
	await expect(pa.getByText('Renamed sevens', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(pa.getByText('Rename me', { exact: true })).toHaveCount(0);
	// The other device, left open on its Cascades page.
	await expect(pb.getByText('Renamed sevens', { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(pb.getByText('Rename me', { exact: true })).toHaveCount(0);
	await a.close();
	await b.close();
});
