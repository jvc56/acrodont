<script lang="ts">
	// The Search page's list (PLAN.md § Search page → The page): one row per
	// word, laid out like an answer row — probability order, front hooks, the
	// word with its inner-hook dots, back hooks, definition — with each set of
	// anagrams banded in alphagram order. Only the rows in view are drawn, and
	// they come from the worker a page at a time, so a whole lexicon scrolls
	// like twenty words.
	import TileText from '$lib/components/TileText.svelte';
	import { searchEngine, type SearchResult } from '$lib/search/engine.svelte';
	import type { ResultRow, Sort } from '$lib/search/protocol';
	import type { Columns } from '$lib/search/state.svelte';
	import { onMount } from 'svelte';

	let {
		result,
		columns,
		sort,
		dimmed = false,
		scrollTop = 0,
		onscroll
	}: {
		result: SearchResult;
		columns: Columns;
		sort: Sort;
		dimmed?: boolean;
		/** Where to start, for coming back to the same place. */
		scrollTop?: number;
		onscroll?: (top: number) => void;
	} = $props();

	const PAGE = 200;
	const OVERSCAN = 10;
	let box: HTMLDivElement | undefined = $state();
	let top = $state(0);
	let height = $state(600);
	/** Two lines a row on a narrow screen: the definition goes under the word. */
	let narrow = $state(false);
	let rowHeight = $derived(narrow && columns.definition ? 52 : 34);
	let pages = $state<Map<number, ResultRow[]>>(new Map());
	let pending = new Set<number>();
	let shownVersion = 0;

	onMount(() => {
		const mq = window.matchMedia('(max-width: 639px)');
		narrow = mq.matches;
		const onChange = () => (narrow = mq.matches);
		mq.addEventListener('change', onChange);
		const ro = new ResizeObserver(() => (height = box?.clientHeight ?? height));
		if (box) {
			ro.observe(box);
			box.scrollTop = scrollTop;
			top = scrollTop;
		}
		return () => {
			mq.removeEventListener('change', onChange);
			ro.disconnect();
		};
	});

	// A new result (or order) starts from the top with nothing fetched.
	$effect(() => {
		const v = result.version;
		if (v === shownVersion) return;
		const first = shownVersion === 0;
		shownVersion = v;
		pages = new Map();
		pending = new Set();
		if (!first && box) {
			box.scrollTop = 0;
			top = 0;
			onscroll?.(0);
		}
	});

	let first = $derived(Math.max(0, Math.floor(top / rowHeight) - OVERSCAN));
	let last = $derived(Math.min(result.count, Math.ceil((top + height) / rowHeight) + OVERSCAN));

	$effect(() => {
		const version = result.version;
		for (let p = Math.floor(first / PAGE); p * PAGE < last; p++) {
			if (pages.has(p) || pending.has(p)) continue;
			pending.add(p);
			void searchEngine.rows(version, p * PAGE, PAGE).then((rows) => {
				pending.delete(p);
				if (!rows || version !== result.version) return;
				pages = new Map(pages).set(p, rows);
			});
		}
	});

	function rowAt(i: number): ResultRow | undefined {
		return pages.get(Math.floor(i / PAGE))?.[i % PAGE];
	}

	let visible = $derived(Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k));
</script>

<div
	bind:this={box}
	class="relative min-h-0 flex-1 overflow-y-auto rounded-md border {dimmed ? 'opacity-50' : ''}"
	onscroll={() => {
		top = box?.scrollTop ?? 0;
		onscroll?.(top);
	}}
	role="list"
	aria-label="Results"
	data-results
>
	<div style={`height: ${result.count * rowHeight}px; position: relative;`}>
		{#each visible as i (i)}
			{@const r = rowAt(i)}
			<div
				role="listitem"
				class="absolute inset-x-0 grid items-center gap-x-3 px-3 text-sm {r?.band && sort === 'alphagram'
					? 'bg-muted/50'
					: ''} {narrow && columns.definition ? 'grid-rows-2 content-center gap-y-0.5' : ''}"
				style={`top: ${i * rowHeight}px; height: ${rowHeight}px; grid-template-columns: ${[
					columns.probability ? '4.5rem' : '',
					columns.hooks ? 'minmax(2.5rem, auto)' : '',
					'auto',
					columns.hooks ? 'minmax(2.5rem, auto)' : '',
					columns.playability ? '4.5rem' : '',
					columns.definition && !narrow ? 'minmax(0, 1fr)' : ''
				]
					.filter(Boolean)
					.join(' ')};`}
				data-result-row={i}
			>
				{#if r}
					{#if columns.probability}<span class="text-right text-muted-foreground tabular-nums" title="Probability order">{r.probability_order}</span>{/if}
					{#if columns.hooks}<span class="text-right whitespace-nowrap" data-result-hooks="front"><TileText text={r.front_hooks} lower /></span>{/if}
					<span class="font-semibold whitespace-nowrap tracking-wide" data-result-word={r.word}>
						{#if columns.hooks}<span class:invisible={!r.front_inner} aria-hidden={!r.front_inner}>·</span>{/if}<TileText
							text={r.word}
						/>{#if columns.hooks}<span class:invisible={!r.back_inner} aria-hidden={!r.back_inner}>·</span>{/if}
					</span>
					{#if columns.hooks}<span class="whitespace-nowrap" data-result-hooks="back"><TileText text={r.back_hooks} lower /></span>{/if}
					{#if columns.playability}<span class="text-right text-muted-foreground tabular-nums" title="Playability order">{r.playability_order}</span>{/if}
					{#if columns.definition}
						<span
							class="min-w-0 truncate text-muted-foreground {narrow ? 'col-span-full' : ''}"
							title={r.definition}
							data-result-definition>{r.definition}</span
						>
					{/if}
				{:else}
					<span class="col-span-full h-3 w-24 animate-pulse rounded bg-muted"></span>
				{/if}
			</div>
		{/each}
	</div>
</div>
