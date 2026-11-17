// Presets (PLAN.md § Settings → Presets): every setting's value and a
// cascade's three rules, saved under a name, to apply to a cascade or to start
// one with. The server keeps the account's presets; saving, renaming and
// deleting one needs a connection. Each sync response carries the whole list
// when this device's version (`meta.presets.version`) is not the account's, and
// the device keeps it, so a preset can be applied offline and the builder can
// list them. Defaults is built in: never stored, first in every list, and its
// name is no other preset's.
import { api } from '$lib/api';
import type { UserDb } from '$lib/local/db';
import { getMeta, readMeta, writeMeta } from '$lib/local/meta';
import type { Progression } from '$lib/cascade/rules';
import { CASCADE_SETTING_DEFAULTS, type CascadeRow } from '$lib/local/rows';
import { SETTING_KEYS, type Settings, type Values } from './layers';

export interface Preset {
	id: string;
	name: string;
	/** Setting name to value; a setting it does not name, or null, is the default. */
	settings: Values;
	clear_threshold: number;
	segment_size: number;
	progression: Progression;
	updated_at?: string;
}

/** The built-in preset's id and name. */
export const DEFAULTS_ID = 'defaults';
export const DEFAULTS_NAME = 'Defaults';

/** Defaults: every setting at its default, and the rules a new cascade starts with. */
export function defaultsPreset(): Preset {
	return {
		id: DEFAULTS_ID,
		name: DEFAULTS_NAME,
		settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, null])),
		...CASCADE_SETTING_DEFAULTS
	};
}

export const isDefaults = (p: Pick<Preset, 'id'>) => p.id === DEFAULTS_ID;

/** Whether `name` is the built-in preset's, which no stored preset may take. */
export function isDefaultsName(name: string): boolean {
	return name.trim().toLowerCase() === DEFAULTS_NAME.toLowerCase();
}

/** The presets to choose from: Defaults first, then the account's by name. */
export async function presetList(db: UserDb): Promise<Preset[]> {
	const { list } = await getMeta(db, 'presets');
	return [defaultsPreset(), ...[...list].sort((a, b) => a.name.localeCompare(b.name))];
}

/** The preset the builder starts at: the one used last here, or Defaults once that one is gone. */
export async function startingPreset(db: UserDb, list: Preset[]): Promise<Preset> {
	const last = await getMeta(db, 'last_preset_id');
	return list.find((p) => p.id === last) ?? list[0] ?? defaultsPreset();
}

export async function rememberPreset(db: UserDb, id: string) {
	const tx = db.transaction(['meta'], 'readwrite');
	await writeMeta(tx, 'last_preset_id', id === DEFAULTS_ID ? null : id);
	await tx.done;
}

/** A preset as a sync response carries it, made valid; null when it cannot be read. */
function presetOf(v: unknown): Preset | null {
	if (typeof v !== 'object' || v === null) return null;
	const p = v as Record<string, unknown>;
	if (typeof p.id !== 'string' || typeof p.name !== 'string') return null;
	const settings = typeof p.settings === 'object' && p.settings !== null && !Array.isArray(p.settings) ? (p.settings as Values) : {};
	return {
		id: p.id,
		name: p.name,
		settings,
		clear_threshold: typeof p.clear_threshold === 'number' ? p.clear_threshold : CASCADE_SETTING_DEFAULTS.clear_threshold,
		segment_size: typeof p.segment_size === 'number' ? p.segment_size : CASCADE_SETTING_DEFAULTS.segment_size,
		progression: p.progression === 'drill' ? 'drill' : 'ladder',
		updated_at: typeof p.updated_at === 'string' ? p.updated_at : undefined
	};
}

/**
 * After a sync: the response's version, and its list when it carried one.
 * True when the list this device holds changed.
 */
export async function takePresets(db: UserDb, version: unknown, list: unknown): Promise<boolean> {
	if (typeof version !== 'string') return false;
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'presets');
	let changed = false;
	if (Array.isArray(list)) {
		const next = list.map(presetOf).filter((p): p is Preset => p !== null);
		changed = JSON.stringify(next) !== JSON.stringify(st.list);
		st.list = next;
		st.version = version;
	} else if (st.version !== version) {
		// A version moved without its list: the next request asks again.
		st.version = null;
	}
	await writeMeta(tx, 'presets', st);
	await tx.done;
	return changed;
}

/** The version to send with the next sync: the list's, or none to be sent it. */
export async function presetsVersion(db: UserDb): Promise<string | null> {
	return (await getMeta(db, 'presets')).version;
}

/**
 * Changes this device's list at once, as the server just did. The version is
 * forgotten, so the next sync brings the account's whole list: another
 * device's change made meanwhile is never missed.
 */
async function edit(db: UserDb, fn: (list: Preset[]) => Preset[]) {
	const tx = db.transaction(['meta'], 'readwrite');
	const st = await readMeta(tx, 'presets');
	await writeMeta(tx, 'presets', { version: null, list: fn(st.list) });
	await tx.done;
}

/** A preset made from what a cascade shows on this device: every setting's value, and the cascade's rules. */
export function presetFrom(id: string, name: string, values: Settings, cascade: Pick<CascadeRow, 'clear_threshold' | 'segment_size' | 'progression'>): Preset {
	return {
		id,
		name,
		settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, values[k]])),
		clear_threshold: cascade.clear_threshold,
		segment_size: cascade.segment_size,
		progression: cascade.progression
	};
}

/**
 * Saves `p` on the server under its id: a new preset, or a replacement of the
 * one with that id. Throws the server's refusal (`name_taken`, `preset_limit`,
 * a field error) or a connection's failure, as `api` does.
 */
export async function savePreset(db: UserDb, p: Preset): Promise<Preset> {
	const r = await api.put<{ preset: unknown }>(`/api/presets/${p.id}`, {
		name: p.name,
		settings: p.settings,
		clear_threshold: p.clear_threshold,
		segment_size: p.segment_size,
		progression: p.progression
	});
	const saved = presetOf(r.preset) ?? p;
	await edit(db, (list) => [...list.filter((o) => o.id !== saved.id), saved]);
	return saved;
}

export async function renamePreset(db: UserDb, id: string, name: string): Promise<void> {
	await api.patch(`/api/presets/${id}`, { name });
	await edit(db, (list) => list.map((o) => (o.id === id ? { ...o, name } : o)));
}

export async function deletePreset(db: UserDb, id: string): Promise<void> {
	await api.delete(`/api/presets/${id}`);
	await edit(db, (list) => list.filter((o) => o.id !== id));
}

/** A cascade's starting settings from `p`, as Create Cascade sends them: none for Defaults. */
export function startingSettings(p: Preset): Values | undefined {
	if (isDefaults(p)) return undefined;
	const out = Object.fromEntries(Object.entries(p.settings).filter(([, v]) => v !== null && v !== undefined));
	return Object.keys(out).length ? out : undefined;
}
