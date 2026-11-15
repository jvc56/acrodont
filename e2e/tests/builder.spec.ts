import { test, expect } from '@playwright/test';
import { newUser, openPlayerSettings, press } from './support';

// A smoke run of the builder against the seeded fixture catalog (PLAN.md §
// Creating a cascade): preview as filters change, then Create Cascade.
test('the builder previews and creates a cascade', async ({ page }) => {
	// Its own account rather than the seeded admin: the journeys run side by side.
	await newUser(page, 'builder');
	await page.goto('/cascades/new');
	await page.getByLabel('Lexicon').selectOption('EN-FIX');
	await page.getByLabel('Minimum').first().fill('7');
	await page.getByLabel('Maximum').first().fill('7');
	await expect(page.getByText('18 questions')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByLabel('Cascade name')).toHaveValue('EN-FIX · Length 7–7');
	await page.getByRole('button', { name: 'Create Cascade' }).click();
	await expect(page).toHaveURL(/\/cascades\/[0-9a-f-]{36}$/);
	const id = page.url().split('/').pop()!;
	// The new cascade is in this device's base at once, with its Source quiz's
	// 18 rows, and the sync engine has synced against the real server since
	// (PLAN.md § Downloads, § The sync cycle).
	await expect
		.poll(
			() =>
				page.evaluate(async (cascadeId) => {
					const open = (name: string) =>
						new Promise<IDBDatabase>((res, rej) => {
							const r = indexedDB.open(name);
							r.onsuccess = () => res(r.result);
							r.onerror = () => rej(r.error);
						});
					const get = <T>(db: IDBDatabase, store: string, key: IDBValidKey) =>
						new Promise<T>((res) => {
							const r = db.transaction(store).objectStore(store).get(key);
							r.onsuccess = () => res(r.result as T);
						});
					const count = (db: IDBDatabase, store: string, index: string, key: IDBValidKey) =>
						new Promise<number>((res) => {
							const r = db.transaction(store).objectStore(store).index(index).count(key);
							r.onsuccess = () => res(r.result);
						});
					const unscoped = await open('acrodont');
					const pointer = await get<{ user_id: string }>(unscoped, 'pointer', 'signed_in');
					const db = await open(`acrodont-user-${pointer.user_id}`);
					const sync = await get<{ cursor: number | null }>(db, 'meta', 'sync');
					const rows = await count(db, 'quiz_questions', 'cascade_id', cascadeId);
					return { synced: sync?.cursor != null, rows };
				}, id),
			{ timeout: 15_000 }
		)
		.toEqual({ synced: true, rows: 18 });

	// An account's cascades each have their own name (PLAN.md § Creating a cascade): the same
	// search again is suggested the name with the next free number, a name already in use is
	// refused under the field with Create Cascade disabled, and Duplicate cascade numbers its copy.
	await page.goto('/cascades/new');
	await page.getByLabel('Lexicon').selectOption('EN-FIX');
	await page.getByLabel('Minimum').first().fill('7');
	await page.getByLabel('Maximum').first().fill('7');
	await expect(page.getByText('18 questions')).toBeVisible({ timeout: 15_000 });
	const name = page.getByLabel('Cascade name');
	await expect(name).toHaveValue('EN-FIX · Length 7–7 (2)');
	await name.fill('EN-FIX · Length 7–7');
	await expect(page.getByText('You already have a cascade named “EN-FIX · Length 7–7”. Each cascade needs its own name, the Trash included.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create Cascade' })).toBeDisabled();
	await name.fill('Sevens again');
	await page.getByRole('button', { name: 'Create Cascade' }).click();
	await expect(page).toHaveURL(/\/cascades\/[0-9a-f-]{36}$/);
	await expect(page.getByText(/^1 \/ 18$/)).toBeVisible({ timeout: 30_000 });
	// The original moves on a card, so the copy's first card is told from it.
	await press(page, 'Space');
	await press(page, 'Space');
	await expect(page.getByText(/^2 \/ 18$/)).toBeVisible();
	await openPlayerSettings(page);
	await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Duplicate cascade' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Duplicate', exact: true }).click();
	await expect(page).not.toHaveURL(new RegExp(page.url().split('/').pop()!), { timeout: 30_000 });
	// The player is the copy's, at its first card, and Back is the original's, where it was left.
	await expect(page.getByText(/^1 \/ 18$/)).toBeVisible({ timeout: 30_000 });
	await page.goBack();
	await expect(page.getByText(/^2 \/ 18$/)).toBeVisible({ timeout: 30_000 });
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Sevens again (2)', exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('link', { name: 'Sevens again', exact: true })).toBeVisible();
});
