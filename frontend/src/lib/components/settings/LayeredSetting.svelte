<script lang="ts">
	// One setting that can be set in any of the four places (PLAN.md § Settings
	// → Where a setting applies): its row, with the place its value comes from
	// under its name, then the offer after a change and the 2×2 of places when
	// the chip is pressed. The control is the caller's; it calls
	// `settings.change`, which saves for this cascade on this device.
	import type { Snippet } from 'svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import type { SettingKey } from '$lib/settings/layers';
	import PlaceChip from './PlaceChip.svelte';
	import PlaceDetails from './PlaceDetails.svelte';

	let {
		key,
		label,
		for: forId,
		info = null,
		children
	}: { key: SettingKey; label: string; for: string; info?: string | null; children: Snippet } = $props();
</script>

<div class="space-y-1.5" data-setting={key}>
	<SettingRow {label} for={forId} {info}>
		{#snippet under()}<PlaceChip {key} {label} />{/snippet}
		{@render children()}
	</SettingRow>
	<PlaceDetails {key} {label} />
</div>
