// The running sync engine for the signed-in account (PLAN.md § Frontend →
// lib/sync). One tab per account leads, elected with Web Locks; the others
// read the shared stores, show the leader's status, and ask it to sync after
// their own writes. A 401 shows "Log in to sync" and studying continues.
import { session } from '$lib/auth/session.svelte';
import { controls } from '$lib/player/controls.svelte';
import { display } from '$lib/player/display.svelte';
import { recordTotals } from '$lib/local/accounts';
import { hasPending } from '$lib/local/apply';
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
	// Operations held back for a level whose rows have just come (rebase.ts,
	// `replay`) are applied before the player reads the level, so it is not
	// shown, and answered, without them.
	if ((await getMeta(db, 'held'))[cascadeId]) await syncAndWait();
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
	/** A tab that does not lead asks for a sync and waits for `synced` with the same id (`syncAndWait`). */
	| { kind: 'sync'; id: string }
	| { kind: 'synced'; id: string; ok: boolean }
	| { kind: 'notices'; notices: Notice[] }
	| { kind: 'changed'; ids: string[] }
	/** The leader took shared device settings: an open player in any tab shows them. */
	| { kind: 'settings' }
	| { kind: 'progress'; noRoom?: boolean };

function post(m: Message) {
	channel?.postMessage(m);
}

/**
 * Whether a tab may sync for the account it shows, and so hold the account's
 * sync lock: not once the account was signed out in another tab, not once a
 * newer build took its database, and not once another tab activated a newer
 * build at all (`updatedElsewhere`: the service worker changed under this
 * tab). A tab on the old build that kept the lock would keep the tab on the
 * new build from leading: after an update the server asked for, the old tab's
 * syncs are answered `426`, and the updated tab would go on reading "reload
 * to keep syncing" until the old tab was reloaded or closed. What the old tab
 * writes afterwards is in the database both read, and goes out with the new
 * build's next sync.
 */
export function tabMaySync(tab: { signedOutInAnotherTab: boolean; updatedInAnotherTab: boolean }, updatedElsewhere: boolean): boolean {
	return !tab.signedOutInAnotherTab && !tab.updatedInAnotherTab && !updatedElsewhere;
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
			else if (m.kind === 'sync') {
				// Only the tab that leads answers; the asker gives up by itself if none does.
				const id = m.id;
				if (engine) void syncedBy(engine).then((ok) => post({ kind: 'synced', id, ok }));
			} else if (m.kind === 'synced') asked.get(m.id)?.(m.ok);
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
				onProgress: () => {
					syncState.progress += 1;
					// Rows have landed: operations held back for them are applied now.
					void e.releaseHeld().catch(() => undefined);
				},
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

/** How long a page waits for a sync it asked for before it goes on without it. */
export const SYNC_WAIT_MS = 5_000;

/** The syncs this tab asked the leader for and still waits on, by id. */
const asked = new Map<string, (ok: boolean) => void>();

/** One sync of this engine: whether it ended with the server's answer applied and nothing refused. */
const syncedBy = (e: SyncEngine): Promise<boolean> =>
	e.sync().then(
		() => e.status === 'idle',
		() => false
	);

/**
 * A sync now, and the wait for it: this tab's own where it leads, the leader's
 * elsewhere, asked for on the channel and answered when it ends. True when a
 * sync that took this call into account ended with the server's answer
 * applied; false when it did not (no connection, logged out, a newer app
 * needed), when no tab leads, or when `waitMs` passed first: the caller goes
 * on either way, and reads the outbox for what is still unsent.
 */
export async function syncAndWait(waitMs = SYNC_WAIT_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs)));
	const id = crypto.randomUUID();
	let done: Promise<boolean>;
	if (engine) done = syncedBy(engine);
	else if (channel) {
		done = new Promise<boolean>((r) => asked.set(id, r));
		post({ kind: 'sync', id });
	} else done = Promise.resolve(false);
	try {
		return await Promise.race([done, gaveUp]);
	} finally {
		clearTimeout(timer);
		asked.delete(id);
		await refreshPending().catch(() => undefined);
	}
}

/**
 * Before the server is asked for something it makes from a cascade's rows (an
 * export, a duplicate): if this device holds changes to the cascade it has not
 * sent, a sync, waited for. Whether everything of the cascade is sent now.
 */
export async function sendPending(db: UserDb, cascadeId: string, waitMs = SYNC_WAIT_MS): Promise<boolean> {
	if (!(await hasPending(db, cascadeId))) return true;
	await syncAndWait(waitMs);
	return !(await hasPending(db, cascadeId));
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
