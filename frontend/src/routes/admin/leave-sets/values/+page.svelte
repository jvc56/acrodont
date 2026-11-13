<script lang="ts">
	// Replacing a leave value set's values (PLAN.md § Immutability and deletion →
	// Replacing definitions and leave values): the leaves stay, their values change.
	import { onMount } from 'svelte';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import UploadForm from '$lib/components/admin/UploadForm.svelte';
	import { loadAdminCatalog, type AdminCatalog } from '$lib/admin/catalog';

	let set = $state<number | null>(null);
	let catalog = $state<AdminCatalog | null>(null);

	onMount(async () => {
		catalog = await loadAdminCatalog();
		set = catalog.leave_sets[0]?.id ?? null;
	});
</script>

<main class="mx-auto grid max-w-2xl gap-4 p-6">
	<a class="text-sm underline" href="/admin">← Catalog</a>
	<Card.Root>
		<Card.Header>
			<Card.Title>Replace a lexicon’s leave values</Card.Title>
			<Card.Description>
				The lexicon’s leave values file with new values: comma-separated leave, value. It must hold
				exactly the leaves the lexicon’s set holds, in any order; only values may differ. Every Leave Value
				cascade on the lexicon then shows the new values, on each device once it has synced. A
				cascade keeps the questions it was created with, even where a Leave Value filter would now
				match differently; Start over picks the questions again.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<UploadForm path={`/api/admin/leave-sets/${set ?? 0}/values`} accept=".csv,text/csv" fields={() => ({})}>
				<div class="grid gap-1.5">
					<Label for="lexicon">Lexicon</Label>
					<select id="lexicon" class="h-9 rounded-md border bg-transparent px-3 text-sm" bind:value={set}>
						{#each catalog?.leave_sets ?? [] as s (s.id)}
							<option value={s.id}>{s.lexicon}</option>
						{/each}
					</select>
				</div>
				{#snippet created(item)}
					<strong>{item.lexicon}</strong>: {Number(item.values_changed).toLocaleString()} of
					{Number(item.leave_count).toLocaleString()} values changed. This is revision
					{item.values_revision} of its leave values.
				{/snippet}
			</UploadForm>
		</Card.Content>
	</Card.Root>
</main>
