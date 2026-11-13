// The app shell (PLAN.md § On the device → App shell). Precaches the built app
// and answers every navigation to an app route with the cached index.html, so
// /cascades/:id loads with no connection. A new version installs and waits:
// it never calls skipWaiting() on install, only when a page posts
// SKIP_WAITING, and it deletes an old build's cache only once no page runs
// that build, never a newer build's (a worker waiting to take over), and not
// while it does not know what some open page runs. A worker that finds its
// own cache gone fetches it again, and until then answers from the network,
// never with another build's shell: that shell's chunks are not this build's.
/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
import { cacheName, CACHE_PREFIX, deletable, route, type ToWorker } from '$lib/sw/logic';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = cacheName(version);
const SHELL = '/index.html';
const precached = new Set([...build, ...files, SHELL]);
/** The build each page reports it runs, by client id. */
const clientVersions = new Map<string, string>();

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...precached])));
});

async function prune() {
	const live = new Set((await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => c.id));
	for (const id of [...clientVersions.keys()]) if (!live.has(id)) clientVersions.delete(id);
	// A page that has not said what it runs (this worker has just taken over, or was
	// stopped while idle and has forgotten) may run any build: nothing goes until it has.
	if ([...live].some((id) => !clientVersions.has(id))) return;
	const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
	for (const n of deletable(names, version, clientVersions.values())) await caches.delete(n);
}

/** This build's files again, if its cache has gone (an earlier build's worker deleted a newer one's). */
async function restore() {
	const cache = await caches.open(CACHE);
	if (await cache.match(SHELL)) return;
	await cache.addAll([...precached]).catch(() => undefined);
}

sw.addEventListener('activate', (event) => {
	event.waitUntil(restore().then(() => sw.clients.claim()).then(prune));
});

sw.addEventListener('message', (event) => {
	const m = event.data as ToWorker;
	const id = (event.source as Client | null)?.id;
	if (m.type === 'SKIP_WAITING') void sw.skipWaiting();
	else if (m.type === 'HELLO' && id) clientVersions.set(id, m.version);
	else if (m.type === 'CLOSING') {
		if (id) clientVersions.delete(id);
		event.waitUntil(prune());
	}
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	const r = route(url, req.mode, sw.location.origin, precached);
	if (r === 'network') return; // untouched: /api, the export frame, anything unrecognised
	event.respondWith(
		(async () => {
			const path = r === 'shell' ? SHELL : url.pathname;
			// Another build's chunk, for a tab still running it: its cache if it is still here.
			if (r === 'other_build') return (await caches.match(path)) ?? fetch(req);
			const hit = await (await caches.open(CACHE)).match(path);
			if (hit) return hit;
			// This build's file is not in its cache: the server's, which is this build's or a
			// newer one's whole. Another build's copy only with no connection, as a last resort.
			try {
				return await fetch(r === 'shell' ? SHELL : req);
			} catch (e) {
				const old = await caches.match(path);
				if (old) return old;
				throw e;
			}
		})()
	);
});
