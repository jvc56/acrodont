<script lang="ts">
	// The answer settings (PLAN.md § Settings): what a revealed answer shows and
	// how a reveal grades it. For a cascade, only those that apply to its quiz
	// type; for a preset (`quizType` null), every one, since a preset can be
	// applied to any cascade. The rows read and save the source the page
	// provides (lib/settings/source): the cascade's on this device, or a preset's.
	import type { QuizType } from '$lib/filters';
	import { INFO } from '$lib/settings-info';
	import { useSettings } from '$lib/settings/source';
	import ScopedSetting from './ScopedSetting.svelte';

	let { quizType = null }: { quizType?: QuizType | null } = $props();

	const settings = useSettings();
	const dsp = $derived(settings.value);
	const is = (...types: QuizType[]) => quizType === null || types.includes(quizType);
</script>

{#snippet flag(
	key: 'show_definitions' | 'show_hooks' | 'show_found_count' | 'require_alphabetical' | 'show_probability' | 'definition_column' | 'hooks_on_question',
	label: string,
	id: string,
	info: string
)}
	<ScopedSetting {key} {label} for={id} {info}>
		<input {id} type="checkbox" checked={dsp[key]} onchange={(e) => settings.change(key, e.currentTarget.checked)} />
	</ScopedSetting>
{/snippet}

{#if is('anagram')}
	<!-- Typing answers is for anagram quizzes only. -->
	<ScopedSetting key="answer_mode" label="Answer mode" info={INFO.answer_mode} for="player-mode">
		<select
			id="player-mode"
			class="rounded border bg-background px-2 py-1"
			value={dsp.answer_mode}
			onchange={(e) => settings.change('answer_mode', e.currentTarget.value === 'typed' ? 'typed' : 'flashcard')}
		>
			<option value="flashcard">Flashcard</option>
			<option value="typed">Typed</option>
		</select>
	</ScopedSetting>
{/if}
<ScopedSetting key="reveal_correct" label="When an answer is revealed, mark it" info={INFO.reveal_correct} for="cascade-reveal">
	<select
		id="cascade-reveal"
		class="rounded border bg-background px-2 py-1"
		value={dsp.reveal_correct ? 'correct' : 'missed'}
		onchange={(e) => settings.change('reveal_correct', e.currentTarget.value === 'correct')}
	>
		<option value="correct">Correct</option>
		<option value="missed">Missed</option>
	</select>
</ScopedSetting>
{#if is('anagram')}
	{@render flag('show_definitions', 'Show definitions', 'cascade-definitions', INFO.show_definitions)}
	{@render flag('show_hooks', 'Show hooks', 'cascade-hooks', INFO.show_hooks)}
	{@render flag('show_found_count', 'Show how many anagrams are found in typed mode', 'cascade-found-count', INFO.found_count)}
	{@render flag('require_alphabetical', 'Typed answers must be in alphabetical order', 'cascade-alphabetical', INFO.alphabetical)}
{/if}
{#if is('anagram', 'definition')}
	{@render flag('show_probability', 'Show each word’s probability order', 'cascade-probability', INFO.show_probability)}
	{@render flag('definition_column', 'Definitions in their own column', 'cascade-definition-column', INFO.definition_column)}
{/if}
{#if is('definition')}
	{@render flag('hooks_on_question', 'Show the word once, with its hooks, in the question', 'cascade-hooks-on-question', INFO.hooks_on_question)}
{/if}
{#if is('leave_value')}
	<ScopedSetting key="leave_value_decimals" label="Round leave values to (decimal places)" info={INFO.leave_value_decimals} for="cascade-decimals">
		<select
			id="cascade-decimals"
			class="rounded border bg-background px-2 py-1"
			value={String(dsp.leave_value_decimals)}
			onchange={(e) => settings.change('leave_value_decimals', Number(e.currentTarget.value))}
		>
			{#each [0, 1, 2, 3] as d (d)}<option value={String(d)}>{d}</option>{/each}
		</select>
	</ScopedSetting>
{/if}
