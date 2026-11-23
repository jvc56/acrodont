// The search on the Search page and in the player's Search, which are one
// (PLAN.md § Search page): its lexicon, filters, order, columns and the
// download's choices, kept in `meta` so a reload finds it as it was left.
import { newGroup, newKey, newRow, type GroupState, type NodeState } from '$lib/builder/form';
import type { UserDb } from '$lib/local/db';
import { readMeta, writeMeta } from '$lib/local/meta';
import type { IDBPTransaction } from 'idb';
import { CSV_COLUMNS, type CsvColumn, type Sort } from './protocol';

/** The list's optional columns; the word is always shown. */
export interface Columns {
	probability: boolean;
	hooks: boolean;
	definition: boolean;
	playability: boolean;
}

export interface SavedSearch {
	lexicon: string;
	root: GroupState;
	sort: Sort;
	columns: Columns;
	format: 'txt' | 'csv';
	csvColumns: CsvColumn[];
}

/** One Anagram Match row, its pattern empty (PLAN.md § Search page → The page). */
export const startingRoot = () => newGroup('and', [newRow('anagram_match', 'definition', null)]);
export const DEFAULT_COLUMNS: Columns = { probability: true, hooks: true, definition: true, playability: false };
export const DEFAULT_CSV: CsvColumn[] = ['word', 'probability_order', 'front_hooks', 'back_hooks', 'definition'];

/** A saved tree's nodes get keys of this tab's: keys number from 1 in every tab. */
function rekey<T extends NodeState>(n: T): T {
	if (n.kind === 'row') return { ...n, key: newKey() };
	return { ...n, key: newKey(), children: n.children.map(rekey) };
}

type Tx = IDBPTransaction<import('$lib/local/db').UserSchema, import('$lib/local/db').StoreName[], 'readwrite'>;

class SearchState {
	lexicon = $state('');
	root = $state<GroupState>(startingRoot());
	sort = $state<Sort>('alphagram');
	columns = $state<Columns>({ ...DEFAULT_COLUMNS });
	format = $state<'txt' | 'csv'>('txt');
	csvColumns = $state<CsvColumn[]>([...DEFAULT_CSV]);
	/** The list's scroll position, for coming back to the same place; not saved. */
	scrollTop = 0;
	/** Whether this tab has read the saved search yet. */
	loaded = $state(false);
	private saving: ReturnType<typeof setTimeout> | null = null;

	async load(db: UserDb) {
		if (this.loaded) return;
		const tx = db.transaction(['meta']) as unknown as Tx;
		const s = await readMeta(tx, 'search_state');
		if (s) {
			this.lexicon = s.lexicon;
			this.root = rekey(s.root);
			this.sort = s.sort;
			this.columns = { ...DEFAULT_COLUMNS, ...s.columns };
			this.format = s.format;
			this.csvColumns = s.csvColumns.filter((c) => (CSV_COLUMNS as readonly string[]).includes(c));
		}
		this.loaded = true;
	}

	snapshot(): SavedSearch {
		return $state.snapshot({
			lexicon: this.lexicon,
			root: this.root,
			sort: this.sort,
			columns: this.columns,
			format: this.format,
			csvColumns: this.csvColumns
		}) as SavedSearch;
	}

	/** Saved 300 ms after the last change. */
	saveSoon(db: UserDb) {
		if (!this.loaded) return;
		const s = this.snapshot();
		if (this.saving) clearTimeout(this.saving);
		this.saving = setTimeout(async () => {
			this.saving = null;
			const tx = db.transaction(['meta'], 'readwrite') as unknown as Tx;
			await writeMeta(tx, 'search_state', s);
			await tx.done;
		}, 300);
	}

	/** Back to one empty Anagram Match row. */
	reset() {
		this.root = startingRoot();
	}
}

export const searchState = new SearchState();

/** Hands a search to the builder: New cascade from this search. */
let handoff: { lexicon: string; root: GroupState } | null = null;
export function handToBuilder(lexicon: string, root: GroupState) {
	handoff = { lexicon, root: $state.snapshot(root) as GroupState };
}
export function takeHandoff(): { lexicon: string; root: GroupState } | null {
	const h = handoff;
	handoff = null;
	return h ? { lexicon: h.lexicon, root: rekey(h.root) } : null;
}
