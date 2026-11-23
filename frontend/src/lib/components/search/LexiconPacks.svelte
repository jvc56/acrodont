<script lang="ts">
	// The lexicons Search keeps on this device (PLAN.md § Search page →
	// Lexicon packs): each with its size, and Remove. Never evicted otherwise;
	// a removed one is downloaded again the next time Search needs it.
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { session } from '$lib/auth/session.svelte';
	import { formatBytes } from '$lib/cascades/storage';
	import type { UserDb } from '$lib/local/db';
	import { userDb } from '$lib/local/open';
	import { searchEngine } from '$lib/search/engine.svelte';
	import { listPacks, packSize } from '$lib/search/packs';

	let db: UserDb | null = null;
	let packs = $state<{ lexicon: string; size: number; definitions: boolean }[] | null>(null);

	async function refresh() {
		if (!db) return;
		packs = (await listPacks(db))
			.map((p) => ({ lexicon: p.lexicon, size: packSize(p), definitions: p.definitions }))
			.sort((a, b) => a.lexicon.localeCompare(b.lexicon));
	}

	onMount(async () => {
		if (!session.userId) return;
		db = await userDb(session.userId, session.username);
		await refresh();
	});

	async function remove(lexicon: string) {
		if (!db) return;
		await searchEngine.remove(db, lexicon);
		await refresh();
	}
</script>

<Card.Root data-lexicon-packs>
	<Card.Header><Card.Title>Lexicons for Search on this device</Card.Title></Card.Header>
	<Card.Content class="grid gap-2 text-sm">
		{#if packs === null}
			<p class="text-muted-foreground">…</p>
		{:else if packs.length === 0}
			<p class="text-muted-foreground">None yet. Search downloads a lexicon the first time it searches it, and keeps it for searching offline.</p>
		{:else}
			<ul class="grid gap-1">
				{#each packs as p (p.lexicon)}
					<li class="flex items-center justify-between gap-3">
						<span>{p.lexicon} <span class="text-muted-foreground">· {formatBytes(p.size)}{p.definitions ? ', with definitions' : ''}</span></span>
						<Button type="button" size="sm" variant="outline" onclick={() => remove(p.lexicon)}>Remove</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</Card.Content>
</Card.Root>
