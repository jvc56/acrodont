// The preset editor's settings (PLAN.md § Settings → Presets): a preset's
// values, read and saved by the same Settings rows as a cascade's
// (lib/settings/source), and its three rules. Each change is saved to the
// server at once, the whole preset in one `PUT`, one save after another; like
// every change to a preset, it needs a connection. A save that fails says why
// and puts the preset back as it was last saved. Editing a preset changes
// no cascade: a cascade keeps the values it was given when the preset was
// applied, or when it was made with it.
import type { UserDb } from '$lib/local/db';
import { CASCADE_SETTING_DEFAULTS } from '$lib/local/rows';
import type { CascadeSettings } from './cascade';
import type { SettingKey, Settings } from './layers';
import { presetFailure } from './preset-actions';
import { defaultsPreset, presetValues, savePreset, type Preset } from './presets';
import type { SettingsSource } from './source';

const clone = (p: Preset): Preset => JSON.parse(JSON.stringify(p));

export class PresetEditor implements SettingsSource {
	readonly scoped = false;
	preset = $state<Preset>({ ...defaultsPreset(), id: '', name: '', ...CASCADE_SETTING_DEFAULTS });
	value = $derived<Settings>(presetValues(this.preset));
	/** What the last save said: "Saved", or why it could not be. */
	saved = $state(false);
	error = $state<string | null>(null);
	/** Bumped when a failed save puts the preset back, so forms holding their own text show it again. */
	reverts = $state(0);
	#db: UserDb | null = null;
	/** The preset as the server last took it: what a failed save goes back to. */
	#last: Preset | null = null;
	#chain: Promise<unknown> = Promise.resolve();

	load(db: UserDb, preset: Preset) {
		this.#db = db;
		this.#last = clone(preset);
		this.preset = clone(preset);
		this.saved = false;
		this.error = null;
	}

	/** One setting changed in a row. */
	change<K extends SettingKey>(key: K, value: Settings[K]): Promise<boolean> {
		this.preset = { ...this.preset, settings: { ...this.preset.settings, [key]: $state.snapshot(value) } };
		return this.#save();
	}

	/** Some of the rules changed. */
	setRules(fields: CascadeSettings): Promise<boolean> {
		this.preset = { ...this.preset, ...fields };
		return this.#save();
	}

	/** A new name. */
	rename(name: string): Promise<boolean> {
		this.preset = { ...this.preset, name };
		return this.#save();
	}

	/** Saves the preset as it is now, after any save still under way. */
	#save(): Promise<boolean> {
		const run = this.#chain.then(async () => {
			const db = this.#db;
			if (!db) return false;
			this.saved = false;
			this.error = null;
			const p = clone($state.snapshot(this.preset) as Preset);
			try {
				if (!navigator.onLine) throw new TypeError('offline');
				const kept = await savePreset(db, p);
				this.#last = clone(kept);
				this.saved = true;
				return true;
			} catch (e) {
				this.error = presetFailure(e, 'Changing a preset', 'saved');
				if (this.#last) this.preset = clone(this.#last);
				this.reverts += 1;
				return false;
			}
		});
		this.#chain = run.catch(() => undefined);
		return run;
	}
}
