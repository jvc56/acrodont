import { describe, expect, it } from 'vitest';
import { definitionLines } from './definition';

describe('definitionLines', () => {
	it('gives each part of speech a line of its own', () => {
		expect(definitionLines('a harbour [n -S]')).toEqual(['a harbour [n -S]']);
		expect(definitionLines('a way out [n -S] / to go out [v -ED, -ING, -S]')).toEqual(['a way out [n -S]', 'to go out [v -ED, -ING, -S]']);
		expect(definitionLines('typical [adj] / a mean [n -S] / to find a mean [v -ED, -ING, -S]')).toHaveLength(3);
	});

	it('splits only after a part of speech, so a slash inside a meaning stays', () => {
		expect(definitionLines('an either / or choice [n -S]')).toEqual(['an either / or choice [n -S]']);
		expect(definitionLines('no brackets here')).toEqual(['no brackets here']);
		expect(definitionLines('')).toEqual([]);
	});
});
