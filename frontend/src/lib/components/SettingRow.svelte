<script lang="ts">
	// One setting: what it is on the left, the control on the right. Every
	// settings form uses it, so whatever the setting — a checkbox, a choice, a
	// number — the place to click is always the row's right end.
	import type { Snippet } from 'svelte';
	import InfoTip from './InfoTip.svelte';

	let {
		label,
		for: forId,
		hint = null,
		info = null,
		children
	}: {
		label: string;
		/** The control's id, so the label names it and a click on it reaches it. */
		for: string;
		hint?: string | null;
		/** What the setting does, behind an ⓘ beside its name. */
		info?: string | null;
		children: Snippet;
	} = $props();
</script>

<div class="flex items-center justify-between gap-4">
	<div class="min-w-0">
		<div class="flex items-center gap-1.5">
			<label for={forId} class="text-sm">{label}</label>
			{#if info}<InfoTip text={info} />{/if}
		</div>
		{#if hint}<p class="text-xs text-muted-foreground">{hint}</p>{/if}
	</div>
	<div class="flex shrink-0 items-center gap-2 text-sm">{@render children()}</div>
</div>
