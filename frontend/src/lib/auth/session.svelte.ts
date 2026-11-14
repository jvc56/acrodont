// The signed-in account for this tab (PLAN.md § Authentication while offline).
// The unscoped `signed_in` pointer is read before anything else at startup,
// and the user is treated as signed in until a sync is answered 401.
import { ApiError, bindUser, readCookie, CSRF_COOKIE, CSRF_HEADER } from '$lib/api';
import {
	forgetReplacedAccounts,
	getAccount,
	recordLogin,
	recordLogout,
	removeAccountData,
	retryQueuedLogout,
	signedIn,
	SIGNED_IN_CHANNEL,
	type LogoutOutcome
} from '$lib/local/accounts';
import { closeUserDb, onUpdatedElsewhere, userDb } from '$lib/local/open';
import { authApi } from './client';
import { getMeta } from '$lib/local/meta';
import type { Me } from './types';

class Session {
	ready = $state(false);
	userId = $state<string | null>(null);
	username = $state('');
	isAdmin = $state(false);
	/** Another tab signed in as someone else: this tab stops syncing and keeps its data. */
	signedOutInAnotherTab = $state(false);
	/** A newer build in another tab took the database: "reload to continue". */
	updatedInAnotherTab = $state(false);
	/** The server no longer accepts this tab's session: "Log in to sync". */
	needsLogin = $state(false);
	me = $state<Me | null>(null);
	/** Signing out on the way to the landing page (a deleted account), not to /login. */
	toLanding = $state(false);
}

export const session = new Session();

/** How long the queued logout's request may take before it is left for the next try. */
export const LOGOUT_TIMEOUT_MS = 15_000;

/**
 * The queued logout's request, with the CSRF token whenever the cookie is
 * there. A connection that accepts the request and never answers (a hotel's
 * sign-in page) is given up after `LOGOUT_TIMEOUT_MS` and counts as no
 * connection: the flag stays and the request is made again later.
 */
export async function sendQueuedLogout(): Promise<LogoutOutcome> {
	const giveUp = new AbortController();
	const timer = setTimeout(() => giveUp.abort(), LOGOUT_TIMEOUT_MS);
	const send = () => {
		const headers: Record<string, string> = {};
		const csrf = readCookie(CSRF_COOKIE);
		if (csrf) headers[CSRF_HEADER] = csrf;
		return fetch('/api/auth/logout', { method: 'POST', headers, credentials: 'same-origin', signal: giveUp.signal });
	};
	try {
		let r = await send();
		if (r.status === 403) {
			// A session cookie whose CSRF cookie is gone (a browser that cleared
			// part of its site data). /api/auth/me sets the token again for a
			// session that still holds, so the logout can clear the cookie
			// rather than leave it valid on a machine someone else may use.
			const me = await fetch('/api/auth/me', { credentials: 'same-origin', signal: giveUp.signal });
			if (me.ok && readCookie(CSRF_COOKIE)) r = await send();
		}
		return { status: r.status };
	} catch {
		return { networkError: true };
	} finally {
		clearTimeout(timer);
	}
}

function applyMe(me: Me) {
	session.me = me;
	session.isAdmin = me.is_admin;
	session.username = me.username;
	// The server's limits, and the account's storage, as /api/auth/me last reported them.
	void userDb(me.user_id, me.username)
		.then((db) =>
			db.put(
				'meta',
				{
					trash_retention_days: me.trash_retention_days,
					max_quiz_questions: me.max_quiz_questions,
					storage_bytes: me.storage_bytes,
					max_storage_bytes: me.max_storage_bytes
				},
				'server'
			)
		)
		.catch(() => undefined);
}

onUpdatedElsewhere(() => {
	session.updatedInAnotherTab = true;
});

let channel: BroadcastChannel | null = null;
let onlineHooked = false;
/** Bumped by every login: a session check begun before one must not judge the new session. */
let logins = 0;

export async function initSession() {
	const id = await signedIn();
	if (id) {
		const row = await getAccount(id);
		session.userId = id;
		session.username = row?.username ?? '';
		bindUser(id);
		// Data here from an earlier account with this username can never sync again (accounts.ts).
		void forgetReplacedAccounts(id, session.username);
	} else {
		await retryQueuedLogout(sendQueuedLogout);
	}
	session.ready = true;

	// A queued logout is retried at the next connection on which no account is signed in.
	if (!onlineHooked) {
		onlineHooked = true;
		addEventListener('online', () => {
			if (!session.userId) void retryQueuedLogout(sendQueuedLogout);
		});
	}

	if (typeof BroadcastChannel !== 'undefined' && !channel) {
		channel = new BroadcastChannel(SIGNED_IN_CHANNEL);
		channel.onmessage = (ev) => {
			const other = (ev.data as { signed_in: string | null }).signed_in;
			if (session.userId) session.signedOutInAnotherTab = other !== session.userId;
		};
	}

	if (id && navigator.onLine) {
		// A login while the check is out (the dev sign-in page logs in as the
		// layout starts) makes its answer, about the old cookie, stale.
		const at = logins;
		try {
			const me = await authApi.me();
			if (at !== logins) return;
			if (me.user_id !== id) session.needsLogin = true;
			else applyMe(me);
		} catch (e) {
			if (at === logins && e instanceof ApiError && e.status === 401) session.needsLogin = true;
		}
	}
}

export async function login(username: string, password: string): Promise<Me> {
	return adoptSession(await authApi.login(username, password));
}

/**
 * Makes `me`, whose session cookie the server has just set, this tab's
 * signed-in account: the bookkeeping a login does. Shared by the login form
 * and the local-only /dev-login page, so the two cannot drift.
 */
export async function adoptSession(me: Me): Promise<Me> {
	logins++;
	await recordLogin(me.user_id, me.username);
	session.userId = me.user_id;
	session.needsLogin = false;
	session.signedOutInAnotherTab = false;
	await userDb(me.user_id, me.username);
	applyMe(me);
	bindUser(me.user_id);
	// PLAN.md § On the device: ask the browser to keep this site's data.
	void navigator.storage?.persist?.().catch(() => false);
	return me;
}

/**
 * Always completes locally; the server request is queued and retried.
 * `removeData` is "Remove this account's data from this device": done here,
 * before the request is sent, because it needs no connection and the request
 * may be a long time settling on a network that accepts it and stalls. The
 * account's row keeps the queued logout (accounts.ts), so the request
 * outlives the removal.
 */
export async function logout(opts: { removeData?: boolean } = {}) {
	const id = session.userId;
	if (id) await recordLogout(id);
	closeUserDb();
	session.userId = null;
	session.me = null;
	session.isAdmin = false;
	session.username = '';
	bindUser(null);
	if (opts.removeData && id) await removeAccountData(id);
	await retryQueuedLogout(sendQueuedLogout);
}

/** After DELETE /api/account succeeded: the session is already void. */
export function forgetSession() {
	closeUserDb();
	session.userId = null;
	session.me = null;
	session.isAdmin = false;
	session.username = '';
	bindUser(null);
}
