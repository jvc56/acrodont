import { stack } from './stack';

export default async function globalTeardown() {
	if (process.env.BASE_URL || process.env.E2E_KEEP_STACK) return;
	// Its data goes too, locally as in CI: specs that create cascades as the
	// seeded admin would otherwise fill its MAX_CASCADES_PER_USER over runs.
	// E2E_KEEP_STACK keeps the stack and its data for debugging.
	stack('down', ['--volumes']);
}
