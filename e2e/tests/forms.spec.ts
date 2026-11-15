import { test, expect } from '@playwright/test';
import { PASSWORD, ROOT_URL, mailed } from './support';

// The pages a new user meets first, through their own forms and the links in
// their mail (PLAN.md § Authentication). The other journeys register and
// confirm through the API (support.ts newUser), so nothing else fills these.
test('registering, confirming, a wrong password, a reset and Sign out everywhere, through the forms', async ({ page }) => {
	test.setTimeout(120_000);
	const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	const username = `forms${tag}`.slice(0, 30);
	const email = `${username}@example.test`;
	const next = 'violet-harbor-lantern-quill';

	// Register, from the log-in page's link.
	await page.goto('/login');
	await page.getByRole('link', { name: 'Create an account' }).click();
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page.getByText(`We sent a confirmation link to ${email}`)).toBeVisible();

	// Before the link is followed, logging in says to confirm first.
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page.getByText('Confirm your email address first: follow the link we sent you.')).toBeVisible();

	// The mail's link confirms and lands on the log-in page, which says so; a second use is refused.
	const code = await mailed(email, 'confirmation_code');
	await page.goto(`/confirm-email?code=${code}`);
	await expect(page).toHaveURL(/\/login\?confirmed=1$/);
	await expect(page.getByText('Your email address is confirmed. Log in to start.')).toBeVisible();
	await page.goto(`/confirm-email?code=${code}`);
	await expect(page.getByText('This confirmation link has expired or was already used. Register again to get a new one.')).toBeVisible();

	// A wrong password is said on the form.
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill('not-the-password');
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page.getByText('Wrong username or password.')).toBeVisible();

	// Forgot password: the same answer for any address, then the mail's link.
	await page.getByRole('link', { name: 'Forgot password?' }).click();
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Send reset link' }).click();
	await expect(page.getByText('If that address has a confirmed account, a reset link is on its way')).toBeVisible();
	const token = await mailed(email, 'reset_token');
	await page.goto(`/reset-password/confirm?token=${token}`);
	// A weak password is refused under the field, and the link still works.
	await page.getByLabel('New password').fill('password1');
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page.getByText('This password is too easy to guess.')).toBeVisible();
	await page.getByLabel('New password').fill(next);
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page).toHaveURL(/\/login$/);
	// The link is spent.
	await page.goto(`/reset-password/confirm?token=${token}`);
	await page.getByLabel('New password').fill(next);
	await page.getByRole('button', { name: 'Set new password' }).click();
	await expect(page.getByText('This reset link has expired or was already used. Ask for a new one.')).toBeVisible();

	// The old password no longer logs in; the new one does.
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page.getByText('Wrong username or password.')).toBeVisible();
	await page.getByLabel('Password').fill(next);
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page).toHaveURL(ROOT_URL);

	// Sign out everywhere: a wrong password is said under its field, the right one keeps this session.
	await page.goto('/account');
	await page.locator('#everywhere_password').fill('not-the-password');
	await page.getByRole('button', { name: 'Sign out everywhere' }).click();
	await expect(page.getByText('That password is not right.')).toBeVisible();
	await page.locator('#everywhere_password').fill(next);
	await page.getByRole('button', { name: 'Sign out everywhere' }).click();
	await expect(page.getByText('Every other session has been signed out. This one keeps working.')).toBeVisible();
	await page.reload();
	await expect(page).toHaveURL(/\/account$/);
});
