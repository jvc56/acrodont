<script lang="ts">
	// How the player looks and responds: the question's, the answers' and the
	// definitions' typeface, size and letter spacing, the player's layout and
	// grade border, the hooks' size, a phone's tap zones, and the repeat guard.
	// The typeface is a choice of the few every device has; the rest are numbers
	// in px, em or ms, committed when the field loses focus or on Enter, so a
	// half-typed number is never applied; each control sits at the right of its
	// row like every other setting. Like every setting, each can be set in any
	// of four places (lib/settings/layers): a change saves for this cascade on
	// this device and offers to move it wider. The caller opens `settings` for
	// the cascade first.
	import { INFO } from '$lib/settings-info';
	import TileText from '$lib/components/TileText.svelte';
	import LayeredSetting from '$lib/components/settings/LayeredSetting.svelte';
	import { clampSetting, FONTS, LIMITS, textStyle, type LimitKey } from '$lib/player/display';
	import { settings } from '$lib/settings/store.svelte';
	import type { SettingKey } from '$lib/settings/layers';

	const d = $derived(settings.value);
	// Every control is the same width and followed by the same unit column (px, em, ms, or
	// nothing), so the fields, choices and checkboxes of the rows line up with each other.
	const inputClass = 'w-36 rounded-md border bg-background px-2 py-1';
	const selectClass = 'w-36 rounded-md border bg-background px-2 py-1';

	type NumberKey = { [K in SettingKey]: (typeof settings.value)[K] extends number ? K : never }[SettingKey];
	type FlagKey = { [K in SettingKey]: (typeof settings.value)[K] extends boolean ? K : never }[SettingKey];
	type FontKey = 'question_font' | 'answer_font' | 'definition_font';

	/** Commits a number; what is out of bounds is clamped, and the field shows what was kept. */
	function setNumber(field: NumberKey, limit: LimitKey, e: Event & { currentTarget: HTMLInputElement }) {
		const v = clampSetting(limit, e.currentTarget.value);
		e.currentTarget.value = String(v);
		if (v !== d[field]) void settings.change(field, v);
	}
</script>

{#snippet check(label: string, field: FlagKey, id: string, checked: boolean, info: string, set: (on: boolean) => void)}
	<LayeredSetting key={field} {label} for={id} {info}>
		<!-- On a wide screen the checkbox sits in the fields' column; on a phone, at the row's right end. -->
		<span class="flex justify-end sm:w-36"><input {id} type="checkbox" {checked} onchange={(e) => set(e.currentTarget.checked)} /></span>
		<span class="w-8 max-sm:hidden" aria-hidden="true"></span>
	</LayeredSetting>
{/snippet}

{#snippet number(label: string, unit: string, field: NumberKey, limit: LimitKey, info: string)}
	{@const l = LIMITS[limit]}
	<LayeredSetting key={field} {label} for={`display-${field}`} {info}>
		<input
			id={`display-${field}`}
			class={inputClass}
			type="number"
			min={l.min}
			max={l.max}
			step={l.step}
			value={d[field]}
			onchange={(e) => setNumber(field, limit, e)}
		/>
		<span class="w-8 text-muted-foreground">{unit}</span>
	</LayeredSetting>
{/snippet}

<div class="grid gap-4 text-sm">
	{#each [
		{ which: 'question', title: 'Question', limit: 'size_px', sample: 'AEINRST' },
		{ which: 'answer', title: 'Answers', limit: 'size_px', sample: 'NASTIER' },
		{ which: 'definition', title: 'Definitions', limit: 'definition_size_px', sample: 'a coarse, loosely woven fabric' }
	] as const as part (part.which)}
		{@const fontKey = `${part.which}_font` as FontKey}
		{@const font = d[fontKey]}
		{@const size = d[`${part.which}_size_px`]}
		{@const spacing = d[`${part.which}_spacing`]}
		<fieldset class="grid gap-3">
			<legend class="mb-1 font-medium">{part.title}</legend>
			<LayeredSetting key={fontKey} label="Font" info={INFO.font} for={`display-${fontKey}`}>
				<select
					id={`display-${fontKey}`}
					class={selectClass}
					value={font}
					onchange={(e) => settings.change(fontKey, e.currentTarget.value)}
				>
					{#each FONTS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
				</select>
				<span class="w-8" aria-hidden="true"></span>
			</LayeredSetting>
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
	<fieldset class="grid gap-3">
		<legend class="mb-1 font-medium">Layout</legend>
		{@render number('Question position from the top', 'px', 'question_top_px', 'question_top_px', INFO.question_top)}
		{@render check('Green border on a correct answer', 'border_correct', 'display-border-correct', d.border_correct, INFO.border_correct, (on) => settings.change('border_correct', on))}
		{@render check('Red border on a missed answer', 'border_missed', 'display-border-missed', d.border_missed, INFO.border_missed, (on) => settings.change('border_missed', on))}
		{@render number('Grade border width', 'px', 'border_px', 'border_px', INFO.border_width)}
		{@render check('Show the status bar', 'status_bar_hidden', 'display-status-bar', !d.status_bar_hidden, INFO.status_bar, (on) => settings.change('status_bar_hidden', !on))}
		{@render check('Show the sync status', 'sync_status_hidden', 'display-sync-status', !d.sync_status_hidden, INFO.sync_status, (on) => settings.change('sync_status_hidden', !on))}
		{@render number('Definition width', 'px', 'definition_width_px', 'definition_width_px', INFO.definition_width)}
		{@render number('Hook size', 'px', 'hook_size_px', 'hook_size_px', INFO.hook_size)}
		<LayeredSetting key="player_buttons" label="Show the Previous, Toggle and Show / Next buttons" info={INFO.player_buttons} for="display-player-buttons">
			<select
				id="display-player-buttons"
				class={selectClass}
				value={d.player_buttons}
				onchange={(e) => settings.change('player_buttons', e.currentTarget.value === 'always' ? 'always' : 'auto')}
			>
				<option value="auto">On a touch screen or a narrow window</option>
				<option value="always">Always</option>
			</select>
			<span class="w-8" aria-hidden="true"></span>
		</LayeredSetting>
		{#if d.player_buttons === 'auto'}
			{@render number('A window is narrow below', 'px', 'buttons_below_px', 'buttons_below_px', INFO.buttons_below)}
		{/if}
		<LayeredSetting key="mobile_buttons" label="Tap zones on a phone" info={INFO.mobile_buttons} for="display-mobile-buttons">
			<select
				id="display-mobile-buttons"
				class={selectClass}
				value={d.mobile_buttons}
				onchange={(e) => settings.change('mobile_buttons', e.currentTarget.value === 'rows' ? 'rows' : 'columns')}
			>
				<option value="columns">Columns</option>
				<option value="rows">Rows</option>
			</select>
			<span class="w-8" aria-hidden="true"></span>
		</LayeredSetting>
		{#if d.mobile_buttons === 'rows'}
			{@render number('Row height on a phone', 'px', 'mobile_row_px', 'mobile_row_px', INFO.mobile_row_px)}
		{/if}
	</fieldset>
	<fieldset class="grid gap-3">
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
