<script lang="ts">
	// The Trash (PLAN.md § Trash), shown under the cascades on the Cascades page:
	// finished quizzes and trashed cascades, grouped by cascade and collapsed,
	// each group rendering its entries in pages of 100 behind Show more, since
	// one segmented attempt can leave tens of thousands. Entries show the final
	// score, cleared or replaced, and the date it will be deleted forever, or
	// "deleted forever 30 days after this syncs" while that date is provisional.
	// ("Purge" is the operation's name, never the page's word.) Everything in it
	// still counts toward the account's storage, and each entry says how much
	// Delete forever frees (PLAN.md § Storage limit). `version` is
	// bumped by the page when it moves something to the Trash; `onchange` runs
	// after a restore or a deletion, so the cascades above can refresh.
	import { Button } from '$lib/components/ui/button';
	import { canDeleteForever, PAGE, trashGroups, type TrashEntry, type TrashGroup } from '$lib/cascades/summary';
	import { formatBytes } from '$lib/cascades/storage';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import type { UserDb } from '$lib/local/db';
	import { getMeta } from '$lib/local/meta';
	import { afterLocalWrite, syncState } from '$lib/sync/runtime.svelte';
	import { confirmAction } from '$lib/confirm.svelte';

	let { db, version = 0, onchange = () => undefined }: { db: UserDb; version?: number; onchange?: () => unknown } = $props();

	let groups = $state<TrashGroup[]>([]);
	/** Read at least once: until then nothing says the Trash is empty. */
	let loaded = $state(false);
	let open = $state<Record<string, number>>({});
	let days = $state(30);

	async function refresh() {
		groups = await trashGroups(db);
		days = (await getMeta(db, 'server')).trash_retention_days;
		loaded = true;
	}

	$effect(() => {
		void syncState.changed.tick;
		void version;
		void refresh();
	});

	async function write(op: NewOp) {
		await applyLocally(db, op);
		afterLocalWrite();
		await refresh();
		await onchange();
	}

	function restore(e: TrashEntry) {
		const seed = new BigUint64Array(1);
		crypto.getRandomValues(seed);
		return e.kind === 'cascade'
			? write({ type: 'restore_cascade', cascade_id: e.id })
			: write({ type: 'restore_quiz', quiz_id: e.id, shuffle_seed: seed[0].toString() });
	}

	async function deleteForever(e: TrashEntry) {
		const what = e.kind === 'cascade' ? `“${e.cascade.name}” and everything in it` : `Level ${e.quiz!.level} of “${e.cascade.name}”`;
		const ok = await confirmAction({
			title: `Delete ${what} forever?`,
			body: `It cannot be restored or exported afterwards. This frees ${formatBytes(e.bytes)} of your storage.`,
			action: 'Delete forever',
			destructive: true
		});
		if (!ok) return;
		return e.kind === 'cascade'
			? write({ type: 'purge_cascade', cascade_id: e.id })
			: write({ type: 'purge_quiz', quiz_id: e.id });
	}

	const date = (iso: string) => new Date(iso).toLocaleDateString();
	// A group holding one entry is rendered expanded.
	const shown = (g: TrashGroup) => open[g.cascade.id] ?? (g.entries.length === 1 ? PAGE : 0);
	const total = $derived(groups.reduce((n, g) => n + g.bytes, 0));
</script>


<section id="trash" class="scroll-mt-6" aria-labelledby="trash-heading" data-loaded={loaded || undefined}>
	<div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4">
		<h2 id="trash-heading" class="text-xl font-semibold">Trash</h2>
		{#if groups.length}
			<p class="text-sm text-muted-foreground" data-trash-storage>The Trash holds {formatBytes(total)} of your storage.</p>
		{/if}
	</div>
	{#if loaded && groups.length === 0}<p class="text-muted-foreground">The Trash is empty.</p>{/if}
	<ul class="space-y-3">
		{#each groups as g (g.cascade.id)}
			{@const n = shown(g)}
			<li class="rounded-lg border p-4">
				<button class="flex w-full items-baseline justify-between text-left" onclick={() => (open[g.cascade.id] = n ? 0 : PAGE)}>
					<span class="font-medium">{g.trashed ? `${g.cascade.name} (cascade in the Trash)` : g.cascade.name}</span>
					<span class="text-sm text-muted-foreground">
						{`${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'} · ${formatBytes(g.bytes)}${g.earliest ? ` · deleted forever on ${date(g.earliest)}` : ''}`}
					</span>
				</button>
				{#if n}
					<ul class="mt-3 divide-y text-sm">
						{#each g.entries.slice(0, n) as e (e.id)}
							<li class="flex flex-wrap items-center gap-3 py-2">
								<span class="min-w-40">
									{e.kind === 'cascade' ? 'The whole cascade' : `Level ${e.quiz!.level} · ${e.quiz!.question_count}`}
								</span>
								{#if e.score !== null}<span>{e.score}% · {e.outcome === 'replaced' ? 'replaced' : 'cleared'}</span>{/if}
								<span class="text-muted-foreground">
									{#if e.provisional}deleted forever {days} days after this syncs{:else if e.purgesAt}deleted forever on {date(e.purgesAt)}{/if}
								</span>
								<span class="ml-auto flex gap-2">
									<Button size="sm" variant="outline" onclick={() => restore(e)}>Restore</Button>
									<Button size="sm" variant="outline" href={`/cascades/${g.cascade.id}/export${e.kind === 'quiz' ? `?quiz=${e.id}` : ''}`}>Export…</Button>
									{#if canDeleteForever(e)}
										<Button size="sm" variant="outline" onclick={() => deleteForever(e)}>Delete forever ({formatBytes(e.bytes)})</Button>
									{/if}
								</span>
								{#if g.notHere}<span class="w-full text-xs text-muted-foreground">Downloads when online.</span>{/if}
							</li>
						{/each}
					</ul>
					{#if g.entries.length > n}
						<Button size="sm" variant="ghost" onclick={() => (open[g.cascade.id] = n + PAGE)}>Show more</Button>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
</section>
