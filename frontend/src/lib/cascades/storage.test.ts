// PLAN.md § Storage limit: the device's copy of the per-row costs is the
// server's (contract-fixtures/storage.json), and the figures read as stated.
import { describe, expect, it } from 'vitest';
import costs from '../../../../contract-fixtures/storage.json';
import { formatBytes, levelBytes, STORAGE_COSTS, storageState } from './storage';

describe('storage', () => {
	it('uses the server’s per-row costs', () => {
		expect(STORAGE_COSTS).toEqual(costs);
	});

	it('a level costs its quiz row, a chunk per 256 questions and each question, with its index past the Source quiz', () => {
		const c = STORAGE_COSTS;
		expect(levelBytes(1000, true)).toBe(c.quiz_row + 4 * c.chunk_row + 1000 * c.card);
		expect(levelBytes(1000, false)).toBe(c.quiz_row + 4 * c.chunk_row + 1000 * (c.card + c.card_idx));
		expect(levelBytes(256, false)).toBe(c.quiz_row + c.chunk_row + 256 * (c.card + c.card_idx));
		expect(levelBytes(0, false)).toBe(c.quiz_row);
	});

	it('is ok, almost full from 90%, and over past the limit', () => {
		expect(storageState(0, 100)).toBe('ok');
		expect(storageState(89, 100)).toBe('ok');
		expect(storageState(90, 100)).toBe('almost');
		expect(storageState(100, 100)).toBe('almost');
		expect(storageState(101, 100)).toBe('over');
	});

	it('reads in decimal units, as the limit is stated', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(4_200)).toBe('4.2 KB');
		expect(formatBytes(18_259_968)).toBe('18 MB');
		expect(formatBytes(4_860_000)).toBe('4.9 MB');
		expect(formatBytes(100_000_000)).toBe('100 MB');
		expect(formatBytes(2_147_483_648)).toBe('2.1 GB');
	});
});
