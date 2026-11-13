<script lang="ts">
	// Catalog overview with delete actions (PLAN.md § Admin). Admins only;
	// the API answers 404 to everyone else, and so does this page.
	import { confirmAction } from '$lib/confirm.svelte';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { api, ApiError } from '$lib/api';
	import { formatBytes } from '$lib/cascades/storage';
	import NotFound from '$lib/components/NotFound.svelte';

	interface Item {
		id: number;
		name?: string;
		lexicon?: string;
		letter_distribution?: string;
		uploaded_by: string | null;
		uploaded_at: string;
		loading: boolean;
		loaded_by: string[];
		tile_count?: number;
		word_count?: number;
		leave_count?: number;
		lexicon_count?: number;
		cascade_count?: number;
		has_leave_set?: boolean;
		/** A lexicon's: 1 as uploaded, raised by each replacement of its definitions. */
		definitions_revision?: number;
		/** Everything the server keeps for it: its rows and their indexes, and its in-memory index. */
		storage_bytes: number;
		index_bytes?: number | null;
		build_ms?: number | null;
	}
	interface Catalog {
		instance_id: string;
		instances: { instance_id: string; heartbeat_at: string }[];
		letter_distributions: Item[];
		lexicons: Item[];
		leave_sets: Item[];
	}

	let catalog = $state<Catalog | null>(null);
	let notFound = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		try {
			catalog = await api.get<Catalog>('/api/admin/catalog');
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else error = 'Could not load the catalog.';
		}
	}

	onMount(load);

	async function remove(kind: string, id: number, label: string) {
		const ok = await confirmAction({ title: `Delete ${label}?`, body: 'This cannot be undone.', action: 'Delete', destructive: true });
		if (!ok) return;
		error = null;
		try {
			await api.delete(`/api/admin/${kind}/${id}`);
		} catch (e) {
			error = e instanceof ApiError && e.status === 409 ? `${label} is still in use.` : 'Delete failed.';
		}
		await load();
	}

	const when = (s: string) => new Date(s).toLocaleString();
	// The in-memory part, on hover: what the task's memory is sized from.
	function storageTitle(i: Item): string | undefined {
		if (i.index_bytes == null) return undefined;
		const built = i.build_ms != null ? `, built in ${i.build_ms} ms` : '';
		return `${formatBytes(i.storage_bytes - i.index_bytes)} in the database, ${formatBytes(i.index_bytes)} in memory${built}`;
	}

	function lexiconBlocker(l: Item): string | null {
		const parts = [];
		if (l.has_leave_set) parts.push('it has leave values');
		if (l.cascade_count) parts.push(l.cascade_count === 1 ? '1 cascade uses it' : `${l.cascade_count} cascades use it`);
		return parts.length ? `In use: ${parts.join(' and ')}.` : null;
	}

	interface Col {
		head: string;
		cell: (i: Item) => string;
		title?: (i: Item) => string | undefined;
	}
	interface Section {
		kind: string;
		title: string;
		/** What its Upload button uploads, for its accessible name. */
		noun: string;
		items: Item[];
		name: (i: Item) => string;
		/** Named in the delete confirmation. */
		label: (i: Item) => string;
		cols: Col[];
		blocker: (i: Item) => string | null;
		/** A second action beside Upload. */
		also?: { href: string; label: string };
	}

	const uploaded: Col = { head: 'Uploaded', cell: (i) => `${when(i.uploaded_at)} by ${i.uploaded_by ?? 'a deleted user'}` };
	const storage: Col = { head: 'Storage', cell: (i) => formatBytes(i.storage_bytes), title: storageTitle };
	const count = (n: number | undefined) => n?.toLocaleString() ?? '';

	// The three kinds, each a table on a wide screen and a list of entries on a phone,
	// so nothing scrolls sideways.
	const sections = $derived<Section[]>(
		catalog
			? [
					{
						kind: 'letter-distributions',
						title: 'Letter distributions',
						noun: 'distribution',
						items: catalog.letter_distributions,
						name: (d) => d.name ?? '',
						label: (d) => d.name ?? '',
						cols: [{ head: 'Tiles', cell: (d) => count(d.tile_count) }, uploaded, { head: 'Lexicons', cell: (d) => count(d.lexicon_count) }, storage],
						blocker: (d) => (d.lexicon_count ? 'In use: lexicons refer to it.' : null)
					},
					{
						kind: 'lexicons',
						title: 'Lexicons',
						noun: 'lexicon',
						items: catalog.lexicons,
						name: (l) => l.name ?? '',
						label: (l) => l.name ?? '',
						cols: [
							{ head: 'Distribution', cell: (l) => l.letter_distribution ?? '' },
							{ head: 'Words', cell: (l) => count(l.word_count) },
							{ head: 'Definitions', cell: (l) => (l.definitions_revision === 1 ? 'as uploaded' : `revision ${l.definitions_revision}`) },
							uploaded,
							{ head: 'Cascades', cell: (l) => count(l.cascade_count) },
							storage
						],
						blocker: lexiconBlocker,
						also: { href: '/admin/lexicons/definitions', label: 'Replace definitions' }
					},
					{
						kind: 'leave-sets',
						title: 'Leave values',
						noun: 'leave values',
						items: catalog.leave_sets,
						name: (s) => s.lexicon ?? '',
						label: (s) => `the leave values ${s.name} of ${s.lexicon}`,
						cols: [{ head: 'Name', cell: (s) => s.name ?? '' }, { head: 'Leaves', cell: (s) => count(s.leave_count) }, uploaded, { head: 'Cascades', cell: (s) => count(s.cascade_count) }, storage],
						blocker: (s) => (s.cascade_count ? 'In use: Leave Value cascades refer to it.' : null)
					}
				]
			: []
	);
</script>

{#snippet named(sec: Section, i: Item)}
	{sec.name(i)}
	{#if i.loading}<Badge variant="secondary">loading</Badge>{/if}
{/snippet}

{#snippet del(sec: Section, i: Item)}
	{@const blocker = sec.blocker(i)}
	<Button size="sm" variant="destructive" disabled={!!blocker} title={blocker ?? undefined} onclick={() => remove(sec.kind, i.id, sec.label(i))}>Delete</Button>
{/snippet}

{#if notFound}
	<NotFound />
{:else}
	<main class="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6">
		<h1 class="text-2xl font-semibold">Catalog</h1>
		{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
		{#if catalog}
			<p class="text-sm text-muted-foreground">
				{catalog.instances.length} live instance{catalog.instances.length === 1 ? '' : 's'}. An
				item marked <em>loading</em> is not yet indexed by every instance, and is not offered in
				the cascade builder until it is.
			</p>

			{#each sections as sec (sec.kind)}
				<Card.Root>
					<Card.Header>
						<Card.Title>{sec.title}</Card.Title>
						<Card.Action class="flex flex-wrap justify-end gap-2">
							{#if sec.also && sec.items.length}
								<Button href={sec.also.href} variant="outline" size="sm">{sec.also.label}</Button>
							{/if}
							<Button href={`/admin/${sec.kind}/new`} variant="outline" size="sm" aria-label={`Upload ${sec.noun}`}>Upload</Button>
						</Card.Action>
					</Card.Header>
					<Card.Content>
						{#if sec.items.length === 0}<p class="text-sm text-muted-foreground">None yet.</p>{/if}
						<!-- A phone: one entry each, its figures listed under its name. -->
						<ul class="divide-y sm:hidden">
							{#each sec.items as i (i.id)}
								{@const blocker = sec.blocker(i)}
								<li class="grid gap-2 py-3 first:pt-0 last:pb-0">
									<div class="flex items-center justify-between gap-3">
										<span class="min-w-0 font-medium break-words">{@render named(sec, i)}</span>
										{@render del(sec, i)}
									</div>
									<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
										{#each sec.cols as c (c.head)}
											<dt class="text-muted-foreground">{c.head}</dt>
											<dd class="min-w-0 break-words" title={c.title?.(i)}>{c.cell(i)}</dd>
										{/each}
									</dl>
									{#if blocker}<p class="text-xs text-muted-foreground">{blocker}</p>{/if}
								</li>
							{/each}
						</ul>
						{#if sec.items.length}
							<div class="max-sm:hidden">
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head>{sec.kind === 'leave-sets' ? 'Lexicon' : 'Name'}</Table.Head>
											{#each sec.cols as c (c.head)}<Table.Head>{c.head}</Table.Head>{/each}
											<Table.Head></Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each sec.items as i (i.id)}
											{@const blocker = sec.blocker(i)}
											<Table.Row>
												<Table.Cell>{@render named(sec, i)}</Table.Cell>
												{#each sec.cols as c (c.head)}<Table.Cell title={c.title?.(i)}>{c.cell(i)}</Table.Cell>{/each}
												<Table.Cell class="text-right">
													{@render del(sec, i)}
													{#if blocker}<p class="mt-1 text-xs text-muted-foreground">{blocker}</p>{/if}
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}

			<Card.Root>
				<Card.Header><Card.Title>Instances</Card.Title></Card.Header>
				<Card.Content>
					<ul class="text-sm">
						{#each catalog.instances as i (i.instance_id)}
							<li class="break-all">
								<code>{i.instance_id}</code>{i.instance_id === catalog.instance_id ? ' (this one)' : ''}
								— heartbeat {when(i.heartbeat_at)}
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>
		{/if}
	</main>
{/if}
