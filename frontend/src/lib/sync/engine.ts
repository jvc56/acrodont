// The sync engine (PLAN.md § The sync cycle, § When the device syncs,
// § Frontend → lib/sync). One tab per account runs it, elected with the Web
// Locks API; where Web Locks is missing every tab syncs and idempotency keeps
// that correct. It pushes the outbox in batches of up to BATCH_OPS, pulls
// every page, rebases, and backs off on 429 and 503 by Retry-After.
import { pendingShares, takeShared, type SharedSettings } from '$lib/settings/device';
import { ApiError, request } from '$lib/api';
import type { UserDb } from '$lib/local/db';
import { getMeta } from '$lib/local/meta';
import type { OutboxEntry } from '$lib/local/rows';
import { SYNC_INTERVAL_MS } from './config';
import type { Notice } from './notices';
import { questionRowsFor } from './policy';
import { BATCH_OPS, type Reply, type SyncRequest, type SyncResponse, type Transport } from './protocol';
import { clearStaging, newPull, writePage, type PullState } from './pull';
import { rebase, type Acked, type RebaseOutcome } from './rebase';

export type SyncStatus =
	| 'idle'
	| 'syncing'
	| 'offline'
	/** A 401: studying continues; "Log in to sync". */
	| 'needs_login'
	/** A 426: "reload to keep syncing". */
	| 'reload';

export interface EngineHooks {
	onStatus?: (s: SyncStatus) => void;
	onNotices?: (n: Notice[]) => void;
	/** After every completed pull: the download manager's turn (§ Downloads). */
	onSynced?: (o: RebaseOutcome) => void | Promise<void>;
	/** A display setting or the controls changed here, taken from the account's shared ones. */
	onDeviceSettings?: () => void;
}

/** POST /api/sync over fetch, with the session cookie, CSRF token and user binding. */
export const fetchTransport: Transport = async (req: SyncRequest): Promise<Reply> => {
	try {
		const body = await request<unknown>('POST', '/api/sync', { body: req });
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
	private readonly transport: Transport;
	private readonly now: () => Date;
	private readonly appVersion: number;
	private readonly wait: (s: number) => Promise<void>;

	constructor(
		private readonly db: UserDb,
		private readonly hooks: EngineHooks = {},
		opts: EngineOptions = {}
	) {
		this.transport = opts.transport ?? fetchTransport;
		this.now = opts.now ?? (() => new Date());
		this.appVersion = opts.appVersion ?? (typeof __APP_BUILD__ === 'number' ? __APP_BUILD__ : 0);
		this.wait = opts.wait ?? ((s) => sleep(s * 1000));
	}

	private setStatus(s: SyncStatus) {
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
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	private async send(req: SyncRequest): Promise<Reply | null> {
		for (;;) {
			let reply: Reply;
			try {
				reply = await this.transport(req);
			} catch {
				this.setStatus('offline');
				return null;
			}
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
		if (sync.upgrade_required) this.setStatus('reload');
		else this.setStatus('syncing');
		const { device_id } = await getMeta(this.db, 'device');
		const server = await getMeta(this.db, 'server');
		let cursor = sync.cursor;
		// Device settings shared here and not yet sent go with the first request.
		let shares: SharedSettings | null = await pendingShares(this.db);
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
			if (Object.keys(sent).length) req.device_settings = sent;
			shares = null;
			const reply = await this.send(req);
			if (!reply) return;
			if (reply.status === 401) {
				// Studying continues; the outbox waits for the next login.
				this.setStatus('needs_login');
				return;
			}
			if (reply.status !== 200 && reply.status !== 426) {
				this.setStatus('offline');
				return;
			}
			const body = reply.body as SyncResponse;
			// The account's storage, for the Cascades page and the limit checks, offline too.
			if (body.storage) {
				const s = await getMeta(this.db, 'server');
				await this.db.put('meta', { ...s, storage_bytes: body.storage.used, max_storage_bytes: body.storage.limit }, 'server');
			}
			if (body.device_settings && (await takeShared(this.db, body.device_settings, sent))) this.hooks.onDeviceSettings?.();
			if (body.resync_required) {
				// A full pull, with the same batch: the server answers each operation
				// from its record. Its results go to the rebase with the rows they
				// produced. Dropped here, with nothing pulled, the device's own rows
				// for a level a finish made would be cleared before the server's
				// arrived, and the operations queued on it refused and lost.
				cursor = null;
				continue;
			}
			const acked = ackedOf(batch, body);
			const rctx = { device_id, max_quiz_questions: server.max_quiz_questions, now: this.now };
			// A 426 applied its operations and carries their pull like a 200: both
			// are taken, so what was just pushed stays on the device as the server
			// has it.
			const st = newPull(Number(body.sync_seq), cursor === null, qrf);
			const pulled = await this.pullPages(st, body, device_id, cursor);
			if (!pulled) return;
			const o = await rebase(this.db, st, acked, rctx);
			if (reply.status === 426) {
				// The rest of the outbox waits, and "reload to keep syncing" shows
				// until a sync succeeds.
				await this.db.put('meta', { ...(await getMeta(this.db, 'sync')), upgrade_required: true }, 'sync');
				this.emit(o);
				await this.hooks.onSynced?.(o);
				this.setStatus('reload');
				return;
			}
			this.emit(o);
			await this.hooks.onSynced?.(o);
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
				question_rows_for: []
			});
			if (!reply || reply.status !== 200) {
				if (reply?.status === 401) this.setStatus('needs_login');
				else if (reply) this.setStatus('offline');
				return false;
			}
			page = reply.body as SyncResponse;
		}
	}

	private emit(o: RebaseOutcome) {
		if (o.notices.length) this.hooks.onNotices?.(o.notices);
	}
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

/**
 * Telling the other devices (PLAN.md § The sync cycle): the server's stream of
 * `changed` events for this account, each a change another device synced,
 * which this device syncs at once rather than at its next 30-second sync. A
 * stream opened again (the server ends each after a few minutes; a network
 * drops) syncs too, since a change may have come while it was closed. The
 * browser reconnects by itself; a stream the server refuses (signed out) is
 * left closed, and the 30-second sync carries on alone.
 */
export function listenForChanges(engine: SyncEngine, userId: string, deviceId: string): () => void {
	if (typeof EventSource === 'undefined') return () => undefined;
	const q = new URLSearchParams({ user: userId, device: deviceId });
	const es = new EventSource(`/api/sync/events?${q}`);
	let opened = false;
	es.addEventListener('changed', () => engine.schedule(0));
	es.onopen = () => {
		if (opened) engine.schedule(0);
		opened = true;
	};
	return () => es.close();
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
