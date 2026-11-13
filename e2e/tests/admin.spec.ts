import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, apiCascade, login, openPlayerSettings } from './support';

// PLAN.md § End-to-end tests: "As an admin, upload a distribution, lexicon and
// leave value set, see a deliberately broken file rejected with line numbers,
// build a Leave Value cascade from the new set, and see deletion refused while
// the cascade exists"; and "Build a cascade with a segment size that would
// create more than 2,000 levels and see the warning naming the count, on the
// builder and in a quiz's settings menu" — on a generated 11,000-word lexicon,
// since the fixture catalog is far too small for that.
//
// @serial: it changes the catalog every journey reads, and works as the seeded
// `dev` admin.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../fixtures/catalog');

/** 11,000 distinct seven-letter words, each its own alphagram. */
function bigLexicon(): string {
	const letters = 'ABCDEFGHILMNOPRSTU'.split('');
	const out: string[] = [];
	const pick = (start: number, chosen: string[]) => {
		if (out.length >= 11_000) return;
		if (chosen.length === 7) {
			out.push(`${chosen.join('')}\t1\ta made-up word [n]`);
			return;
		}
		for (let i = start; i < letters.length && out.length < 11_000; i++) pick(i + 1, [...chosen, letters[i]]);
	};
	pick(0, []);
	return out.join('\n') + '\n';
}

async function upload(page: Page, url: string, fill: () => Promise<void>, name: string, contents: string) {
	await page.goto(url);
	await fill();
	await page.getByLabel('File').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(contents) });
	await page.getByRole('button', { name: 'Upload' }).click();
}

test('admin uploads, a broken file, a Leave Value cascade from the new set, deletion refused, and the level warning @serial', async ({ page }) => {
	test.setTimeout(420_000);
	await login(page, 'dev');
	void PASSWORD;
	const tag = Date.now().toString(36);
	const dist = `e2e${tag}`;
	const lex = `BIG${tag}`.toUpperCase();

	// A distribution.
	await upload(page, '/admin/letter-distributions/new', () => page.getByLabel('Name').fill(dist), 'dist.csv', readFileSync(path.join(fixtures, 'english.csv'), 'utf8'));
	await expect(page.getByText('Uploaded')).toBeVisible({ timeout: 60_000 });

	// A broken lexicon: rejected with line numbers, nothing stored.
	const fill = async () => {
		await page.getByLabel('Name').fill(lex);
		await page.getByLabel('Letter distribution').selectOption(dist);
	};
	await upload(page, '/admin/lexicons/new', fill, 'broken.tsv', 'ABCDEFG\t1\tfine\nAB1\t1\tbad tile\n\tx\tno word\n');
	await expect(page.getByText('problems; nothing was stored')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText(/^Line 2: /).first()).toBeVisible();
	await expect(page.getByText(/^Line 3: /).first()).toBeVisible();

	// The real one, and a leave value set for it.
	await upload(page, '/admin/lexicons/new', fill, 'big.tsv', bigLexicon());
	await expect(page.getByText(/with 11,000 words/)).toBeVisible({ timeout: 180_000 });
	await upload(
		page,
		'/admin/leave-sets/new',
		() => page.getByLabel('Lexicon').selectOption(lex),
		'leaves.csv',
		readFileSync(path.join(fixtures, 'EN-FIX-leaves.csv'), 'utf8')
	);
	await expect(page.getByText('Uploaded')).toBeVisible({ timeout: 60_000 });

	// A Leave Value cascade from the new set, once every server lists it.
	await expect
		.poll(async () => ((await (await page.request.get('/api/lexicons')).json()) as { name: string }[]).some((l) => l.name === lex), { timeout: 120_000 })
		.toBe(true);
	const leaves = await apiCascade(page, {
		name: 'New leaves',
		lexicon: lex,
		quiz_type: 'leave_value',
		filters: { op: 'and', children: [{ type: 'leave_value', negated: false, min: 30.0, max: null }] }
	});
	await page.goto(leaves);
	await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible({ timeout: 60_000 });

	// A second set for the same lexicon, under its own name. The builder then offers the choice,
	// newest first, and the count follows the set picked (PLAN.md § Uploads).
	// This is the journey's fifth upload within a minute of the seeding's own, so the admin
	// upload limit may answer "Too many uploads" first: tried again until the minute has passed.
	await expect(async () => {
		await upload(
			page,
			'/admin/leave-sets/new',
			async () => {
				await page.getByLabel('Lexicon').selectOption(lex);
				await page.getByLabel('Name').fill('Gen 2');
			},
			'gen2.csv',
			'?,1\nA,40\nE,45.5\n'
		);
		await expect(page.getByText('Uploaded')).toBeVisible({ timeout: 15_000 });
	}).toPass({ timeout: 150_000, intervals: [15_000] });
	await expect
		.poll(
			async () =>
				((await (await page.request.get('/api/lexicons')).json()) as { name: string; leave_sets: { name: string }[] }[])
					.find((l) => l.name === lex)
					?.leave_sets.map((s) => s.name),
			{ timeout: 120_000 }
		)
		.toEqual(['Gen 2', 'leaves']);
	await page.goto('/cascades/new');
	// The radio inputs are visually hidden; their labels are the segments a person clicks.
	await page.getByRole('radiogroup', { name: 'Quiz type' }).getByText('Leave Value').click();
	await page.getByLabel('Lexicon').selectOption(lex);
	// A leave is 1–6 tiles: the row the builder opens with is sized for words.
	await page.getByLabel('Minimum').first().fill('1');
	await page.getByLabel('Maximum').first().fill('6');
	const sets = page.getByLabel('Leave values', { exact: true });
	await expect(sets).toHaveValue('Gen 2');
	await expect(sets.getByRole('option')).toHaveText(['Gen 2 (newest)', 'leaves']);
	await expect(page.getByText('3 questions').first()).toBeVisible({ timeout: 60_000 });
	await sets.selectOption('leaves');
	await expect(page.getByText('35 questions').first()).toBeVisible({ timeout: 60_000 });
	await page.getByLabel('Cascade name').fill('Older leaves');
	await page.getByRole('button', { name: 'Create Cascade' }).click();
	await expect(page).toHaveURL(/\/cascades\/[0-9a-f-]{36}$/, { timeout: 60_000 });
	await expect(page.getByText(/^1 \/ 35$/)).toBeVisible({ timeout: 60_000 });
	// The Cascades page names the set each Leave Value cascade was built on.
	await page.goto('/');
	await expect(page.getByTitle(new RegExp(`Older leaves\\n.*${lex} \\(leaves\\)`))).toHaveCount(1);
	// An anagram cascade has no such choice.
	await page.goto('/cascades/new');
	await page.getByLabel('Lexicon').selectOption(lex);
	await expect(page.getByLabel('Leave values', { exact: true })).toHaveCount(0);

	// The lexicon's definitions replaced: the same words and playabilities with one definition
	// corrected (PLAN.md § Immutability and deletion → Replacing definitions). The overview then
	// shows the revision. Tried again while the upload limit says to wait, as above.
	await expect(async () => {
		await upload(
			page,
			'/admin/lexicons/definitions',
			async () => {
				await page.getByLabel('Lexicon').selectOption({ label: lex });
			},
			'corrected.tsv',
			bigLexicon().replace('a made-up word [n]', 'a corrected word [n]')
		);
		await expect(page.getByText('Uploaded')).toBeVisible({ timeout: 60_000 });
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	await expect(page.getByText('1 of 11,000 definitions changed. This is revision 2 of its definitions.')).toBeVisible();
	await page.goto('/admin');
	await expect(page.getByRole('row').filter({ hasText: lex }).first().getByText('revision 2')).toBeVisible({ timeout: 30_000 });

	// Deletion refused while the cascade exists: the button is disabled and says what uses it
	// (PLAN.md § Catalog: "the admin page disables the delete button and explains what is still using the item").
	await page.goto('/admin');
	const row = page.getByRole('row').filter({ hasText: lex }).first();
	await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled({ timeout: 30_000 });
	await expect(row.getByText('In use: it has leave values and 2 cascades use it.')).toBeVisible();

	// More than 2,000 levels: warned about in a level's options, in Settings.
	await page.goto('/cascades/new');
	await page.getByLabel('Lexicon').selectOption(lex);
	await page.getByLabel('Minimum').first().fill('7');
	await page.getByLabel('Maximum').first().fill('7');
	await expect(page.getByText('11,000 questions').or(page.getByText('11000 questions')).first()).toBeVisible({ timeout: 60_000 });
	await page.getByLabel('Cascade name').fill('Big');
	await page.getByRole('button', { name: 'Create Cascade' }).click();
	await expect(page).toHaveURL(/\/cascades\/[0-9a-f-]{36}$/, { timeout: 60_000 });
	await expect(page.getByText(/^1 \/ 11000$/)).toBeVisible({ timeout: 60_000 });
	await openPlayerSettings(page);
	const d = page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: /the level you are studying/ });
	await d.getByLabel('Study in segments').check();
	await d.getByLabel('Segment size', { exact: true }).fill('5');
	await expect(d.getByText('One pass could create up to 2,200 drill levels, one for each segment with a miss.')).toBeVisible();
});
