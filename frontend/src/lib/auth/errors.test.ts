// The sentences for a refused auth request (PLAN.md § Authentication): a wait
// is said in the unit a person would use, since the registrations-a-day limit
// asks for hours where the others ask for seconds.
import { describe as suite, expect, it } from 'vitest';
import { ApiError } from '$lib/api';
import { describe, waitText } from './errors';

suite('auth errors', () => {
	it('says a wait in seconds, then minutes, then hours, rounded up', () => {
		expect(waitText(1)).toBe('1 second');
		expect(waitText(60)).toBe('60 seconds');
		expect(waitText(120)).toBe('120 seconds');
		expect(waitText(121)).toBe('3 minutes');
		expect(waitText(720)).toBe('12 minutes');
		expect(waitText(7200)).toBe('120 minutes');
		expect(waitText(8640)).toBe('3 hours');
	});

	it('a 429 names its wait', () => {
		const e = Object.assign(Object.create(ApiError.prototype), { status: 429, retryAfterSeconds: 8640 }) as ApiError;
		expect(describe(e)).toBe('Too many attempts. Try again in 3 hours.');
	});
});
