// Reading and writing the four places a setting can be set in (PLAN.md §
// Settings → Where a setting applies; lib/settings/layers). Two are this
// device's, in its `meta` store and never synced: "This cascade on this
// device" and "This device". "This cascade" is the cascade row's `settings`,
// changed by `set_cascade_options` like any other change to the cascade, so
// it works offline and syncs. "Everywhere" is the account's shared settings
// (lib/settings/everywhere), which the next sync carries.
import type { UserDb } from '$lib/local/db';
import { getMeta, readMeta, writeMeta } from '$lib/local/meta';
import type { CascadeRow } from '$lib/local/rows';
import { everywhereValues, setEverywhere } from './everywhere';
import { resolveAll, type Layers, type Place, type Settings, type Values } from './layers';

/** The cascade's own settings, the "This cascade" place. */
export function cascadePlace(row: Pick<CascadeRow, 'settings'> | null | undefined): Values {
	const s = row?.settings;
	return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** What each place holds for `cascade` on this device (no cascade: the device's and the account's only). */
export async function readPlaces(db: UserDb, cascade: Pick<CascadeRow, 'id' | 'settings'> | null): Promise<Layers> {
	const [both, device, shared] = await Promise.all([
		cascade ? getMeta(db, 'cascade_device_settings').then((m) => m[cascade.id] ?? {}) : Promise.resolve({}),
		getMeta(db, 'device_settings'),
		getMeta(db, 'shared_device')
	]);
	return { both, cascade: cascadePlace(cascade), device, all: everywhereValues(shared) };
}

/** Every setting's value for `cascade` on this device. */
export async function settingsFor(db: UserDb, cascade: Pick<CascadeRow, 'id' | 'settings'> | null): Promise<Settings> {
	return resolveAll(await readPlaces(db, cascade));
}

/** `values` with `changes` made: a value replaces, null takes the setting out. */
function changed(values: Values, changes: Record<string, unknown>): Values {
	const out = { ...values };
	for (const [k, v] of Object.entries(changes)) {
		if (v === null || v === undefined) delete out[k];
		else out[k] = v;
	}
	return out;
}

/**
 * Changes what one of this device's places holds: `changes` maps a setting to
 * its new value, or to null to take it out.
 */
export async function writeLocalPlace(db: UserDb, place: 'both' | 'device', cascadeId: string | null, changes: Record<string, unknown>) {
	const tx = db.transaction(['meta'], 'readwrite');
	if (place === 'device') {
		await writeMeta(tx, 'device_settings', changed(await readMeta(tx, 'device_settings'), changes));
	} else if (cascadeId) {
		const all = await readMeta(tx, 'cascade_device_settings');
		const next = changed(all[cascadeId] ?? {}, changes);
		if (Object.keys(next).length) all[cascadeId] = next;
		else delete all[cascadeId];
		await writeMeta(tx, 'cascade_device_settings', all);
	}
	await tx.done;
}

/**
 * Changes one place. "This cascade" goes through `writeCascade`, the caller's
 * `set_cascade_options` (which it syncs and refuses as any change); the other
 * three are written here, and "Everywhere" waits for the next sync.
 */
export async function writePlace(
	db: UserDb,
	place: Place,
	cascadeId: string | null,
	changes: Record<string, unknown>,
	writeCascade: (changes: Record<string, unknown>) => Promise<boolean>
): Promise<boolean> {
	if (place === 'cascade') return writeCascade(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === undefined ? null : v])));
	if (place === 'all') await setEverywhere(db, changes);
	else await writeLocalPlace(db, place, cascadeId, changes);
	return true;
}
