// Calls into scripts/stack.py, the one definition of a working instance.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/stack.py');

/** Each configured pass of the suite runs its own stack (see the Makefile's test-e2e). */
export const PROJECT = process.env.E2E_PROJECT ?? 'acrodont-e2e';
export const PORT = Number(process.env.E2E_PORT ?? 5180);

export function stack(cmd: 'up' | 'seed' | 'reset' | 'down', args: string[] = []): string {
	return execFileSync(
		'python3',
		[script, cmd, '--project', PROJECT, '--port', String(PORT), ...args],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
	).trim();
}

/**
 * Every suite stack's configuration: the per-IP limits raised, because every
 * browser of every worker comes from 127.0.0.1, so four workers registering
 * users trip the 30-a-minute auth limit meant for one person, and a stack kept
 * up for several runs would spend the five resets an hour one address may ask for. No journey
 * asserts these limits; backend/tests/auth.rs and catalog.rs do.
 */
const SUITE_ENV = ['AUTH_RATE_PER_IP_PER_MINUTE=100000', 'CATALOG_RATE_PER_MINUTE=100000', 'RESET_RATE_PER_HOUR=100000'];

/** The suite's stack configuration, then E2E_ENV's, through the same --env flag a developer uses; a later value wins. */
export function e2eEnv(): string[] {
	const extra = (process.env.E2E_ENV ?? '').split(/\s+/).filter(Boolean);
	return [...SUITE_ENV, ...extra].flatMap((kv) => ['--env', kv]);
}
