import { test, expect } from '@playwright/test';
import { login, newUser } from './support';

// There is no separate home page: / is the Cascades page signed in and the
// log-in page signed out; the site header leads everywhere, Admin only for admins.

test('signed out, / is the log-in page, with the way to create an account', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);
	await page.getByRole('link', { name: 'Create an account' }).click();
	await expect(page).toHaveURL(/\/register$/);
});

test('signed in, / is the Cascades page, and the header leads everywhere, Admin only for admins', async ({ page }) => {
	await newUser(page, 'home');
	await page.goto('/');
	await expect(page).toHaveURL(/\/cascades$/);
	const nav = page.getByRole('navigation', { name: 'Main' });
	for (const name of ['Cascades', 'New cascade', 'Trash']) {
		await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
	}
	await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);
	await nav.getByRole('link', { name: 'Trash', exact: true }).click();
	await expect(page).toHaveURL(/\/trash$/);
	await expect(nav.getByRole('link', { name: 'Trash', exact: true })).toHaveAttribute('aria-current', 'page');
	await page.getByRole('link', { name: 'Acrodont', exact: true }).click();
	await expect(page).toHaveURL(/\/cascades$/);

	await login(page, 'dev');
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' }).click();
	await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
});
