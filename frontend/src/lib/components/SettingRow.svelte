<script lang="ts">
	// One setting: what it is on the left, with an ⓘ beside its name that says
	// what it does (and nothing else under the name, so a form stays short), and
	// the control on the right. Every settings form uses it,
	// so whatever the setting — a checkbox, a choice, a number — the place to
	// click is always the row's right end. On a phone there is no room for a
	// name beside a field or a choice, so those go under the name, which then
	// has the whole width; a checkbox, which is small, stays at the right end.
	import type { Snippet } from 'svelte';
	import InfoTip from './InfoTip.svelte';

	let {
		label,
		for: forId,
		info = null,
		children
	}: {
		label: string;
		/** The control's id, so the label names it and a click on it reaches it. */
		for: string;
		/** What the setting does, behind an ⓘ beside its name. */
		info?: string | null;
		children: Snippet;
	} = $props();
</script>

<div class="row">
	<div class="min-w-0">
		<div class="flex items-center gap-1">
			<label for={forId} class="text-sm">{label}</label>
			{#if info}<InfoTip text={info} />{/if}
		</div>
	</div>
	<div class="flex shrink-0 items-center gap-2 text-sm">{@render children()}</div>
</div>

<style>
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	/* A checkbox (the browser's, or the Checkbox component's button) beside its name at every width. */
	.row:has(:global(input[type='checkbox'])),
	.row:has(:global([role='checkbox'])) {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	@media (min-width: 640px) {
		.row {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
			gap: 1rem;
		}
	}
</style>
