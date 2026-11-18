// The settings of the open cascade on this device (PLAN.md § Settings → Where
// a setting applies): what each of the four scopes holds, and the value each
// setting takes from them, the latest change winning. A change is made for
// this cascade on this device; the offer under it can then make the same
// change for this cascade on all devices, all cascades on this device, or all
// cascades on all devices. Each change is stamped by the server's clock
// (lib/settings/clock).
import { untrack } from 'svelte';
import type { UserDb } from '$lib/local/db';
import type { CascadeRow } from '$lib/local/rows';
import { settingsNow } from './clock';
import {
	emptyLayers,
	resolve,
	resolveAll,
	sameValue,
	SCOPES,
	SETTING_KEYS,
	stamp,
	type Layers,
	type Scope,
	type SettingKey,
	type Settings,
	type Values
} from './layers';
import { cascadeEntries, readScopes, writeScope } from './places';

export interface SettingsHooks {
	/** Makes changes for this cascade on all devices with `set_cascade_settings` at `at`; false when it was refused. */
	writeCascade: (values: Values, at: Date) => Promise<boolean>;
	/** After any change: the page syncs, and makes the player show what changed. */
	afterChange: (keys: SettingKey[]) => Promise<void> | void;
}

type Cascade = Pick<CascadeRow, 'id' | 'settings' | 'created_at'>;

/** A change made for this cascade on this device, which its offer can make more widely. */
export interface Offer {
	values: Values;
	/** Bumped by each change, so a second change to the same setting starts a fresh offer. */
	serial: number;
}

class SettingsState {
	/** A cascade's settings on this device: rows say where a value comes from and offer to widen a change. */
	readonly scoped = true;
	layers = $state<Layers>(emptyLayers());
	/** When the open cascade was made: a change for all cascades made before it does not reach it. */
	createdAt = $state<string | null>(null);
	/** Every setting's value: the latest change covering this cascade on this device, else the default. */
	value = $derived<Settings>(resolveAll(this.layers, this.createdAt));
	/** The offer under each setting (or preset) changed since Settings opened. */
	offers = $state<Record<string, Offer>>({});
	/** How many cascades "all cascades" would reach: those not in the Trash. */
	reach = $state(1);
	#serial = 0;
	#db: UserDb | null = null;
	#cascade: Cascade | null = null;
	#hooks: SettingsHooks | null = null;

	/** Reads every scope for `cascade` (null: the device's and the account's only). */
	async open(db: UserDb, cascade: Cascade | null, hooks: SettingsHooks | null = null) {
		this.#db = db;
		this.#cascade = cascade;
		this.#hooks = hooks;
		this.createdAt = cascade?.created_at || null;
		this.layers = await readScopes(db, cascade);
	}

	/** The cascade row as the player now has it: its own changes may have changed (a sync, another tab). */
	setCascade(row: Cascade | null) {
		if (!row || row.id !== this.#cascade?.id) return;
		this.#cascade = row;
		const own = cascadeEntries(row);
		// Untracked: an effect that passes the row in depends on the row alone.
		if (row.created_at && row.created_at !== untrack(() => this.createdAt)) this.createdAt = row.created_at;
		if (!untrack(() => sameValue(own, this.layers.cascade))) this.layers = { ...untrack(() => this.layers), cascade: own };
	}

	/** Reads the scopes again: after a sync took the account's changes, or another tab made some here. */
	async reload() {
		if (this.#db) this.layers = await readScopes(this.#db, this.#cascade);
	}

	/** The scope a setting's value comes from, or the default. */
	sourceOf(key: SettingKey): Scope | 'default' {
		return resolve(this.layers, key, this.createdAt).from;
	}

	/** Settings opened: no offers yet. */
	resetOffers() {
		this.offers = {};
	}

	/** A change from Settings: made for this cascade on this device, and offered more widely. */
	async change<K extends SettingKey>(key: K, value: Settings[K]) {
		await this.applyValues(key, { [key]: value });
	}

	/**
	 * Changes for this cascade on this device (a preset applied, or one
	 * setting), with the offer `id` to make them more widely. Returns how many
	 * settings now show another value.
	 */
	async applyValues(id: string, values: Values): Promise<number> {
		const before = this.value;
		if (!(await this.#write('both', values))) return 0;
		this.offers = { ...this.offers, [id]: { values, serial: ++this.#serial } };
		const after = this.value;
		return SETTING_KEYS.filter((k) => !sameValue(before[k], after[k])).length;
	}

	/** The offer `id` taken: the same changes, made now for `scope`. */
	async widen(id: string, scope: Exclude<Scope, 'both'>): Promise<boolean> {
		const o = this.offers[id];
		if (!o) return false;
		return this.#write(scope, o.values);
	}

	async #write(scope: Scope, given: Values): Promise<boolean> {
		const db = this.#db;
		if (!db) return false;
		// Plain values: a preset's, or a list from a form, may be reactive state, which IndexedDB cannot store.
		const values = $state.snapshot(given) as Values;
		const keys = Object.keys(values) as SettingKey[];
		// Later than every change it is made over, so it wins even in the same millisecond.
		let t = (await settingsNow(db)).getTime();
		for (const scope of SCOPES) {
			for (const k of keys) {
				const held = Date.parse(this.layers[scope][k]?.at ?? '');
				if (held >= t) t = held + 1;
			}
		}
		const now = new Date(t);
		const at = now.toISOString();
		// Shown at once; the scope's own store follows.
		this.layers = { ...this.layers, [scope]: stamp(this.layers[scope], values, at) };
		const ok = await writeScope(db, scope, this.#cascade?.id ?? null, values, at, (v) =>
			this.#hooks ? this.#hooks.writeCascade(v, now) : Promise.resolve(false)
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
