// Lexicons for Search, on this device (PLAN.md § Search page → Lexicon packs).
//
// The server sends a lexicon as two packs: the core (`word⇥playability`
// lines) and its definitions (a line per word, in the same order). The
// worker builds its index from them once; what the device keeps is that
// index, as the worker saved it, gzipped: reading it back takes a fraction of
// a second where building takes seconds. One row per lexicon, replaced when
// the lexicon's revisions move or the index's format changes, and never
// evicted: Account lists them, each with Remove.
import { ApiError, boundUser, USER_HEADER } from '$lib/api';
import type { LexiconInfo } from '$lib/filters';
import type { UserDb } from '$lib/local/db';
import { readMeta, writeMeta } from '$lib/local/meta';
import type { DistributionRow } from '$lib/local/rows';
import { loadLexicons } from '$lib/catalog';
import type { IDBPTransaction } from 'idb';

export interface LexiconPackRow {
	lexicon: string;
	letter_distribution: string;
	/** `definitions.playability`, the server's revisions the index was built from. */
	revisions: string;
	/** Whether the index holds the definitions. */
	definitions: boolean;
	/** The index's layout (`encoded::FORMAT`); another is rebuilt. */
	format: number;
	gzipped: ArrayBuffer;
	saved_at: string;
}

export type PackPart = 'core' | 'definitions';

/** A lexicon's revisions as the listing gives them, or null from a server too old to say. */
export function revisionsOf(info: LexiconInfo | undefined): string | null {
	if (info?.definitions_revision === undefined || info.playability_revision === undefined) return null;
	return `${info.definitions_revision}.${info.playability_revision}`;
}

export const getPack = (db: UserDb, lexicon: string) => db.get('lexicon_packs', lexicon);
export const putPack = (db: UserDb, row: LexiconPackRow) => db.put('lexicon_packs', row);
export const removePack = (db: UserDb, lexicon: string) => db.delete('lexicon_packs', lexicon);
export const listPacks = (db: UserDb) => db.getAll('lexicon_packs');

type MetaTx = IDBPTransaction<import('$lib/local/db').UserSchema, import('$lib/local/db').StoreName[], 'readwrite'>;

/**
 * The lexicons, from the server when it answers, kept for when it does not;
 * `online` false when the list is the kept one.
 */
export async function lexiconList(db: UserDb): Promise<{ lexicons: LexiconInfo[]; online: boolean }> {
	try {
		const lexicons = await loadLexicons();
		const tx = db.transaction(['meta'], 'readwrite') as unknown as MetaTx;
		await writeMeta(tx, 'lexicons', lexicons);
		await tx.done;
		return { lexicons, online: true };
	} catch {
		const tx = db.transaction(['meta']) as unknown as MetaTx;
		return { lexicons: await readMeta(tx, 'lexicons'), online: false };
	}
}

/** The distribution from the device, or the server (kept for next time, as the downloads keep it). */
export async function distributionFor(db: UserDb, name: string): Promise<DistributionRow> {
	const kept = await db.get('distributions', name);
	if (kept) return kept;
	const resp = await fetch(`/api/letter-distributions/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
	if (!resp.ok) throw new ApiError(resp.status, null, null);
	const d = (await resp.json()) as DistributionRow;
	const row = { name: d.name, tiles: d.tiles };
	await db.put('distributions', row);
	return row;
}

/**
 * Downloads one pack of `lexicon`, reporting bytes as they arrive. Signed-in
 * only: the server refuses anyone else (`401`).
 */
export async function downloadPack(
	lexicon: string,
	part: PackPart,
	onBytes: (received: number) => void = () => {},
	fetcher: typeof fetch = fetch
): Promise<{ bytes: ArrayBuffer; revisions: string }> {
	const headers: Record<string, string> = {};
	const user = boundUser();
	if (user) headers[USER_HEADER] = user;
	const path = `/api/lexicons/${encodeURIComponent(lexicon)}/pack${part === 'definitions' ? '/definitions' : ''}`;
	const resp = await fetcher(path, { headers, credentials: 'same-origin' });
	if (!resp.ok) {
		let body: unknown = null;
		try {
			body = await resp.json();
		} catch {
			/* not JSON */
		}
		throw new ApiError(resp.status, body, Number(resp.headers.get('Retry-After')) || null);
	}
	const revisions = resp.headers.get('X-Lexicon-Revisions') ?? '';
	if (!resp.body) return { bytes: await resp.arrayBuffer(), revisions };
	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = resp.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		onBytes(received);
	}
	const bytes = new Uint8Array(received);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.length;
	}
	return { bytes: bytes.buffer, revisions };
}

/** The kept index is usable as it is: built from these revisions (when known) in this format. */
export function current(row: LexiconPackRow | undefined, revisions: string | null, format: number): boolean {
	return !!row && row.format === format && (revisions === null || row.revisions === revisions);
}

/** Bytes, in the Account page's words. */
export function packSize(row: Pick<LexiconPackRow, 'gzipped'>): number {
	return row.gzipped.byteLength;
}
