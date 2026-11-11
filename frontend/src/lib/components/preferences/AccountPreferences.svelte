<script lang="ts">
	// The account's preferences (PLAN.md § Preferences), in two groups that
	// apply differently: `every`, which applies to every cascade at once, and
	// `defaults`, which prefill the builder for a new cascade. The Preferences
	// page and the player's Preferences both show them, through `save`, which
	// writes a `set_preferences` operation, so a change works offline and syncs.
	// A default segment size is clamped to the cap `/api/auth/me` reported.
	//
	// With `everyCascade`, a default just changed offers to give the cascades
	// you already have the same value (§ Where a setting applies).
	import { INFO } from '$lib/settings-info';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import ApplyWider from './ApplyWider.svelte';
	import type { PreferencesRow } from '$lib/local/rows';
	import { segmentSizeError } from '$lib/options';
	import { fieldOfDefault, type CascadeFields } from '$lib/preferences/widen';

	let {
		prefs,
		maxQuiz,
		part,
		save,
		everyCascade = null
	}: {
		prefs: PreferencesRow;
		maxQuiz: number;
		part: 'every' | 'defaults';
		save: (field: keyof PreferencesRow, value: unknown) => unknown;
		everyCascade?: { count: (f: CascadeFields) => Promise<number>; apply: (f: CascadeFields) => Promise<void> } | null;
	} = $props();

	let sizeText = $state('');
	let sizeError = $state<string | null>(null);
	$effect(() => {
		sizeText = String(prefs.default_segment_size);
	});

	/** The offer under each default changed on this visit, keyed by the preference. */
	let offers = $state<Partial<Record<keyof PreferencesRow, { fields: CascadeFields; count: number; serial: number }>>>({});
	let serial = 0;

	async function saveDefault(pref: keyof PreferencesRow, value: unknown) {
		await save(pref, value);
		const field = fieldOfDefault(pref);
		if (!field || !everyCascade) return;
		const fields = { [field]: value } as CascadeFields;
		offers = { ...offers, [pref]: { fields, count: await everyCascade.count(fields), serial: ++serial } };
	}

	/** A whole percentage from 1 to 100; anything else puts the old value back. */
	function setThreshold(el: HTMLInputElement) {
		const n = Number(el.value);
		if (!Number.isInteger(n) || n < 1 || n > 100) {
			el.value = String(prefs.default_clear_threshold);
			return;
		}
		if (n !== prefs.default_clear_threshold) void saveDefault('default_clear_threshold', n);
	}

	function setSegment() {
		const n = Number(sizeText);
		sizeError = Number.isFinite(n) ? segmentSizeError(n, maxQuiz) : 'Use a whole number.';
		if (!sizeError && n !== prefs.default_segment_size) void saveDefault('default_segment_size', n);
	}
</script>

{#snippet offer(pref: keyof PreferencesRow, kind: string)}
	{@const o = offers[pref]}
	{#if o && everyCascade}
		{#key o.serial}
			<ApplyWider
				saved="Saved for new cascades"
				offers={o.count > 0
					? [
							{
								key: 'all',
								label: `all ${o.count} ${kind}${o.count === 1 ? '' : 's'} you have`,
								done: `Used for all ${o.count} ${kind}${o.count === 1 ? '' : 's'}`,
								run: () => everyCascade.apply(o.fields)
							}
						]
					: []}
			/>
		{/key}
	{/if}
{/snippet}

<div class="grid gap-3 text-sm">
	{#if part === 'every'}
		<SettingRow label="Show definitions with anagrams" info={INFO.anagram_show_definitions} for="pref-definitions">
			<input id="pref-definitions" type="checkbox" checked={prefs.anagram_show_definitions} onchange={(e) => save('anagram_show_definitions', e.currentTarget.checked)} />
		</SettingRow>
		<SettingRow label="Show hooks with anagrams" info={INFO.anagram_show_hooks} for="pref-hooks">
			<input id="pref-hooks" type="checkbox" checked={prefs.anagram_show_hooks} onchange={(e) => save('anagram_show_hooks', e.currentTarget.checked)} />
		</SettingRow>
		<SettingRow label="When an answer is revealed, mark it" info={INFO.reveal_correct} for="pref-reveal">
			<select id="pref-reveal" class="rounded border bg-background px-2 py-1" value={prefs.reveal_correct === false ? 'missed' : 'correct'} onchange={(e) => save('reveal_correct', e.currentTarget.value === 'correct')}>
				<option value="correct">Correct</option>
				<option value="missed">Missed</option>
			</select>
		</SettingRow>
		<SettingRow label="Round leave values to (decimal places)" info={INFO.leave_value_decimals} for="pref-decimals">
			<select id="pref-decimals" class="rounded border bg-background px-2 py-1" value={String(prefs.leave_value_decimals)} onchange={(e) => save('leave_value_decimals', Number(e.currentTarget.value))}>
				{#each [0, 1, 2, 3] as d (d)}<option value={String(d)}>{d}</option>{/each}
			</select>
		</SettingRow>
	{:else}
		<SettingRow label="Default clear threshold (%)" info={INFO.default_clear_threshold} for="pref-threshold">
			<input id="pref-threshold" class="w-20 rounded border bg-background px-2 py-1" type="number" min="1" max="100" value={prefs.default_clear_threshold} onchange={(e) => setThreshold(e.currentTarget)} />
		</SettingRow>
		{@render offer('default_clear_threshold', 'cascade')}
		<SettingRow label="Default segment size (0 is off)" info={INFO.default_segment_size} for="pref-segment">
			<input id="pref-segment" class="w-28 rounded border bg-background px-2 py-1" bind:value={sizeText} onchange={setSegment} inputmode="numeric" />
		</SettingRow>
		{#if sizeError}<p class="text-destructive">{sizeError}</p>{/if}
		{@render offer('default_segment_size', 'cascade')}
		<SettingRow label="Default progression" info={INFO.default_progression} for="pref-progression">
			<select id="pref-progression" class="rounded border bg-background px-2 py-1" value={prefs.default_progression} onchange={(e) => saveDefault('default_progression', e.currentTarget.value)}>
				<option value="ladder">Ladder</option>
				<option value="drill">Drill</option>
			</select>
		</SettingRow>
		{@render offer('default_progression', 'cascade')}
		<SettingRow label="Default alphabetical order" info={INFO.default_alphabetical} for="pref-alphabetical">
			<input id="pref-alphabetical" type="checkbox" checked={prefs.default_require_alphabetical} onchange={(e) => saveDefault('default_require_alphabetical', e.currentTarget.checked)} />
		</SettingRow>
		{@render offer('default_require_alphabetical', 'cascade')}
		<SettingRow label="Default answer mode for new anagram cascades" info={INFO.anagram_answer_mode} for="pref-mode">
			<select id="pref-mode" class="rounded border bg-background px-2 py-1" value={prefs.anagram_answer_mode} onchange={(e) => saveDefault('anagram_answer_mode', e.currentTarget.value)}>
				<option value="flashcard">Flashcard</option>
				<option value="typed">Typed</option>
			</select>
		</SettingRow>
		{@render offer('anagram_answer_mode', 'anagram cascade')}
	{/if}
</div>
