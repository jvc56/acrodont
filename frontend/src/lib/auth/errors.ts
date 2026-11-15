import { ApiError } from '$lib/api';

/**
 * A wait as a person reads it: seconds up to two minutes, then minutes, then
 * hours, rounded up. The registrations-a-day limit asks for hours.
 */
export function waitText(seconds: number): string {
	if (seconds <= 120) return `${seconds} second${seconds === 1 ? '' : 's'}`;
	if (seconds <= 7200) return `${Math.ceil(seconds / 60)} minutes`;
	return `${Math.ceil(seconds / 3600)} hours`;
}

/** A sentence for a failed auth request that has no field errors. */
export function describe(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 429) return `Too many attempts. Try again in ${waitText(e.retryAfterSeconds ?? 60)}.`;
		if (e.status === 503)
			return `The server is busy. Try again in ${e.retryAfterSeconds ?? 10} seconds.`;
		if (e.status >= 500) return 'Something went wrong on the server. Try again shortly.';
		return 'That did not work. Check the details and try again.';
	}
	return 'Could not reach Acrodont. Check your connection.';
}
