// The messages between the page and the search worker (PLAN.md § Search
// page): one request at a time per id, each answered once.
import type { DistributionRow } from '$lib/local/rows';

/** The orders the list can take. */
export type Sort = 'alphagram' | 'alphabetical' | 'probability' | 'playability' | 'length';

/** A CSV download's columns, in the order the file holds them. */
export const CSV_COLUMNS = [
	'word',
	'alphagram',
	'length',
	'probability_order',
	'playability_order',
	'front_hooks',
	'back_hooks',
	'inner_hooks',
	'definition'
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** One word of a result, as the list draws it. */
export interface ResultRow {
	/** Flips where the alphagram changes: the list bands each set of anagrams. */
	band: boolean;
	word: string;
	alphagram: number;
	length: number;
	probability_order: number;
	playability_order: number;
	front_hooks: string;
	back_hooks: string;
	front_inner: boolean;
	back_inner: boolean;
	definition: string;
}

/** A row error, as the server's `400` gives it. */
export interface PathError {
	path: number[];
	field: string;
	message: string;
}

export type Request =
	| { type: 'format' }
	| { type: 'build'; name: string; distribution: DistributionRow; core: ArrayBuffer }
	| { type: 'restore'; name: string; distribution: DistributionRow; gzipped: ArrayBuffer; definitions: boolean }
	| { type: 'add_definitions'; name: string; definitions: ArrayBuffer }
	| { type: 'save'; name: string }
	| { type: 'unload'; name: string }
	| { type: 'search'; lexicon: string; filters: unknown; sort: Sort; deadline_ms: number }
	| { type: 'sort'; sort: Sort }
	| { type: 'rows'; from: number; n: number }
	| { type: 'export'; format: 'txt' | 'csv'; columns: CsvColumn[] };

export interface Failure {
	ok: false;
	message?: string;
	errors?: PathError[];
	too_broad?: boolean;
}

export type Reply =
	| { ok: true; format?: number; ms?: number; count?: number; rows?: ResultRow[]; gzipped?: ArrayBuffer; file?: Blob }
	| Failure;
