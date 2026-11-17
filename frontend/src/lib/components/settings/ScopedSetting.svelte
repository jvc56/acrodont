<script lang="ts">
	// One setting of this cascade on this device (PLAN.md § Settings → Where a
	// setting applies): its row, and once it is changed, the offer under it to
	// make the same change more widely. The control is the caller's; it calls
	// `settings.change`, which saves for this cascade on this device.
	import type { Snippet } from 'svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import type { SettingKey } from '$lib/settings/layers';
	import { settings } from '$lib/settings/store.svelte';
	import ScopeOffer from './ScopeOffer.svelte';

	let {
		key,
		label,
		for: forId,
		info = null,
		children
	}: { key: SettingKey; label: string; for: string; info?: string | null; children: Snippet } = $props();
</script>

<div data-setting={key} data-source={settings.sourceOf(key)}>
	<SettingRow {label} for={forId} {info}>
		{@render children()}
	</SettingRow>
	<ScopeOffer id={key} />
</div>
