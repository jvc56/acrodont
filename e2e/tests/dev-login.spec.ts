import { test, expect } from '@playwright/test';
import { newUser, ROOT_URL } from './support';

// PLAN.md § Development → One command: ./scripts/dev.py opens the browser at
// /dev-login, which signs in through POST /api/dev/login (DEV_LOGIN, local
// stacks only) and then adopts the session as a login does.

test('dev sign-in adopts the session and refuses an off-site next', async ({ page, browser }) => {
	const { username } = await newUser(page, 'devlogin');
	const fresh = await browser.newContext();
	const tab = await fresh.newPage();
	await tab.goto(`/dev-login?username=${username}&next=/account`);
	await expect(tab).toHaveURL(/\/account$/);
	// Signed in as far as the app is concerned: the account page names the user
	// and a reload keeps it (the IndexedDB pointer was written, not just a cookie).
	await expect(tab.getByText(username).first()).toBeVisible();
	await tab.reload();
	await expect(tab.getByText(username).first()).toBeVisible();
	// A next that a browser could read as another host lands on the Cascades page.
	await tab.goto(`/dev-login?username=${username}&next=//evil.example/`);
	await expect(tab).toHaveURL(ROOT_URL);
	await fresh.close();
});

test('dev sign-in names an unknown account', async ({ page }) => {
	await page.goto('/dev-login?username=nobody-here');
	await expect(page.getByText(/No such account/)).toBeVisible();
});
