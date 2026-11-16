// The settings of the open cascade on this device (PLAN.md § Settings → Where
// a setting applies): what each of the four places holds, the value each
// setting takes from them, and where each row's two switches point. A row's
// switches show the place its value comes from, or, while it has none, where
// a change will go: this cascade on this device until they are switched. A
// change is saved in the place they show; switching one moves the value.
import { untrack } from 'svelte';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow } from '$lib/local/rows';
import {
	emptyLayers,
	narrowerThan,
	PLACE_NAMES,
	PLACES,
	resolve,
	resolveAll,
	sameValue,
	settingText,
	valueIn,
	type Layers,
	type Place,
	type SettingKey,
	type Settings
} from './layers';
import { cascadePlace, readPlaces, writePlace } from './places';

export interface SettingsHooks {
	/** Sets or clears (null) the cascade's own settings with `set_cascade_options`; false when it was refused. */
	writeCascade: (changes: Record<string, unknown>) => Promise<boolean>;
	/** After any change: the page syncs, and makes the player show what changed. */
	afterChange: (keys: SettingKey[]) => Promise<void> | void;
}

/** Where a row's switches start while nothing is set: this cascade on this device. */
export const START: Place = 'both';

class SettingsState {
	layers = $state<Layers>(emptyLayers());
	/** Every setting's value: the first place holding one, else the default. */
	value = $derived<Settings>(resolveAll(this.layers));
	/** Where the switches of a row with no value point, once switched; START otherwise. */
	targets = $state<Partial<Record<SettingKey, Place>>>({});
	/** What a move took out of the narrower places, said under the row until Settings closes. */
	replaced = $state<Partial<Record<SettingKey, string>>>({});
	#db: UserDb | null = null;
	#cascade: Pick<CascadeRow, 'id' | 'settings'> | null = null;
	#hooks: SettingsHooks | null = null;

	/** Reads every place for `cascade` (null: the device's and the account's only). */
	async open(db: UserDb, cascade: Pick<CascadeRow, 'id' | 'settings'> | null, hooks: SettingsHooks | null = null) {
		this.#db = db;
		this.#cascade = cascade;
		this.#hooks = hooks;
		this.layers = await readPlaces(db, cascade);
	}

	/** The cascade row as the player now has it: its own settings may have changed (a sync, another tab). */
	setCascade(row: Pick<CascadeRow, 'id' | 'settings'> | null) {
		if (!row || row.id !== this.#cascade?.id) return;
		this.#cascade = row;
		const own = cascadePlace(row);
		// Untracked: an effect that passes the row in depends on the row alone.
		if (!untrack(() => sameValue(own, this.layers.cascade))) this.layers = { ...untrack(() => this.layers), cascade: own };
	}

	/** Reads the places again: after a sync took the account's values, or another tab changed this device's. */
	async reload() {
		if (this.#db) this.layers = await readPlaces(this.#db, this.#cascade);
	}

	/** Where a setting's value comes from. */
	sourceOf(key: SettingKey): Place | 'default' {
		return resolve(this.layers, key).from;
	}

	/** What `place` holds for `key`, or undefined. */
	heldIn<K extends SettingKey>(place: Place, key: K): Settings[K] | undefined {
		return valueIn(this.layers, place, key);
	}

	/** Where a row's switches point: the place its value comes from, or where a change will go. */
	placeOf(key: SettingKey): Place {
		const from = this.sourceOf(key);
		return from === 'default' ? (this.targets[key] ?? START) : from;
	}

	/** Settings opened: every row's switches start where its value is, or at START. */
	resetRows() {
		this.targets = {};
		this.replaced = {};
	}

	/** A change from Settings: saved in the place the row's switches show. */
	async change<K extends SettingKey>(key: K, value: Settings[K]) {
		await this.#write(this.placeOf(key), { [key]: value }, [key]);
	}

	/**
	 * A switch pressed: the row now points at `place`. A value in use moves
	 * there: it is set there, then taken out of the place it came from and of
	 * every place narrower than `place`, which would otherwise still win here.
	 * With no value, the next change goes there.
	 */
	async moveTo(key: SettingKey, place: Place) {
		const from = this.sourceOf(key);
		this.targets = { ...this.targets, [key]: place };
		if (from === 'default' || from === place) return;
		const value = this.value[key];
		const out = new Set<Place>([from]);
		const replaced: string[] = [];
		for (const p of narrowerThan(place)) {
			if (p === from || !Object.prototype.hasOwnProperty.call(this.layers[p], key)) continue;
			out.add(p);
			const held = this.heldIn(p, key);
			if (held !== undefined && !sameValue(held, value)) replaced.push(`${PLACE_NAMES[p].toLowerCase()}’s ${settingText(key, held as never)}`);
		}
		// The new place first: the value stays in use throughout.
		if (!(await this.#write(place, { [key]: value }, [key]))) return;
		for (const p of PLACES) {
			if (out.has(p) && !(await this.#write(p, { [key]: null }, [key]))) return;
		}
		this.replaced = { ...this.replaced, [key]: replaced.length ? `Replaced ${replaced.join(' and ')}` : undefined };
	}

	/**
	 * Reset: takes the value out of the place it comes from. The next place
	 * holding one is used, and the switches show it; with none, the default,
	 * and the switches stay where they were.
	 */
	async reset(key: SettingKey) {
		const from = this.sourceOf(key);
		if (from === 'default') return;
		this.targets = { ...this.targets, [key]: from };
		this.replaced = { ...this.replaced, [key]: undefined };
		await this.#write(from, { [key]: null }, [key]);
	}

	async #write(place: Place, changes: Record<string, unknown>, keys: SettingKey[]): Promise<boolean> {
		const db = this.#db;
		if (!db) return false;
		// Shown at once; the place's own store follows.
		const next = { ...this.layers[place] };
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) delete next[k];
			else next[k] = v;
		}
		this.layers = { ...this.layers, [place]: next };
		const ok = await writePlace(db, place, this.#cascade?.id ?? null, changes, (c) =>
			this.#hooks ? this.#hooks.writeCascade(c) : Promise.resolve(false)
		);
		if (!ok) {
			await this.reload();
			return false;
		}
		await this.#hooks?.afterChange(keys);
		return true;
	}
}

export const settings = new SettingsState();
