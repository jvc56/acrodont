<script lang="ts">
	// The settings kept on this device: the question's and the answers'
	// typeface, size and letter spacing, the player's layout and grade border,
	// and the repeat guard. The typeface is a choice of the few every device
	// has; the rest are numbers in px, em or ms, committed when the field loses
	// focus or on Enter, so a half-typed number is never applied; each control sits at the
	// right of its row like every other setting. The caller loads `display` for
	// the signed-in user first.
	import { INFO } from '$lib/settings-info';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import TileText from '$lib/components/TileText.svelte';
	import { clampSetting, display, FONTS, LIMITS, textStyle, type Display, type LimitKey } from '$lib/player/display.svelte';

	const d = $derived(display.value);
	const inputClass = 'w-24 rounded-md border bg-background px-2 py-1';

	/** Commits a number; what is out of bounds is clamped, and the field shows what was kept. */
	function setNumber(field: keyof Display, limit: LimitKey, e: Event & { currentTarget: HTMLInputElement }) {
		const v = clampSetting(limit, e.currentTarget.value);
		e.currentTarget.value = String(v);
		void display.set({ [field]: v } as Partial<Display>);
	}
</script>

{#snippet number(label: string, unit: string, field: keyof Display, limit: LimitKey, info: string, hint: string | null = null)}
	{@const l = LIMITS[limit]}
	<SettingRow {label} for={`display-${field}`} {hint} {info}>
		<input
			id={`display-${field}`}
			class={inputClass}
			type="number"
			min={l.min}
			max={l.max}
			step={l.step}
			value={d[field] as number}
			onchange={(e) => setNumber(field, limit, e)}
		/>
		<span class="w-8 text-muted-foreground">{unit}</span>
	</SettingRow>
{/snippet}

<div class="grid gap-4 text-sm">
	<p class="text-muted-foreground">These apply to this device only.</p>
	{#each [
		{ which: 'question', title: 'Question', limit: 'size_px', sample: 'AEINRST' },
		{ which: 'answer', title: 'Answers', limit: 'size_px', sample: 'NASTIER' },
		{ which: 'definition', title: 'Definitions', limit: 'definition_size_px', sample: 'a coarse, loosely woven fabric' }
	] as const as part (part.which)}
		{@const font = d[`${part.which}_font`]}
		{@const size = d[`${part.which}_size_px`]}
		{@const spacing = d[`${part.which}_spacing`]}
		<fieldset class="grid gap-2">
			<legend class="mb-1 font-medium">{part.title}</legend>
			<SettingRow label="Font" info={INFO.font} for={`display-${part.which}_font`}>
				<select
					id={`display-${part.which}_font`}
					class="w-40 rounded-md border bg-background px-2 py-1"
					value={font}
					onchange={(e) => display.set({ [`${part.which}_font`]: e.currentTarget.value })}
				>
					{#each FONTS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
				</select>
				<span class="w-8"></span>
			</SettingRow>
			{@render number('Size', 'px', `${part.which}_size_px`, part.limit, INFO.size)}
			{@render number('Letter spacing', 'em', `${part.which}_spacing`, 'spacing_em', INFO.spacing)}
			<p
				class="overflow-hidden rounded-md border px-3 py-2 whitespace-nowrap"
				class:font-semibold={part.which !== 'definition'}
				style={textStyle(font, size, spacing)}
				aria-hidden="true"
			>
				{#if part.which === 'definition'}{part.sample}{:else}<TileText text={part.sample} />{/if}
			</p>
		</fieldset>
	{/each}
	<fieldset class="grid gap-2">
		<legend class="mb-1 font-medium">Layout</legend>
		{@render number('Question position from the top', 'px', 'question_top_px', 'question_top_px', INFO.question_top)}
		<SettingRow label="Green border on a correct answer" info={INFO.border_correct} for="display-border-correct">
			<input id="display-border-correct" type="checkbox" checked={d.border_correct} onchange={(e) => display.set({ border_correct: e.currentTarget.checked })} />
		</SettingRow>
		<SettingRow label="Red border on a missed answer" info={INFO.border_missed} for="display-border-missed">
			<input id="display-border-missed" type="checkbox" checked={d.border_missed} onchange={(e) => display.set({ border_missed: e.currentTarget.checked })} />
		</SettingRow>
		{@render number('Grade border width', 'px', 'border_px', 'border_px', INFO.border_width)}
		<SettingRow label="Show the status bar below the quiz" info={INFO.status_bar} for="display-status-bar">
			<input id="display-status-bar" type="checkbox" checked={!d.status_bar_hidden} onchange={(e) => display.set({ status_bar_hidden: !e.currentTarget.checked })} />
		</SettingRow>
		<SettingRow label="Show how many anagrams are found in typed mode" info={INFO.found_count} for="display-found-count">
			<input id="display-found-count" type="checkbox" checked={d.show_found_count} onchange={(e) => display.set({ show_found_count: e.currentTarget.checked })} />
		</SettingRow>
	</fieldset>
	<fieldset class="grid gap-2">
		<legend class="mb-1 font-medium">Repeated presses</legend>
		{@render number(
			'Ignore the same action pressed again within',
			'ms',
			'repeat_guard_ms',
			'repeat_guard_ms',
			INFO.repeat_guard,
			'0, the default, counts every press. Raise it if a bouncing mouse button or an accidental double tap skips cards.'
		)}
	</fieldset>
</div>
