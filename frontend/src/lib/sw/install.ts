// The pure parts of installing the app and keeping its data (PLAN.md § On the
// device → Installing the app), apart from the browser so they can be tested.

/** An iPhone or iPad, where installing is Share → Add to Home Screen, never a prompt. */
export function isIos(userAgent: string, platform: string, maxTouchPoints: number): boolean {
	if (/iPad|iPhone|iPod/.test(userAgent)) return true;
	// An iPad asks for desktop sites and says it is a Mac; a Mac has no touch screen.
	return platform === 'MacIntel' && maxTouchPoints > 1;
}

type Storage = Pick<StorageManager, 'persisted' | 'persist'>;

/**
 * Asks the browser to keep this site's data until the user removes it, rather
 * than clearing it when the device runs low on space (or, in Safari, after a
 * week without a visit). Returns whether it is kept, or null where the browser
 * cannot say.
 */
export async function keepStorage(storage: Storage | undefined): Promise<boolean | null> {
	if (!storage?.persist || !storage.persisted) return null;
	try {
		if (await storage.persisted()) return true;
		return await storage.persist();
	} catch {
		return null;
	}
}

export type Shell = 'preparing' | 'ready' | 'unsupported';

/** One line for each state, for the header's offline status and its ⓘ. */
export function shellText(shell: Shell): string {
	switch (shell) {
		case 'ready':
			return 'Acrodont opens on this device with no connection.';
		case 'preparing':
			return 'Getting Acrodont ready to open with no connection…';
		case 'unsupported':
			return 'This browser can’t open Acrodont with no connection.';
	}
}

export function storageText(kept: boolean | null): string {
	if (kept) return 'What you study here stays on this device until you remove it.';
	return 'If the device runs low on space, the browser may clear its copy of what you study, losing anything not yet synced. Installing Acrodont helps keep it.';
}
