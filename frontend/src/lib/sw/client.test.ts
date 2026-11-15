// PLAN.md § On the device → App shell: "a new version is ready" is offered when
// a new worker has installed and waits, however the browser reports it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ version: 'v1' }));

import { updates, watchUpdates } from './client.svelte';

type Listener = () => void;

/** A registration or a worker: something that is listened to. */
class Target {
	listeners = new Map<string, Listener[]>();
	addEventListener(type: string, fn: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	fire(type: string) {
		for (const fn of this.listeners.get(type) ?? []) fn();
	}
}

class Worker extends Target {
	state = 'installing';
	postMessage() {}
}

class Registration extends Target {
	installing: Worker | null = null;
	waiting: Worker | null = null;
	update = vi.fn(async () => undefined);
}

let registration: Registration;
let page: Target;

beforeEach(() => {
	updates.ready = false;
	registration = new Registration();
	page = new Target();
	const container = Object.assign(new Target(), {
		controller: new Worker(),
		getRegistration: async () => registration,
		ready: Promise.resolve(registration)
	});
	vi.stubGlobal('navigator', { serviceWorker: container });
	vi.stubGlobal('document', Object.assign(new Target(), { documentElement: { dataset: {} }, visibilityState: 'visible' }));
	vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
	vi.stubGlobal('setInterval', () => 0);
});

afterEach(() => vi.unstubAllGlobals());

describe('a new version is ready', () => {
	it('when the new worker is heard installing and then installed', async () => {
		await watchUpdates();
		const w = new Worker();
		registration.installing = w;
		registration.fire('updatefound');
		expect(updates.ready).toBe(false);
		w.state = 'installed';
		registration.installing = null;
		registration.waiting = w;
		w.fire('statechange');
		expect(updates.ready).toBe(true);
	});

	it('when `updatefound` arrives with the new worker already waiting and none installing, as Safari may deliver it', async () => {
		await watchUpdates();
		registration.waiting = Object.assign(new Worker(), { state: 'installed' });
		registration.fire('updatefound');
		expect(updates.ready).toBe(true);
	});

	it('when no event arrived at all: the next look for an update finds the worker waiting', async () => {
		await watchUpdates();
		registration.waiting = Object.assign(new Worker(), { state: 'installed' });
		expect(updates.ready).toBe(false);
		// The connection is back, one of the moments the page looks.
		page.fire('online');
		await vi.waitFor(() => expect(updates.ready).toBe(true));
		expect(registration.update).toHaveBeenCalledTimes(1);
	});

	it('not on a first visit, when the first worker installs under a page no worker controls', async () => {
		(navigator.serviceWorker as unknown as { controller: unknown }).controller = null;
		await watchUpdates();
		const w = Object.assign(new Worker(), { state: 'installed' });
		registration.installing = w;
		registration.waiting = w;
		registration.fire('updatefound');
		w.fire('statechange');
		expect(updates.ready).toBe(false);
	});
});
