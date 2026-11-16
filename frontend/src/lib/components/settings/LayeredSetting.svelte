<script lang="ts">
	// One setting that can be set in any of the four places (PLAN.md § Settings
	// → Where a setting applies): its row, with the two switches that say where
	// its value applies under its name. The control is the caller's; it calls
	// `settings.change`, which saves in the place the switches show.
	import type { Snippet } from 'svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import type { SettingKey } from '$lib/settings/layers';
	import PlaceSwitches from './PlaceSwitches.svelte';

	let {
		key,
		label,
		for: forId,
		info = null,
		children
	}: { key: SettingKey; label: string; for: string; info?: string | null; children: Snippet } = $props();
</script>

<div data-setting={key}>
	<SettingRow {label} for={forId} {info}>
		{#snippet under()}<PlaceSwitches {key} {label} />{/snippet}
		{@render children()}
	</SettingRow>
</div>
