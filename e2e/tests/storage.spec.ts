import { test, expect } from '@playwright/test';
import { confirm, createCascade, newUser, playLevel, sql } from './support';

// PLAN.md § End-to-end tests: storage at its limit, and a Trash holding a long
// history. Each journey makes the state it needs for its own account with SQL
// (an account's own storage limit, a segmented attempt's 5,000 chain
// quizzes), so both run on the suite's one stack beside the others.

// The storage limit, lowered for this account alone (users.storage_limit_bytes):
// creating stops when the next cascade would not fit, studying never stops,
// and deleting forever makes room again (PLAN.md § Storage limit).
test('the storage limit: creation stops at it, studying goes past it, deleting forever makes room', async ({ page }) => {
	test.setTimeout(300_000);
	const { username } = await newUser(page, 'limits');
	const limit = 12_000;
	sql(`UPDATE users SET storage_limit_bytes = ${limit} WHERE username = '${username}'`);
	// The device learns the account's limit from the server's next answer.
	await page.goto('/cascades');
	await expect(page.getByText(new RegExp(`of ${limit / 1000} KB used$`))).toBeVisible({ timeout: 30_000 });
	const estimate = page.locator('[data-storage-estimate]');
	const builder = async () => {
		await page.goto('/cascades/new');
		await page.getByLabel('Lexicon').selectOption('EN-FIX');
		await page.getByLabel('Minimum').first().fill('7');
		await page.getByLabel('Maximum').first().fill('7');
		await expect(page.getByText(/\d+ questions/).first()).toBeVisible({ timeout: 15_000 });
		await expect(estimate).toContainText(/This cascade will use about [\d.]+ (B|KB)\./);
	};
	// Cascades until the next would not fit: at least one fits, and not many.
	let made = 0;
	for (;;) {
		await builder();
		if ((await estimate.textContent())!.includes('won’t fit')) break;
		await page.getByLabel('Cascade name').fill(`Room ${made}`);
		await page.getByRole('button', { name: 'Create Cascade' }).click();
		// The device's figure can be a sync behind: then the server refuses it, with what it needs.
		const refused = page.getByText(/^This cascade needs about [\d.]+ (B|KB)/);
		await expect(page.getByText('1 / 18').or(refused)).toBeVisible({ timeout: 30_000 });
		if (await refused.isVisible()) break;
		made++;
		expect(made).toBeLessThan(10);
	}
	expect(made).toBeGreaterThan(0);
	await expect(page.getByRole('button', { name: 'Create Cascade' })).toBeDisabled();

	// Studying is never refused: two passes with all but one missed add two levels, past
	// the limit. (A pass with every question missed makes no level: it only reshuffles.)
	await page.goto('/cascades');
	await page.getByRole('link', { name: 'Room 0', exact: true }).click();
	expect(await playLevel(page, (i) => i > 0)).toMatch(/^Level 1: \d+%\. Reshuffled, and its 17 missed questions are now Level 2\.$/);
	expect(await playLevel(page, (i) => i > 0)).toMatch(/^Level 2/);
	await expect(page.getByText('Level 3 of 3')).toBeVisible();
	await page.goto('/cascades');
	await expect(page.locator('[data-storage="over"]')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/^Over your storage by [\d.]+ (B|KB)/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'New cascade' })).toBeDisabled();
	await expect(page.getByText(new RegExp(`of ${limit / 1000} KB used$`))).toBeVisible();

	// The Trash still counts; deleting forever makes room.
	await page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Room 0', exact: true }) }).getByRole('button', { name: 'Move to Trash' }).click();
	await confirm(page, 'Move to Trash');
	await expect(page.locator('[data-storage="over"]')).toBeVisible();
	await page.getByRole('listitem').filter({ hasText: /^The whole cascade/ }).getByRole('button', { name: /^Delete forever/ }).click();
	await confirm(page, 'Delete forever');
	await expect(page.locator('[data-storage="over"]')).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByRole('link', { name: 'New cascade' })).toBeVisible();
	await builder();
	await expect(page.getByRole('button', { name: 'Create Cascade' })).toBeEnabled();
});

// A cascade whose segmented attempt left 5,000 cleared chain quizzes opens /trash in budget.
test('/trash with 5,000 cleared chain quizzes: one collapsed group, pages of 100', async ({ page }) => {
	test.setTimeout(240_000);
	const { username } = await newUser(page, 'trash5k');
	const player = await createCascade(page, { name: 'Many chains' });
	const cascade = player.split('/').pop()!;
	// The chain quizzes as a segmented attempt leaves them, written to the database.
	sql(`
		WITH u AS (UPDATE users SET sync_seq = sync_seq + 1 WHERE username = '${username}' RETURNING id, sync_seq),
		     src AS (SELECT q.id, q.cascade_id FROM quizzes q WHERE q.cascade_id = '${cascade}' AND q.origin = 'source'),
		     ins AS (
		       INSERT INTO quizzes (id, cascade_id, user_id, level, origin, origin_quiz_id, origin_attempt, origin_segment_end,
		                            status, segment_chain, segment_size, progression, options_changed_at, options_seq,
		                            options_device_id, shuffle_seed, questions_hash, question_count, correct_count,
		                            created_seq, updated_seq, cleared_at, last_activity_at)
		       SELECT gen_random_uuid(), src.cascade_id, u.id, 2, 'segment', src.id, g, 5, 'cleared', true, 0, 'drill', now(),
		              u.sync_seq, gen_random_uuid(), g, 0, 1, 1, u.sync_seq, u.sync_seq, now() - interval '1 day', now()
		       FROM u, src, generate_series(1, 5000) AS g RETURNING 1)
		SELECT count(*) FROM ins;`);
	await page.goto('/cascades');
	await expect(page.getByText('Synced')).toBeVisible({ timeout: 60_000 });
	const t = Date.now();
	await page.goto('/trash');
	const group = page.getByRole('button', { name: /Many chains/ });
	await expect(group).toContainText('5000 entries', { timeout: 30_000 });
	expect(Date.now() - t).toBeLessThan(15_000);
	await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
	await group.click();
	await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(100);
	await page.getByRole('button', { name: 'Show more' }).click();
	await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(200);
});
