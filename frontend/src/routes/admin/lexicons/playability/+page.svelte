<script lang="ts">
	// Replacing a lexicon's playability values (PLAN.md § Immutability and deletion →
	// Replacing definitions, playabilities and leave values): the words and their
	// definitions stay, and the two playability filters rank by the new values.
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
			<Card.Title>Replace a lexicon’s playability values</Card.Title>
			<Card.Description>
				The lexicon’s own file with new playability values: tab-separated word, playability,
				definition. It must hold exactly the lexicon’s words with the same definitions, in any
				order; only playabilities may differ. To change definitions, use
				<a class="underline" href="/admin/lexicons/definitions">Replace definitions</a>.
			</Card.Description>
			<Card.Description>
				Existing cascades keep their questions: a cascade’s questions are fixed when it is created.
				Saved searches and new cascades that use Playability Order or Limit by Playability Order
				return different words from then on. Duplicate cascade, in a cascade’s Settings, picks its
				questions again.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<UploadForm path={`/api/admin/lexicons/${lexicon ?? 0}/playability`} accept=".tsv,.txt,text/tab-separated-values" fields={() => ({})}>
				<div class="grid gap-1.5">
					<Label for="lexicon">Lexicon</Label>
					<select id="lexicon" class="h-9 rounded-md border bg-transparent px-3 text-sm" bind:value={lexicon}>
						{#each catalog?.lexicons ?? [] as l (l.id)}
							<option value={l.id}>{l.name}</option>
						{/each}
					</select>
				</div>
				{#snippet created(item)}
					<strong>{item.name}</strong>: {Number(item.playabilities_changed).toLocaleString()} of
					{Number(item.word_count).toLocaleString()} playability values changed. This is revision
					{item.playability_revision} of its playability values. Searches rank by them once every
					server has rebuilt the lexicon’s index.
				{/snippet}
			</UploadForm>
		</Card.Content>
	</Card.Root>
</main>
