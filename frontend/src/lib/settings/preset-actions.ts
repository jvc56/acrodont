// What a page says about a preset's name, or about a change to a preset the
// server refused (PLAN.md § Settings → Presets): shared by a cascade's
// Settings, the Cascades page and the preset editor.
import { ApiError } from '$lib/api';
import { isRetriable } from '$lib/builder/create';
import { isDefaults, isDefaultsName, type Preset } from './presets';

/** What a change to a preset says when it fails; `doing` names it ("Saving a preset"), `done` its past ("saved"). */
export function presetFailure(e: unknown, doing: string, done: string): string {
	if (e instanceof ApiError && e.code === 'name_taken') return 'You already have a preset with that name.';
	if (e instanceof ApiError && e.code === 'preset_limit') return 'You have 50 presets, the most an account can hold. Delete one to make room.';
	const field = e instanceof ApiError ? e.fieldErrors.find((f) => f.field === 'name') : undefined;
	if (field) return field.message;
	if (isRetriable(e)) return `${doing} needs a connection.`;
	return `The preset could not be ${done}. Try again.`;
}

/**
 * Why `name` cannot be a preset's, or null. `id` is the preset being renamed
 * (another holding the name is refused), or null for a new one, whose name may
 * be a taken one only where the caller asks to replace it.
 */
export function presetNameError(name: string, id: string | null, presets: Preset[]): string | null {
	if (!name) return 'A preset needs a name.';
	if (isDefaultsName(name)) return '“Defaults” is the built-in preset’s name.';
	if (id !== null && presets.some((o) => o.id !== id && !isDefaults(o) && o.name === name)) return 'You already have a preset with that name.';
	return null;
}

/** A copy's suggested name: the original's with the next free number, "Phone (2)", as Duplicate names a cascade. */
export function nextFreeName(name: string, presets: Pick<Preset, 'name'>[]): string {
	const base = name.replace(/ \(\d+\)$/, '');
	const taken = new Set(presets.map((p) => p.name));
	for (let n = 2; ; n++) {
		const candidate = `${base} (${n})`;
		if (!taken.has(candidate) && !isDefaultsName(candidate)) return candidate;
	}
}
