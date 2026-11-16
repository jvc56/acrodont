<script lang="ts">
	// A place a setting can be set in, drawn as its cell of the 2×2 the places
	// make (PLAN.md § Settings → Where a setting applies): the rows are this
	// cascade and every cascade, the columns this device and every device. The
	// default fills no cell. Decoration only: the place's name is always beside it.
	import type { Place } from '$lib/settings/layers';

	let { place }: { place: Place | 'default' } = $props();
	const CELLS: Place[] = ['both', 'cascade', 'device', 'all'];
</script>

<span class="inline-grid shrink-0 grid-cols-2 gap-[2px]" aria-hidden="true" data-glyph={place}>
	{#each CELLS as c (c)}
		<span class="block size-1.5 rounded-[1.5px] {c === place ? 'bg-sky-500' : 'border border-muted-foreground/60'}"></span>
	{/each}
</span>
