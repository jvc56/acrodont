import { stack, e2eEnv } from './stack';

export default async function globalSetup() {
	if (process.env.BASE_URL) return; // an existing instance, given an admin account
	// The Makefile's second pass on a stack its first pass brought up and seeded.
	if (process.env.E2E_STACK_READY) return;
	stack('up', e2eEnv());
	stack('seed');
}
