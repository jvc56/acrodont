<script lang="ts">
	// The signed-in site header, on every page but the player, which keeps the
	// whole screen for the quiz and has its own rail. Acrodont goes to the
	// Cascades page, the landing page, which holds New cascade and the Trash;
	// Search lists words (PLAN.md § Search page); an admin also has Admin.
	import { page } from '$app/state';
	import { session } from '$lib/auth/session.svelte';
	import SyncStatus from '$lib/components/SyncStatus.svelte';
	import OfflineStatus from '$lib/components/OfflineStatus.svelte';

	let {
		path: given = null
	}: {
		/** The page it heads, where that is not the address's (the Search page over a quiz). */
		path?: string | null;
	} = $props();
	const path = $derived(given ?? page.url.pathname);

	const links = $derived([
		{ href: '/search', label: 'Search' },
		...(session.isAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);

	// The most specific link that matches is the current one: /cascades/new is
	// New cascade, not Cascades.
	const current = $derived.by(() => {
		const hits = links.filter((l) => path === l.href || path.startsWith(`${l.href}/`));
		return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
	});
</script>

<header class="border-b bg-background">
	<!-- One line at every width: what gives way is the account's name, cut short with an ellipsis. -->
	<div class="mx-auto flex max-w-6xl items-center gap-x-3 px-4 sm:gap-x-6 py-3 md:px-6">
		<a href="/" class="shrink-0 text-lg font-semibold tracking-tight">Acrodont</a>
		{#if links.length}<nav aria-label="Main" class="flex shrink-0 gap-1 text-sm">
			{#each links as l (l.href)}
				<a
					href={l.href}
					aria-current={current === l.href ? 'page' : undefined}
					class="rounded-md px-2 py-1.5 whitespace-nowrap text-muted-foreground sm:px-3 hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
				>
					{l.label}
				</a>
			{/each}
		</nav>{/if}
		<div class="ml-auto flex min-w-0 items-center gap-3 sm:gap-4">
			<OfflineStatus />
			<SyncStatus compact />
			<a
				href="/account"
				aria-current={path === '/account' ? 'page' : undefined}
				class="min-w-0 truncate rounded-md border px-3 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted"
				title="Account: log out, storage on this device, password"
			>
				{session.username || 'Account'}
			</a>
		</div>
	</div>
</header>
