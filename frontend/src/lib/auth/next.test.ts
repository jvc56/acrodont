import { describe, expect, it } from 'vitest';
import { sameSitePath } from './next';

describe('sameSitePath', () => {
	it('keeps a path on this site', () => {
		expect(sameSitePath('/cascades/new?x=1')).toBe('/cascades/new?x=1');
	});
	it('refuses anything a browser could read as another host', () => {
		for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/x', 'https://evil.example', 'cascades', '', null, undefined, '/é']) {
			expect(sameSitePath(bad)).toBe('/');
		}
	});
});
