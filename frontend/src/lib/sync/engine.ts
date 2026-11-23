// The sync engine (PLAN.md § The sync cycle, § When the device syncs,
// § Frontend → lib/sync). One tab per account runs it, elected with the Web
// Locks API; where Web Locks is missing every tab syncs and idempotency keeps
// that correct. It pushes the outbox in batches of up to BATCH_OPS, pulls
// every page, rebases, and backs off on 429 and 503 by Retry-After.
import { offsetOf } from '$lib/settings/clock';
import { pendingShares, takeShared } from '$lib/settings/everywhere';
import type { Entries } from '$lib/settings/layers';
import { presetsAsSent, takePresets } from '$lib/settings/presets';
import { ApiError, request } from '$lib/api';
import type { UserDb } from '$lib/local/db';
import { getMeta } from '$lib/local/meta';
import type { OutboxEntry } from '$lib/local/rows';
import { SYNC_INTERVAL_MS } from './config';
import type { Notice } from './notices';
import { questionRowsFor } from './policy';
import { BATCH_OPS, type Reply, type SyncRequest, type SyncResponse, type Transport } from './protocol';
import { clearStaging, newPull, writePage, type PullState } from './pull';
import { heldReady, newOutcome, rebase, replayHeld, type Acked, type RebaseCtx, type RebaseOutcome } from './rebase';

export type SyncStatus =
	| 'idle'
	| 'syncing'
	| 'offline'
	/** A 401: studying continues; "Log in to sync". */
	| 'needs_login'
	/** A 426: "reload to keep syncing". */
	| 'reload'
	/** The server refused the request itself (its own 4xx other than 401, 426 and 429): "Can't sync: reload". */
	| 'refused';

/**
 * A request the server refused is not sent again sooner than this, whatever
 * asks for a sync: the same batch would be refused the same way, and every
 * answer, every 30 seconds and every change on another device would ask.
 */
export const REFUSED_RETRY_MS = 300_000;

/**
 * The server's own word that the request itself is wrong: a 4xx that is not
 * the session (401), the build (426) or the rate (429), carrying the body the
 * API writes on every error it answers, `{ "error": "<code>", … }`
 * (backend/src/error.rs). A 4xx without that body is not the server's: a
 * proxy's 408 for an upload that stalled, a hotel sign-in page's 403 or 407.
 * The same request may well be taken once the connection is back, so that is
 * no connection, not a refusal.
 */
const isRefusal = (reply: Reply) => {
	const { status, body } = reply;
	if (status < 400 || status >= 500 || status === 401 || status === 426 || status === 429) return false;
	return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string';
};

export interface EngineHooks {
	onStatus?: (s: SyncStatus) => void;
	onNotices?: (n: Notice[]) => void;
	/** After every completed pull: the download manager's turn (§ Downloads). */
	onSynced?: (o: RebaseOutcome) => void | Promise<void>;
	/** The account's settings for all cascades on all devices, or its presets, changed here. */
	onDeviceSettings?: () => void;
	/**
	 * A pull's write found no room on the device: the drop pass, then the answer
	 * eviction (§ On the device, "A quota error is handled"). The pull is then
	 * made once more.
	 */
	makeRoom?: () => void | Promise<void>;
	/** That second try found no room either: "not enough room on this device". */
	onNoRoom?: () => void;
}

/** IndexedDB's refusal for want of room, as a failed write or an aborted transaction reports it. */
const isQuota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError';

/**
 * POST /api/sync over fetch, with the session cookie, the CSRF token and the
 * user binding. `userId` is the account whose database the engine holds: the
 * request names it whatever account the tab has since come to run as, so a
 * batch read before another account logged in here is refused `401` by the
 * server, never recorded under that other account (PLAN.md § Authentication
 * while offline). Without it the request names the tab's account.
 */
export const transportFor =
	(userId?: string): Transport =>
	async (req: SyncRequest): Promise<Reply> => {
		try {
			const body = await request<unknown>('POST', '/api/sync', { body: req, user: userId });
			return { status: 200, body, retryAfter: null };
		} catch (e) {
			if (e instanceof ApiError) return { status: e.status, body: e.body, retryAfter: e.retryAfterSeconds };
			throw e;
		}
	};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EngineOptions {
	transport?: Transport;
	now?: () => Date;
	appVersion?: number;
	/** Waits out a Retry-After; tests replace it. */
	wait?: (seconds: number) => Promise<void>;
}

export class SyncEngine {
	status: SyncStatus = 'idle';
	private running: Promise<void> | null = null;
	private again = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastRun = 0;
	private stopped = false;
	/** When the server last refused a request (`Date.now()`), until a request is answered otherwise. */
	private refusedAt: number | null = null;
	private readonly transport: Transport;
	private readonly now: () => Date;
	private readonly appVersion: number;
	private readonly wait: (s: number) => Promise<void>;

	constructor(
		private readonly db: UserDb,
		private readonly hooks: EngineHooks = {},
		opts: EngineOptions = {}
	) {
		this.transport = opts.transport ?? transportFor();
		this.now = opts.now ?? (() => new Date());
		this.appVersion = opts.appVersion ?? (typeof __APP_BUILD__ === 'number' ? __APP_BUILD__ : 0);
		this.wait = opts.wait ?? ((s) => sleep(s * 1000));
	}

	/**
	 * A stopped engine says nothing more: the tab may already run as another
	 * account, and a `401` answered to this one's last request is not that
	 * account's to be told about.
	 */
	private setStatus(s: SyncStatus) {
		if (this.stopped) return;
		this.status = s;
		this.hooks.onStatus?.(s);
	}

	/**
	 * Half a second after a new operation, and no more than once a second while
	 * operations keep arriving.
	 */
	schedule(delayMs = 500) {
		if (this.stopped || this.timer) return;
		const since = Date.now() - this.lastRun;
		this.timer = setTimeout(
			() => {
				this.timer = null;
				void this.sync();
			},
			Math.max(delayMs, 1000 - since)
		);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
	}

	/** One sync cycle, draining the outbox back to back; concurrent calls share it. */
	sync(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.cycle();
				} while (this.again && !this.stopped && this.status === 'idle');
			} catch (e) {
				// A cycle that threw did not sync: never left reading "Syncing…".
				if (this.status === 'syncing') this.setStatus('offline');
				throw e;
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	/**
	 * Called when question rows have landed (the download manager's, in this tab
	 * or another): if operations were held back for a quiz whose rows are now
	 * here, a sync, whose first step applies them (`release`).
	 */
	async releaseHeld(): Promise<void> {
		if (this.stopped || !(await heldReady(this.db))) return;
		await this.sync();
	}

	/**
	 * The operations an earlier replay held back (rebase.ts, `replay`), applied
	 * to the overlay once the rows they waited for are here, before anything is
	 * sent. No room for it is not an error of the sync: they stay held, are sent
	 * as they are, and the server judges them.
	 */
	private async release(rctx: RebaseCtx) {
		const held = Object.keys(await getMeta(this.db, 'held'));
		if (!held.length) return;
		const o = newOutcome();
		try {
			for (const id of held.sort()) await replayHeld(this.db, id, rctx, o);
		} catch (e) {
			if (!isQuota(e)) {
				this.emit(o);
				throw e;
			}
		}
		this.emit(o);
		if (o.changed.size && !this.stopped) await this.hooks.onSynced?.(o);
	}

	private async send(req: SyncRequest): Promise<Reply | null> {
		for (;;) {
			// Stopped since the request was put together (the reads before it take
			// time): the account was signed out of this tab, and nothing is sent.
			if (this.stopped) return null;
			let reply: Reply;
			try {
				reply = await this.transport(req);
			} catch {
				this.setStatus('offline');
				return null;
			}
			// Stopped while it was out: the answer is not used. What the server
			// applied stays in the outbox and is acknowledged from its records at
			// this account's next sync.
			if (this.stopped) return null;
			// 429 and 503: the same request again after Retry-After, nothing dropped.
			if (reply.status === 429 || reply.status === 503) {
				await this.wait(reply.retryAfter ?? 5);
				if (this.stopped) return null;
				continue;
			}
			return reply;
		}
	}

	private async cycle() {
		this.lastRun = Date.now();
		const sync = await getMeta(this.db, 'sync');
		// Refused a short while ago: nothing is sent, and the status stays.
		const refused = this.refusedAt !== null && Date.now() - this.refusedAt < REFUSED_RETRY_MS;
		if (refused) this.setStatus('refused');
		else if (sync.upgrade_required) this.setStatus('reload');
		else this.setStatus('syncing');
		const { device_id } = await getMeta(this.db, 'device');
		const server = await getMeta(this.db, 'server');
		const rctx: RebaseCtx = { device_id, max_quiz_questions: server.max_quiz_questions, now: this.now };
		await this.release(rctx);
		if (refused) return;
		let cursor = sync.cursor;
		// Changes for all cascades on all devices made here and not yet sent go with the first request.
		let shares: Entries | null = await pendingShares(this.db);
		let madeRoom = false;
		for (;;) {
			const batch: OutboxEntry[] = await this.db.getAll('outbox', undefined, BATCH_OPS);
			const qrf = await questionRowsFor(this.db, this.now());
			const req: SyncRequest = {
				device_id,
				app_version: this.appVersion,
				cursor,
				question_rows_for: qrf,
				ops: batch.map((e) => e.op)
			};
			const sent = shares ?? {};
			if (Object.keys(sent).length) req.settings = sent;
			shares = null;
			const presetsSent = await presetsAsSent(this.db);
			req.presets_version = presetsSent.version;
			const reply = await this.send(req);
			const receivedAt = Date.now();
			if (!reply) return;
			if (reply.status === 401) {
				// Studying continues; the outbox waits for the next login.
				this.setStatus('needs_login');
				return;
			}
			if (isRefusal(reply)) {
				this.refuse();
				return;
			}
			this.refusedAt = null;
			if (reply.status !== 200 && reply.status !== 426) {
				this.setStatus('offline');
				return;
			}
			// Something between the device and the server that answers 200 with a
			// page of its own (a hotel's sign-in, a proxy's error) is no connection.
			if (!isSyncBody(reply.body)) {
				this.setStatus('offline');
				return;
			}
			const body = reply.body;
			// The account's storage, for the Cascades page and the limit checks, offline too.
			if (body.storage) {
				const s = await getMeta(this.db, 'server');
				await this.db.put('meta', { ...s, storage_bytes: body.storage.used, max_storage_bytes: body.storage.limit }, 'server');
			}
			const offset = offsetOf(body.server_time, receivedAt);
			if (offset !== null) await this.db.put('meta', { offset_ms: offset }, 'clock');
			let settingsChanged = !!body.settings && (await takeShared(this.db, body.settings, sent));
			if (await takePresets(this.db, body.presets_version, body.presets, presetsSent.edits)) settingsChanged = true;
			if (settingsChanged) this.hooks.onDeviceSettings?.();
			if (body.resync_required) {
				// A full pull, with the same batch: the server answers each operation
				// from its record. Its results go to the rebase with the rows they
				// produced. Dropped here, with nothing pulled, the device's own rows
				// for a level a finish made would be cleared before the server's
				// arrived, and the operations queued on it refused and lost.
				// The server never answers a full pull this way; one that did would
				// be asked again without end, so that is taken for no connection.
				if (cursor === null) {
					this.setStatus('offline');
					return;
				}
				cursor = null;
				continue;
			}
			const acked = ackedOf(batch, body);
			// A 426 applied its operations and carries their pull like a 200: both
			// are taken, so what was just pushed stays on the device as the server
			// has it.
			const st = newPull(Number(body.sync_seq), cursor === null, qrf);
			const o = newOutcome();
			try {
				const pulled = await this.pullPages(st, body, device_id, cursor);
				if (!pulled) return;
				await rebase(this.db, st, acked, rctx, o);
			} catch (e) {
				// What the cascades already applied had to say is still said.
				this.emit(o);
				if (!isQuota(e)) throw e;
				// No room for the pull. The failed write took nothing with it: the
				// cursor has not moved, the staging rows are the next pull's to
				// discard, and an operation leaves the outbox only in the transaction
				// that applies its cascade's rows. Make room, and pull once more:
				// the server answers what it already recorded from its records.
				if (!madeRoom) {
					madeRoom = true;
					try {
						await this.hooks.makeRoom?.();
						continue;
					} catch (e2) {
						if (!isQuota(e2)) throw e2;
					}
				}
				this.hooks.onNoRoom?.();
				this.setStatus('idle');
				return;
			}
			if (reply.status === 426) {
				// The rest of the outbox waits, and "reload to keep syncing" shows
				// until a sync succeeds.
				await this.db.put('meta', { ...(await getMeta(this.db, 'sync')), upgrade_required: true }, 'sync');
				this.emit(o);
				if (!this.stopped) await this.hooks.onSynced?.(o);
				this.setStatus('reload');
				return;
			}
			this.emit(o);
			if (!this.stopped) await this.hooks.onSynced?.(o);
			cursor = st.seq;
			// While the outbox still holds more than was just sent, go again at once.
			// Anything left, asked as a first key: a count would walk the whole outbox every batch.
			if ((await this.db.getKey('outbox', IDBKeyRange.lowerBound(-Infinity))) === undefined || batch.length < BATCH_OPS) break;
		}
		this.setStatus('idle');
	}

	/** Writes the first page and fetches the rest with the token; false if interrupted. */
	private async pullPages(st: PullState, first: SyncResponse, deviceId: string, cursor: number | null): Promise<boolean> {
		await clearStaging(this.db);
		let page = first;
		for (;;) {
			if (page.changes) await writePage(this.db, st, page.changes);
			if (!page.next_page_token) return true;
			const reply = await this.send({
				device_id: deviceId,
				app_version: this.appVersion,
				// A page request carries no operations; its token fixes the rest.
				cursor,
				page_token: page.next_page_token,
				question_rows_for: [],
				// The first response brought the presets if they had changed.
				presets_version: first.presets_version ?? null
			});
			// A page that is not one ends the pull unapplied: taken for the last
			// page, it would advance the cursor past rows that never arrived.
			if (!reply || reply.status !== 200 || !isSyncBody(reply.body)) {
				if (reply?.status === 401) this.setStatus('needs_login');
				else if (reply && isRefusal(reply)) this.refuse();
				else if (reply) this.setStatus('offline');
				return false;
			}
			page = reply.body;
		}
	}

	/**
	 * The server refused the request: "Can't sync: reload". The batch stays in
	 * the outbox, whole, and is never dropped for it; the same request is made
	 * again no sooner than REFUSED_RETRY_MS, or at once by the engine a reload
	 * starts, which a newer build may send differently.
	 */
	private refuse() {
		this.refusedAt = Date.now();
		this.setStatus('refused');
	}

	private emit(o: RebaseOutcome) {
		if (o.notices.length && !this.stopped) this.hooks.onNotices?.(o.notices);
	}
}

/** Whether a 2xx body is the sync endpoint's: every one carries the sequence it took. */
function isSyncBody(body: unknown): body is SyncResponse {
	if (typeof body !== 'object' || body === null) return false;
	const seq = (body as { sync_seq?: unknown }).sync_seq;
	return (typeof seq === 'string' || typeof seq === 'number') && seq !== '' && Number.isFinite(Number(seq));
}

/** The batch's entries paired with their results, in request order. */
function ackedOf(batch: OutboxEntry[], body: SyncResponse): Acked[] {
	const byId = new Map(batch.map((e) => [e.op.id, e]));
	const out: Acked[] = [];
	for (const r of body.results ?? []) {
		const entry = byId.get(r.op_id);
		if (entry) out.push({ entry, result: r });
	}
	return out;
}

/** The triggers: online, visible again, every 30 seconds, and right after login. */
export function startTriggers(engine: SyncEngine): () => void {
	const kick = () => void engine.sync();
	const visible = () => {
		if (document.visibilityState === 'visible') kick();
	};
	window.addEventListener('online', kick);
	document.addEventListener('visibilitychange', visible);
	const interval = setInterval(kick, SYNC_INTERVAL_MS);
	kick();
	return () => {
		window.removeEventListener('online', kick);
		document.removeEventListener('visibilitychange', visible);
		clearInterval(interval);
		engine.stop();
	};
}

/** `EventSource.CLOSED`: the browser has given the stream up. */
const STREAM_CLOSED = 2;
/** The wait before a closed stream is opened again, doubling up to the stream's own lifetime. */
export const STREAM_REOPEN_MS = 5_000;
export const STREAM_REOPEN_MAX_MS = 300_000;

/**
 * Telling the other devices (PLAN.md § The sync cycle): the server's stream of
 * `changed` events for this account, each a change another device synced,
 * which this device syncs at once rather than at its next 30-second sync. A
 * stream opened again (the server ends each after a few minutes; a network
 * drops) syncs too, since a change may have come while it was closed. The
 * browser reconnects by itself after a dropped connection; a stream it gives
 * up, because the answer was not a stream, is opened again after a wait; and
 * one refused because the account is signed out is left closed, and the
 * 30-second sync carries on alone.
 */
export function listenForChanges(engine: SyncEngine, userId: string, deviceId: string): () => void {
	if (typeof EventSource === 'undefined') return () => undefined;
	const q = new URLSearchParams({ user: userId, device: deviceId });
	let es: EventSource | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let delay = STREAM_REOPEN_MS;
	let opened = false;
	let stopped = false;
	const open = () => {
		timer = null;
		const stream = new EventSource(`/api/sync/events?${q}`);
		es = stream;
		stream.addEventListener('changed', () => engine.schedule(0));
		stream.onopen = () => {
			delay = STREAM_REOPEN_MS;
			if (opened) engine.schedule(0);
			opened = true;
		};
		stream.onerror = () => {
			// A dropped connection leaves the stream CONNECTING and the browser
			// opens it again. An answer that is not a stream (a 502 while the
			// server is replaced, a 429) closes it for good, so it is opened again
			// here, each time after twice as long, unless the account is signed out.
			if (stopped || stream.readyState !== STREAM_CLOSED || engine.status === 'needs_login') return;
			timer = setTimeout(open, delay);
			delay = Math.min(delay * 2, STREAM_REOPEN_MAX_MS);
		};
	};
	open();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		es?.close();
	};
}

/**
 * Runs `lead` while this tab holds the account's sync lock, for the tab's
 * life; where Web Locks is missing, every tab leads. The function returned
 * gives the lock up, or, while this tab is still waiting for it, takes back
 * the request: left queued, it would be granted later and lead for an account
 * this tab no longer runs as, keeping the lock from the tab that does.
 */
export function electLeader(userId: string, lead: () => () => void): () => void {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) return lead();
	let release: (() => void) | null = null;
	let stopLeading: (() => void) | null = null;
	const waiting = new AbortController();
	locks
		.request(`acrodont-sync-${userId}`, { signal: waiting.signal }, () => {
			// Granted in the same moment it was taken back.
			if (waiting.signal.aborted) return;
			stopLeading = lead();
			return new Promise<void>((r) => (release = r));
		})
		// The request taken back while it waited.
		.catch(() => undefined);
	return () => {
		waiting.abort();
		stopLeading?.();
		release?.();
	};
}
