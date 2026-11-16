// PLAN.md § Settings → Name: a rename the server answered is shown at once,
// wherever this device holds the cascade, and keeps a setting changed here
// and not yet sent.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it } from 'vitest';
import { storeRenamed } from './created';
import { openUserDb, type UserDb } from './db';
import { initMeta } from './meta';
import type { CascadeRow } from './rows';
import * as view from './view';

const USER = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

async function freshDb(): Promise<UserDb> {
	const db = await openUserDb(USER);
	await initMeta(db, USER, 'alice');
	return db;
}

const row = (o: Partial<CascadeRow>) => ({ id: C, name: 'Sevens', clear_threshold: 80, ...o }) as CascadeRow;

it('a rename reaches the base and the overlay, and keeps what the overlay changed', async () => {
	const db = await freshDb();
	await db.put('cascades', row({}));
	// A threshold changed here and not yet sent.
	await db.put('overlay_cascades', row({ clear_threshold: 90 }));
	await storeRenamed(db, C, 'Sevens to study');
	expect(await db.get('cascades', C)).toMatchObject({ name: 'Sevens to study', clear_threshold: 80 });
	expect(await db.get('overlay_cascades', C)).toMatchObject({ name: 'Sevens to study', clear_threshold: 90 });
	expect(await db.get('staging_cascades', C)).toBeUndefined();
	const tx = db.transaction(view.VIEW_STORES, 'readonly');
	expect(await view.cascade(tx, C)).toMatchObject({ name: 'Sevens to study', clear_threshold: 90 });
});

it('a cascade deleted here stays deleted', async () => {
	const db = await freshDb();
	await db.put('cascades', row({}));
	await db.put('overlay_cascades', row({ deleted: true }));
	await storeRenamed(db, C, 'Sevens to study');
	expect(await db.get('overlay_cascades', C)).toMatchObject({ name: 'Sevens', deleted: true });
	const tx = db.transaction(view.VIEW_STORES, 'readonly');
	expect(await view.cascade(tx, C)).toBeUndefined();
});
