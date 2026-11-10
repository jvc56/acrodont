<script lang="ts">
	// The player for the cascade's deepest level (PLAN.md § Taking a quiz):
	// for a fine pointer at least 900 px wide, a hideable menu on the left, the
	// quiz area with the question at the top, and a status bar along the bottom;
	// tap zones otherwise. The three actions from mouse, wheel, keys and taps;
	// typed mode; the settings dialog with preferences, this device's display
	// and this quiz's options; banners, the completion screen, and a trashed
	// cascade's Restore.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import CascadeLadder from '$lib/components/CascadeLadder.svelte';
	import QuizOptionsForm from '$lib/components/QuizOptionsForm.svelte';
	import SyncStatus from '$lib/components/SyncStatus.svelte';
	import TileText from '$lib/components/TileText.svelte';
	import AnswerView from '$lib/components/player/AnswerView.svelte';
	import DisplaySettings from '$lib/components/player/DisplaySettings.svelte';
	import CreatingCascade from '$lib/components/CreatingCascade.svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { display, textStyle } from '$lib/player/display.svelte';
	import { runIndicator, runIndicatorText } from '$lib/cascade/rules';
	import { applyLocally, quizState, type NewOp } from '$lib/local/apply';
	import { storeCreated, type Created } from '$lib/local/created';
	import type { UserDb } from '$lib/local/db';
	import { getMeta, recordOpen } from '$lib/local/meta';
	import { userDb } from '$lib/local/open';
	import { defaultPreferences, preferencesView } from '$lib/local/preferences';
	import type { AttemptRow, PreferencesRow } from '$lib/local/rows';
	import type { RwTx } from '$lib/local/view';
	import { PLAYER_LOCK } from '$lib/sync/downloads';
	import { afterLocalWrite, ensureCascade, fetchAhead, fetchCard, playerActs, syncState } from '$lib/sync/runtime.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PanelBottomCloseIcon from '@lucide/svelte/icons/panel-bottom-close';
	import PanelBottomOpenIcon from '@lucide/svelte/icons/panel-bottom-open';
	import { actionFor, Debounce, inputOwns, keyStroke, mouseStroke, wheelStroke, type Action } from '$lib/player/bindings';
	import { Player, type PlayerView } from '$lib/player/controller';
	import { levelRows, type LevelRow } from '$lib/player/ladder';
	import type { QuizOptions } from '$lib/options';

	const id = $derived(page.params.id as string);

	let db = $state<UserDb | null>(null);
	let player = $state<Player | null>(null);
	let v = $state<PlayerView | null>(null);
	let prefs = $state<PreferencesRow>(defaultPreferences());
	let attempts = $state<AttemptRow[]>([]);
	let desktop = $state(true);
	let landscape = $state(false);
	let settingsOpen = $state(false);
	let typedText = $state('');
	let typedInput = $state<HTMLInputElement | null>(null);
	let typedFocused = $state(false);
	let quizOptions = $state<QuizOptions | null>(null);
	let maxQuiz = $state(130_000);

	// The repeat guard is a setting on this device (display.repeat_guard_ms), read on every press.
	const actions = new Debounce(() => display.value.repeat_guard_ms);
	const wheel = new Debounce(150);

	let rows = $derived<LevelRow[]>(v?.cascade ? levelRows(v.quizzes, v.cascade.depth, attempts) : []);
	let run = $derived.by(() => {
		if (!v?.quiz) return null;
		const ri = runIndicator(quizState(v.quiz));
		return ri ? runIndicatorText(ri) : null;
	});
	let dsp = $derived(display.value);
	/** How far through the pass the current card is, for the status bar's line. */
	let progress = $derived(v?.quiz ? (((v.card?.pos ?? v.quiz.cursor) + 1) / Math.max(1, v.quiz.question_count)) * 100 : 0);
	/** Of the level's questions, the share graded in this pass; of those, the share correct. */
	let gradedPct = $derived(v?.quiz ? ((v.quiz.correct_count + v.quiz.missed_count) / Math.max(1, v.quiz.question_count)) * 100 : 0);
	let correctPct = $derived(
		v?.quiz && v.quiz.correct_count + v.quiz.missed_count > 0
			? (v.quiz.correct_count / (v.quiz.correct_count + v.quiz.missed_count)) * 100
			: null
	);
	/** A percentage to two decimal places, rounded. */
	const pct = (p: number) => `${p.toFixed(2)}%`;
	/** Whether the share correct so far would clear the level: green on track, red not; nothing before a grade. */
	let onTrack = $derived(correctPct === null || !v?.cascade ? null : correctPct >= v.cascade.clear_threshold);
	/** The grade the quiz area's border shows once the answer is shown; none before. */
	let gradeState = $derived(v?.status === 'ready' && v.card?.revealed ? v.card.grade : null);
	// Each grade's border is a setting: by default a missed answer shows red and a correct one nothing.
	let gradeBorder = $derived(
		gradeState === 'correct' && dsp.border_correct
			? 'border-green-600'
			: gradeState === 'missed' && dsp.border_missed
				? 'border-red-600'
				: 'border-transparent'
	);
	/** The menu beside the quiz: hidden whenever a cascade opens, shown for this visit by ☰. */
	let menuOpen = $state(false);

	async function refreshSide() {
		if (!db) return;
		prefs = await preferencesView(db);
		attempts = await db.getAllFromIndex('quiz_attempts', 'cascade_id', id);
	}

	onMount(() => {
		const fine = matchMedia('(pointer: fine) and (min-width: 900px)');
		const land = matchMedia('(orientation: landscape)');
		const layout = () => {
			desktop = fine.matches;
			landscape = land.matches;
		};
		layout();
		fine.addEventListener('change', layout);
		land.addEventListener('change', layout);
		let release: (() => void) | null = null;
		let unsub: (() => void) | null = null;
		let cancelled = false;
		(async () => {
			if (!session.userId) return;
			const d = await userDb(session.userId, session.username);
			if (cancelled) return;
			db = d;
			maxQuiz = (await getMeta(d, 'server')).max_quiz_questions;
			await display.load(d);
			// Navigating to the player is an open (§ Downloads).
			const tx = d.transaction(['meta'], 'readwrite');
			await recordOpen(tx as unknown as RwTx, id, new Date().toISOString());
			await tx.done;
			// Each player tab holds a Web Lock named for its cascade, so no drop pass takes it.
			if (navigator.locks) {
				void navigator.locks.request(PLAYER_LOCK + id, () => new Promise<void>((r) => (release = r)));
			}
			syncState.openCascade = id;
			const p = new Player(d, id, {
				prefs: () => preferencesView(d),
				ensure: (cid) => ensureCascade(d, cid),
				fetchCard: (cid, idx, ahead) => fetchCard(d, cid, idx, ahead),
				fetchAhead: (cid, idx) => fetchAhead(d, cid, idx),
				afterWrite: () => {
					afterLocalWrite();
					void refreshSide();
				}
			});
			unsub = p.subscribe((x) => (v = x));
			player = p;
			await refreshSide();
			await p.load();
		})();
		return () => {
			cancelled = true;
			fine.removeEventListener('change', layout);
			land.removeEventListener('change', layout);
			unsub?.();
			release?.();
			if (syncState.openCascade === id) syncState.openCascade = null;
		};
	});

	// Step 5 of the rebase: refresh if what the player shows changed.
	$effect(() => {
		const c = syncState.changed;
		if (c.tick && player && c.ids.includes(id)) {
			void refreshSide();
			void player.load(true);
		}
	});

	// A download made progress: the card takes what it lacked.
	$effect(() => {
		if (syncState.progress && player) void player.refreshCard();
	});

	/**
	 * An action from a key, a click, the wheel or a tap. Never dropped and never
	 * waited on: the player takes actions in order and changes the screen before
	 * its writes are saved (PLAN.md § Taking a quiz → Instant at any size).
	 */
	function act(a: Action) {
		if (!player || !actions.pass(a, performance.now())) return;
		const card = v?.card;
		// Before the reveal, Show / Next on a typed card focuses the input instead of giving up.
		if (a === 'show_next' && card?.typed && !card.revealed && !typedFocused) {
			typedInput?.focus();
			return;
		}
		const p = player;
		if (a !== 'toggle_grade') typedText = '';
		if (a === 'toggle_grade') navigator.vibrate?.(15);
		// Background downloads start no chunk while the action and its writes run.
		void playerActs(async () => {
			if (a === 'show_next') await p.showNext();
			else if (a === 'toggle_grade') await p.toggle();
			else await p.previous();
		}).catch((e) => console.error('player action failed', e));
	}


	function onKey(e: KeyboardEvent) {
		if (settingsOpen) {
			if (e.key === 'Escape') settingsOpen = false;
			return;
		}
		if (!v || v.status !== 'ready') return;
		const t = e.target as HTMLElement | null;
		const inTyped = t === typedInput;
		// Text fields outside the quiz area keep their keys.
		if (!inTyped && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		if (inTyped && inputOwns(e)) return;
		const a = actionFor(prefs.bindings, keyStroke(e));
		if (!a) return;
		e.preventDefault();
		void act(a);
	}

	function onMouse(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('input,button,a')) return;
		const s = mouseStroke(e);
		if (!s) return;
		e.preventDefault();
		const a = actionFor(prefs.bindings, s);
		if (a) void act(a);
	}

	function onWheel(e: WheelEvent) {
		const s = wheelStroke(e);
		if (!s) return;
		const a = actionFor(prefs.bindings, s);
		if (!a) return; // an unbound direction scrolls as usual
		e.preventDefault();
		if (wheel.pass(s.code, performance.now())) void act(a);
	}

	async function onTypedKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !player) return;
		e.preventDefault();
		const text = typedText;
		const r = await player.enter(text);
		if (r && (r.kind === 'found' || r.kind === 'out_of_order' || r.kind === 'already' || r.kind === 'wrong')) typedText = '';
		if (r?.kind === 'empty') typedText = '';
	}

	async function write(op: NewOp) {
		if (!db) return;
		await applyLocally(db, op);
		afterLocalWrite();
		await refreshSide();
		await player?.load(true);
	}

	async function setPref(field: string, value: unknown) {
		// Definitions or hooks change what an answer holds: the cards in memory go first.
		if (field === 'anagram_show_definitions' || field === 'anagram_show_hooks') player?.prefsChanged();
		await write({ type: 'set_preferences', [field]: value } as NewOp);
		if (field === 'anagram_answer_mode') await player?.modeChanged();
	}

	function openSettings() {
		const q = v?.quiz;
		if (q) {
			quizOptions = {
				segment_size: q.segment_size,
				progression: q.progression,
				require_alphabetical: q.require_alphabetical
			};
		}
		settingsOpen = true;
	}

	async function saveQuizOptions() {
		const q = v?.quiz;
		if (!q || !quizOptions) return;
		const op: Record<string, unknown> = { type: 'set_quiz_options', quiz_id: q.id };
		if (quizOptions.segment_size !== q.segment_size) op.segment_size = quizOptions.segment_size;
		if (quizOptions.progression !== q.progression) op.progression = quizOptions.progression;
		if (quizOptions.require_alphabetical !== q.require_alphabetical) op.require_alphabetical = quizOptions.require_alphabetical;
		if (Object.keys(op).length > 2) await write(op as unknown as NewOp);
		settingsOpen = false;
	}

	async function restore() {
		await write({ type: 'restore_cascade', cascade_id: id });
	}

	async function moveToTrash() {
		await write({ type: 'trash_cascade', cascade_id: id });
		await goto('/cascades');
	}

	let starting = $state<{ stage: 'server' | 'device'; progress: number; count: number | null } | null>(null);

	async function startOver() {
		if (!db || !session.userId) return;
		const { device_id } = await getMeta(db, 'device');
		const body = { id: crypto.randomUUID(), source_quiz_id: crypto.randomUUID(), device_id, at: new Date().toISOString() };
		starting = { stage: 'server', progress: 0, count: null };
		try {
			const created = await api.post<Created>(`/api/cascades/${id}/start-over`, body);
			starting = { stage: 'device', progress: 0, count: Number(created.source_quiz.question_count) };
			await storeCreated(db, created, new Date(), (f) => starting && (starting.progress = f));
			await goto(`/cascades/${body.id}`);
		} finally {
			starting = null;
		}
	}

	function keepStudying() {
		player?.dismissCompletion();
	}
</script>

<svelte:window onkeydown={onKey} />

{#snippet waiting(text: string, detail: string | null = null)}
	<div class="flex flex-col items-center gap-3 text-muted-foreground" role="status" aria-busy="true">
		<LoaderCircleIcon class="size-8 animate-spin" aria-hidden="true" />
		<p>{text}</p>
		{#if detail}<p class="max-w-sm text-center text-sm">{detail}</p>{/if}
	</div>
{/snippet}

{#snippet question()}
	{#if v?.fetchingCard}
		{@render waiting('Loading the next questions…')}
	{:else if v?.card}
		{@const card = v.card}
		{#if card.key === null}
			<p class="text-center text-muted-foreground">This question needs a connection.</p>
		{:else}
			<div class="text-center font-semibold" style={textStyle(dsp.question_font, dsp.question_size_px, dsp.question_spacing)} data-question><TileText text={card.key} /></div>
			{#if card.typed && !card.revealed}
				<div class="mx-auto mt-6 max-w-sm space-y-2">
					<p class="text-center text-sm text-muted-foreground">
						{card.typed.found.length} of {player?.words(card).length ?? 0} found
					</p>
					<input
						bind:this={typedInput}
						bind:value={typedText}
						onkeydown={onTypedKey}
						onfocus={() => (typedFocused = true)}
						onblur={() => (typedFocused = false)}
						class="w-full rounded-md border px-3 py-2 text-center uppercase"
						aria-label="Type an answer"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
					/>
					{#if card.note}<p class="text-center text-sm text-muted-foreground">{card.note}</p>{/if}
					{#if v.quiz?.require_alphabetical && card.typed.found.length}
						<p class="text-center text-xs text-muted-foreground">after {card.typed.found.at(-1)}</p>
					{/if}
					<ul class="flex flex-wrap justify-center gap-2 text-sm">
						{#each card.typed.found as w (w)}<li><TileText text={w} /></li>{/each}
					</ul>
					<ul class="flex flex-wrap justify-center gap-2 text-sm text-destructive">
						{#each card.typed.wrong as w, i (i)}<li>{w}</li>{/each}
					</ul>
				</div>
			{/if}
			{#if card.revealed}
				<div class="mt-6">
					{#if card.answer === null}
						<p class="text-center text-muted-foreground">Answer needs a connection.</p>
					{:else}
						<AnswerView
								quizType={v.cascade!.quiz_type}
								answer={card.answer}
								{prefs}
								found={card.typed?.found ?? null}
								font={dsp.answer_font}
								size={dsp.answer_size_px}
								spacing={dsp.answer_spacing}
								definition={{ font: dsp.definition_font, size: dsp.definition_size_px, spacing: dsp.definition_spacing }}
								word={card.word}
							/>
					{/if}
				</div>
				<!-- The grade is the quiz area's border colour; this says it for screen readers. -->
				<p class="sr-only" role="status">{card.grade === 'correct' ? 'Correct' : 'Missed'}</p>
			{/if}
		{/if}
		{#if v.distributionMissing}
			<p class="mt-2 text-center text-sm text-muted-foreground">Typed mode needs a connection for this cascade’s tiles.</p>
		{/if}
		{#if v.message}
			<p class="mt-4 text-center text-sm text-muted-foreground" role="status">{v.message}</p>
		{/if}
		{#if v.storage}
			<div class="mt-2 text-center text-sm">
				Free space by turning Keep offline off or removing another account’s data on the
				<a class="underline" href="/account">Account page</a>.
				<Button size="sm" variant="outline" onclick={() => player?.retryStorage()}>Try again</Button>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet status()}
	{#if !v || v.status === 'loading'}
		{@render waiting('Loading…')}
	{:else if v.status === 'downloading'}
		{@render waiting('Getting this level ready…', 'Its questions are downloading to this device. You can start as soon as they are here.')}
	{:else if v.status === 'needs_connection'}
		<p class="text-muted-foreground">This cascade needs a connection to download.</p>
	{:else if v.status === 'gone'}
		<p class="text-muted-foreground">This cascade is not on this device.</p>
		<Button href="/cascades" variant="outline" class="mt-4">Cascades</Button>
	{:else if v.status === 'trashed'}
		<p>This cascade is in the Trash.</p>
		<Button class="mt-4" onclick={restore}>Restore</Button>
		<div class="mt-6"><CascadeLadder {rows} /></div>
	{/if}
{/snippet}

{#snippet levels()}
	<Popover.Root>
		<Popover.Trigger class="rounded px-2 py-1 text-left hover:bg-muted">Levels</Popover.Trigger>
		<Popover.Content side="right" align="start" class="w-[30rem] max-w-[90vw]">
			{#if v?.cascade}
				<p class="mb-3 text-sm text-muted-foreground">
					A level clears when a pass ends with at least <span class="font-medium text-foreground">{v.cascade.clear_threshold}%</span> correct.
				</p>
			{/if}
			<CascadeLadder {rows} onExport={(r) => goto(`/cascades/${id}/export?quiz=${r.quiz.id}`)} />
		</Popover.Content>
	</Popover.Root>
{/snippet}

{#if desktop}
	<div class="flex h-screen">
		{#if menuOpen}
			<nav class="flex w-48 shrink-0 flex-col gap-1 border-r p-4 text-sm" aria-label="Player menu">
				<div class="mb-2 flex items-center justify-between">
					<a href="/cascades" class="font-semibold">Wordfall</a>
					<button class="rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onclick={() => (menuOpen = false)} aria-label="Hide menu" title="Hide menu">«</button>
				</div>
				<a class="rounded px-2 py-1 hover:bg-muted" href="/cascades">Cascades</a>
				<a class="rounded px-2 py-1 hover:bg-muted" href="/cascades/new">New cascade</a>
				<a class="rounded px-2 py-1 hover:bg-muted" href="/trash">Trash</a>
				{#if session.isAdmin}<a class="rounded px-2 py-1 hover:bg-muted" href="/admin">Admin</a>{/if}
				<a class="rounded px-2 py-1 hover:bg-muted" href="/account">Account</a>
				<button class="rounded px-2 py-1 text-left hover:bg-muted" onclick={openSettings}>Preferences</button>
				{#if v?.quiz && v.cascade}{@render levels()}{/if}
			</nav>
		{/if}
		<div class="relative flex min-w-0 flex-1 flex-col">
			<!-- The quiz area: the only place mouse controls act; no selection, no context menu.
			     The question sits at the top, so revealing the answer never moves it. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				role="application"
				class="relative flex flex-1 flex-col items-center overflow-y-auto px-8 pb-8 select-none {gradeBorder}"
				style={`padding-top: ${dsp.question_top_px}px; border-width: ${dsp.border_px}px; border-style: solid;`}
				data-grade={gradeState ?? undefined}
				aria-label="Quiz area"
				onmousedown={(e) => e.button === 1 && e.preventDefault()}
				onmouseup={onMouse}
				oncontextmenu={(e) => e.preventDefault()}
				onauxclick={(e) => e.preventDefault()}
				onwheel={onWheel}
			>
				{#if !menuOpen}
					<button class="absolute top-3 left-3 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" onclick={() => (menuOpen = true)} aria-label="Show menu" title="Show menu">☰</button>
				{/if}
				{#if v?.banner}<p class="absolute bottom-4 max-w-[70%] rounded-md bg-muted px-4 py-2 text-center text-sm" role="status">{v.banner}</p>{/if}
				<div class="w-full max-w-4xl">
					{#if v?.status === 'ready'}{@render question()}{:else}<div class="text-center">{@render status()}</div>{/if}
				</div>
			</div>
			{#if !dsp.status_bar_hidden}
			<footer class="shrink-0 border-t text-sm">
				<div class="h-0.5 bg-muted" aria-hidden="true"><div class="h-full bg-foreground/50" style={`width: ${progress}%`}></div></div>
				<div class="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-1 py-2 pr-6 pl-3">
					<button
						class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						onclick={() => display.set({ status_bar_hidden: true })}
						aria-label="Hide status bar"
						title="Hide status bar"><PanelBottomCloseIcon class="size-4" /></button
					>
					{#if v?.quiz && v.cascade}
						<p class="font-medium">Level {v.quiz.level} of {v.cascade.depth}</p>
						<p class="text-muted-foreground">Pass {v.quiz.attempt}</p>
						<p title="The card shown, and the share of the level graded in this pass">
							<!-- The count in its own element, apart from its percentage: it is read on its own. -->
							<span>{(v.card?.pos ?? v.quiz.cursor) + 1} / {v.quiz.question_count}</span>
							<span class="text-muted-foreground">({pct(gradedPct)})</span>
						</p>
						<p title={`Correct and missed in this pass, and the share correct: the level clears at ${v.cascade.clear_threshold}%`}>
							<span>{v.quiz.correct_count} ✓ {v.quiz.missed_count} ✗</span>
							{#if correctPct !== null}
								<span class:text-green-600={onTrack} class:text-red-600={onTrack === false} data-on-track={onTrack}>({pct(correctPct)})</span>
							{/if}
						</p>
						{#if run}<p class="text-muted-foreground">{run}</p>{/if}
					{/if}
					<div class="ml-auto"><SyncStatus /></div>
				</div>
			</footer>
			{:else}
				<!-- The status bar hidden: its Show button and the sync status keep the bottom corners, outside the quiz area. -->
				<button
					class="absolute bottom-2 left-3 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					onclick={() => display.set({ status_bar_hidden: false })}
					aria-label="Show status bar"
					title="Show status bar"><PanelBottomOpenIcon class="size-4" /></button
				>
				<div class="pointer-events-none absolute right-6 bottom-2"><div class="pointer-events-auto"><SyncStatus /></div></div>
			{/if}
		</div>
	</div>
{:else}
	<div class="flex h-screen flex-col">
		<header class="flex items-center justify-between border-b px-3 py-2 text-sm">
			<a href="/cascades" aria-label="Menu">☰</a>
			<span>
				{#if v?.quiz && v.cascade}
					L{v.quiz.level} · {(v.card?.pos ?? v.quiz.cursor) + 1}/{v.quiz.question_count} · {v.cascade.clear_threshold}%{#if run} · {run}{/if}
				{/if}
			</span>
			<button onclick={openSettings} aria-label="Settings">⚙</button>
		</header>
		{#if v?.status === 'ready'}
			<div class="relative flex flex-1 select-none" class:flex-col={!landscape} style="touch-action: manipulation">
				{#if v.banner}<p class="absolute top-2 left-2 right-2 z-10 rounded-md bg-muted px-3 py-2 text-sm" role="status">{v.banner}</p>{/if}
				<button class="text-muted-foreground" style={landscape ? 'width:20%' : 'height:15%'} onclick={() => act('previous')}>↶ Previous</button>
				<div
					class="overflow-y-auto p-4 {gradeBorder}"
					style={`${landscape ? 'width:55%' : 'height:60%'}; border-width: ${dsp.border_px}px; border-style: solid;`}
					data-grade={gradeState ?? undefined}
					role="button"
					tabindex="0"
					onclick={(e) => !(e.target as HTMLElement).closest('input,button,a') && act('show_next')}
					onkeydown={() => undefined}
				>
					{@render question()}
				</div>
				<button class="text-muted-foreground" style={landscape ? 'width:25%' : 'height:25%'} onclick={() => act('toggle_grade')}>✓ ⇄ ✗ Toggle</button>
				{#if typedFocused}
					<!-- The on-screen keyboard covers the zones: three buttons sit above it. -->
					<div class="fixed right-0 bottom-0 left-0 flex justify-around border-t bg-background p-2">
						<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('previous')}>Previous</Button>
						<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('show_next')}>Show / Next</Button>
						<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('toggle_grade')}>Toggle</Button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="p-6">{@render status()}</div>
		{/if}
	</div>
{/if}

{#if settingsOpen}
	<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="presentation" onclick={() => (settingsOpen = false)}>
		<div
			class="max-h-full w-full max-w-lg space-y-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg"
			role="dialog"
			aria-label="Settings"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.key === 'Escape' && (settingsOpen = false)}
		>
			<h2 class="text-lg font-semibold">Preferences</h2>
			<SettingRow label="Show definitions with anagrams" for="player-definitions">
				<input id="player-definitions" type="checkbox" checked={prefs.anagram_show_definitions} onchange={(e) => setPref('anagram_show_definitions', e.currentTarget.checked)} />
			</SettingRow>
			<SettingRow label="Show hooks with anagrams" for="player-hooks">
				<input id="player-hooks" type="checkbox" checked={prefs.anagram_show_hooks} onchange={(e) => setPref('anagram_show_hooks', e.currentTarget.checked)} />
			</SettingRow>
			<SettingRow label="Anagram answer mode" for="player-mode">
				<select id="player-mode" class="rounded border bg-background px-2 py-1" value={prefs.anagram_answer_mode} onchange={(e) => setPref('anagram_answer_mode', e.currentTarget.value)}>
					<option value="flashcard">Flashcard</option>
					<option value="typed">Typed</option>
				</select>
			</SettingRow>
			<SettingRow label="Leave value decimal places" for="player-decimals">
				<select id="player-decimals" class="rounded border bg-background px-2 py-1" value={String(prefs.leave_value_decimals)} onchange={(e) => setPref('leave_value_decimals', Number(e.currentTarget.value))}>
					{#each [0, 1, 2, 3] as d (d)}<option value={String(d)}>{d}</option>{/each}
				</select>
			</SettingRow>
			<p class="text-sm"><a class="underline" href="/account#controls">Controls</a> are edited on the Account page.</p>
			<h2 class="pt-4 text-lg font-semibold">On this device</h2>
			<DisplaySettings />
			{#if v?.quiz && quizOptions}
				<h2 class="pt-4 text-lg font-semibold">This quiz’s options</h2>
				<QuizOptionsForm
					bind:options={quizOptions}
					questionCount={v.quiz.question_count}
					maxQuizQuestions={maxQuiz}
					editing="quiz"
					segmentChain={v.quiz.segment_chain}
					source={v.quiz.origin === 'source'}
					showAlphabetical={v.cascade?.quiz_type === 'anagram'}
				/>
				<Button onclick={saveQuizOptions}>Save options</Button>
			{/if}
			<Button variant="outline" onclick={() => (settingsOpen = false)}>Close</Button>
		</div>
	</div>
{/if}

{#if v?.completion}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
		<div class="max-w-sm space-y-4 rounded-lg bg-background p-6 text-center" role="dialog" aria-label="Cascade complete">
			<h2 class="text-xl font-semibold">Cascade complete</h2>
			<p>After {v.completion.levels} levels and {v.completion.attempts} {v.completion.attempts === 1 ? 'pass' : 'passes'}.</p>
			<div class="flex flex-col gap-2">
				<Button onclick={keepStudying}>Keep studying</Button>
				<Button variant="outline" onclick={startOver}>Start over</Button>
				<Button variant="outline" onclick={moveToTrash}>Move to Trash</Button>
			</div>
		</div>
	</div>
{/if}

{#if starting}
	<CreatingCascade title="Starting over" stage={starting.stage} progress={starting.progress} count={starting.count} />
{/if}
