import { defineConfig, devices } from '@playwright/test';

// PLAN.md § End-to-end tests. globalSetup brings a Acrodont up through the same
// scripts/stack.py entry points ./scripts/dev.py uses, as project acrodont-e2e
// on a port from the environment, unless BASE_URL names an existing instance.
//
// The journeys run side by side, E2E_WORKERS (4) at a time: each registers its
// own user. Those tagged @serial change what every other journey stands on
// (the catalog, the backend's process, the stack itself), so they run after
// the rest, one at a time. If a side-by-side journey fails, Playwright skips
// them ("did not run").
const port = Number(process.env.E2E_PORT ?? 5180);
const chrome = { ...devices['Desktop Chrome'] };

export default defineConfig({
	testDir: './tests',
	globalSetup: './global-setup.ts',
	globalTeardown: './global-teardown.ts',
	workers: Number(process.env.E2E_WORKERS ?? 4),
	retries: 0,
	timeout: 120_000,
	reporter: [['list']],
	use: {
		baseURL: process.env.BASE_URL ?? `http://localhost:${port}`,
		trace: 'retain-on-failure',
		serviceWorkers: 'allow'
	},
	projects: [
		{ name: 'parallel', grepInvert: /@serial/, fullyParallel: true, use: chrome },
		{ name: 'serial', grep: /@serial/, dependencies: ['parallel'], workers: 1, use: chrome }
	]
});
