<script lang="ts">
	// Segment size and progression, each explained behind its ⓘ (PLAN.md §
	// Quiz options, § Frontend → QuizOptionsForm): a cascade's, which every
	// level reads, the one being studied included, in the cascade's Settings. Each option is a row with its control on the
	// right, like every other setting, and is saved as soon as it is changed:
	// `onchange` runs with the options once a change is complete (a segment size
	// when its field is left or Enter is pressed), never for a half-typed one.
	import { INFO } from '$lib/settings-info';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import { chainBound, segmentSizeError, type QuizOptions } from '$lib/options';

	let {
		options = $bindable(),
		questionCount = null,
		maxQuizQuestions = 300_000,
		idPrefix = '',
		onchange = () => undefined
	}: {
		options: QuizOptions;
		/** The cascade's count. */
		questionCount?: number | null;
		maxQuizQuestions?: number;
		/** Keeps the controls' ids apart when two forms share a page. */
		idPrefix?: string;
		onchange?: (options: QuizOptions) => void;
	} = $props();

	let sizeText = $state(String(options.segment_size));
	let segmented = $state(options.segment_size > 0);

	let error = $derived(segmented ? segmentSizeError(Number(sizeText), maxQuizQuestions) : null);
	/** The drill levels one pass could make at the size in the field, warned about before it is saved. */
	let levels = $derived(questionCount && segmented && !error ? chainBound(questionCount, Number(sizeText)) : 0);

	/** Saves the segment size the field holds, when it is one; turned on with none yet, it waits for one. */
	function commitSize() {
		const size = segmented ? Number(sizeText) : 0;
		if (segmentSizeError(size, maxQuizQuestions) || (segmented && size === 0)) return;
		if (size === options.segment_size) return;
		options.segment_size = size;
		onchange(options);
	}

	function setSegmented(on: boolean) {
		segmented = on;
		if (on && Number(sizeText) === 0) sizeText = '';
		commitSize();
	}
</script>

<div class="grid gap-3">
	<SettingRow label="Study in segments" info={INFO.segmented} for={`${idPrefix}segmented`}>
		<Checkbox id={`${idPrefix}segmented`} checked={segmented} onCheckedChange={(v) => setSegmented(v === true)} />
	</SettingRow>
	{#if segmented}
		<SettingRow label="Segment size" info={INFO.segment_size} for={`${idPrefix}segment-size`}>
			<Input
				id={`${idPrefix}segment-size`}
				class="h-8 w-28"
				type="number"
				min="5"
				max={maxQuizQuestions}
				bind:value={sizeText}
				onchange={commitSize}
				onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && commitSize()}
			/>
			<span class="text-muted-foreground">questions each</span>
		</SettingRow>
	{/if}
	{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
	{#if questionCount && levels > 2000}
		<p class="text-sm text-amber-400">
			One pass could create up to {levels.toLocaleString()} drill levels, one for each segment with a miss.
		</p>
	{/if}
	<SettingRow label="When a quiz is finished below the clear threshold" info={INFO.progression} for={`${idPrefix}progression`}>
		<select
			id={`${idPrefix}progression`}
			class="rounded border bg-background px-2 py-1"
			value={options.progression}
			onchange={(e) => {
				options.progression = e.currentTarget.value as QuizOptions['progression'];
				onchange(options);
			}}
		>
			<option value="ladder">Ladder</option>
			<option value="drill">Drill</option>
		</select>
	</SettingRow>
</div>
