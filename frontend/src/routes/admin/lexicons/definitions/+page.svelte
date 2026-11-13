<script lang="ts">
	// Replacing a lexicon's definitions (PLAN.md § Immutability and deletion →
	// Replacing definitions and leave values): the one part of an uploaded lexicon that can change.
	import { onMount } from 'svelte';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import UploadForm from '$lib/components/admin/UploadForm.svelte';
	import { loadAdminCatalog, type AdminCatalog } from '$lib/admin/catalog';

	let lexicon = $state<number | null>(null);
	let catalog = $state<AdminCatalog | null>(null);

	onMount(async () => {
		catalog = await loadAdminCatalog();
		lexicon = catalog.lexicons[0]?.id ?? null;
	});
</script>

<main class="mx-auto grid max-w-2xl gap-4 p-6">
	<a class="text-sm underline" href="/admin">← Catalog</a>
	<Card.Root>
		<Card.Header>
			<Card.Title>Replace a lexicon’s definitions</Card.Title>
			<Card.Description>
				The lexicon’s own file with corrected definitions: tab-separated word, playability,
				definition. It must hold exactly the lexicon’s words with the same playabilities, in any
				order; only definitions may differ. Every cascade on the lexicon then shows the new
				definitions, on each device once it has synced. A cascade keeps the questions it was
				created with, even where a Definition or Part of Speech filter would now match differently.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<UploadForm path={`/api/admin/lexicons/${lexicon ?? 0}/definitions`} accept=".tsv,.txt,text/tab-separated-values" fields={() => ({})}>
				<div class="grid gap-1.5">
					<Label for="lexicon">Lexicon</Label>
					<select id="lexicon" class="h-9 rounded-md border bg-transparent px-3 text-sm" bind:value={lexicon}>
						{#each catalog?.lexicons ?? [] as l (l.id)}
							<option value={l.id}>{l.name}</option>
						{/each}
					</select>
				</div>
				{#snippet created(item)}
					<strong>{item.name}</strong>: {Number(item.definitions_changed).toLocaleString()} of
					{Number(item.word_count).toLocaleString()} definitions changed. This is revision
					{item.definitions_revision} of its definitions.
				{/snippet}
			</UploadForm>
		</Card.Content>
	</Card.Root>
</main>
