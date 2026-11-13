// The service worker's decisions, kept pure so they can be tested (PLAN.md
// § On the device → App shell). Every navigation to an app route is answered
// with the cached index.html; a navigation under /api/ — the export is one, a
// hidden frame's — and any request the worker does not recognise as part of
// the built app go to the network untouched. /api responses are never cached.

// A chunk of the built app that this build does not have is another build's:
// a tab still running that build asks for it, and its cache may still hold it.
export type Route = 'shell' | 'precached' | 'other_build' | 'network';

export function route(url: URL, mode: RequestMode, origin: string, precached: Set<string>): Route {
	if (url.origin !== origin) return 'network';
	if (url.pathname.startsWith('/api/') || url.pathname === '/api') return 'network';
	if (mode === 'navigate') return 'shell';
	if (precached.has(url.pathname)) return 'precached';
	return url.pathname.startsWith(IMMUTABLE) ? 'other_build' : 'network';
}

/** Where a build's hashed files are served: a path names one build's file for good. */
export const IMMUTABLE = '/_app/immutable/';

export const CACHE_PREFIX = 'acrodont-';

export function cacheName(version: string): string {
	return `${CACHE_PREFIX}${version}`;
}

/** A cache's build, or null for a cache that is not one of the app's. */
function buildOf(name: string): string | null {
	return name.startsWith(CACHE_PREFIX) ? name.slice(CACHE_PREFIX.length) : null;
}

/** Whether build `a` was made before build `b`; a build's version is the time it was made. Unknown when either is not a number. */
function older(a: string, b: string): boolean | null {
	const [x, y] = [Number(a), Number(b)];
	return a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) ? x < y : null;
}

/**
 * The previous builds' caches that may go: one is deleted only once no page
 * is still running that build, so a tab left on the old build can still load
 * the chunks the card it is on needs. Never a **newer** build's: that is the
 * cache of a worker installed and waiting to take over, which would start
 * with nothing; and never one whose age cannot be told.
 */
export function deletable(names: string[], current: string, clientVersions: Iterable<string>): string[] {
	const inUse = new Set([...clientVersions].map(cacheName));
	return names.filter((n) => {
		const build = buildOf(n);
		return build !== null && build !== current && !inUse.has(n) && older(build, current) === true;
	});
}

/** Messages between pages and the worker. */
export type ToWorker =
	| { type: 'SKIP_WAITING' }
	/** A page announces the build it runs. */
	| { type: 'HELLO'; version: string }
	/** A page on some build is closing. */
	| { type: 'CLOSING'; version: string };
