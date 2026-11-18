// The time a settings change is stamped with (PLAN.md § Settings → Clocks).
// Changes made on different devices are compared by their times, so each is
// stamped by the server's clock: this device's, plus the offset the last sync
// response's `server_time` showed. Before a first sync, the offset is 0.
import type { UserDb } from '$lib/local/db';
import { getMeta } from '$lib/local/meta';

/** Now, by the server's clock as this device last learned it. */
export async function settingsNow(db: UserDb): Promise<Date> {
	const { offset_ms } = await getMeta(db, 'clock');
	return new Date(Date.now() + (Number.isFinite(offset_ms) ? offset_ms : 0));
}

/**
 * The offset a response's `server_time` shows, taken when the response was
 * received: what the request's time on the wire adds is small beside the
 * clock errors this is for.
 */
export function offsetOf(serverTime: unknown, receivedAt: number): number | null {
	if (typeof serverTime !== 'string') return null;
	const t = Date.parse(serverTime);
	return Number.isFinite(t) ? t - receivedAt : null;
}
