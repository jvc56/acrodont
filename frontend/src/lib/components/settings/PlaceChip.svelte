<script lang="ts">
	// Under a setting's name: the place its value comes from (PLAN.md § Settings
	// → Where a setting applies). Pressed, it opens the setting's 2×2 of places
	// below the row (PlaceDetails).
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { PLACE_NAMES, type SettingKey } from '$lib/settings/layers';
	import { settings } from '$lib/settings/store.svelte';
	import PlaceGlyph from './PlaceGlyph.svelte';

	let { key, label }: { key: SettingKey; label: string } = $props();
	const from = $derived(settings.sourceOf(key));
	const open = $derived(settings.expanded === key);
</script>

<button
	type="button"
	class="inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground {open ? 'border-sky-500 text-foreground' : ''}"
	aria-expanded={open}
	aria-label={`${label}: from ${PLACE_NAMES[from].toLowerCase()}. Show where it is set`}
	data-source={from}
	onclick={() => (settings.expanded = open ? null : key)}
>
	<PlaceGlyph place={from} />
	{PLACE_NAMES[from]}
	<ChevronDownIcon class="size-3 transition-transform {open ? 'rotate-180' : ''}" aria-hidden="true" />
</button>
