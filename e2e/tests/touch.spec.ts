import { test, expect, devices, type Page } from '@playwright/test';
import { createCascade, login, newUser, playerSetting } from './support';

// PLAN.md § End-to-end tests → Touch zones (mobile viewport emulation,
// portrait and landscape): in the columns layout, the default, each column
// fires its action wherever it is tapped and by its button along the bottom;
// in the rows layout each band does; a drag scrolls without acting, a quick
// double tap advances once per tap, and the status bar and the menu (with
// Settings in it) are those of the desktop.

/** The status bar shows the card out of the level, as on the desktop. */
async function at(page: Page, n: number) {
	await expect(page.locator('footer').getByText(`${n} / 18`, { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function drag(page: Page, x: number, y0: number, y1: number) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
	for (let i = 1; i <= 5; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 5 }] });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const graded = (page: Page) => page.locator('[data-grade="correct"], [data-grade="missed"]');

for (const orientation of ['portrait', 'landscape'] as const) {
	test(`touch zones, ${orientation}`, async ({ browser, baseURL }) => {
		test.setTimeout(180_000);
		const phone = devices['Pixel 5'];
		const viewport = orientation === 'portrait' ? phone.viewport : { width: phone.viewport.height, height: phone.viewport.width };
		const setup = await browser.newContext({ baseURL });
		const sp = await setup.newPage();
		const { username } = await newUser(sp, `touch${orientation[0]}`);
		const player = await createCascade(sp, { name: 'Touch' });
		await setup.close();
		const ctx = await browser.newContext({ ...phone, viewport, baseURL });
		const page = await ctx.newPage();
		await login(page, username);
		await page.goto(player);
		await at(page, 1);
		// The status bar is the desktop's, sync status included.
		await expect(page.locator('footer').getByText('Level 1 of 1')).toBeVisible();
		await expect(page.locator('footer').getByRole('status')).toBeVisible();

		// Columns, the default: Previous, Toggle and Show / Next, a third of the quiz area each.
		const area = page.locator('[data-zone="columns"]');
		const box = (await area.boundingBox())!;
		const tapThird = (i: number) => area.tap({ position: { x: (box.width * (i + 0.5)) / 3, y: box.height / 2 } });
		await tapThird(2);
		await expect(page.locator('[data-grade="correct"]')).toBeVisible();
		await page.waitForTimeout(150);
		await tapThird(1);
		await expect(page.locator('[data-grade="missed"]')).toBeVisible();
		await page.waitForTimeout(150);
		await tapThird(2);
		await at(page, 2);
		await page.waitForTimeout(150);
		await tapThird(0);
		await at(page, 1);
		// The buttons along the bottom do the same.
		await page.waitForTimeout(150);
		await page.getByRole('button', { name: /Show \/ Next/ }).tap();
		await at(page, 2);
		await page.waitForTimeout(150);
		await page.getByRole('button', { name: /Previous/ }).tap();
		await at(page, 1);
		// A drag in the quiz area scrolls and does not act.
		await drag(page, box.x + (box.width * 5) / 6, box.y + box.height * 0.7, box.y + box.height * 0.2);
		await page.waitForTimeout(300);
		await at(page, 1);
		// The repeat guard is off by default, so both taps of a quick double tap on a
		// revealed card count (back on card 1, its saved grade is shown): it moves on,
		// then shows card 2's answer.
		await expect(graded(page)).toBeVisible();
		await page.waitForTimeout(150);
		await tapThird(2);
		await tapThird(2);
		await at(page, 2);
		await expect(graded(page)).toBeVisible();

		// Rows, from the menu's Settings: Previous above, the question for Show / Next, Toggle below.
		await playerSetting(page, 'Tap zones on a phone', 'rows');
		const show = page.locator('[data-zone="show_next"]');
		await page.waitForTimeout(150);
		await show.tap();
		await at(page, 3);
		await page.waitForTimeout(150);
		await show.tap();
		await expect(page.locator('[data-grade="correct"]')).toBeVisible();
		await page.waitForTimeout(150);
		await page.getByRole('button', { name: /Toggle/ }).tap();
		await expect(page.locator('[data-grade="missed"]')).toBeVisible();
		await page.waitForTimeout(150);
		await page.getByRole('button', { name: /Previous/ }).tap();
		await at(page, 2);
		await ctx.close();
	});
}
