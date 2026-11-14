// The running sync engine for the signed-in account (PLAN.md § Frontend →
// lib/sync). One tab per account leads, elected with Web Locks; the others
// read the shared stores, show the leader's status, and ask it to sync after
// their own writes. A 401 shows "Log in to sync" and studying continues.
import { session } from '$lib/auth/session.svelte';
import { controls } from '$lib/player/controls.svelte';
import { display } from '$lib/player/display.svelte';
import { recordTotals } from '$lib/local/accounts';
import type { UserDb } from '$lib/local/db';
import { getMeta } from '$lib/local/meta';
import { onUpdatedElsewhere, userDb } from '$lib/local/open';
import { DownloadManager, httpApiFor, openPlayers } from './downloads';
import { electLeader, listenForChanges, startTriggers, SyncEngine, transportFor, type EngineHooks, type SyncStatus } from './engine';
import type { Notice } from './notices';

class SyncState {
	status = $state<SyncStatus>('idle');
	notices = $state<Notice[]>([]);
	leader = $state(false);
	/** Bumped whenever the download manager makes progress; pages re-read their badges. */
	progress = $state(0);
	/** The cascade this tab's player has open (the drop pass skips it). */
	openCascade = $state<string | null>(null);
	/** The last download pass found no room on this device, even after dropping what it may. */
	noRoom = $state(false);
	/** Operations waiting in the outbox; null until counted, so "Synced" is never shown unread. */
	pending = $state<number | null>(null);
	/** Cascades a rebase changed: a player showing one refreshes (step 5). */
	changed = $state<{ ids: string[]; tick: number }>({ ids: [], tick: 0 });
}

export const syncState = new SyncState();

let engine: SyncEngine | null = null;
let downloads: DownloadManager | null = null;

/** The running download manager, in the leader tab. */
export function downloadManager(): DownloadManager | null {
	return downloads;
}

/** The card page the player needs now, in whichever tab it is. */
export async function fetchCard(db: UserDb, cascadeId: string, idx: number, ahead: number[] = []) {
	if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('offline');
	await (downloads ?? new DownloadManager(db)).fetchForPlayer(cascadeId, idx, ahead);
}

/** The cascade's tile distribution for typed mode, in whichever tab the player is (online only). */
export async function fetchDistribution(db: UserDb, cascadeId: string) {
	if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('offline');
	await (downloads ?? new DownloadManager(db)).distributionForPlayer(cascadeId);
}

/** A player action; this tab's background downloads let it go first (DownloadManager.whilePlayerActs). */
export function playerActs<T>(fn: () => Promise<T>): Promise<T> {
	return downloads ? downloads.whilePlayerActs(fn) : fn();
}

/** The player's read-ahead of the next cards in its order, in whichever tab it is. */
export async function fetchAhead(db: UserDb, cascadeId: string, idx: number[]) {
	if (typeof navigator !== 'undefined' && !navigator.onLine) return;
	await (downloads ?? new DownloadManager(db)).fetchAhead(cascadeId, idx);
}

/**
 * A first open, in whichever tab the player is: the level's rows, which the
 * player waits for (with `progress`), then the cascade's keys and cards in the
 * background, which an open cascade is wanted for (PLAN.md § Downloads).
 */
export async function ensureCascade(db: UserDb, cascadeId: string, progress?: (fraction: number) => void) {
	const dm =
		downloads ??
		new DownloadManager(db, {
			sync: async () => {
				afterLocalWrite();
			}
		});
	await dm.ensureLevel(cascadeId, progress);
	downloadInBackground();
}

/**
 * A download pass now rather than after the next sync: in the leader tab its
 * own manager's (once more if one already running began before this cascade
 * was wanted), elsewhere the leader's, after a sync.
 */
function downloadInBackground() {
	const dm = downloads;
	if (!dm) {
		post({ kind: 'kick' });
		return;
	}
	const again = dm.busy;
	void dm
		.run()
		.then(() => (again ? dm.run() : undefined))
		.catch(() => undefined)
		.then(() => passDone(dm));
}

/** A download pass ended, well or not: badges changed, here and in every other tab, and whether there was room. */
function passDone(dm: DownloadManager) {
	syncState.progress += 1;
	syncState.noRoom = dm.noRoom;
	post({ kind: 'progress', noRoom: dm.noRoom });
}
let channel: BroadcastChannel | null = null;
let stop: (() => void) | null = null;
/** The account whose notices `syncState.notices` holds. */
let noticesOf: string | null = null;

// A newer build in another tab took the database (its `versionchange` closed
// this tab's connection): this tab can no longer sync, so it stops and gives
// the account's sync lock up, or the tab on the new build could never lead and
// nothing would be sent while this one stayed open. What this tab had queued
// is in the database, which the new build now holds and sends from.
onUpdatedElsewhere(() => stopSync());

function reloadDeviceSettings() {
	void display.reload();
	void controls.reload();
}

type Message =
	| { kind: 'status'; status: SyncStatus }
	| { kind: 'kick' }
	| { kind: 'notices'; notices: Notice[] }
	| { kind: 'changed'; ids: string[] }
	/** The leader took shared device settings: an open player in any tab shows them. */
	| { kind: 'settings' }
	| { kind: 'progress'; noRoom?: boolean };

function post(m: Message) {
	channel?.postMessage(m);
}

/** Starts syncing for this account; returns the function that stops it. */
export function startSync(userId: string): () => void {
	stopSync();
	currentUser = userId;
	keepNoticesFor(userId);
	syncState.pending = null;
	syncState.noRoom = false;
	// A database that cannot be opened is counted when it can be.
	void refreshPending().catch(() => undefined);
	if (typeof BroadcastChannel !== 'undefined') {
		channel = new BroadcastChannel(`acrodont-sync-${userId}`);
		channel.onmessage = (ev) => {
			const m = ev.data as Message;
			if (m.kind === 'kick') engine?.schedule();
			else if (m.kind === 'status' && !syncState.leader) {
				// The leader's sync may have sent this tab's operations too.
				syncState.status = m.status;
				void refreshPending();
			}
			else if (m.kind === 'notices' && !syncState.leader) syncState.notices = [...syncState.notices, ...m.notices];
			else if (m.kind === 'changed') syncState.changed = { ids: m.ids, tick: syncState.changed.tick + 1 };
			else if (m.kind === 'settings') reloadDeviceSettings();
			else if (m.kind === 'progress') {
				syncState.progress += 1;
				if (!syncState.leader && m.noRoom !== undefined) syncState.noRoom = m.noRoom;
			}
		};
	}
	const release = electLeader(userId, () => {
		let stopTriggers: (() => void) | null = null;
		let stopListening: (() => void) | null = null;
		let cancelled = false;
		syncState.leader = true;
		// A database that cannot be opened leaves nothing to lead with; one a
		// newer build has already upgraded stops this sync (open.ts).
		void userDb(userId).then((db) => {
			// Only for the account this tab still runs as.
			if (cancelled || session.userId !== userId) return;
			const hooks: EngineHooks = {
				// The download manager's turn after every pull; never awaited by the
				// cycle, since its grades fetch syncs first.
				onSynced: (o) => {
					if (o.changed.size) {
						const ids = [...o.changed];
						syncState.changed = { ids, tick: syncState.changed.tick + 1 };
						post({ kind: 'changed', ids });
					}
					const dm = downloads;
					if (dm)
						void dm
							.run()
							.catch(() => undefined)
							.then(() => passDone(dm));
				},
				// A shared display setting or the controls changed: an open player
				// shows them, in this tab and in every other.
				onDeviceSettings: () => {
					reloadDeviceSettings();
					post({ kind: 'settings' });
				},
				// A pull with no room: what the download manager may drop, dropped.
				makeRoom: async () => {
					await downloads?.makeRoom();
				},
				onNoRoom: () => {
					if (downloads) downloads.noRoom = true;
					syncState.noRoom = true;
					post({ kind: 'progress', noRoom: true });
				},
				onStatus: (s) => {
					syncState.status = s;
					void refreshPending();
					post({ kind: 'status', status: s });
					if (s === 'needs_login') session.needsLogin = true;
				},
				onNotices: (n) => {
					syncState.notices = [...syncState.notices, ...n];
					post({ kind: 'notices', notices: n });
				}
			};
			// Every request names the account this engine was started for, not
			// whichever the tab runs as at the moment the request leaves.
			const e = new SyncEngine(db, hooks, { transport: transportFor(userId) });
			engine = e;
			downloads = new DownloadManager(db, {
				api: httpApiFor(userId),
				sync: () => e.sync(),
				openElsewhere: openPlayers,
				openHere: () => syncState.openCascade,
				onProgress: () => (syncState.progress += 1),
				onTotals: (t) => {
					void recordTotals(userId, { rows: t.rows, keys: t.keys, answer_bytes: t.answer_bytes });
				}
			});
			stopTriggers = startTriggers(e);
			void getMeta(db, 'device').then(({ device_id }) => {
				if (!cancelled) stopListening = listenForChanges(e, userId, device_id);
			});
		}, () => undefined);
		return () => {
			cancelled = true;
			stopListening?.();
			stopTriggers?.();
			engine = null;
			downloads = null;
			syncState.leader = false;
		};
	});
	const mine = () => {
		release();
		channel?.close();
		channel = null;
	};
	stop = mine;
	return () => {
		// Only the sync this call started: a later one is not this caller's to stop.
		if (stop === mine) stopSync();
	};
}

/**
 * Stops syncing in this tab: the lock is given up, and nothing here names the
 * account any more, so a count or a sync asked for later (a Log out that
 * outlived its wait) does not open the account's database again.
 */
export function stopSync() {
	stop?.();
	stop = null;
	currentUser = null;
	// The stopped engine says nothing more: its last word, "Syncing…" if a
	// request was out, is not left standing.
	syncState.status = 'idle';
}

/** After a local write: half a second later, by this tab or by the leader. */
export function afterLocalWrite() {
	if (engine) engine.schedule();
	else post({ kind: 'kick' });
	void refreshPending();
}

let currentUser: string | null = null;

/** A sync now, in the leader tab; elsewhere, a request to the leader. */
export async function syncNow() {
	if (engine) await engine.sync();
	else post({ kind: 'kick' });
	await refreshPending();
}

/** Operations waiting in the outbox: whether any are (the sync status), and how many (the logout warning). */
export async function refreshPending() {
	const user = currentUser;
	if (!user) return;
	const db = await userDb(user);
	const pending = await db.count('outbox');
	// Counted for the account this tab was syncing when it asked.
	if (currentUser === user) syncState.pending = pending;
}

/**
 * The account this tab runs as, or none: a notice is the account's it was
 * raised for, so those of another are taken off the screen, rather than stay
 * on the log-in page and into the session of whoever uses the tab next. A tab
 * that only stopped syncing for its account keeps that account's notices.
 */
export function keepNoticesFor(userId: string | null) {
	if (noticesOf !== userId) syncState.notices = [];
	noticesOf = userId;
}

export function dismissNotice(n: Notice) {
	syncState.notices = syncState.notices.filter((x) => x !== n);
}
