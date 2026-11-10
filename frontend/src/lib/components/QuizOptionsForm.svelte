<script lang="ts">
	// Segment size, progression and alphabetical order, with their inline
	// explanations (PLAN.md § Quiz options, § Frontend → QuizOptionsForm). The
	// same component serves the builder, the cascade's options dialog and the
	// quiz settings menu. Each option is a row with its control on the right,
	// like every other setting.
	import { INFO } from '$lib/settings-info';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import { chainBound, segmentSizeError, type QuizOptions } from '$lib/options';

	let {
		options = $bindable(),
		questionCount = null,
		maxQuizQuestions = 130_000,
		editing = 'cascade',
		segmentChain = false,
		source = false,
		showAlphabetical = true,
		idPrefix = ''
	}: {
		options: QuizOptions;
		/** The cascade's count in the builder and options dialog, the quiz's own in its menu. */
		questionCount?: number | null;
		maxQuizQuestions?: number;
		editing?: 'cascade' | 'quiz';
		segmentChain?: boolean;
		source?: boolean;
		showAlphabetical?: boolean;
		/** Keeps the controls' ids apart when two forms share a page. */
		idPrefix?: string;
	} = $props();

	let sizeText = $state(String(options.segment_size));
	let segmented = $state(options.segment_size > 0);

	let error = $derived(segmented ? segmentSizeError(Number(sizeText), maxQuizQuestions) : null);
	let levels = $derived(questionCount ? chainBound(questionCount, options.segment_size) : 0);

	const PROGRESSIONS = {
		ladder: 'Keep the quiz and go down a level with the misses; come back up to clear it.',
		drill: 'Replace the quiz with its misses and keep going until nothing is missed.'
	} as const;

	$effect(() => {
		const size = segmented ? Number(sizeText) : 0;
		if (!segmentSizeError(size, maxQuizQuestions)) options.segment_size = size;
	});
</script>

<div class="grid gap-3">
	{#if segmentChain}
		<p class="text-sm text-muted-foreground">
			This quiz drills a run's misses: it always uses Drill progression and is never split into
			segments.
		</p>
	{:else}
		<SettingRow
			label="Study in segments" info={INFO.segmented}
			for={`${idPrefix}segmented`}
			hint="A segment of 40 means you study 40 at a time and drill what you missed before going on."
		>
			<Checkbox id={`${idPrefix}segmented`} bind:checked={segmented} />
		</SettingRow>
		{#if segmented}
			<SettingRow label="Segment size" info={INFO.segment_size} for={`${idPrefix}segment-size`}>
				<Input id={`${idPrefix}segment-size`} class="h-8 w-28" type="number" min="5" max={maxQuizQuestions} bind:value={sizeText} />
				<span class="text-muted-foreground">questions each</span>
			</SettingRow>
		{/if}
		{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
		{#if questionCount && levels > 2000}
			<p class="text-sm text-amber-400">
				One pass could create up to {levels.toLocaleString()} drill levels, one for each segment with a miss.
			</p>
		{/if}
		{#if !source}
			<SettingRow label="When a quiz is finished below the clear threshold" info={INFO.progression} for={`${idPrefix}progression`} hint={PROGRESSIONS[options.progression]}>
				<select id={`${idPrefix}progression`} class="rounded border bg-background px-2 py-1" bind:value={options.progression}>
					<option value="ladder">Ladder</option>
					<option value="drill">Drill</option>
				</select>
			</SettingRow>
		{/if}
	{/if}
	{#if showAlphabetical}
		<SettingRow label="Typed answers must be in alphabetical order" info={INFO.alphabetical} for={`${idPrefix}alphabetical`}>
			<Checkbox id={`${idPrefix}alphabetical`} bind:checked={options.require_alphabetical} />
		</SettingRow>
	{/if}
	{#if editing === 'quiz' && !segmentChain}
		<p class="text-xs text-muted-foreground">Changes apply to this quiz only, from the current card.</p>
	{/if}
</div>
