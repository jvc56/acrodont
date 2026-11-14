// The running sync of a tab (runtime.svelte.ts): what it gives up when a newer
// build in another tab takes the database (PLAN.md § On the device → App
// shell), and what of one account it leaves in the tab for the next (§
// Authentication while offline).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '$lib/auth/session.svelte';
import { userDbName } from '$lib/local/accounts';
import { USER_DB_VERSION } from '$lib/local/db';
import { closeUserDb, countUnsent, userDb } from '$lib/local/open';
import { keepNoticesFor, refreshPending, startSync, stopSync, syncNow, syncState } from './runtime.svelte';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** Web Locks as far as the election uses them: one holder a name, the rest queued in order. */
class FakeLocks {
	private held = new Set<string>();
	private queue: { name: string; grant: () => void }[] = [];

	request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void> | void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const grant = () => {
				this.held.add(name);
				void Promise.resolve(callback()).then(() => {
					this.held.delete(name);
					resolve();
					const i = this.queue.findIndex((q) => q.name === name);
					if (i >= 0) this.queue.splice(i, 1)[0].grant();
				});
			};
			options.signal?.addEventListener('abort', () => {
				const i = this.queue.findIndex((q) => q.grant === grant);
				if (i < 0) return;
				this.queue.splice(i, 1);
				reject(new DOMException('The request was aborted.', 'AbortError'));
			});
			if (this.held.has(name)) this.queue.push({ name, grant });
			else grant();
		});
	}
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
let locks: FakeLocks;
let navigatorBefore: PropertyDescriptor | undefined;
/** The requests the tab made. */
let asked: string[];

/** Another tab of the account, waiting to lead; says whether it does yet. */
function anotherTabWaits(userId: string): () => boolean {
	let leads = false;
	void locks.request(`acrodont-sync-${userId}`, {}, () => {
		leads = true;
		return new Promise<void>(() => undefined);
	});
	return () => leads;
}

/** Whether the account's database is on the device (asking makes an empty one, so ask once it should be gone). */
async function userDbExists(userId: string): Promise<boolean> {
	let created = false;
	const db = await openDB(userDbName(userId), undefined, {
		upgrade() {
			created = true;
		}
	});
	db.close();
	return !created;
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	locks = new FakeLocks();
	navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', { value: { locks, onLine: true }, configurable: true });
	const listens = { addEventListener: () => undefined, removeEventListener: () => undefined };
	vi.stubGlobal('window', listens);
	vi.stubGlobal('document', { ...listens, visibilityState: 'visible', cookie: '' });
	// A connection that takes each request and never answers.
	asked = [];
	vi.stubGlobal('fetch', (url: string) => {
		asked.push(url);
		return new Promise<Response>(() => undefined);
	});
	session.userId = null;
	session.updatedInAnotherTab = false;
	keepNoticesFor(null);
});

afterEach(() => {
	stopSync();
	closeUserDb();
	if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
	vi.unstubAllGlobals();
});

describe('a newer build in another tab takes the database', () => {
	it('this tab stops syncing and gives the lock up, and what it had queued is the new build’s to send', async () => {
		session.userId = A;
		const db = await userDb(A, 'alice');
		await db.put('outbox', { device_seq: 1, op: { type: 'move_cursor' } } as never);
		startSync(A);
		await vi.waitFor(() => expect(asked).toEqual(['/api/sync']));
		expect(syncState.leader).toBe(true);
		expect(syncState.status).toBe('syncing');
		const newTabLeads = anotherTabWaits(A);
		await tick();
		expect(newTabLeads()).toBe(false);

		// The new build's tab opens the database at its version: this tab's
		// connection is closed under it by `versionchange`.
		const upgraded = await openDB(userDbName(A), USER_DB_VERSION + 1);
		await vi.waitFor(() => expect(newTabLeads()).toBe(true));
		expect(session.updatedInAnotherTab).toBe(true);
		expect(syncState.leader).toBe(false);
		// Not left reading "Syncing…" for the request that was out.
		expect(syncState.status).toBe('idle');
		// The queued operation is where the new build reads its outbox.
		expect(await upgraded.count('outbox')).toBe(1);

		// Nothing this tab is asked for afterwards sends anything or opens the
		// database again at the old version.
		await syncNow();
		await refreshPending();
		await tick();
		expect(asked).toEqual(['/api/sync']);
		upgraded.close();
	});

	it('a tab that finds the database already upgraded says so and does not keep the lock', async () => {
		// Upgraded while this tab held no connection for `versionchange` to close.
		(await openDB(userDbName(A), USER_DB_VERSION + 1)).close();
		session.userId = A;
		startSync(A);
		const newTabLeads = anotherTabWaits(A);
		await vi.waitFor(() => expect(newTabLeads()).toBe(true));
		expect(session.updatedInAnotherTab).toBe(true);
		expect(syncState.leader).toBe(false);
		expect(asked).toEqual([]);
	});
});

describe('one account after another in a tab', () => {
	const notice = { cascade_id: 'c', text: 'Level 2 was finished on another device. 3 answers from this device weren’t kept.' };

	it('an account’s notices leave the screen when it logs out, and are not shown to the next account', async () => {
		session.userId = A;
		const stop = startSync(A);
		syncState.notices = [notice];
		// The tab only stops syncing (signed out in another tab) and starts again: still this account's.
		stop();
		expect(syncState.notices).toEqual([notice]);
		startSync(A);
		expect(syncState.notices).toEqual([notice]);

		// Logged out: the log-in page shows none of them.
		session.userId = null;
		stopSync();
		keepNoticesFor(session.userId);
		expect(syncState.notices).toEqual([]);

		// And an account that takes the tab straight from another is shown none either.
		session.userId = A;
		startSync(A);
		syncState.notices = [notice];
		session.userId = B;
		startSync(B);
		expect(syncState.notices).toEqual([]);
	});

	it('a sync or a count asked for after the logout does not make the account’s removed database again', async () => {
		session.userId = A;
		await userDb(A, 'alice');
		const stop = startSync(A);
		await vi.waitFor(() => expect(asked).toEqual(['/api/sync']));
		expect(syncState.status).toBe('syncing');

		// Log out with "Remove this account's data from this device".
		session.userId = null;
		stop();
		closeUserDb();
		await tick();
		await new Promise<void>((done, failed) => {
			const r = indexedDB.deleteDatabase(userDbName(A));
			r.onsuccess = () => done();
			r.onerror = () => failed(r.error);
		});
		expect(syncState.status).toBe('idle');

		// The Log out button's sync, still waiting on a stalled connection, ends now.
		await syncNow();
		await refreshPending();
		expect(await userDbExists(A)).toBe(false);
	});
});

/** Deletes the account's database as a logout that removes its data does; says whether an open connection held it up. */
function removeUserDb(userId: string): Promise<{ blocked: boolean }> {
	return new Promise((done, failed) => {
		let blocked = false;
		const r = indexedDB.deleteDatabase(userDbName(userId));
		r.onblocked = () => (blocked = true);
		r.onsuccess = () => done({ blocked });
		r.onerror = () => failed(r.error);
	});
}

describe('the unsent changes counted before an account’s data is removed', () => {
	it('are counted in a tab that has stopped syncing, from the account’s own database', async () => {
		session.userId = A;
		const db = await userDb(A, 'alice');
		const stop = startSync(A);
		await vi.waitFor(() => expect(syncState.pending).toBe(0));
		// Signed out in another tab: this tab stops syncing, keeps its data, and is studied in.
		stop();
		await db.put('outbox', { device_seq: 1, op: { type: 'move_cursor' } } as never);
		await db.put('outbox', { device_seq: 2, op: { type: 'move_cursor' } } as never);

		expect(await countUnsent(A)).toBe(2);

		// The count's connection is closed: the removal that follows waits for nothing.
		closeUserDb();
		await tick();
		expect(await removeUserDb(A)).toEqual({ blocked: false });
	});

	it('are none for a database that is not on the device, which the count does not make', async () => {
		expect(await countUnsent(B)).toBe(0);
		expect(await userDbExists(B)).toBe(false);
	});

	it('are not known, rather than none, when the database cannot be read or does not open in time', async () => {
		// A database with no outbox to count.
		(
			await openDB(userDbName(A), 1, {
				upgrade(db) {
					db.createObjectStore('meta');
				}
			})
		).close();
		expect(await countUnsent(A)).toBeNull();

		// An open that is never answered.
		const real = indexedDB.open.bind(indexedDB);
		indexedDB.open = (() => ({})) as unknown as typeof indexedDB.open;
		try {
			expect(await countUnsent(B, 20)).toBeNull();
		} finally {
			indexedDB.open = real;
		}
	});
});

describe('another tab removes the account’s data at its logout', () => {
	it('this tab is not told it was updated, and syncs again when the account logs back in', async () => {
		session.userId = A;
		await userDb(A, 'alice');
		const stop = startSync(A);
		await vi.waitFor(() => expect(asked).toEqual(['/api/sync']));
		// The other tab logs out: this one reads "Signed out in another tab" and stops.
		stop();
		// And removes the data: the deletion closes this tab's connection, and is not held up by it.
		expect(await removeUserDb(A)).toEqual({ blocked: false });
		expect(session.updatedInAnotherTab).toBe(false);

		// Logged in again there: this tab resumes, on a database made anew.
		startSync(A);
		await vi.waitFor(() => expect(asked).toEqual(['/api/sync', '/api/sync']));
		expect(syncState.leader).toBe(true);
	});
});
