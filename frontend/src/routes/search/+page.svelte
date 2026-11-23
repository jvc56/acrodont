<script lang="ts">
	// The Search page (PLAN.md § Search page): the one page, from the header or
	// from a quiz. Signed-in only, as every page but the sign-in pages is: the
	// root layout sends anyone else to /login.
	//
	// From a quiz the player shows this same page over the quiz, at
	// /search?from=<cascade> (SvelteKit shallow routing), handing it the quiz:
	// its lexicon, its Search keys and the way back, which this page offers as its
	// button, those keys (Q outside a text box, Alt+Q anywhere, by default) or Back.
	// Loaded at that address on its own (a reload), it finds the quiz itself and
	// goes back to it in history, or opens it afresh.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { session } from '$lib/auth/session.svelte';
	import SearchView from '$lib/components/search/SearchView.svelte';
	import { userDb } from '$lib/local/open';
	import { DEFAULT_BINDINGS, isSearchKey, searchTitle, type Binding } from '$lib/player/bindings';
	import { settings } from '$lib/settings/store.svelte';

	let {
		quiz: given = null
	}: {
		/** Shown by the player over its quiz: the quiz, whether this page is showing, and the way back. */
		quiz?: { id: string; lexicon: string; bindings: Binding[]; active: boolean; back: () => void } | null;
	} = $props();

	let from = $derived(given ? given.id : page.url.searchParams.get('from'));
	/** Loaded on its own: the quiz's cascade, whose settings this page opened, and its lexicon. */
	let opened = $state<{ id: string; lexicon: string } | null>(null);

	// Loaded on its own from a quiz: the cascade's lexicon, and its Search keys from its settings on
	// this device. (Shown by the player, the player has them; its settings are open for it.)
	$effect(() => {
		const id = from;
		const user = session.userId;
		if (given || !id || !user) return;
		let gone = false;
		void (async () => {
			const d = await userDb(user, session.username);
			const row = await d.get('cascades', id);
			if (gone || !row) return;
			await settings.open(d, row);
			if (!gone) opened = { id, lexicon: row.lexicon };
		})();
		return () => {
			gone = true;
		};
	});

	let lexicon = $derived(given ? given.lexicon : opened && opened.id === from ? opened.lexicon : null);
	let bindings = $derived(given ? given.bindings : opened && opened.id === from ? settings.value.bindings : DEFAULT_BINDINGS);
	let active = $derived(given ? given.active : true);

	function back() {
		if (given) return given.back();
		if (!from) return;
		if (page.state.search) history.back();
		else void goto(`/cascades/${encodeURIComponent(from)}`);
	}

	function onKey(e: KeyboardEvent) {
		if (!active || !from || !isSearchKey(bindings, e)) return;
		e.preventDefault();
		if (!e.repeat) back();
	}
</script>

<svelte:head>{#if active}<title>Search · Acrodont</title>{/if}</svelte:head>
<svelte:window onkeydown={onKey} />

<!-- A fixed height under the header, so the list scrolls inside the page. -->
<main class="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-6xl flex-col p-4 md:p-6">
	<SearchView cascadeLexicon={lexicon} onclose={from ? back : null} closeHint={searchTitle(bindings).replace(/^Search/, 'Back to the quiz')} {active} />
</main>
