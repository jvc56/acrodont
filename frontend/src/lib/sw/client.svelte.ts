// The page's side of updates (PLAN.md § On the device → App shell). The app
// watches `registration.waiting` and offers "a new version is ready"; when the
// user accepts — or presses reload in the 426 state — it posts SKIP_WAITING.
// Only the tab that posted it reloads on `controllerchange`; every other tab
// shows "Acrodont was updated in another tab — reload to continue" and keeps
// running. The app never reloads on its own initiative.
import { version } from '$app/environment';
import type { ToWorker } from './logic';

class UpdateState {
	/** A new version installed and is waiting. */
	ready = $state(false);
	/** Another tab activated a new version under this one. */
	updatedElsewhere = $state(false);
}

export const updates = new UpdateState();

let asked = false;
let registration: ServiceWorkerRegistration | null = null;

function post(to: ServiceWorker | null | undefined, m: ToWorker) {
	to?.postMessage(m);
}

export async function watchUpdates() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	const sw = navigator.serviceWorker;
	// The build this page runs, for support and for the update journey's check.
	document.documentElement.dataset.build = String(typeof __APP_BUILD__ === 'number' ? __APP_BUILD__ : 0);
	registration = (await sw.getRegistration()) ?? null;
	// A card can stay open for hours with no navigation to prompt the browser's
	// own check, so look for a new version now and then, and on returning.
	const lookForUpdate = () => void registration?.update().catch(() => undefined);
	setInterval(lookForUpdate, 5 * 60_000);
	addEventListener('online', lookForUpdate);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') lookForUpdate();
	});
	post(sw.controller, { type: 'HELLO', version });
	addEventListener('pagehide', () => post(sw.controller, { type: 'CLOSING', version }));
	// On a first visit the new worker claims the page (clients.claim() on
	// activate): a controller arriving, not a version changing under the tab.
	let controlled = !!sw.controller;
	sw.addEventListener('controllerchange', () => {
		if (!controlled) {
			controlled = true;
			post(sw.controller, { type: 'HELLO', version });
			return;
		}
		if (asked) location.reload();
		else {
			updates.updatedElsewhere = true;
			// The new worker is told what this tab still runs, so it keeps that build's files.
			post(sw.controller, { type: 'HELLO', version });
		}
	});
	const check = (r: ServiceWorkerRegistration) => {
		if (r.waiting) updates.ready = true;
		r.addEventListener('updatefound', () => {
			const w = r.installing;
			w?.addEventListener('statechange', () => {
				if (w.state === 'installed' && sw.controller) updates.ready = true;
			});
		});
	};
	if (registration) check(registration);
	// A first visit: the worker is registered at the page's load event, after
	// this ran, so there was no registration to read. Taken once there is one,
	// or this tab would never look for a new version, however long it stays open.
	else
		void sw.ready.then((r) => {
			registration = r;
			check(r);
		});
}

/** The user accepted the new version: the one reload they asked for. */
export function applyUpdate() {
	const waiting = registration?.waiting;
	if (!waiting) {
		location.reload();
		return;
	}
	asked = true;
	post(waiting, { type: 'SKIP_WAITING' });
}
