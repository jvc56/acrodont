import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, apiCascade, login, openPlayerSettings } from './support';

// PLAN.md § End-to-end tests: "As an admin, upload a distribution, lexicon and
// leave value set, see a deliberately broken file rejected with line numbers,
// build a Leave Value cascade from the new set, replace the lexicon's
// definitions, its playability values and the set's values, and see deletion
// refused while the cascades exist"; and "Build a cascade with a segment size that would
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

/** Its own headers for an API call made beside the page: the session's CSRF token and the account it is bound to. */
async function apiHeaders(page: Page) {
	const csrf = (await page.context().cookies()).find((c) => c.name === 'acrodont_csrf')!.value;
	const me = await (await page.request.get('/api/auth/me')).json();
	return { 'X-CSRF-Token': csrf, 'X-Acrodont-User': me.user_id as string };
}

/** The question keys the server holds for the cascade at this player path. */
async function questionKeys(page: Page, cascade: string): Promise<string[]> {
	const r = await page.request.get(`/api${cascade}/cards?from=0&limit=100&keys=1`, { headers: await apiHeaders(page) });
	expect(r.status(), await r.text()).toBe(200);
	return ((await r.json()) as { keys: string[] }).keys;
}

async function upload(page: Page, url: string, fill: () => Promise<void>, name: string, contents: string) {
	await page.goto(url);
	await fill();
	await page.getByLabel('File').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(contents) });
	await page.getByRole('button', { name: 'Upload' }).click();
}

test('admin uploads, a broken file, a Leave Value cascade from the new set, deletion refused, and the level warning @serial', async ({ page }) => {
	test.setTimeout(600_000);
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
		await expect(page.getByText('1 of 11,000 definitions changed. This is revision 2 of its definitions.')).toBeVisible({ timeout: 60_000 });
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	await page.goto('/admin');
	await expect(page.getByRole('row').filter({ hasText: lex }).first().getByText('revision 2')).toBeVisible({ timeout: 30_000 });

	// The lexicon's playability values replaced (PLAN.md § Replacing definitions, playabilities and
	// leave values → Playabilities). Every word was uploaded with playability 1, and equal values rank
	// by alphagram, so the most playable seven is the first word; a cascade of it is made first.
	const mostPlayable = {
		op: 'and',
		children: [
			{ type: 'length', negated: false, min: 7, max: 7 },
			{ type: 'playability_order', negated: false, min: 1, max: 1, lax: false }
		]
	};
	const found = async () => {
		const r = await page.request.post('/api/search/preview', {
			headers: await apiHeaders(page),
			data: { lexicon: lex, quiz_type: 'anagram', filters: mostPlayable }
		});
		return r.ok() ? ((await r.json()) as { sample: string[] }).sample : null;
	};
	expect(await found()).toEqual(['ABCDEFG']);
	const first = await apiCascade(page, { name: `Most playable ${tag}`, lexicon: lex, filters: mostPlayable });
	expect(await questionKeys(page, first)).toEqual(['ABCDEFG']);
	// The lexicon's file as it now stands (the corrected definition), with the second word made the most playable.
	const raised = bigLexicon().replace('a made-up word [n]', 'a corrected word [n]').replace('ABCDEFH\t1\t', 'ABCDEFH\t2\t');
	// The definitions page refuses it, by line, and says where playabilities are replaced.
	await expect(async () => {
		await upload(
			page,
			'/admin/lexicons/definitions',
			async () => {
				await page.getByLabel('Lexicon').selectOption({ label: lex });
			},
			'raised.tsv',
			raised
		);
		await expect(page.getByText('1 problem; nothing was stored')).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/^Line 2: "ABCDEFH" has playability 2 here and 1 in the lexicon; .*Replace playability$/)).toBeVisible();
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	await page.getByRole('main').getByRole('link', { name: 'Replace playability' }).click();
	await expect(page).toHaveURL(/\/admin\/lexicons\/playability$/);
	// The page says what a replacement leaves alone and what it changes.
	await expect(page.getByText('Existing cascades keep their questions: a cascade’s questions are fixed when it is created.')).toBeVisible();
	await expect(page.getByText('Saved searches and new cascades that use Playability Order or Limit by Playability Order return different words from then on.')).toBeVisible();
	// It refuses the file as first uploaded, whose first definition is no longer the lexicon's.
	await expect(async () => {
		await upload(
			page,
			'/admin/lexicons/playability',
			async () => {
				await page.getByLabel('Lexicon').selectOption({ label: lex });
			},
			'old-definitions.tsv',
			bigLexicon().replace('ABCDEFH\t1\t', 'ABCDEFH\t2\t')
		);
		await expect(page.getByText('1 problem; nothing was stored')).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/^Line 1: "ABCDEFG" has a definition here that is not its definition in the lexicon; .*Replace definitions$/)).toBeVisible();
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	// And takes the file that differs in a playability alone.
	await expect(async () => {
		await upload(
			page,
			'/admin/lexicons/playability',
			async () => {
				await page.getByLabel('Lexicon').selectOption({ label: lex });
			},
			'raised.tsv',
			raised
		);
		await expect(page.getByText('1 of 11,000 playability values changed. This is revision 2 of its playability values.')).toBeVisible({ timeout: 60_000 });
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	// A search ranks by the new values once the server has rebuilt the lexicon's index; the cascade
	// made before keeps its question, and a new one from the same filters takes the word that matches now.
	await expect.poll(found, { timeout: 120_000, intervals: [2_000] }).toEqual(['ABCDEFH']);
	expect(await questionKeys(page, first)).toEqual(['ABCDEFG']);
	const second = await apiCascade(page, { name: `Most playable now ${tag}`, lexicon: lex, filters: mostPlayable });
	expect(await questionKeys(page, second)).toEqual(['ABCDEFH']);
	// The overview shows both revisions: the definitions' and the playability values'.
	await page.goto('/admin');
	await expect(page.getByRole('row').filter({ hasText: lex }).first().getByText('revision 2')).toHaveCount(2, { timeout: 30_000 });

	// And the leave values replaced the same way: the same leaves, one value changed.
	await expect(async () => {
		await upload(
			page,
			'/admin/leave-sets/values',
			async () => {
				await page.getByLabel('Lexicon').selectOption({ label: lex });
			},
			'new-values.csv',
			readFileSync(path.join(fixtures, 'EN-FIX-leaves.csv'), 'utf8').replace('?S,32.400', '?S,12.5')
		);
		await expect(page.getByText('1 of 35 values changed. This is revision 2 of its leave values.')).toBeVisible({ timeout: 60_000 });
	}).toPass({ timeout: 240_000, intervals: [15_000] });
	// The Leave Value cascade made above keeps its questions and shows the new value, with no reload of the app:
	// its cards are fetched again once this device has pulled the row at the new revision.
	await page.goto(leaves);
	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					const open = (name: string) =>
						new Promise<IDBDatabase>((res, rej) => {
							const r = indexedDB.open(name);
							r.onsuccess = () => res(r.result);
							r.onerror = () => rej(r.error);
						});
					const all = <T>(db: IDBDatabase, store: string) =>
						new Promise<T[]>((res) => {
							const r = db.transaction(store).objectStore(store).getAll();
							r.onsuccess = () => res(r.result as T[]);
						});
					const pointer = (await all<{ user_id: string }>(await open('acrodont'), 'pointer'))[0];
					const db = await open(`acrodont-user-${pointer.user_id}`);
					const keys = await all<{ cascade_id: string; idx: number; key: string }>(db, 'questions');
					const cards = await all<{ cascade_id: string; idx: number; answer: number; rev?: number }>(db, 'cards');
					const q = keys.find((k) => k.key === '?S');
					const card = q && cards.find((c) => c.cascade_id === q.cascade_id && c.idx === q.idx);
					return card ? [card.answer, card.rev] : null;
				}),
			{ timeout: 90_000 }
		)
		.toEqual([12.5, 2]);

	// Deletion refused while the cascade exists: the button is disabled and says what uses it
	// (PLAN.md § Catalog: "the admin page disables the delete button and explains what is still using the item").
	await page.goto('/admin');
	const row = page.getByRole('row').filter({ hasText: lex }).first();
	await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled({ timeout: 30_000 });
	await expect(row.getByText('In use: it has leave values and 3 cascades use it.')).toBeVisible();

	// More than 2,000 levels: warned about under the cascade's segment size, in Settings.
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
	const d = page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'This Cascade' });
	await d.getByLabel('Study in segments').check();
	await d.getByLabel('Segment size', { exact: true }).fill('5');
	await expect(d.getByText('One pass could create up to 2,200 drill levels, one for each segment with a miss.')).toBeVisible();
});
