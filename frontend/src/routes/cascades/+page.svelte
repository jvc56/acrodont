<script lang="ts">
	// The Cascades page (PLAN.md § Cascades page): newest activity first, one
	// row each for a glance — its options in short form, a compact ladder with
	// the current level's progress, how much storage it holds, whether it is on
	// this device, and Move to Trash; the rest (quiz options, Export…, Start
	// over) is in the player. The header shows the account's storage against
	// its one limit (PLAN.md § Storage limit). The Trash is under the cascades, so
	// they are seen together. Everything reads the local stores and works offline.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Button } from '$lib/components/ui/button';
	import TrashList from '$lib/components/TrashList.svelte';
	import { tick } from 'svelte';
	import { cascadeSummaries, ladderText, type CascadeSummary } from '$lib/cascades/summary';
	import { DEFAULT_STORAGE_LIMIT, formatBytes, levelBytes, storageState } from '$lib/cascades/storage';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import { confirmAction } from '$lib/confirm.svelte';
	import { getMeta } from '$lib/local/meta';
	import type { UserDb } from '$lib/local/db';
	import { userDb } from '$lib/local/open';
	import { afterLocalWrite, syncState } from '$lib/sync/runtime.svelte';

	let db = $state<UserDb | null>(null);
	let list = $state<CascadeSummary[]>([]);
	/** The account's storage and its limit, as the server last reported them. */
	let used = $state(0);
	let limit = $state(DEFAULT_STORAGE_LIMIT);
	let fill = $derived(storageState(used, limit));
	/** No lexicon on the server: known only online, and asked only while there are no cascades. */
	let noCatalog = $state(false);
	let retentionDays = $state(30);
	/** Bumped when a cascade goes to the Trash here, so the Trash below shows it. */
	let trashVersion = $state(0);

	async function refresh() {
		if (!db) return;
		list = await cascadeSummaries(db, navigator.onLine);
		const server = await getMeta(db, 'server');
		retentionDays = server.trash_retention_days;
		used = server.storage_bytes ?? 0;
		limit = server.max_storage_bytes ?? DEFAULT_STORAGE_LIMIT;
	}

	onMount(() => {
		void (async () => {
			if (!session.userId) return;
			db = await userDb(session.userId, session.username);
			await refresh();
			// A link to the Trash (/trash, or #trash) lands on it once it is drawn.
			if (location.hash === '#trash') {
				await tick();
				document.getElementById('trash')?.scrollIntoView({ block: 'start' });
			}
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
		trashVersion++;
	}

	async function trash(s: CascadeSummary) {
		const ok = await confirmAction({
			title: `Move “${s.cascade.name}” to the Trash?`,
			body: `You can restore it from the Trash for ${retentionDays} days. After that it is deleted forever. Its storage is freed only then, or when you delete it forever from the Trash.`,
			action: 'Move to Trash'
		});
		if (ok) await write({ type: 'trash_cascade', cascade_id: s.cascade.id });
	}

	/** What a cascade's figure is made of: its levels, from the same per-row costs, and the rest. */
	function sizeTitle(s: CascadeSummary): string {
		const levels = s.levels.reduce((n, r) => n + levelBytes(r.quiz.question_count), 0);
		const rest = Math.max(0, (s.cascade.storage_bytes ?? 0) - levels);
		return `Storage: ${formatBytes(s.cascade.storage_bytes ?? 0)} — questions and filters ${formatBytes(rest)}, levels ${formatBytes(levels)}`;
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
		<div class="min-w-56 flex-1">
			<h1 class="text-2xl font-semibold">Cascades</h1>
			<!-- The account's storage against its one limit: the Trash counts until it is emptied. -->
			<div class="mt-1 max-w-sm space-y-1" data-storage={fill}>
				<p class="text-sm text-muted-foreground"><span class="text-foreground">{formatBytes(used)}</span> of {formatBytes(limit)} used</p>
				<div
					class="h-1.5 overflow-hidden rounded-full bg-muted"
					role="meter"
					aria-label="Storage used"
					aria-valuemin={0}
					aria-valuemax={limit}
					aria-valuenow={Math.min(used, limit)}
				>
					<div
						class="h-full {fill === 'over' ? 'bg-red-600' : fill === 'almost' ? 'bg-amber-500' : 'bg-foreground/60'}"
						style={`width: ${Math.min(100, (used / Math.max(1, limit)) * 100)}%`}
					></div>
				</div>
				{#if fill === 'over'}
					<p class="text-sm text-destructive">
						Over your storage by {formatBytes(used - limit)}: you can keep studying, but can’t create cascades until you make room.
						Empty the <a class="underline" href="#trash">Trash</a> or delete cascades.
					</p>
				{:else if fill === 'almost'}
					<p class="text-sm text-amber-600 dark:text-amber-400">
						Almost full: empty the <a class="underline" href="#trash">Trash</a> or delete cascades to make room.
					</p>
				{/if}
			</div>
		</div>
		<div class="flex items-center gap-4">
			{#if used >= limit}
				<Button disabled title="Your storage is full: make room first">New cascade</Button>
			{:else}
				<Button href="/cascades/new">New cascade</Button>
			{/if}
		</div>
	</header>
		{#if list.length === 0 && noCatalog}
		<!-- Nothing to build from yet: say so, and where to fix it. -->
		<p class="text-muted-foreground">
			There are no word lists yet.
			{#if session.isAdmin}Upload a letter distribution, a lexicon and its leave values in <a class="underline" href="/admin">Admin</a>.{:else}An admin has to upload a lexicon first.{/if}
		</p>
	{/if}
	{#if list.length > 0}
		<!-- One row per cascade, for a glance: what it is and where it stands, whether it is on
		     this device, and Move to Trash. Everything else is in the player. -->
		<ul class="divide-y rounded-lg border">
			{#each list as s (s.cascade.id)}
				<li class="flex items-center gap-x-4 px-4 py-2.5">
					<div class="min-w-0 flex-1">
						<div class="flex min-w-0 items-baseline gap-2">
							<a class="min-w-0 truncate font-medium underline-offset-2 hover:underline" href={`/cascades/${s.cascade.id}`} title={s.cascade.name}>{s.cascade.name}</a>
							<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
								{s.cascade.quiz_type.replace('_', ' ')} · {s.cascade.lexicon} · clear at {s.cascade.clear_threshold}%{#if s.options} · {s.options}{/if}{#if s.completedAt} · complete {new Date(s.completedAt).toLocaleDateString()}{/if}
							</span>
						</div>
						<p class="truncate text-xs text-muted-foreground" title={ladderText(s.levels)}>{ladderText(s.levels)}</p>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<span class="text-xs text-muted-foreground tabular-nums" title={sizeTitle(s)} data-cascade-storage>{formatBytes(s.cascade.storage_bytes ?? 0)}</span>
						<span class="rounded bg-muted px-2 py-0.5 text-xs">{badge(s)}</span>
						<Button
							size="icon-sm"
							variant="ghost"
							class="hover:text-destructive"
							onclick={() => trash(s)}
							aria-label="Move to Trash"
							title="Move to Trash"
						>
							<TrashIcon class="size-4" />
						</Button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	{#if db}
		<div class="mt-10"><TrashList {db} version={trashVersion} onchange={refresh} /></div>
	{/if}
</main>
