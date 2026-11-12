<script lang="ts">
	// The signed-in site header, on every page but the player, which keeps the
	// whole screen for the quiz and has its own rail. Acrodont goes to the
	// Cascades page, the landing page, which holds New cascade and the Trash;
	// an admin also has Admin.
	import { page } from '$app/state';
	import { session } from '$lib/auth/session.svelte';
	import SyncStatus from '$lib/components/SyncStatus.svelte';

	const links = $derived([
		...(session.isAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);

	// The most specific link that matches is the current one: /cascades/new is
	// New cascade, not Cascades.
	const current = $derived.by(() => {
		const path = page.url.pathname;
		const hits = links.filter((l) => path === l.href || path.startsWith(`${l.href}/`));
		return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
	});
</script>

<header class="border-b bg-background">
	<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
		<a href="/cascades" class="text-lg font-semibold tracking-tight">Acrodont</a>
		{#if links.length}<nav aria-label="Main" class="order-last flex w-full gap-1 overflow-x-auto text-sm md:order-none md:w-auto">
			{#each links as l (l.href)}
				<a
					href={l.href}
					aria-current={current === l.href ? 'page' : undefined}
					class="rounded-md px-3 py-1.5 whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
				>
					{l.label}
				</a>
			{/each}
		</nav>{/if}
		<div class="ml-auto flex items-center gap-4">
			<SyncStatus />
			<a
				href="/account"
				aria-current={page.url.pathname === '/account' ? 'page' : undefined}
				class="rounded-md border px-3 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted"
				title="Account: log out, storage on this device, password"
			>
				{session.username || 'Account'}
			</a>
		</div>
	</div>
</header>
