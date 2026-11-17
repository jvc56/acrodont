// Reading and writing the four scopes a change can be made in (PLAN.md §
// Settings → Where a setting applies; lib/settings/layers). Two are this
// device's, in its `meta` store and never synced: this cascade on this device
// and all cascades on this device. This cascade on all devices is the cascade
// row's `settings`, changed by `set_cascade_settings` like any other change to
// the cascade, so it works offline and syncs. All cascades on all devices is
// the account's settings (lib/settings/everywhere), which the next sync carries.
import type { UserDb } from '$lib/local/db';
import { getMeta, readMeta, writeMeta } from '$lib/local/meta';
import type { CascadeRow } from '$lib/local/rows';
import { everywhereEntries, setEverywhere } from './everywhere';
import { entriesOf, resolveAll, stamp, type Entries, type Layers, type Scope, type Settings, type Values } from './layers';

/** The cascade's own changes, made for it on all devices. */
export function cascadeEntries(row: Pick<CascadeRow, 'settings'> | null | undefined): Entries {
	return entriesOf(row?.settings);
}

/** What each scope holds for `cascade` on this device (no cascade: the device's and the account's only). */
export async function readScopes(db: UserDb, cascade: Pick<CascadeRow, 'id' | 'settings'> | null): Promise<Layers> {
	const [both, device, shared] = await Promise.all([
		cascade ? getMeta(db, 'cascade_device_scope').then((m) => entriesOf(m[cascade.id])) : Promise.resolve({}),
		getMeta(db, 'device_scope'),
		getMeta(db, 'account_settings')
	]);
	return { both, cascade: cascadeEntries(cascade), device: entriesOf(device), all: everywhereEntries(shared) };
}

/** Every setting's value for `cascade` on this device. */
export async function settingsFor(db: UserDb, cascade: Pick<CascadeRow, 'id' | 'settings' | 'created_at'> | null): Promise<Settings> {
	return resolveAll(await readScopes(db, cascade), cascade?.created_at ?? null);
}

/** Makes `values` changes at `at` in one of this device's scopes. */
export async function writeLocalScope(db: UserDb, scope: 'both' | 'device', cascadeId: string | null, values: Values, at: string) {
	const tx = db.transaction(['meta'], 'readwrite');
	if (scope === 'device') {
		await writeMeta(tx, 'device_scope', stamp(entriesOf(await readMeta(tx, 'device_scope')), values, at));
	} else if (cascadeId) {
		const all = await readMeta(tx, 'cascade_device_scope');
		all[cascadeId] = stamp(entriesOf(all[cascadeId]), values, at);
		await writeMeta(tx, 'cascade_device_scope', all);
	}
	await tx.done;
}

/**
 * Makes `values` changes at `at` in `scope`. This cascade on all devices goes
 * through `writeCascade`, the caller's `set_cascade_settings` (which it
 * syncs and refuses as any change); the other three are written here, and
 * all cascades on all devices waits for the next sync.
 */
export async function writeScope(
	db: UserDb,
	scope: Scope,
	cascadeId: string | null,
	values: Values,
	at: string,
	writeCascade: (values: Values) => Promise<boolean>
): Promise<boolean> {
	if (scope === 'cascade') return writeCascade(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? null : v])));
	if (scope === 'all') await setEverywhere(db, values, at);
	else await writeLocalScope(db, scope, cascadeId, values, at);
	return true;
}
