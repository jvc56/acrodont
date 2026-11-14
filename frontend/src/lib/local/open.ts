// The signed-in account's database connection, one per tab (PLAN.md § On the
// device → IndexedDB stores: no per-user database but the signed-in one is
// ever opened). A `versionchange` from a newer build in another tab closes it
// and raises the "updated in another tab" notice; so does finding the database
// already upgraded. A `versionchange` from a deletion (another tab removed the
// account's data at its logout) closes it and raises nothing: no build changed,
// and the tab syncs again when its account is signed in again.
import { openDB } from 'idb';
import { userDbName } from './accounts';
import { openUserDb, type UserDb, type UserSchema } from './db';
import { initMeta } from './meta';

let current: { userId: string; db: Promise<UserDb> } | null = null;
const listeners = new Set<() => void>();

/** Called when another tab's newer build needs the database. */
export function onUpdatedElsewhere(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The signed-in account's database, opened once and kept for the tab's life. */
export function userDb(userId: string, username = ''): Promise<UserDb> {
	if (current?.userId === userId) return current.db;
	closeUserDb();
	const db = openUserDb(userId, (deleted) => {
		if (current?.userId === userId) current = null;
		if (!deleted) for (const fn of listeners) fn();
	}).then(async (db) => {
		await initMeta(db, userId, username);
		return db;
	});
	current = { userId, db };
	db.catch((e) => {
		if (current?.db === db) current = null;
		// The database is already at a version this build does not know: a newer
		// build upgraded it while this tab held no connection to be closed.
		if ((e as { name?: string } | null)?.name === 'VersionError') for (const fn of listeners) fn();
	});
	return db;
}

/** Closes the connection, before a logout or removing the account's data. */
export function closeUserDb() {
	const c = current;
	current = null;
	c?.db.then((db) => db.close()).catch(() => undefined);
}

/** How long `countUnsent` waits for the database before it answers "not known". */
export const COUNT_UNSENT_WAIT_MS = 3000;

/**
 * How many operations the account's database holds unsent, read from the
 * database itself before it is removed: whether this tab is syncing, and for
 * whom, has no say in it. `null` when the count could not be made (the
 * database would not open, or not in time, or has no outbox to read), which
 * the caller takes as "there may be unsent changes". A database that is not
 * on the device holds nothing, and is not made by the asking; the connection
 * is this call's own, at whatever version the database is, and is closed
 * before the answer, so it is not in the way of the removal that follows.
 */
export async function countUnsent(userId: string, waitMs = COUNT_UNSENT_WAIT_MS): Promise<number | null> {
	let missing = false;
	const counted = (async () => {
		const db = await openDB<UserSchema>(userDbName(userId), undefined, {
			// Only a database that does not exist is "upgraded" by an open that names no version.
			upgrade(_db, _from, _to, tx) {
				missing = true;
				tx.done.catch(() => undefined);
				tx.abort();
			}
		});
		// Also when the wait below has already given up on it.
		db.addEventListener('versionchange', () => db.close());
		try {
			return await db.count('outbox');
		} finally {
			db.close();
		}
	})().catch(() => (missing ? 0 : null));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)));
	try {
		return await Promise.race([counted, gaveUp]);
	} finally {
		clearTimeout(timer);
	}
}
