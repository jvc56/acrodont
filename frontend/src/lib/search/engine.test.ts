// PLAN.md § Search page → Lexicon packs: a lexicon is downloaded and built
// once, kept, and read back after that; its definitions come only when
// asked for; a newer revision replaces the kept copy while the old one still
// searches; offline with nothing kept, it says so; and a search started later
// wins over one still running.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { openUserDb, type UserDb } from '$lib/local/db';
import { initMeta } from '$lib/local/meta';
import type { LexiconInfo } from '$lib/filters';
import { SearchEngine } from './engine.svelte';
import type { SearchClient } from './client';
import type { Reply, Request } from './protocol';
import { getPack } from './packs';

const USER = '11111111-1111-4111-8111-111111111111';
const FORMAT = 1;

const info = (d = 1, p = 1): LexiconInfo => ({
	name: 'EN-FIX',
	letter_distribution: 'english',
	word_count: 3,
	leave_count: null,
	max_num_anagrams: 1,
	max_order_rank: 1,
	max_leave_num_anagrams: null,
	max_leave_order_rank: null,
	definitions_revision: d,
	playability_revision: p
});

/** The worker, answering every request at once unless held. */
class FakeWorker {
	requests: Request[] = [];
	held: { request: Request; resolve: (r: Reply) => void }[] = [];
	hold = false;
	answer(request: Request): Reply {
		switch (request.type) {
			case 'format':
				return { ok: true, format: FORMAT };
			case 'save':
				return { ok: true, gzipped: new Uint8Array([1, 2, 3]).buffer };
			case 'search':
				return { ok: true, count: (request.filters as { n: number }).n, ms: 1 };
			default:
				return { ok: true };
		}
	}
	client(): SearchClient {
		return {
			call: (request: Request) => {
				this.requests.push(request);
				if (this.hold && request.type === 'search') return new Promise<Reply>((resolve) => this.held.push({ request, resolve }));
				return Promise.resolve(this.answer(request));
			}
		} as unknown as SearchClient;
	}
	types() {
		return this.requests.map((r) => r.type);
	}
}

/** The server: each pack at a revision, or no connection. */
function server(revisions = '1.1') {
	const s = {
		calls: [] as string[],
		offline: false,
		revisions,
		download: async (_name: string, part: 'core' | 'definitions', onBytes: (n: number) => void = () => {}) => {
			s.calls.push(part);
			if (s.offline) throw new TypeError('Failed to fetch');
			onBytes(10);
			return { bytes: new TextEncoder().encode(part).buffer as ArrayBuffer, revisions: s.revisions };
		}
	};
	return s;
}

let db: UserDb;

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	db = await openUserDb(USER);
	await initMeta(db, USER, 'alice');
	// The letters are on the device already, as the downloads leave them.
	await db.put('distributions', { name: 'english', tiles: [] });
});

describe('getting a lexicon ready', () => {
	it('the first time downloads and builds it, and keeps the index', async () => {
		const w = new FakeWorker();
		const s = server();
		const e = new SearchEngine(() => w.client(), s.download);
		await e.ensure(db, info());
		expect(s.calls).toEqual(['core']);
		expect(w.types()).toEqual(['format', 'build', 'save']);
		expect(e.lexicons['EN-FIX']).toEqual({ kind: 'ready', definitions: false });
		expect(e.ready('EN-FIX')).toBe(true);
		expect(e.ready('EN-FIX', true)).toBe(false);
		expect(await getPack(db, 'EN-FIX')).toMatchObject({ revisions: '1.1', definitions: false, format: FORMAT, letter_distribution: 'english' });
	});

	it('definitions come only when asked for, and are kept with it', async () => {
		const w = new FakeWorker();
		const s = server();
		const e = new SearchEngine(() => w.client(), s.download);
		await e.ensure(db, info());
		await e.ensure(db, info(), { definitions: true });
		expect(s.calls).toEqual(['core', 'definitions']);
		expect(w.types().slice(3)).toEqual(['add_definitions', 'save']);
		expect(e.ready('EN-FIX', true)).toBe(true);
		expect((await getPack(db, 'EN-FIX'))?.definitions).toBe(true);
	});

	it('another tab reads the kept index back, downloading nothing', async () => {
		const s = server();
		await new SearchEngine(() => new FakeWorker().client(), s.download).ensure(db, info(), { definitions: true });
		const w = new FakeWorker();
		const again = new SearchEngine(() => w.client(), s.download);
		await again.ensure(db, info(), { definitions: true });
		expect(s.calls).toEqual(['core', 'definitions']);
		expect(w.types()).toEqual(['format', 'restore']);
		expect(w.requests[1]).toMatchObject({ type: 'restore', definitions: true });
		expect(again.lexicons['EN-FIX']).toEqual({ kind: 'ready', definitions: true });
	});

	it('a newer revision on the server is built again, while the kept copy searches meanwhile', async () => {
		const s = server();
		await new SearchEngine(() => new FakeWorker().client(), s.download).ensure(db, info());
		s.revisions = '2.1';
		const w = new FakeWorker();
		const e = new SearchEngine(() => w.client(), s.download);
		await e.ensure(db, info(2, 1));
		// Ready from the kept copy at once.
		expect(e.ready('EN-FIX')).toBe(true);
		await new Promise((r) => setTimeout(r, 10));
		expect(w.types()).toEqual(['format', 'restore', 'build', 'save']);
		expect((await getPack(db, 'EN-FIX'))?.revisions).toBe('2.1');
	});

	it('the player only reads back what the device has: it downloads nothing', async () => {
		const w = new FakeWorker();
		const s = server();
		const e = new SearchEngine(() => w.client(), s.download);
		await e.ensure(db, info(), { download: false });
		expect(s.calls).toEqual([]);
		expect(e.ready('EN-FIX')).toBe(false);
	});

	it('offline with nothing kept, it says the lexicon needs a connection once', async () => {
		const s = server();
		s.offline = true;
		const e = new SearchEngine(() => new FakeWorker().client(), s.download);
		await expect(e.ensure(db, info())).rejects.toThrow();
		expect(e.lexicons['EN-FIX']).toEqual({ kind: 'offline' });
	});

	it('offline, a kept lexicon still searches, and its missing definitions wait for a connection', async () => {
		const s = server();
		await new SearchEngine(() => new FakeWorker().client(), s.download).ensure(db, info());
		s.offline = true;
		const e = new SearchEngine(() => new FakeWorker().client(), s.download);
		await expect(e.ensure(db, info(), { definitions: true })).rejects.toThrow();
		expect(e.ready('EN-FIX')).toBe(true);
		expect(e.lexicons['EN-FIX']).toEqual({ kind: 'ready', definitions: false });
	});

	it('Remove takes it off the device and out of the worker', async () => {
		const w = new FakeWorker();
		const e = new SearchEngine(() => w.client(), server().download);
		await e.ensure(db, info());
		await e.remove(db, 'EN-FIX');
		expect(await getPack(db, 'EN-FIX')).toBeUndefined();
		expect(e.ready('EN-FIX')).toBe(false);
		expect(w.types().at(-1)).toBe('unload');
	});
});

describe('searching', () => {
	it('a later search wins over one still running', async () => {
		const w = new FakeWorker();
		const e = new SearchEngine(() => w.client(), server().download);
		w.hold = true;
		const first = e.search('EN-FIX', { n: 1 }, 'alphagram');
		const second = e.search('EN-FIX', { n: 2 }, 'alphagram');
		// The worker answers in order; the first answer arrives while the second is current.
		w.held[0].resolve(w.answer(w.held[0].request));
		await first;
		expect(e.result).toBeNull();
		w.held[1].resolve(w.answer(w.held[1].request));
		await second;
		expect(e.result).toMatchObject({ lexicon: 'EN-FIX', count: 2 });
		expect(e.searching).toBe(false);
	});

	it('row errors keep the last result; a sort makes its rows new', async () => {
		const w = new FakeWorker();
		const e = new SearchEngine(() => w.client(), server().download);
		await e.search('EN-FIX', { n: 5 }, 'alphagram');
		const before = e.result!;
		const failing = new FakeWorker();
		failing.answer = () => ({ ok: false, errors: [{ path: [0], field: 'pattern', message: 'Enter a pattern.' }] });
		const e2 = new SearchEngine(() => failing.client(), server().download);
		e2.result = before;
		await e2.search('EN-FIX', {}, 'alphagram');
		expect(e2.result).toBe(before);
		expect(e2.failure?.errors?.[0].field).toBe('pattern');
		await e.sort('probability');
		expect(e.result!.version).toBeGreaterThan(before.version);
		// Rows asked for under the old version are dropped.
		expect(await e.rows(before.version, 0, 10)).toBeNull();
	});
});
