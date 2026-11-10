<script lang="ts">
	// The levels of a cascade (PLAN.md § Frontend → CascadeLadder): sizes,
	// passes, last scores, the current run of a segmented level, which level is
	// current, a pending level shown as "waiting for download", and per-level
	// Quiz options and Export… actions. The panel is a table, so every column
	// lines up; `compact` is a one-line-per-level list.
	import { compactItems, ladderItems, type LevelRow } from '$lib/player/ladder';

	let {
		rows,
		compact = false,
		onOptions,
		onExport
	}: {
		rows: LevelRow[];
		compact?: boolean;
		onOptions?: (row: LevelRow) => void;
		onExport?: (row: LevelRow) => void;
	} = $props();

	let expanded = $state(false);
	let items = $derived(compact ? compactItems(rows, expanded) : ladderItems(rows, expanded));
	let actions = $derived(!!onOptions || !!onExport);

	function status(r: LevelRow): string {
		if (r.downloading) return 'waiting for download';
		if (r.current) return r.run ? `now · ${r.run}` : 'now';
		return 'waiting';
	}
</script>

{#if compact}
	<ol class="space-y-1 text-sm" aria-label="Ladder">
		{#each items as item, i (item.kind === 'level' ? item.row.quiz.id : `more-${i}`)}
			{#if item.kind === 'more'}
				<li>
					<button class="text-muted-foreground underline" onclick={() => (expanded = true)}>+{item.count} more</button>
				</li>
			{:else}
				{@const r = item.row}
				<li class="flex items-baseline gap-2" class:font-semibold={r.current} data-level={r.level}>
					<span>Level {r.level}</span>
					<span class:text-muted-foreground={!r.current}>{status(r)}</span>
				</li>
			{/if}
		{/each}
	</ol>
{:else}
	<table class="w-full text-sm" aria-label="Ladder">
		<thead>
			<tr class="border-b text-left text-xs text-muted-foreground">
				<th class="py-1.5 pr-4 font-medium">Level</th>
				<th class="py-1.5 pr-4 text-right font-medium">Questions</th>
				<th class="py-1.5 pr-4 text-right font-medium">Pass</th>
				<th class="py-1.5 pr-4 text-right font-medium">Last pass</th>
				<th class="py-1.5 pr-4 font-medium">Status</th>
				{#if actions}<th class="py-1.5 font-medium"><span class="sr-only">Actions</span></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each items as item, i (item.kind === 'level' ? item.row.quiz.id : `more-${i}`)}
				{#if item.kind === 'more'}
					<tr>
						<td colspan={actions ? 6 : 5} class="py-1.5">
							<button class="text-muted-foreground underline" onclick={() => (expanded = true)}>Show more ({item.count} levels)</button>
						</td>
					</tr>
				{:else}
					{@const r = item.row}
					<tr class="border-b last:border-b-0" class:font-semibold={r.current} data-level={r.level}>
						<td class="py-1.5 pr-4 whitespace-nowrap">Level {r.level}</td>
						<td class="py-1.5 pr-4 text-right tabular-nums">{r.size}</td>
						<td class="py-1.5 pr-4 text-right tabular-nums">{r.attempt}</td>
						<td class="py-1.5 pr-4 text-right tabular-nums">{r.lastScore === null ? '—' : `${r.lastScore}%`}</td>
						<td class="py-1.5 pr-4" class:text-muted-foreground={!r.current}>{status(r)}</td>
						{#if actions}
							<td class="py-1.5 text-right whitespace-nowrap">
								{#if onOptions}<button class="underline" onclick={() => onOptions?.(r)}>Quiz options</button>{/if}
								{#if onExport}<button class="ml-3 underline" onclick={() => onExport?.(r)}>Export…</button>{/if}
							</td>
						{/if}
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
{/if}
