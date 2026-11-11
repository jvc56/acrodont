import { stack } from './stack';

export default async function globalTeardown() {
	if (process.env.BASE_URL || process.env.E2E_KEEP_STACK) return;
	// Its data goes too, locally as in CI: the admin journey creates cascades
	// as the seeded admin, which would otherwise fill its storage over runs.
	// E2E_KEEP_STACK keeps the stack and its data, for debugging or for the
	// next run to reuse (its `up` then rebuilds only what changed).
	stack('down', ['--volumes']);
}
