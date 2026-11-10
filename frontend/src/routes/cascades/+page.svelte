<script lang="ts">
	// The Cascades page (PLAN.md § Cascades page): newest activity first, each
	// with its options in short form, a compact ladder, Complete and offline
	// badges, and a row menu; the header shows the cascade limit and the sync
	// status. Everything reads the local stores and works offline.
	import CreatingCascade from '$lib/components/CreatingCascade.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import QuizOptionsForm from '$lib/components/QuizOptionsForm.svelte';
	import { Button } from '$lib/components/ui/button';
	import {
		allCascades,
		cascadeSummaries,
		keepHint,
		ladderText,
		type CascadeSummary
	} from '$lib/cascades/summary';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import { storeCreated, type Created } from '$lib/local/created';
	import type { UserDb } from '$lib/local/db';
	import { getMeta } from '$lib/local/meta';
	import { userDb } from '$lib/local/open';
	import { setKeepOffline } from '$lib/sync/keep';
	import { afterLocalWrite, downloadManager, syncState } from '$lib/sync/runtime.svelte';
	import { clampPrefill, type QuizOptions } from '$lib/options';

	let db = $state<UserDb | null>(null);
	let list = $state<CascadeSummary[]>([]);
	let count = $state(0);
	let opens = $state<Record<string, string>>({});
	/** Budget-dropped cascades: "kept automatically once opened" until they are opened again. */
	let dropped = $state<string[]>([]);
	let maxQuiz = $state(130_000);
	let editing = $state<{ id: string; count: number; options: QuizOptions } | null>(null);
	let error = $state<string | null>(null);
	let online = $state(true);
	/** No lexicon on the server: known only online, and asked only while there are no cascades. */
	let noCatalog = $state(false);

	async function refresh() {
		if (!db) return;
		online = navigator.onLine;
		list = await cascadeSummaries(db, online);
		count = (await allCascades(db)).length;
		opens = await getMeta(db, 'opens');
		dropped = await getMeta(db, 'budget_dropped');
	}

	onMount(() => {
		void (async () => {
			if (!session.userId) return;
			db = await userDb(session.userId, session.username);
			maxQuiz = (await getMeta(db, 'server')).max_quiz_questions;
			await refresh();
			if (list.length === 0 && navigator.onLine) {
				api
					.get<unknown[]>('/api/lexicons', { bindUser: false })
					.then((l) => (noCatalog = l.length === 0))
					.catch(() => undefined);
			}
		})();
		const on = () => void refresh();
		addEventListener('online', on);
		addEventListener('offline', on);
		return () => {
			removeEventListener('online', on);
			removeEventListener('offline', on);
		};
	});

	// Syncs and downloads change what is shown.
	$effect(() => {
		void syncState.changed.tick;
		void syncState.progress;
		void refresh();
	});

	async function write(op: NewOp) {
		if (!db) return;
		await applyLocally(db, op);
		afterLocalWrite();
		await refresh();
	}

	function editOptions(s: CascadeSummary) {
		const c = s.cascade;
		editing = {
			id: c.id,
			count: c.question_count,
			options: { segment_size: clampPrefill(c.segment_size, maxQuiz), progression: c.progression, require_alphabetical: c.require_alphabetical }
		};
	}

	async function saveOptions() {
		if (!editing) return;
		const c = list.find((s) => s.cascade.id === editing!.id)!.cascade;
		const op: Record<string, unknown> = { type: 'set_cascade_options', cascade_id: c.id };
		if (editing.options.segment_size !== c.segment_size) op.segment_size = editing.options.segment_size;
		if (editing.options.progression !== c.progression) op.progression = editing.options.progression;
		if (editing.options.require_alphabetical !== c.require_alphabetical) op.require_alphabetical = editing.options.require_alphabetical;
		if (Object.keys(op).length > 2) await write(op as unknown as NewOp);
		editing = null;
	}

	let starting = $state<{ stage: 'server' | 'device'; progress: number; count: number | null } | null>(null);

	async function startOver(s: CascadeSummary) {
		if (!db) return;
		error = null;
		starting = { stage: 'server', progress: 0, count: null };
		const { device_id } = await getMeta(db, 'device');
		const body = { id: crypto.randomUUID(), source_quiz_id: crypto.randomUUID(), device_id, at: new Date().toISOString() };
		try {
			const created = await api.post<Created>(`/api/cascades/${s.cascade.id}/start-over`, body);
			starting = { stage: 'device', progress: 0, count: Number(created.source_quiz.question_count) };
			await storeCreated(db, created, new Date(), (f) => starting && (starting.progress = f));
			await goto(`/cascades/${body.id}`);
		} catch {
			error = 'Start over needs a connection.';
		} finally {
			starting = null;
		}
	}

	async function toggleKeep(s: CascadeSummary, on: boolean) {
		if (!db) return;
		await setKeepOffline(db, s.cascade.id, on, downloadManager());
		await refresh();
	}

	function badge(s: CascadeSummary): string {
		switch (s.offline) {
			case 'available':
				return 'Available offline';
			case 'downloading':
				return `Downloading ${s.progress}%`;
			case 'answers_need_connection':
				return 'Answers need a connection';
			default:
				return 'Not downloaded on this device, open to download';
		}
	}
</script>

<main class="mx-auto max-w-4xl p-6">
	<header class="mb-6 flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold">Cascades</h1>
			<p class="text-sm text-muted-foreground">{count} of {session.cascadeLimit} cascades</p>
		</div>
		<div class="flex items-center gap-4">
			{#if count >= session.cascadeLimit}
				<span class="text-sm">At the limit — <a class="underline" href="/trash">Trash</a></span>
			{:else}
				<Button href="/cascades/new">New cascade</Button>
			{/if}
		</div>
	</header>
	{#if error}<p class="mb-4 text-sm text-destructive" role="alert">{error}</p>{/if}
	{#if list.length === 0}
		{#if noCatalog}
			<!-- Nothing to build from yet: say so, and where to fix it. -->
			<p class="text-muted-foreground">
				There are no word lists yet.
				{#if session.isAdmin}Upload a letter distribution, a lexicon and its leave values in <a class="underline" href="/admin">Admin</a>.{:else}An admin has to upload a lexicon first.{/if}
			</p>
		{:else}
			<p class="text-muted-foreground">No cascades yet. <a class="underline" href="/cascades/new">Create one</a>.</p>
		{/if}
	{/if}
	<!-- One row per cascade: what it is and where it stands, its status, and its actions. -->
	<ul class="divide-y rounded-lg border">
		{#each list as s (s.cascade.id)}
			{@const hint = keepHint(s, !!opens[s.cascade.id] && !dropped.includes(s.cascade.id))}
			<li class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 md:flex-nowrap">
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 items-baseline gap-2">
						<a class="min-w-0 truncate font-medium underline-offset-2 hover:underline" href={`/cascades/${s.cascade.id}`} title={s.cascade.name}>{s.cascade.name}</a>
						<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{s.cascade.quiz_type.replace('_', ' ')} · {s.cascade.lexicon} · clear at {s.cascade.clear_threshold}%{#if s.options} · {s.options}{/if}
						</span>
					</div>
					<p class="truncate text-xs text-muted-foreground" title={ladderText(s.levels)}>{ladderText(s.levels)}</p>
				</div>
				<!-- Status, Keep offline and the actions stay together on the right; the text beside them truncates. -->
				<div class="flex shrink-0 items-center gap-3">
				<div class="flex items-center gap-2 text-xs">
					{#if s.completedAt}<span class="rounded bg-muted px-2 py-0.5">Complete {new Date(s.completedAt).toLocaleDateString()}</span>{/if}
					<span class="rounded bg-muted px-2 py-0.5">{badge(s)}</span>
				</div>
				<label class="flex items-center gap-1.5 text-xs">
					Keep offline{#if hint}<span class="text-muted-foreground">{` (${hint})`}</span>{/if}
					<input type="checkbox" checked={s.keptByUser || s.keptAutomatically} onchange={(e) => toggleKeep(s, e.currentTarget.checked)} />
				</label>
				<div class="flex items-center">
					<Button size="icon-sm" variant="ghost" onclick={() => editOptions(s)} aria-label="Quiz options" title="Quiz options">
						<SlidersHorizontalIcon class="size-4" />
					</Button>
					<Button size="icon-sm" variant="ghost" href={`/cascades/${s.cascade.id}/export`} aria-label="Export…" title="Export…">
						<DownloadIcon class="size-4" />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						disabled={count >= session.cascadeLimit}
						onclick={() => startOver(s)}
						aria-label="Start over"
						title={count >= session.cascadeLimit ? 'Start over: at the cascade limit' : 'Start over'}
					>
						<RotateCcwIcon class="size-4" />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						class="hover:text-destructive"
						onclick={() => write({ type: 'trash_cascade', cascade_id: s.cascade.id })}
						aria-label="Move to Trash"
						title="Move to Trash"
					>
						<TrashIcon class="size-4" />
					</Button>
				</div>
				</div>
			</li>
		{/each}
	</ul>
</main>

{#if editing}
	<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/30" role="presentation">
		<div class="w-full max-w-md space-y-4 rounded-lg bg-background p-6" role="dialog" aria-label="Quiz options">
			<h2 class="text-lg font-semibold">Quiz options for new quizzes</h2>
			<QuizOptionsForm bind:options={editing.options} questionCount={editing.count} maxQuizQuestions={maxQuiz} editing="cascade" />
			<div class="flex gap-2">
				<Button onclick={saveOptions}>Save</Button>
				<Button variant="outline" onclick={() => (editing = null)}>Cancel</Button>
			</div>
		</div>
	</div>
{/if}

{#if starting}
	<CreatingCascade title="Starting over" stage={starting.stage} progress={starting.progress} count={starting.count} />
{/if}
