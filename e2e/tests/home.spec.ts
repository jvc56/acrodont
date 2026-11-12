import { test, expect } from '@playwright/test';
import { login, newUser, ROOT_URL } from './support';

// There is no separate home page: / is the Cascades page signed in and the
// log-in page signed out; the site header leads everywhere, Admin only for admins.

test('signed out, / is the log-in page, with the way to create an account', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);
	await page.getByRole('link', { name: 'Create an account' }).click();
	await expect(page).toHaveURL(/\/register$/);
});

test('signed in, / is the Cascades page, with New cascade and the Trash on it; the header has Admin only for admins', async ({ page }) => {
	await newUser(page, 'home');
	await page.goto('/');
	await expect(page).toHaveURL(ROOT_URL);
	// The Cascades page is the landing page: New cascade and the Trash are on it, not in the header.
	await expect(page.getByRole('link', { name: 'New cascade' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
	await expect(page.getByText('The Trash is empty.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
	// An old link to /trash lands on it.
	await page.goto('/trash');
	await expect(page).toHaveURL(/^https?:\/\/[^/]+\/#trash$/);
	// So does an old link to /cascades.
	await page.goto('/cascades');
	await expect(page).toHaveURL(ROOT_URL);
	await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
	await page.goto('/account');
	await page.getByRole('link', { name: 'Acrodont', exact: true }).click();
	await expect(page).toHaveURL(ROOT_URL);

	await login(page, 'dev');
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' }).click();
	await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
});
