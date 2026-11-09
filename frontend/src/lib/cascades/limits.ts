// The cascade limit (PLAN.md § Cascade limit). A module of its own, with no
// imports, so the session can read it without pulling in the local stores.

/** MAX_CASCADES_PER_USER's default, used until /api/auth/me has reported the server's. */
export const DEFAULT_CASCADE_LIMIT = 20;

/** The builder warns from 90% of the limit. */
export function cascadeWarning(limit: number): number {
	return Math.ceil(limit * 0.9);
}
