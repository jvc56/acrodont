<script lang="ts">
	// Search (PLAN.md § Search page): the builder's lexicon select and filter
	// rows, listing the words that match instead of making a cascade, as
	// Zyzzyva's Search tab does. It searches on this device, in a worker running
	// the server's own engine, so once a lexicon is here it works offline. The
	// same view is the /search page and the player's Search (Q), and both show
	// the one remembered search.
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import FilterGroup from '$lib/components/builder/FilterGroup.svelte';
	import ResultList from './ResultList.svelte';
	import DownloadMenu from './DownloadMenu.svelte';
	import { api, ApiError } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { sendWithRetry } from '$lib/builder/create';
	import { changeLexicon, changeQuizType, fromWire, nodeAt, rows, saveBlocker, toWire, type RowState } from '$lib/builder/form';
	import { parseTree, QUIZ_TYPE_LABELS, summaryName, type CeilingContext, type LexiconInfo, type QuizType } from '$lib/filters';
	import { confirmAction } from '$lib/confirm.svelte';
	import type { UserDb } from '$lib/local/db';
	import { userDb } from '$lib/local/open';
	import { formatBytes } from '$lib/cascades/storage';
	import { searchEngine } from '$lib/search/engine.svelte';
	import { distributionFor, lexiconList } from '$lib/search/packs';
	import type { Sort } from '$lib/search/protocol';
	import { handToBuilder, searchState } from '$lib/search/state.svelte';
	import { Distribution } from '$lib/tiles';

	let {
		cascadeLexicon = null,
		onclose = null,
		closeHint = '',
		active = true
	}: {
		/** Opened from a quiz: its cascade's lexicon, which Search switches to. */
		cascadeLexicon?: string | null;
		/** Opened from a quiz: back to it. */
		onclose?: (() => void) | null;
		/** The keys that close it, for the button's title. */
		closeHint?: string;
		/** Shown: the player keeps Search mounted while the quiz is in front. */
		active?: boolean;
	} = $props();

	const QUIZ: QuizType = 'definition';
	const SORTS: [Sort, string][] = [
		['alphagram', 'Alphagram'],
		['alphabetical', 'Alphabetical'],
		['probability', 'Probability'],
		['playability', 'Playability'],
		['length', 'Length']
	];

	let db = $state<UserDb | null>(null);
	let lexicons = $state<LexiconInfo[]>([]);
	let online = $state(true);
	let dist = $state<Distribution | null>(null);
	let distFor = '';
	let loadError = $state<string | null>(null);
	let root: HTMLElement | undefined = $state();

	let info = $derived(lexicons.find((l) => l.name === searchState.lexicon));
	let ctx = $derived<CeilingContext | null>(info && dist ? { quizType: QUIZ, lexicon: info, maxTileValue: dist.maxValue } : null);
	let wire = $derived(toWire(searchState.root, QUIZ, dist, ctx));
	let lexState = $derived(info ? searchEngine.lexicons[info.name] : undefined);
	// The engine's state is read so this follows the lexicon becoming ready.
	let ready = $derived.by(() => {
		void lexState;
		return !!info && searchEngine.ready(info.name);
	});

	/** A row with nothing typed in it yet: unfinished rather than wrong, so it shows no error. */
	function blank(r: RowState): boolean {
		switch (r.type) {
			case 'anagram_match':
			case 'pattern_match':
			case 'subanagram_match':
				return r.pattern.trim() === '';
			case 'includes_letters':
			case 'takes_prefix':
			case 'takes_suffix':
			case 'consists_of':
				return r.tiles.trim() === '';
			case 'definition':
				return r.text.trim() === '';
			case 'in_lexicon':
				return r.lexicon === '';
			case 'in_word_list':
				return r.entries.length === 0;
			default:
				return false;
		}
	}
	let blanks = $derived(new Set([...rows(searchState.root)].filter(blank).map((r) => r.key)));

	/** The rows' errors: the form's, and the engine's mapped from paths to rows; none for a blank row. */
	let errors = $derived.by(() => {
		const m = new Map([...wire.errors].filter(([k]) => !blanks.has(k)));
		for (const e of searchEngine.failure?.errors ?? []) {
			const n = nodeAt(searchState.root, e.path);
			if (n && !m.has(n.key) && !blanks.has(n.key)) m.set(n.key, e.message);
		}
		return m;
	});

	const DEFINITION_TYPES = new Set(['definition', 'part_of_speech', 'root_word']);
	/** Definitions are fetched only once something reads them (PLAN.md § Search page, D3). */
	let needDefinitions = $derived(searchState.columns.definition || [...rows(searchState.root)].some((r) => DEFINITION_TYPES.has(r.type)));

	onMount(async () => {
		if (!session.userId) return;
		const d = await userDb(session.userId, session.username);
		await searchState.load(d);
		const list = await lexiconList(d);
		lexicons = list.lexicons;
		online = list.online;
		if (!lexicons.length) loadError = online ? 'There are no lexicons yet.' : 'Search needs a connection once, to list the lexicons.';
		const want = cascadeLexicon && lexicons.some((l) => l.name === cascadeLexicon) ? cascadeLexicon : searchState.lexicon;
		setLexicon(lexicons.some((l) => l.name === want) ? want : (lexicons[0]?.name ?? ''));
		db = d;
	});

	// Straight to typing whenever it is shown: the first box of the first row.
	$effect(() => {
		if (!active || !db) return;
		void tick().then(() => root?.querySelector<HTMLInputElement>('[data-row-key] input:not([type=checkbox])')?.focus());
	});

	// Opened from a quiz of another lexicon, Search takes the quiz's.
	$effect(() => {
		const want = cascadeLexicon;
		if (active && want && lexicons.some((l) => l.name === want)) setLexicon(want);
	});

	function setLexicon(name: string) {
		if (name && name !== searchState.lexicon) changeLexicon(searchState.root, lexicons, name);
		searchState.lexicon = name;
	}

	// The lexicon's distribution, from the device when it has it.
	$effect(() => {
		const i = info;
		if (!i || !db || distFor === i.letter_distribution) return;
		distFor = i.letter_distribution;
		dist = null;
		distributionFor(db, i.letter_distribution).then(
			(d) => (dist = new Distribution(d.name, d.tiles)),
			() => {
				distFor = '';
				loadError = 'Search needs a connection once, to get this lexicon’s letters.';
			}
		);
	});

	/** Something to search for: until then a lexicon is only read back, never downloaded. */
	let started = $derived([...rows(searchState.root)].some((r) => !blanks.has(r.key)));

	// The lexicon in the worker, with its definitions once something reads them.
	// Downloaded only once a row has something in it, so opening Search, or
	// passing through a lexicon on the way to another, fetches nothing.
	$effect(() => {
		const i = info;
		const defs = needDefinitions;
		const download = started;
		if (!i || !db) return;
		void searchEngine.ensure(db, i, { definitions: defs, download }).catch(() => {});
	});

	// Searching as the filters change, 150 ms after the last change.
	let lastQuery = '';
	let lastSort: Sort | null = null;
	$effect(() => {
		const i = info;
		const sort = searchState.sort;
		const tree = wire.tree;
		const bad = wire.errors.size > 0;
		const isReady = ready;
		// Read so a lexicon becoming ready, or its definitions arriving, searches again.
		void searchEngine.lexicons[i?.name ?? ''];
		if (!i || !isReady || !dist) return;
		if (bad) {
			// Unfinished or wrong: the last result stays, dimmed.
			lastQuery = '';
			return;
		}
		const query = JSON.stringify([i.name, tree, searchEngine.ready(i.name, true)]);
		if (query === lastQuery && sort !== lastSort && searchEngine.result) {
			lastSort = sort;
			void searchEngine.sort(sort);
			return;
		}
		if (query === lastQuery) return;
		const t = setTimeout(() => {
			lastQuery = query;
			lastSort = sort;
			void searchEngine.search(i.name, tree, sort);
		}, 150);
		return () => clearTimeout(t);
	});

	// Kept 300 ms after each change, for the next visit and a reload.
	$effect(() => {
		void JSON.stringify(searchState.snapshot());
		if (db) searchState.saveSoon(db);
	});

	let status = $derived.by((): { text: string; tone: 'muted' | 'error' } | null => {
		if (!info) return null;
		const s = lexState;
		const mb = (n: number) => formatBytes(n);
		if (s?.kind === 'downloading') {
			return { text: s.part === 'core' ? `Downloading ${info.name} for searching: ${mb(s.received)}` : `Downloading ${info.name}’s definitions: ${mb(s.received)}`, tone: 'muted' };
		}
		if (s?.kind === 'preparing') return { text: `Preparing ${info.name} for searching…`, tone: 'muted' };
		if (s?.kind === 'offline') return { text: `Search needs ${info.name} on this device. Connect once to download it.`, tone: 'error' };
		if (s?.kind === 'failed') return { text: s.message, tone: 'error' };
		if (s?.kind === 'ready' && needDefinitions && !s.definitions && !online) return { text: `${info.name}’s definitions need a connection once.`, tone: 'muted' };
		return null;
	});

	let anyBlank = $derived(blanks.size > 0);
	let shownResult = $derived(searchEngine.result && searchEngine.result.lexicon === info?.name ? searchEngine.result : null);
	let dimmed = $derived(wire.errors.size > 0 || searchEngine.searching);

	function filename(ext: 'txt' | 'csv'): string {
		const base = summaryName(searchState.lexicon, wire.tree).replace(/[^A-Za-z0-9 ._-]/gu, '_');
		return `${[...base].slice(0, 100).join('')}.${ext}`;
	}

	async function definitionsReady(): Promise<boolean> {
		if (!info || !db) return false;
		try {
			await searchEngine.ensure(db, info, { definitions: true });
			return searchEngine.ready(info.name, true);
		} catch {
			return false;
		}
	}

	function newCascade() {
		handToBuilder(searchState.lexicon, searchState.root);
		void goto('/cascades/new');
	}

	// Save Search… and Load Search…, as the builder has them: online only.
	let saveOpen = $state(false);
	let saveName = $state('');
	let saveMessage = $state<string | null>(null);
	let saveBusy = $state(false);
	let blocker = $derived(saveBlocker(searchState.root, wire.errors));

	async function save(overwrite = false, id = crypto.randomUUID()) {
		saveMessage = null;
		const body = { id, name: saveName, quiz_type: QUIZ, filters: wire.tree, overwrite };
		try {
			await sendWithRetry(() => api.post('/api/searches', body), { onBusy: (b) => (saveBusy = b) });
			saveOpen = false;
		} catch (e) {
			if (e instanceof ApiError && e.code === 'name_taken') {
				const ok = await confirmAction({
					title: `Replace your saved search “${saveName}”?`,
					body: 'The search saved under this name is replaced by this one.',
					action: 'Replace'
				});
				if (ok) await save(true, id);
			} else if (e instanceof ApiError && e.code === 'storage_limit') {
				const b = e.body as { used: number; limit: number; needed: number };
				saveMessage = `This search needs about ${formatBytes(b.needed)} of storage, and ${formatBytes(Math.max(0, b.limit - b.used))} is free.`;
			} else if (e instanceof ApiError && e.status === 400) {
				saveMessage = (e.body as { errors?: { message: string }[] })?.errors?.map((x) => x.message).join(' ') ?? 'Invalid.';
			} else saveMessage = 'Saving a search needs a connection.';
		}
	}

	interface SavedSummary {
		id: string;
		name: string;
		quiz_type: QuizType;
		word_list_entries: number;
	}
	let loadOpen = $state(false);
	let saved = $state<SavedSummary[]>([]);
	let loadMessage = $state<string | null>(null);

	async function openLoad() {
		loadOpen = true;
		loadMessage = null;
		try {
			saved = await api.get<SavedSummary[]>('/api/searches');
		} catch {
			loadMessage = 'Loading a saved search needs a connection.';
		}
	}

	async function load(s: SavedSummary) {
		loadMessage = 'Loading…';
		try {
			const full = await sendWithRetry(() => api.get<{ quiz_type: QuizType; filters: unknown }>(`/api/searches/${s.id}`));
			const loaded = fromWire(parseTree(full.filters), full.quiz_type);
			// Rows a list of words cannot have (Leave Value) are flagged, as the builder flags them.
			changeQuizType(loaded, QUIZ);
			changeLexicon(loaded, lexicons, searchState.lexicon);
			searchState.root = loaded;
			loadOpen = false;
		} catch {
			loadMessage = 'Could not load that search.';
		}
	}
</script>

<section bind:this={root} class="flex h-full min-h-0 flex-col gap-3" aria-label="Search" data-search>
	<header class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold">Search</h1>
		<div class="flex flex-wrap items-center gap-2">
			<Button type="button" size="sm" variant="outline" onclick={openLoad}>Load Search…</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onclick={() => {
					saveMessage = blocker;
					saveOpen = true;
				}}>Save Search…</Button
			>
			<Button type="button" size="sm" variant="ghost" onclick={() => searchState.reset()} title="Back to one empty Anagram Match row">Clear</Button>
			{#if onclose}
				<Button type="button" size="sm" onclick={onclose} title={closeHint} data-search-close>Back to the quiz</Button>
			{/if}
		</div>
	</header>
	{#if loadError}<p class="text-sm text-destructive">{loadError}</p>{/if}

	<div class="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr] sm:items-center">
		<Label for="search-lexicon">Lexicon</Label>
		<select
			id="search-lexicon"
			class="h-9 w-full rounded-md border bg-transparent px-2 text-sm sm:w-60"
			value={searchState.lexicon}
			onchange={(e) => setLexicon(e.currentTarget.value)}
		>
			{#each lexicons as l (l.name)}<option value={l.name}>{l.name}</option>{/each}
		</select>
	</div>
	{#if status}<p class="text-sm {status.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}" role="status" data-search-status>{status.text}</p>{/if}

	<div class="max-h-[45%] shrink-0 overflow-y-auto">
		<FilterGroup
			group={searchState.root}
			root={searchState.root}
			top
			quizType={QUIZ}
			{ctx}
			{dist}
			{lexicons}
			lexicon={searchState.lexicon}
			{errors}
			defaultType="length"
		/>
	</div>

	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
		<p aria-live="polite" data-search-count>
			{#if shownResult}
				<span class="text-base font-medium">{shownResult.count.toLocaleString()} {shownResult.count === 1 ? 'word' : 'words'}</span>
				<span class="text-muted-foreground">· {shownResult.ms} ms</span>
			{/if}
			{#if searchEngine.failure?.too_broad}
				<span class="text-destructive">This search is too broad to finish in time. Narrow it.</span>
			{:else if searchEngine.failure?.message && !searchEngine.failure.errors}
				<span class="text-destructive">{searchEngine.failure.message}</span>
			{:else if anyBlank && !shownResult}
				<span class="text-muted-foreground">Fill in each row to search.</span>
			{/if}
		</p>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<label class="flex items-center gap-1">
				Order
				<select class="h-8 rounded-md border bg-transparent px-1" bind:value={searchState.sort} data-search-sort>
					{#each SORTS as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</label>
			<span class="flex flex-wrap items-center gap-x-2" role="group" aria-label="Columns">
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={searchState.columns.probability} /> Probability</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={searchState.columns.hooks} /> Hooks</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={searchState.columns.definition} /> Definitions</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={searchState.columns.playability} /> Playability</label>
			</span>
			<DownloadMenu {filename} disabled={!shownResult || shownResult.count === 0} onneeddefinitions={definitionsReady} />
			<Button type="button" size="sm" variant="outline" onclick={newCascade} disabled={wire.errors.size > 0}>New cascade from this search</Button>
		</div>
	</div>

	{#if shownResult}
		<ResultList
			result={shownResult}
			columns={searchState.columns}
			sort={searchState.sort}
			{dimmed}
			scrollTop={searchState.scrollTop}
			onscroll={(t) => (searchState.scrollTop = t)}
		/>
	{/if}
</section>

<Dialog.Root bind:open={saveOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Save Search</Dialog.Title>
			<Dialog.Description>Saves the filters only, never the results, so they work with any lexicon.</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-2">
			<Input bind:value={saveName} placeholder="Name" maxlength={100} />
			{#if saveMessage}<p class="text-sm text-destructive">{saveMessage}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button type="button" onclick={() => save()} disabled={!!blocker || !saveName.trim() || saveBusy}>{saveBusy ? 'the server is busy' : 'Save'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={loadOpen}>
	<Dialog.Content>
		<Dialog.Header><Dialog.Title>Load Search</Dialog.Title></Dialog.Header>
		{#if loadMessage}<p class="text-sm">{loadMessage}</p>{/if}
		<ul class="grid max-h-96 gap-1 overflow-auto">
			{#each saved as s (s.id)}
				<li>
					<button type="button" class="w-full rounded px-2 py-1 text-left hover:bg-accent" onclick={() => load(s)}>
						{s.name}
						<span class="text-xs text-muted-foreground">· {QUIZ_TYPE_LABELS[s.quiz_type]}</span>
					</button>
				</li>
			{:else}
				<li class="text-sm text-muted-foreground">No saved searches yet.</li>
			{/each}
		</ul>
	</Dialog.Content>
</Dialog.Root>
