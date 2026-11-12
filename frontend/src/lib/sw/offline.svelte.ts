// Whether this device can open the app with no connection, whether the browser
// keeps its data, and the browser's offer to install it (PLAN.md § On the
// device → Installing the app). The header shows the first two and the offer;
// on an iPhone or iPad, which never offers, a one-time tip says how.
import { isIos, keepStorage, type Shell } from './install';

/** Chrome's and Edge's install offer: not in the DOM's types. */
interface InstallPrompt extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

class OfflineState {
	shell = $state<Shell>('preparing');
	/** Whether the browser keeps this site's data; null until asked, or where it cannot say. */
	kept = $state<boolean | null>(null);
	/** The browser's install offer, while it stands. */
	offer = $state.raw<InstallPrompt | null>(null);
	/** Running as the installed app, not in a browser tab. */
	installed = $state(false);
	ios = $state(false);
}

export const offline = new OfflineState();

const browser = typeof window !== 'undefined';

// Listening from the moment the app's code loads: the offer can come before
// the first page mounts.
if (browser) {
	addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		offline.offer = e as InstallPrompt;
	});
	addEventListener('appinstalled', () => {
		offline.offer = null;
		offline.installed = true;
	});
}

export function watchOffline() {
	if (!browser) return;
	const nav = navigator as Navigator & { standalone?: boolean };
	offline.installed = matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
	offline.ios = isIos(nav.userAgent, nav.platform, nav.maxTouchPoints);
	if (!('serviceWorker' in nav)) {
		offline.shell = 'unsupported';
		return;
	}
	// A worker is active only once it has stored the whole app.
	void nav.serviceWorker.ready.then((r) => {
		if (r.active) offline.shell = 'ready';
	});
}

let asked = false;

/** Asks once per page load, once someone is signed in: there is then something to keep. */
export async function askToKeepData() {
	if (!browser || asked) return;
	asked = true;
	offline.kept = await keepStorage(navigator.storage);
}

/** The Install button: the browser's own dialog, which says what happens. */
export async function install() {
	const offer = offline.offer;
	if (!offer) return;
	offline.offer = null;
	await offer.prompt();
	const { outcome } = await offer.userChoice;
	if (outcome === 'accepted') {
		offline.installed = true;
		// Installed, Chrome keeps the site's data when asked.
		offline.kept = await keepStorage(navigator.storage);
	}
}
