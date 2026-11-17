// Where the Settings rows read and save their values (PLAN.md § Settings): the
// open cascade's settings on this device (store.svelte), which a change offers
// to make more widely, or a preset's in the preset editor
// (preset-editor.svelte), which has no such offer. A page that edits a preset
// provides its own source; every other page reads the cascade's.
import { getContext, setContext } from 'svelte';
import type { Scope, SettingKey, Settings } from './layers';
import { settings } from './store.svelte';

export interface SettingsSource {
	readonly value: Settings;
	change<K extends SettingKey>(key: K, value: Settings[K]): Promise<unknown>;
	/** True for a cascade's settings on this device: rows say where a value comes from and offer to apply a change more widely. */
	readonly scoped: boolean;
	sourceOf?(key: SettingKey): Scope | 'default';
}

const KEY = Symbol('settings-source');

/** Called while a page is set up: the Settings rows under it read and save `source`. */
export function provideSettings(source: SettingsSource) {
	setContext(KEY, source);
}

/** The source the Settings rows here read and save; called while a component is set up. */
export function useSettings(): SettingsSource {
	return getContext<SettingsSource | undefined>(KEY) ?? settings;
}
