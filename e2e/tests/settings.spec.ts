import { test, expect, type Locator, type Page } from '@playwright/test';
import { AEINRST, apiCascade, createCascade, login, newUser, openPlayerSettings } from './support';

// PLAN.md § Settings: all in the cascade's Settings in the player and nowhere
// else. A cascade's rules are its own on every device: a change is saved for
// it alone, then offers to be used for every cascade. Every other setting can
// be set in four places (§ Where a setting applies), which two switches under
// it choose: a change saves where they point, this cascade on this device until
// they are switched, and the first place holding a value is used. Another cascade's rules and own settings can be
// copied in one go. A new cascade starts with the same rules as every other,
// and the builder says where to change them.

async function openPlayer(page: Page, player: string) {
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
}

/** The This Cascade section of an open Settings: the name, the ladder and the rules. */
const cascadeSettings = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'This Cascade' });
/** The Answers section of an open Settings. */
const answers = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Answers' });
/** One setting's row, with its two switches: which cascades, which devices. */
const setting = (page: Page, key: string) => page.getByRole('dialog', { name: 'Settings' }).locator(`[data-setting="${key}"]`);
/** The switches of a row, whose `data-source` is the place its value comes from, or `default`. */
const switches = (row: Locator) => row.locator('[data-places]');

/** The halves of a row's switches that are pressed. */
async function expectSides(row: Locator, cascades: 'this' | 'all', devices: 'this' | 'all') {
	await expect(row.locator('[data-axis="cascades"] [aria-pressed="true"]')).toHaveAttribute('data-side', cascades);
	await expect(row.locator('[data-axis="devices"] [aria-pressed="true"]')).toHaveAttribute('data-side', devices);
}

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

test('a cascade’s rules: for it alone or for all cascades; its rules and own settings copied from another', async ({ page }) => {
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

	// An answer setting's switches start at this cascade on this device, and a change saves there.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	const hooks = setting(page, 'show_hooks');
	await expect(switches(hooks)).toHaveAttribute('data-source', 'default');
	await expectSides(hooks, 'this', 'this');
	await expect(hooks.getByRole('button', { name: 'Reset' })).toHaveCount(0);
	await answers(page).getByLabel('Show hooks', { exact: true }).uncheck();
	await expect(switches(hooks)).toHaveAttribute('data-source', 'both');
	// Moved to the cascade's own settings, on every device.
	await hooks.getByRole('button', { name: 'all devices', exact: true }).click();
	await expect(switches(hooks)).toHaveAttribute('data-source', 'cascade');
	await expectSides(hooks, 'this', 'all');
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).not.toBeChecked();
	// Typed, for Alpha on every device: switched first, then changed.
	const mode = setting(page, 'answer_mode');
	await mode.getByRole('button', { name: 'all devices', exact: true }).click();
	await expect(switches(mode)).toHaveAttribute('data-source', 'default');
	await expectSides(mode, 'this', 'all');
	await answers(page).getByLabel('Answer mode', { exact: true }).selectOption('typed');
	await expect(switches(mode)).toHaveAttribute('data-source', 'cascade');
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();

	// Beta copies Alpha's rules and own settings in one go: typed, and hooks off.
	await openPlayer(page, beta);
	await expect(page.getByLabel('Type an answer')).toHaveCount(0);
	await openPlayerSettings(page);
	const b = cascadeSettings(page);
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).toBeChecked();
	await b.getByLabel('Cascade to copy from').selectOption({ label: 'Alpha' });
	await b.getByRole('button', { name: 'Copy settings' }).click();
	await expect(b.getByText('✓ Copied 2 settings from “Alpha”.')).toBeVisible();
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).not.toBeChecked();
	await expect(answers(page).getByLabel('Answer mode', { exact: true })).toHaveValue('typed');
	await expect(switches(setting(page, 'answer_mode'))).toHaveAttribute('data-source', 'cascade');
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

// PLAN.md § Settings → Where a setting applies: a value can be set for this
// cascade on this device, this cascade, this device, or everywhere, as a row's
// two switches choose, and the first of those holding one is used. A change
// saves where the switches point; switching moves the value; Reset takes it
// out of its place. "Everywhere" reaches the account's other devices, and so
// does taking it out there.
test('a setting in four places: the first that holds a value is used, on every device', async ({ page, browser, baseURL }) => {
	test.setTimeout(240_000);
	const { username } = await newUser(page, 'places');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	const beta = await apiCascade(page, { name: 'Beta', filters: AEINRST });
	const size = (p: Page) => p.getByRole('dialog', { name: 'Settings' }).locator('#display-question_size_px');
	const row = (p: Page) => setting(p, 'question_size_px');
	const source = (p: Page) => switches(row(p));
	async function setSize(p: Page, n: number, place: string) {
		await size(p).fill(String(n));
		await size(p).press('Tab');
		await expect(source(p)).toHaveAttribute('data-source', place);
	}

	// Alpha alone on this device: Beta keeps the default.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await expect(source(page)).toHaveAttribute('data-source', 'default');
	await expectSides(row(page), 'this', 'this');
	await setSize(page, 44, 'both');
	await closeSettings(page);
	await openPlayer(page, beta);
	await openPlayerSettings(page);
	await expect(size(page)).toHaveValue('36');

	// Beta's switches pointed at every cascade first: its 48 is this device's. Alpha's narrower 44 still wins there.
	await row(page).getByRole('button', { name: 'all cascades', exact: true }).click();
	await expectSides(row(page), 'all', 'this');
	await setSize(page, 48, 'device');
	await closeSettings(page);
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await expect(size(page)).toHaveValue('44');
	await expect(source(page)).toHaveAttribute('data-source', 'both');
	// Reset Alpha's own: this device's 48 shows through, and the switches with it.
	await row(page).getByRole('button', { name: 'Reset' }).click();
	await expect(size(page)).toHaveValue('48');
	await expect(source(page)).toHaveAttribute('data-source', 'device');
	await expectSides(row(page), 'all', 'this');

	// Moved to every device, then changed there: it reaches the other device.
	await row(page).getByRole('button', { name: 'all devices', exact: true }).click();
	await expect(source(page)).toHaveAttribute('data-source', 'all');
	await expect(size(page)).toHaveValue('48');
	await setSize(page, 52, 'all');
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 });
	const other = await browser.newContext({ baseURL });
	const p2 = await other.newPage();
	await login(p2, username);
	await openPlayer(p2, beta);
	await openPlayerSettings(p2);
	await expect(size(p2)).toHaveValue('52', { timeout: 30_000 });
	await expect(source(p2)).toHaveAttribute('data-source', 'all');
	await expectSides(row(p2), 'all', 'all');
	// Reset there: the default again, here too once this device has synced.
	await row(p2).getByRole('button', { name: 'Reset' }).click();
	await expect(size(p2)).toHaveValue('36');
	await expectSides(row(p2), 'all', 'all');
	await expect(size(page)).toHaveValue('36', { timeout: 30_000 });
	await expect(source(page)).toHaveAttribute('data-source', 'default');
	await other.close();
});
