// The player's controls on this device (PLAN.md § Taking a quiz → Controls):
// which keys, mouse buttons and wheel directions do Show / Next, Toggle grade
// and Previous. Kept in the user's `meta` store, per device and user like the
// display settings, and never synced: a laptop's trackpad and a desktop's
// five-button mouse want different bindings.
import type { UserDb } from '$lib/local/db';
import { getMeta } from '$lib/local/meta';
import { DEFAULT_BINDINGS, normalizeBindings, type Binding } from './bindings';

class ControlsState {
	value = $state<Binding[]>(DEFAULT_BINDINGS.map((b) => ({ ...b })));
	#db: UserDb | null = null;

	async load(db: UserDb) {
		this.#db = db;
		this.value = normalizeBindings(await getMeta(db, 'bindings'));
	}

	async set(next: Binding[]) {
		this.value = normalizeBindings($state.snapshot(next));
		if (!this.#db) return;
		const tx = this.#db.transaction(['meta'], 'readwrite');
		await tx.objectStore('meta').put($state.snapshot(this.value), 'bindings');
		await tx.done;
	}
}

export const controls = new ControlsState();
