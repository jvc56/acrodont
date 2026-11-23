// Search on this device (PLAN.md § Search page): getting a lexicon ready in
// the worker — read back from the device, or downloaded and built once — and
// running searches over it. One per tab, shared by the Search page and the
// player's Search, so either finds the other's lexicon already loaded.
import type { LexiconInfo } from '$lib/filters';
import type { UserDb } from '$lib/local/db';
import { searchClient, type SearchClient } from './client';
import {
	current,
	distributionFor,
	downloadPack,
	getPack,
	putPack,
	removePack,
	revisionsOf,
	type LexiconPackRow,
	type PackPart
} from './packs';
import type { CsvColumn, Failure, Reply, ResultRow, Sort } from './protocol';

/** The server's deadline for a search (`SEARCH_TIMEOUT_MS`): longer is "too broad". */
export const DEADLINE_MS = 2000;

export type LexiconState =
	| { kind: 'downloading'; part: PackPart; received: number }
	| { kind: 'preparing' }
	| { kind: 'ready'; definitions: boolean }
	/** Not on this device, and no connection to download it. */
	| { kind: 'offline' }
	| { kind: 'failed'; message: string };

export interface SearchResult {
	/** Changes with every search and sort: rows fetched for another version are stale. */
	version: number;
	lexicon: string;
	count: number;
	ms: number;
}

const failureOf = (r: Reply): Failure | null => (r.ok ? null : r);

function isOffline(e: unknown): boolean {
	return e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

export class SearchEngine {
	/** Each lexicon's state in this tab. */
	lexicons = $state<Record<string, LexiconState>>({});
	result = $state<SearchResult | null>(null);
	failure = $state<Failure | null>(null);
	searching = $state(false);

	private format: number | null = null;
	/** What the worker holds, and whether with definitions. */
	private loaded = new Map<string, { definitions: boolean; revisions: string }>();
	private ensuring = new Map<string, Promise<void>>();
	private generation = 0;
	private version = 0;

	constructor(
		private client: () => SearchClient = searchClient,
		private download: typeof downloadPack = downloadPack
	) {}

	private async call(request: Parameters<SearchClient['call']>[0], transfer?: Transferable[]): Promise<Reply> {
		return this.client().call(request, transfer);
	}

	private async indexFormat(): Promise<number> {
		if (this.format === null) {
			const r = await this.call({ type: 'format' });
			this.format = r.ok ? (r.format ?? 0) : 0;
		}
		return this.format;
	}

	private set(name: string, s: LexiconState) {
		this.lexicons = { ...this.lexicons, [name]: s };
	}

	/** Whether `name` can be searched with what `definitions` asks for, in this tab now. */
	ready(name: string, definitions = false): boolean {
		const l = this.loaded.get(name);
		return !!l && (!definitions || l.definitions);
	}

	/**
	 * Makes `info`'s lexicon searchable: from the device if it has it, else
	 * downloaded and built (and kept). With `definitions`, its definitions too.
	 * `download` false only reads back what the device has: the player warms
	 * the worker without fetching anything.
	 */
	ensure(db: UserDb, info: LexiconInfo, opts: { definitions?: boolean; download?: boolean } = {}): Promise<void> {
		const key = `${info.name}\u0000${!!opts.definitions}\u0000${opts.download ?? true}`;
		let p = this.ensuring.get(key);
		if (!p) {
			p = this.ensureNow(db, info, !!opts.definitions, opts.download ?? true).finally(() => this.ensuring.delete(key));
			this.ensuring.set(key, p);
		}
		return p;
	}

	private async ensureNow(db: UserDb, info: LexiconInfo, definitions: boolean, download: boolean): Promise<void> {
		const name = info.name;
		const wanted = revisionsOf(info);
		try {
			const format = await this.indexFormat();
			let here = this.loaded.get(name);
			if (here && wanted !== null && here.revisions !== wanted && download) {
				// The server's words moved: build afresh, keeping what this tab had meanwhile.
				await this.build(db, info, here.definitions || definitions, format);
				return;
			}
			if (!here) {
				const row = await getPack(db, name);
				if (row && row.format === format) {
					this.set(name, { kind: 'preparing' });
					await this.restore(db, row, info);
					here = this.loaded.get(name)!;
					if (!current(row, wanted, format) && download) {
						if (definitions && !row.definitions) {
							await this.build(db, info, true, format);
							return;
						}
						// Searchable now from the kept copy; the new one replaces it once built.
						this.set(name, { kind: 'ready', definitions: row.definitions });
						void this.build(db, info, row.definitions, format).catch(() =>
							this.set(name, { kind: 'ready', definitions: this.loaded.get(name)?.definitions ?? false })
						);
						return;
					}
				} else if (!download) {
					return;
				} else {
					await this.build(db, info, definitions, format);
					return;
				}
			}
			if (definitions && !here.definitions && download) await this.addDefinitions(db, info, format);
			this.set(name, { kind: 'ready', definitions: this.loaded.get(name)!.definitions });
		} catch (e) {
			if (this.loaded.has(name)) {
				// What it has still searches; only the definitions or a refresh failed.
				this.set(name, { kind: 'ready', definitions: this.loaded.get(name)!.definitions });
			} else this.set(name, isOffline(e) ? { kind: 'offline' } : { kind: 'failed', message: e instanceof Error ? e.message : String(e) });
			throw e;
		}
	}

	private async restore(db: UserDb, row: LexiconPackRow, info: LexiconInfo) {
		const distribution = await distributionFor(db, info.letter_distribution);
		// A copy goes: the row keeps its bytes for the next tab.
		const gzipped = row.gzipped.slice(0);
		const r = await this.call({ type: 'restore', name: row.lexicon, distribution, gzipped, definitions: row.definitions }, [gzipped]);
		if (!r.ok) throw new Error(r.message ?? 'The lexicon on this device could not be read.');
		this.loaded.set(row.lexicon, { definitions: row.definitions, revisions: row.revisions });
	}

	private async fetchPart(name: string, part: PackPart) {
		this.set(name, { kind: 'downloading', part, received: 0 });
		return this.download(name, part, (received) => this.set(name, { kind: 'downloading', part, received }));
	}

	/** Downloads and builds the lexicon (and its definitions), then keeps it. */
	private async build(db: UserDb, info: LexiconInfo, definitions: boolean, format: number) {
		const name = info.name;
		const distribution = await distributionFor(db, info.letter_distribution);
		const core = await this.fetchPart(name, 'core');
		this.set(name, { kind: 'preparing' });
		const r = await this.call({ type: 'build', name, distribution, core: core.bytes }, [core.bytes]);
		if (!r.ok) throw new Error(r.message ?? 'The lexicon could not be prepared.');
		this.loaded.set(name, { definitions: false, revisions: core.revisions });
		await this.keep(db, info, false, core.revisions, format);
		if (definitions) await this.addDefinitions(db, info, format);
		this.set(name, { kind: 'ready', definitions: this.loaded.get(name)!.definitions });
	}

	private async addDefinitions(db: UserDb, info: LexiconInfo, format: number) {
		const name = info.name;
		const defs = await this.fetchPart(name, 'definitions');
		const here = this.loaded.get(name)!;
		if (defs.revisions && here.revisions && defs.revisions !== here.revisions) {
			// The words moved between the two downloads: build them both again.
			return this.build(db, info, true, format);
		}
		this.set(name, { kind: 'preparing' });
		const r = await this.call({ type: 'add_definitions', name, definitions: defs.bytes }, [defs.bytes]);
		if (!r.ok) throw new Error(r.message ?? 'The definitions could not be added.');
		here.definitions = true;
		await this.keep(db, info, true, here.revisions, format);
	}

	private async keep(db: UserDb, info: LexiconInfo, definitions: boolean, revisions: string, format: number) {
		const r = await this.call({ type: 'save', name: info.name });
		if (!r.ok || !r.gzipped) return;
		await putPack(db, {
			lexicon: info.name,
			letter_distribution: info.letter_distribution,
			revisions,
			definitions,
			format,
			gzipped: r.gzipped,
			saved_at: new Date().toISOString()
		});
	}

	/** Takes a lexicon off this device and out of this tab. */
	async remove(db: UserDb, lexicon: string) {
		await removePack(db, lexicon);
		this.loaded.delete(lexicon);
		const { [lexicon]: _gone, ...rest } = this.lexicons;
		this.lexicons = rest;
		if (this.result?.lexicon === lexicon) this.result = null;
		await this.call({ type: 'unload', name: lexicon });
	}

	/**
	 * Runs `filters` over `lexicon`. A search started after this one wins:
	 * this one's answer is then dropped. Row errors keep the last result.
	 */
	async search(lexicon: string, filters: unknown, sort: Sort): Promise<void> {
		const gen = ++this.generation;
		this.searching = true;
		const r = await this.call({ type: 'search', lexicon, filters: $state.snapshot(filters), sort, deadline_ms: DEADLINE_MS });
		if (gen !== this.generation) return;
		this.searching = false;
		this.failure = failureOf(r);
		if (r.ok) this.result = { version: ++this.version, lexicon, count: r.count ?? 0, ms: r.ms ?? 0 };
	}

	/** Forgets the result, as when the filters are emptied. */
	clear() {
		this.generation++;
		this.searching = false;
		this.failure = null;
		this.result = null;
	}

	async sort(sort: Sort): Promise<void> {
		if (!this.result) return;
		await this.call({ type: 'sort', sort });
		this.result = { ...this.result, version: ++this.version };
	}

	/** Rows of the result `version`, or null when a newer one replaced it meanwhile. */
	async rows(version: number, from: number, n: number): Promise<ResultRow[] | null> {
		const r = await this.call({ type: 'rows', from, n });
		if (this.result?.version !== version) return null;
		return r.ok ? (r.rows ?? []) : [];
	}

	async file(format: 'txt' | 'csv', columns: CsvColumn[]): Promise<Blob | null> {
		// A plain copy: the page's list is a state proxy, which postMessage cannot clone.
		const r = await this.call({ type: 'export', format, columns: [...columns] });
		return r.ok ? (r.file ?? null) : null;
	}
}

export const searchEngine = new SearchEngine();
