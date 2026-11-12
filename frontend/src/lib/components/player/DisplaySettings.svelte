<script lang="ts">
	// The settings kept on this device: the question's and the answers'
	// typeface, size and letter spacing, the player's layout and grade border,
	// and the repeat guard. The typeface is a choice of the few every device
	// has; the rest are numbers in px, em or ms, committed when the field loses
	// focus or on Enter, so a half-typed number is never applied; each control sits at the
	// right of its row like every other setting. Each change is saved for this
	// device, then offers to be used for all of the account's devices
	// (lib/settings/device). The caller loads `display` for the signed-in user first.
	import { INFO } from '$lib/settings-info';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import TileText from '$lib/components/TileText.svelte';
	import ApplyWider from '$lib/components/settings/ApplyWider.svelte';
	import { afterLocalWrite } from '$lib/sync/runtime.svelte';
	import { clampSetting, display, FONTS, LIMITS, textStyle, type Display, type LimitKey } from '$lib/player/display.svelte';

	const d = $derived(display.value);
	// Every control is the same width and followed by the same unit column (px, em, ms, or
	// nothing), so the fields, choices and checkboxes of the rows line up with each other.
	const inputClass = 'w-36 rounded-md border bg-background px-2 py-1';
	const selectClass = 'w-36 rounded-md border bg-background px-2 py-1';

	/** Commits a number; what is out of bounds is clamped, and the field shows what was kept. */
	function setNumber(field: keyof Display, limit: LimitKey, e: Event & { currentTarget: HTMLInputElement }) {
		const v = clampSetting(limit, e.currentTarget.value);
		e.currentTarget.value = String(v);
		void change({ [field]: v } as Partial<Display>);
	}

	/** The offer under each setting changed since Settings opened, keyed by the change so a second one starts afresh. */
	let offers = $state<Record<string, number>>({});
	let serial = 0;

	/** Saves a change on this device, and offers it for every device. */
	async function change(patch: Partial<Display>) {
		await display.set(patch);
		for (const k of Object.keys(patch)) offers = { ...offers, [k]: ++serial };
	}

	const everyDevice = (field: keyof Display) => [
		{
			key: 'devices',
			label: 'all your devices',
			done: 'Used for all your devices',
			run: async () => {
				await display.share([field]);
				afterLocalWrite();
			}
		}
	];
</script>

{#snippet widen(field: keyof Display)}
	{#if offers[field]}
		{#key offers[field]}<ApplyWider saved="Saved on this device" offers={everyDevice(field)} />{/key}
	{/if}
{/snippet}

{#snippet check(label: string, field: keyof Display, id: string, checked: boolean, info: string, set: (on: boolean) => void)}
	<SettingRow {label} for={id} {info}>
		<span class="flex w-36 justify-end"><input {id} type="checkbox" {checked} onchange={(e) => set(e.currentTarget.checked)} /></span>
		<span class="w-8" aria-hidden="true"></span>
	</SettingRow>
	{@render widen(field)}
{/snippet}

{#snippet number(label: string, unit: string, field: keyof Display, limit: LimitKey, info: string)}
	{@const l = LIMITS[limit]}
	<SettingRow {label} for={`display-${field}`} {info}>
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
	{@render widen(field)}
{/snippet}

<div class="grid gap-4 text-sm">
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
					class={selectClass}
					value={font}
					onchange={(e) => change({ [`${part.which}_font`]: e.currentTarget.value })}
				>
					{#each FONTS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
				</select>
				<span class="w-8" aria-hidden="true"></span>
			</SettingRow>
			{@render widen(`${part.which}_font`)}
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
		{@render check('Green border on a correct answer', 'border_correct', 'display-border-correct', d.border_correct, INFO.border_correct, (on) => change({ border_correct: on }))}
		{@render check('Red border on a missed answer', 'border_missed', 'display-border-missed', d.border_missed, INFO.border_missed, (on) => change({ border_missed: on }))}
		{@render number('Grade border width', 'px', 'border_px', 'border_px', INFO.border_width)}
		{@render check('Show the status bar below the quiz', 'status_bar_hidden', 'display-status-bar', !d.status_bar_hidden, INFO.status_bar, (on) => change({ status_bar_hidden: !on }))}
		<SettingRow label="Tap zones on a phone" info={INFO.mobile_buttons} for="display-mobile-buttons">
			<select
				id="display-mobile-buttons"
				class={selectClass}
				value={d.mobile_buttons}
				onchange={(e) => change({ mobile_buttons: e.currentTarget.value === 'rows' ? 'rows' : 'columns' })}
			>
				<option value="columns">Columns</option>
				<option value="rows">Rows</option>
			</select>
			<span class="w-8" aria-hidden="true"></span>
		</SettingRow>
		{@render widen('mobile_buttons')}
		{#if d.mobile_buttons === 'rows'}
			{@render number('Row height on a phone', 'px', 'mobile_row_px', 'mobile_row_px', INFO.mobile_row_px)}
		{/if}
	</fieldset>
	<fieldset class="grid gap-2">
		<legend class="mb-1 font-medium">Repeated presses</legend>
		{@render number(
			'Ignore the same action pressed again within',
			'ms',
			'repeat_guard_ms',
			'repeat_guard_ms',
			INFO.repeat_guard
		)}
	</fieldset>
</div>
