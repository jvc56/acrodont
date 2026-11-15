// @vitest-environment jsdom
// PLAN.md § Unit tests → Frontend: the admin pages that replace part of a
// lexicon. The playability page says what a replacement does and does not
// change, uploads to the chosen lexicon's playability endpoint and shows
// either what changed or the error list; the definitions page and the
// overview lead to it.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadResult } from '$lib/admin/upload';

const uploadFile = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('$lib/admin/upload', () => ({ uploadFile }));
vi.mock('$lib/api', async (original) => ({ ...(await original<typeof import('$lib/api')>()), api: { get } }));

import Overview from '../+page.svelte';
import Definitions from './definitions/+page.svelte';
import Playability from './playability/+page.svelte';

const item = { uploaded_by: 'root', uploaded_at: '2026-01-01T00:00:00Z', loading: false, loaded_by: [], storage_bytes: 1000 };
const catalog = {
	instance_id: 'i',
	instances: [],
	letter_distributions: [{ ...item, id: 1, name: 'english', tile_count: 27, lexicon_count: 2 }],
	lexicons: [
		{ ...item, id: 3, name: 'CSW24', letter_distribution: 'english', word_count: 154, has_leave_set: false, cascade_count: 0, definitions_revision: 1, playability_revision: 3 },
		{ ...item, id: 7, name: 'NWL23', letter_distribution: 'english', word_count: 150, has_leave_set: false, cascade_count: 0, definitions_revision: 1, playability_revision: 1 }
	],
	leave_sets: []
};

beforeEach(() => {
	uploadFile.mockReset();
	get.mockReset();
	get.mockResolvedValue(catalog);
});
afterEach(cleanup);

/** The queries of a rendered page that `upload` uses. */
interface Rendered {
	getByLabelText: (text: string) => HTMLElement;
	getByRole: (role: string, options?: { name: string }) => HTMLElement;
}

/** Chooses NWL23 and a file, and presses Upload. */
async function upload(page: Rendered, result: UploadResult) {
	uploadFile.mockResolvedValue(result);
	const select = page.getByLabelText('Lexicon') as HTMLSelectElement;
	await waitFor(() => expect(select.options.length).toBe(2));
	await fireEvent.change(select, { target: { value: '7' } });
	const file = new File(['AA\t1\ta lava\n'], 'new.tsv');
	await fireEvent.change(page.getByLabelText('File'), { target: { files: [file] } });
	await fireEvent.click(page.getByRole('button', { name: 'Upload' }));
	await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
	return file;
}

describe('the playability page', () => {
	it('says that cascades keep their questions and that searches will return different words', () => {
		const page = render(Playability);
		const text = page.container.textContent!.replace(/\s+/g, ' ');
		expect(text).toContain('only playabilities may differ');
		expect(text).toContain('Existing cascades keep their questions: a cascade’s questions are fixed when it is created.');
		expect(text).toContain('Saved searches and new cascades that use Playability Order or Limit by Playability Order return different words from then on.');
		expect(page.getByRole('link', { name: 'Replace definitions' }).getAttribute('href')).toBe('/admin/lexicons/definitions');
	});

	it('uploads the file to the chosen lexicon’s playability endpoint and says what changed', async () => {
		const page = render(Playability);
		const file = await upload(page, { ok: true, item: { id: 7, name: 'NWL23', word_count: 11000, playabilities_changed: 1204, playability_revision: 2 } });
		expect(uploadFile.mock.calls[0].slice(0, 3)).toEqual(['/api/admin/lexicons/7/playability', {}, file]);
		await waitFor(() =>
			expect(page.container.textContent!.replace(/\s+/g, ' ')).toContain(
				'NWL23: 1,204 of 11,000 playability values changed. This is revision 2 of its playability values.'
			)
		);
	});

	it('lists a refusal by line, with nothing stored', async () => {
		const page = render(Playability);
		await upload(page, {
			ok: false,
			status: 400,
			errors: [
				{ line: 2, message: '"AA" has a definition here that is not its definition in the lexicon' },
				{ line: null, message: 'the lexicon’s word "ZA" is missing from the file' }
			],
			total: 2,
			retryAfter: null
		});
		await waitFor(() => expect(page.container.textContent!.replace(/\s+/g, ' ')).toContain('2 problems; nothing was stored'));
		expect(page.getByText('Line 2: "AA" has a definition here that is not its definition in the lexicon')).toBeTruthy();
		expect(page.getByText('the lexicon’s word "ZA" is missing from the file')).toBeTruthy();
	});
});

describe('the ways to the playability page', () => {
	it('the definitions page, which refuses a changed playability, links to it', () => {
		const page = render(Definitions);
		expect(page.getByRole('link', { name: 'Replace playability' }).getAttribute('href')).toBe('/admin/lexicons/playability');
	});

	it('the overview offers it beside Replace definitions and shows each lexicon’s playability revision', async () => {
		const page = render(Overview);
		const link = await waitFor(() => page.getByRole('link', { name: 'Replace playability' }));
		expect(link.getAttribute('href')).toBe('/admin/lexicons/playability');
		expect(page.getByRole('link', { name: 'Replace definitions' }).getAttribute('href')).toBe('/admin/lexicons/definitions');
		const cells = (name: string) =>
			Array.from(page.getAllByRole('row').find((r) => r.textContent!.includes(name))!.querySelectorAll('td')).map((c) => c.textContent!.trim());
		const heads = Array.from(page.getAllByRole('row').find((r) => r.textContent!.includes('Playability'))!.querySelectorAll('th')).map((c) => c.textContent!.trim());
		const at = heads.indexOf('Playability');
		expect(heads[at - 1]).toBe('Definitions');
		expect([cells('CSW24')[at - 1], cells('CSW24')[at]]).toEqual(['as uploaded', 'revision 3']);
		expect(cells('NWL23')[at]).toBe('as uploaded');
	});
});
