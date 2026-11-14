<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();
</script>

<!--
	SvelteKit keeps a page's component when only its parameter changes. The
	player is made once for one cascade (its Player, its Web Lock, its place in
	the sync state), so going from one cascade to another (Duplicate cascade,
	Back from the copy) makes a new page.
-->
{#key page.params.id}
	{@render children()}
{/key}
