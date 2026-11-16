// The settings of the open cascade on this device (PLAN.md § Settings → Where
// a setting applies): what each of the four places holds, the value each
// setting takes from them, and the Settings dialog's state for each setting
// changed while it is open. A change made in Settings applies to this cascade
// on this device, the narrowest place, and the row then offers to move it to
// a wider one; any place's value can be taken out from the row's 2×2.
import type { UserDb } from '$lib/local/db';
import type { CascadeRow } from '$lib/local/rows';
import {
	emptyLayers,
	narrowerThan,
	PLACE_NAMES,
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

/** The offer under a setting changed while Settings is open. */
export interface Offer {
	/** Where the value now is. */
	place: Place;
	/** What moving it there replaced in the narrower places, as the offer says it. */
	replaced: string[];
	/** A new number for each change, so a second change starts a fresh offer. */
	serial: number;
}

class SettingsState {
	layers = $state<Layers>(emptyLayers());
	/** Every setting's value: the first place holding one, else the default. */
	value = $derived<Settings>(resolveAll(this.layers));
	/** The offers under the settings changed since Settings opened. */
	offers = $state<Partial<Record<SettingKey, Offer>>>({});
	/** The setting whose 2×2 of places is open, if any. */
	expanded = $state<SettingKey | null>(null);
	#db: UserDb | null = null;
	#cascade: Pick<CascadeRow, 'id' | 'settings'> | null = null;
	#hooks: SettingsHooks | null = null;
	#serial = 0;

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
		if (!sameValue(own, this.layers.cascade)) this.layers = { ...this.layers, cascade: own };
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

	/** Settings opened: no offers yet, no 2×2 open. */
	resetOffers() {
		this.offers = {};
		this.expanded = null;
	}

	/** A change from Settings (or the player's menu): this cascade on this device. */
	async change<K extends SettingKey>(key: K, value: Settings[K]) {
		const place: Place = this.#cascade ? 'both' : 'device';
		if (!(await this.#write(place, { [key]: value }, [key]))) return;
		this.offers = { ...this.offers, [key]: { place, replaced: [], serial: ++this.#serial } };
	}

	/**
	 * Moves the value in use to `place`: it is set there, and taken out of
	 * every narrower place, which would otherwise still win here.
	 */
	async moveTo(key: SettingKey, place: Place) {
		const value = this.value[key];
		const from = this.offers[key]?.place;
		const changes: Record<string, Record<string, unknown>> = { [place]: { [key]: value } };
		const replaced: string[] = [];
		for (const p of narrowerThan(place)) {
			const held = this.heldIn(p, key);
			if (held === undefined) continue;
			changes[p] = { [key]: null };
			if (p !== from && !sameValue(held, value)) replaced.push(`${PLACE_NAMES[p].toLowerCase()}’s ${settingText(key, held as never)}`);
		}
		// The wider place first: the value stays in use throughout.
		for (const p of [place, ...narrowerThan(place)]) {
			if (changes[p] && !(await this.#write(p as Place, changes[p], [key]))) return;
		}
		this.offers = { ...this.offers, [key]: { place, replaced, serial: ++this.#serial } };
	}

	/** Takes a setting out of one place; the next place holding one, or the default, is used. */
	async clearIn(key: SettingKey, place: Place) {
		if (!Object.prototype.hasOwnProperty.call(this.layers[place], key)) return;
		await this.#write(place, { [key]: null }, [key]);
		const rest = { ...this.offers };
		delete rest[key];
		this.offers = rest;
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
