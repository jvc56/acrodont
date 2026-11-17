import { test, expect, type Locator, type Page } from '@playwright/test';
import { AEINRST, apiCascade, confirm, createCascade, login, newUser, openPlayerSettings } from './support';

// PLAN.md § Settings: all in the cascade's Settings in the player and nowhere
// else. A cascade's rules are its own on every device: a change is saved for
// it alone, then offers to be used for every cascade. Every other setting is
// each cascade's own on each device (§ Where a setting applies): a change is
// saved for this cascade on this device, then offers to be made for this
// cascade on all devices, all cascades on this device, or all cascades on all
// devices; the latest change covering a cascade on a device is used. Presets
// (§ Presets) save a cascade's settings and rules under a name, to apply to
// another cascade or to start a new one with in the builder.

async function openPlayer(page: Page, player: string) {
	await page.goto(player);
	await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 30_000 });
}

/** The This Cascade section of an open Settings: the name, the ladder, the rules and the presets. */
const cascadeSettings = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'This Cascade' });
/** The Presets group of an open Settings. */
const presets = (page: Page) => cascadeSettings(page).locator('[data-presets]');
/** The Answers section of an open Settings. */
const answers = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Answers' });
/** One setting's row, whose `data-source` is the scope of the change its value comes from, or `default`. */
const setting = (page: Page, key: string) => page.getByRole('dialog', { name: 'Settings' }).locator(`[data-setting="${key}"]`);

async function expectSource(row: Locator, source: string) {
	await expect(row).toHaveAttribute('data-source', source);
}

async function setThreshold(page: Page, n: number) {
	await openPlayerSettings(page);
	const here = cascadeSettings(page);
	const box = here.getByLabel('Clear threshold (%)', { exact: true });
	await box.fill(String(n));
	await box.press('Tab');
	await expect(here.getByText('✓ Saved for this cascade', { exact: true })).toBeVisible();
	return here;
}

async function closeSettings(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Settings' });
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
}

/** Save as preset, under `name`. */
async function saveAs(page: Page, name: string) {
	const p = presets(page);
	await p.getByLabel('New preset’s name').fill(name);
	await p.getByRole('button', { name: 'Save as preset' }).click();
}

/** Apply preset `name`. */
async function apply(page: Page, name: string) {
	const p = presets(page);
	await p.getByLabel('Preset to apply').selectOption({ label: name });
	await p.getByRole('button', { name: 'Apply preset' }).click();
}

test('a cascade’s rules for it alone or all; presets saved, applied, replaced, renamed and deleted, and chosen in the builder', async ({ page }) => {
	test.setTimeout(300_000);
	await newUser(page, 'scope');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	const beta = await apiCascade(page, { name: 'Beta', filters: AEINRST });

	// No settings outside a cascade: none in the header, none on the Account page,
	// and the builder has only the preset to start from.
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
	await expect(page.locator('[data-preset-select] option')).toHaveText(['Defaults']);
	await expect(page.getByLabel('Clear threshold (%)')).toHaveCount(0);
	await expect(page.getByLabel('Answer mode')).toHaveCount(0);
	await expect(page.getByLabel('Study in segments')).toHaveCount(0);

	// This cascade alone: the other keeps its own, and the offer is left untaken.
	await openPlayer(page, alpha);
	const here = await setThreshold(page, 60);
	await expect(here.getByRole('button', { name: 'all 2 cascades' })).toBeVisible();
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

	// An answer setting is saved for this cascade on this device, then offered more widely.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	const hooks = setting(page, 'show_hooks');
	await expectSource(hooks, 'default');
	await expect(hooks.locator('[data-offer]')).toHaveCount(0);
	await answers(page).getByLabel('Show hooks', { exact: true }).uncheck();
	await expectSource(hooks, 'both');
	await expect(hooks.getByText('✓ Saved for this cascade on this device')).toBeVisible();
	await hooks.getByRole('button', { name: 'this cascade on all devices' }).click();
	await expect(hooks.getByText('✓ Applied to this cascade on all devices')).toBeVisible();
	await expectSource(hooks, 'cascade');
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).not.toBeChecked();
	// Typed, for Alpha on this device.
	await answers(page).getByLabel('Answer mode', { exact: true }).selectOption('typed');
	await expectSource(setting(page, 'answer_mode'), 'both');

	// Saved as a preset: Alpha's settings as they are here, and its rules.
	await saveAs(page, 'Typed');
	await expect(presets(page).getByText('✓ Saved “Typed”.')).toBeVisible({ timeout: 15_000 });
	await expect(presets(page).locator('[data-preset="Typed"]')).toBeVisible();
	// Defaults is the built-in preset's name.
	await saveAs(page, 'defaults');
	await expect(presets(page).getByText('“Defaults” is the built-in preset’s name.')).toBeVisible();
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();

	// Beta takes the preset in one go: typed, and hooks off; again, and nothing changes.
	await openPlayer(page, beta);
	await expect(page.getByLabel('Type an answer')).toHaveCount(0);
	await openPlayerSettings(page);
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).toBeChecked();
	await apply(page, 'Typed');
	await expect(presets(page).getByText('✓ Applied “Typed”: 2 settings changed.')).toBeVisible();
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).not.toBeChecked();
	await expect(answers(page).getByLabel('Answer mode', { exact: true })).toHaveValue('typed');
	await expectSource(setting(page, 'answer_mode'), 'both');
	await expect(presets(page).getByRole('button', { name: 'all 2 cascades on this device' })).toBeVisible();
	await apply(page, 'Typed');
	await expect(presets(page).getByText('✓ This cascade already matches “Typed”.')).toBeVisible();
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();

	// The builder lists it; a cascade made with it starts typed, with its rules.
	await page.goto('/cascades/new');
	await expect(page.locator('[data-preset-select] option')).toHaveText(['Defaults', 'Typed']);
	const gamma = await createCascade(page, { name: 'Gamma', preset: 'Typed' });
	await expect(page.getByLabel('Type an answer')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades');
	await expect(page.getByTitle(/clear at 70%/)).toHaveCount(3);
	// The builder starts at the preset used last.
	await page.goto('/cascades/new');
	await expect(page.locator('[data-preset-select]')).toHaveValue(/[0-9a-f-]{36}/);

	// Defaults puts Beta back: its settings, and its rules, which offer to go to every cascade.
	await openPlayer(page, beta);
	await openPlayerSettings(page);
	await apply(page, 'Defaults');
	await expect(presets(page).getByText('✓ Applied “Defaults”: 3 settings changed.')).toBeVisible();
	await expect(answers(page).getByLabel('Show hooks', { exact: true })).toBeChecked();
	await expect(answers(page).getByLabel('Answer mode', { exact: true })).toHaveValue('flashcard');
	await expect(cascadeSettings(page).getByLabel('Clear threshold (%)', { exact: true })).toHaveValue('90');
	await expect(presets(page).getByRole('button', { name: 'all 3 cascades', exact: true })).toBeVisible();

	// Saved under a name taken: asked first, then replaced.
	await saveAs(page, 'Typed');
	await confirm(page, 'Replace');
	await expect(presets(page).getByText('✓ Replaced “Typed”.')).toBeVisible({ timeout: 15_000 });
	// Renamed, and offline, nothing is saved.
	await presets(page).getByRole('button', { name: 'Rename “Typed”' }).click();
	await presets(page).getByLabel('New name for “Typed”').fill('Plain');
	await presets(page).getByRole('button', { name: 'Save name' }).click();
	await expect(presets(page).getByText('✓ Renamed “Typed” to “Plain”.')).toBeVisible({ timeout: 15_000 });
	await page.context().setOffline(true);
	await saveAs(page, 'Offline');
	await expect(presets(page).getByText('Saving a preset needs a connection.')).toBeVisible();
	await page.context().setOffline(false);
	// Deleted: Gamma keeps what it was made with, and the builder starts at Defaults again.
	await presets(page).getByRole('button', { name: 'Delete “Plain”' }).click();
	await confirm(page, 'Delete');
	await expect(presets(page).getByText('✓ Deleted “Plain”.')).toBeVisible({ timeout: 15_000 });
	await expect(presets(page).locator('[data-preset]')).toHaveCount(0);
	await closeSettings(page);
	await page.goto(gamma);
	await expect(page.getByLabel('Type an answer')).toBeVisible({ timeout: 30_000 });
	await page.goto('/cascades/new');
	await expect(page.locator('[data-preset-select]')).toHaveValue('defaults');
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

// PLAN.md § Settings → Where a setting applies: each cascade on each device
// has its own settings. A change is saved for this cascade on this device;
// the offer under it makes the same change for this cascade on all devices,
// all cascades on this device, or all cascades on all devices, the widest
// covering the other two. The latest change covering a cascade on a device is
// used, whichever scope it was made in, and the account's other device takes
// the changes made for all devices.
test('each cascade on each device has its own settings; a change offered more widely; the latest is used', async ({ page, browser, baseURL }) => {
	test.setTimeout(240_000);
	const { username } = await newUser(page, 'places');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	const beta = await apiCascade(page, { name: 'Beta', filters: AEINRST });
	const size = (p: Page) => p.getByRole('dialog', { name: 'Settings' }).locator('#display-question_size_px');
	const row = (p: Page) => setting(p, 'question_size_px');
	async function setSize(p: Page, n: number) {
		await size(p).fill(String(n));
		await size(p).press('Tab');
		await expectSource(row(p), 'both');
		await expect(row(p).getByText('✓ Saved for this cascade on this device')).toBeVisible();
	}
	async function sizeOf(p: Page, player: string, n: string, source: string) {
		await openPlayer(p, player);
		await openPlayerSettings(p);
		await expect(size(p)).toHaveValue(n, { timeout: 30_000 });
		await expectSource(row(p), source);
	}

	// Alpha alone on this device: Beta keeps the default.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await expectSource(row(page), 'default');
	await setSize(page, 44);
	await closeSettings(page);
	await sizeOf(page, beta, '36', 'default');

	// Beta's 48, then for all cascades on this device: Alpha takes it, the later change.
	await setSize(page, 48);
	await row(page).getByRole('button', { name: 'all 2 cascades on this device' }).click();
	await expect(row(page).getByText('✓ Applied to all 2 cascades on this device')).toBeVisible();
	await expectSource(row(page), 'device');
	await closeSettings(page);
	await sizeOf(page, alpha, '48', 'device');

	// Alpha's own 40 afterwards: Alpha alone.
	await setSize(page, 40);
	await closeSettings(page);
	await sizeOf(page, beta, '48', 'device');
	await closeSettings(page);

	// Alpha's 52 for all cascades on all devices: the widest covers the other two offers.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await setSize(page, 52);
	await row(page).getByRole('button', { name: 'all 2 cascades on all devices' }).click();
	await expect(row(page).getByText('✓ Applied to all 2 cascades on all devices')).toBeVisible();
	await expect(row(page).getByRole('button', { name: 'this cascade on all devices' })).toHaveCount(0);
	await expect(row(page).getByRole('button', { name: 'all 2 cascades on this device' })).toHaveCount(0);
	await expectSource(row(page), 'all');
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 30_000 });
	await closeSettings(page);
	await sizeOf(page, beta, '52', 'all');
	await closeSettings(page);

	// The other device takes it; there, Beta's 30 for this cascade on all devices reaches this one.
	const other = await browser.newContext({ baseURL });
	const p2 = await other.newPage();
	await login(p2, username);
	await sizeOf(p2, beta, '52', 'all');
	await setSize(p2, 30);
	await row(p2).getByRole('button', { name: 'this cascade on all devices' }).click();
	await expect(row(p2).getByText('✓ Applied to this cascade on all devices')).toBeVisible();
	await expectSource(row(p2), 'cascade');
	await expect(p2.getByText('Synced')).toBeVisible({ timeout: 30_000 });
	await sizeOf(page, beta, '30', 'cascade');
	await closeSettings(page);
	await sizeOf(page, alpha, '52', 'all');
	await other.close();
});

// PLAN.md § Settings → Presets, on the Cascades page under the Trash: Defaults
// (copy only) and the account's presets, each edited on its own page, copied,
// renamed, given a cascade's settings, or deleted; a new one from the defaults
// or a cascade. Editing a preset changes no cascade it was applied to. Every
// change needs a connection.
test('presets on the Cascades page: copied, made, renamed, edited, given a cascade’s settings and deleted', async ({ page }) => {
	test.setTimeout(240_000);
	await newUser(page, 'presets');
	const alpha = await apiCascade(page, { name: 'Alpha', filters: AEINRST });
	const section = page.locator('[data-preset-section]');
	const row = (name: string) => section.locator(`[data-preset-row="${name}"]`);
	await page.goto('/');
	await expect(section.getByText('(built in)')).toBeVisible({ timeout: 30_000 });
	await expect(row('Defaults').getByRole('button', { name: 'Delete “Defaults”' })).toHaveCount(0);
	await expect(row('Defaults').getByRole('link', { name: 'Edit “Defaults”' })).toHaveCount(0);

	// Copied, under a name of one's own; then a new one from the defaults; then renamed.
	await row('Defaults').getByRole('button', { name: 'Copy “Defaults”' }).click();
	await expect(section.getByLabel('Name of the copy of “Defaults”')).toHaveValue('Defaults (2)');
	await section.getByLabel('Name of the copy of “Defaults”').fill('Mine');
	await section.getByRole('button', { name: 'Make copy' }).click();
	await expect(section.getByText('✓ Copied “Defaults” as “Mine”.')).toBeVisible({ timeout: 15_000 });
	await section.getByRole('button', { name: 'New preset' }).click();
	await section.getByLabel('New preset’s name').fill('Desk');
	await section.getByRole('button', { name: 'Make preset' }).click();
	await expect(section.getByText('✓ Made “Desk” from the defaults.')).toBeVisible({ timeout: 15_000 });
	await row('Mine').getByRole('button', { name: 'Rename “Mine”' }).click();
	await section.getByLabel('New name for “Mine”').fill('Desk');
	await section.getByRole('button', { name: 'Save name' }).click();
	await expect(section.getByText('You already have a preset with that name.')).toBeVisible();
	await section.getByLabel('New name for “Mine”').fill('Phone');
	await section.getByRole('button', { name: 'Save name' }).click();
	await expect(section.getByText('✓ Renamed “Mine” to “Phone”.')).toBeVisible({ timeout: 15_000 });

	// Edited on its own page, each change saved at once.
	await row('Phone').getByRole('link', { name: 'Edit “Phone”' }).click();
	await expect(page).toHaveURL(/\/presets\/[0-9a-f-]{36}$/);
	await page.getByLabel('Answer mode', { exact: true }).selectOption('typed');
	await expect(page.locator('[data-preset-status]')).toHaveText('✓ Saved', { timeout: 15_000 });
	const threshold = page.getByLabel('Clear threshold (%)', { exact: true });
	await threshold.fill('95');
	await threshold.press('Tab');
	await expect(page.locator('[data-preset-status]')).toHaveText('✓ Saved', { timeout: 15_000 });
	// No offer to apply a change more widely: a preset is not a cascade on a device.
	await expect(page.locator('[data-offer]')).toHaveCount(0);
	await page.reload();
	await expect(page.getByLabel('Answer mode', { exact: true })).toHaveValue('typed', { timeout: 15_000 });
	await expect(page.getByLabel('Clear threshold (%)', { exact: true })).toHaveValue('95');
	// Offline, nothing is saved and the preset stays as it was.
	await page.context().setOffline(true);
	await page.getByLabel('Answer mode', { exact: true }).selectOption('flashcard');
	await expect(page.locator('[data-preset-error]')).toHaveText('Changing a preset needs a connection.');
	await expect(page.getByLabel('Answer mode', { exact: true })).toHaveValue('typed');
	await page.context().setOffline(false);

	// Applied to Alpha, then edited again: Alpha keeps what it was given.
	await openPlayer(page, alpha);
	await openPlayerSettings(page);
	await apply(page, 'Phone');
	await expect(presets(page).getByText('✓ Applied “Phone”: 2 settings changed.')).toBeVisible();
	await closeSettings(page);
	await expect(page.getByLabel('Type an answer')).toBeVisible();
	await page.goto('/');
	await row('Phone').getByRole('link', { name: 'Edit “Phone”' }).click();
	await page.getByLabel('Answer mode', { exact: true }).selectOption('flashcard');
	await expect(page.locator('[data-preset-status]')).toHaveText('✓ Saved', { timeout: 15_000 });
	await openPlayer(page, alpha);
	await expect(page.getByLabel('Type an answer')).toBeVisible();

	// Desk takes Alpha's settings (typed, 95%), then is deleted.
	await page.goto('/');
	await row('Desk').getByRole('button', { name: 'Copy a cascade’s settings to “Desk”' }).click();
	await section.getByLabel('Cascade whose settings “Desk” takes').selectOption({ label: 'Alpha' });
	await section.getByRole('button', { name: 'Copy settings' }).click();
	await confirm(page, 'Copy settings');
	await expect(section.getByText('✓ “Desk” now has the settings of “Alpha”.')).toBeVisible({ timeout: 15_000 });
	await row('Desk').getByRole('link', { name: 'Edit “Desk”' }).click();
	await expect(page.getByLabel('Answer mode', { exact: true })).toHaveValue('typed', { timeout: 15_000 });
	await expect(page.getByLabel('Clear threshold (%)', { exact: true })).toHaveValue('95');
	await page.goto('/');
	await row('Desk').getByRole('button', { name: 'Delete “Desk”' }).click();
	await confirm(page, 'Delete');
	await expect(section.getByText('✓ Deleted “Desk”.')).toBeVisible({ timeout: 15_000 });
	await expect(row('Desk')).toHaveCount(0);
	// Offline, a copy is not made.
	await page.context().setOffline(true);
	await row('Phone').getByRole('button', { name: 'Copy “Phone”' }).click();
	await section.getByRole('button', { name: 'Make copy' }).click();
	await expect(section.getByText('Copying a preset needs a connection.')).toBeVisible();
	await page.context().setOffline(false);
});
