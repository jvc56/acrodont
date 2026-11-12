import { describe, expect, it, vi } from 'vitest';
import { isIos, keepStorage, shellText, storageText } from './install';

describe('isIos', () => {
	it('knows an iPhone, and an iPad asking for desktop sites', () => {
		expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
		expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
	});
	it('is not a Mac, Android or Windows', () => {
		expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
		expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 7)', 'Linux armv81', 5)).toBe(false);
		expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
	});
});

describe('keepStorage', () => {
	it('does not ask again when the data is already kept', async () => {
		const persist = vi.fn(async () => true);
		expect(await keepStorage({ persisted: async () => true, persist })).toBe(true);
		expect(persist).not.toHaveBeenCalled();
	});
	it('asks, and says what the browser answered', async () => {
		expect(await keepStorage({ persisted: async () => false, persist: async () => true })).toBe(true);
		expect(await keepStorage({ persisted: async () => false, persist: async () => false })).toBe(false);
	});
	it('is null where the browser cannot say', async () => {
		expect(await keepStorage(undefined)).toBeNull();
		expect(
			await keepStorage({
				persisted: async () => {
					throw new Error('no');
				},
				persist: async () => true
			})
		).toBeNull();
	});
});

it('has a line for every state', () => {
	expect(shellText('ready')).toMatch(/opens on this device/);
	expect(shellText('preparing')).toMatch(/Getting/);
	expect(shellText('unsupported')).toMatch(/can’t/);
	expect(storageText(true)).toMatch(/stays on this device/);
	expect(storageText(null)).toMatch(/may clear/);
});
