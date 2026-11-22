<script lang="ts">
	// The Search page (PLAN.md § Search page). Signed-in only, as every page
	// but the sign-in pages is: the root layout sends anyone else to /login.
	import SearchView from '$lib/components/search/SearchView.svelte';
</script>

<svelte:head><title>Search · Acrodont</title></svelte:head>

<!-- A fixed height under the header, so the list scrolls inside the page. -->
<main class="mx-auto flex h-[calc(100dvh-4rem)] max-w-6xl flex-col p-4 md:p-6">
	<SearchView />
</main>
