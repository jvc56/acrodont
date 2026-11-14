// PLAN.md § Authentication while offline → Logging out: "Remove this account's
// data from this device" is done before the queued logout's request is sent,
// and that request is given up after a while rather than waited on for ever.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccount, recordLogin, signedIn, userDbName } from '$lib/local/accounts';
import { userDb } from '$lib/local/open';
import { initSession, logout, LOGOUT_TIMEOUT_MS, sendQueuedLogout, session } from './session.svelte';

const A = '11111111-1111-4111-8111-111111111111';

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
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('logging out', () => {
	it('removes the account’s data before the logout request is answered, and the request still clears the row', async () => {
		// A connection that takes the request and does not answer.
		let answer!: (r: Response) => void;
		const asked: string[] = [];
		vi.stubGlobal('fetch', (url: string) => {
			asked.push(url);
			return new Promise<Response>((r) => (answer = r));
		});
		await recordLogin(A, 'alice');
		const db = await userDb(A, 'alice');
		expect(await db.count('outbox')).toBe(0);
		session.userId = A;

		let finished = false;
		const done = logout({ removeData: true }).then(() => (finished = true));
		await vi.waitFor(() => expect(asked).toEqual(['/api/auth/logout']));
		// The request is out and unanswered; everything local is already done.
		expect(finished).toBe(false);
		expect(session.userId).toBeNull();
		expect(await signedIn()).toBeNull();
		expect(await userDbExists(A)).toBe(false);
		// The row is kept, emptied, for the logout still queued.
		expect(await getAccount(A)).toMatchObject({ logout_pending: true, emptied: true, rows: 0 });

		answer(new Response(null, { status: 204 }));
		await done;
		expect(await getAccount(A)).toBeUndefined();
	});

	it('a session check answered after the logout does not bring the account back', async () => {
		let answerMe!: (r: Response) => void;
		const asked: string[] = [];
		vi.stubGlobal('fetch', (url: string) => {
			asked.push(url);
			if (url === '/api/auth/me') return new Promise<Response>((r) => (answerMe = r));
			return Promise.resolve(new Response(null, { status: 204 }));
		});
		vi.stubGlobal('navigator', { onLine: true });
		vi.stubGlobal('addEventListener', () => undefined);
		await recordLogin(A, 'alice');
		vi.stubGlobal('BroadcastChannel', undefined);

		// The tab starts signed in and asks the server who it is.
		const started = initSession();
		await vi.waitFor(() => expect(asked).toEqual(['/api/auth/me']));
		expect(session.userId).toBe(A);
		// Log out, removing the account's data, before that is answered.
		await logout({ removeData: true });

		const me = { user_id: A, username: 'alice', is_admin: true, trash_retention_days: 30, max_quiz_questions: 100, storage_bytes: 1, max_storage_bytes: 2 };
		answerMe(new Response(JSON.stringify(me), { status: 200, headers: { 'Content-Type': 'application/json' } }));
		await started;
		await new Promise<void>((r) => setTimeout(r, 0));
		// Nothing of the account is put back: not who the tab is, not its database.
		expect(session.me).toBeNull();
		expect(session.isAdmin).toBe(false);
		expect(session.username).toBe('');
		expect(await userDbExists(A)).toBe(false);
	});

	it('gives the logout request up after a while, as no connection', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			(_url: string, init: { signal: AbortSignal }) =>
				new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
		);
		const outcome = sendQueuedLogout();
		await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS);
		expect(await outcome).toEqual({ networkError: true });
	});
});
