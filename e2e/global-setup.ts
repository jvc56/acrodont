import { chromium } from '@playwright/test';
import { PORT, stack, e2eEnv } from './stack';

/**
 * Waits until a browser can load the app: the log-in form, its scripts and all.
 * Docker creating the stack's network and containers makes Chromium report
 * the host's network as changed for a moment after the stack is healthy, and
 * page loads begun then fail (`net::ERR_NETWORK_CHANGED` on the app's chunks,
 * SvelteKit's 500). With four workers starting at once, the first journeys
 * landed in that moment on CI.
 */
async function waitForApp(base: string) {
	const browser = await chromium.launch();
	try {
		const deadline = Date.now() + 60_000;
		for (;;) {
			const page = await browser.newPage();
			try {
				await page.goto(`${base}/login`);
				await page.getByLabel('Username').waitFor({ timeout: 5_000 });
				return;
			} catch (e) {
				if (Date.now() > deadline) throw e;
			} finally {
				await page.close();
			}
			await new Promise((r) => setTimeout(r, 1_000));
		}
	} finally {
		await browser.close();
	}
}

export default async function globalSetup() {
	if (process.env.BASE_URL) return; // an existing instance, given an admin account
	// The Makefile's second pass on a stack its first pass brought up and seeded.
	if (process.env.E2E_STACK_READY) return;
	stack('up', e2eEnv());
	stack('seed');
	await waitForApp(`http://localhost:${PORT}`);
}
