<script lang="ts">
	// The Cascades page (PLAN.md § Cascades page): newest activity first, one
	// row each for a glance — its options in short form, a compact ladder with
	// the current level's progress, whether it is on this device, and Move to
	// Trash; the rest (Keep offline, quiz options, Export…, Start over) is in
	// the player. The header shows the cascade limit. Everything reads the local
	// stores and works offline.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Button } from '$lib/components/ui/button';
	import { allCascades, cascadeSummaries, ladderText, type CascadeSummary } from '$lib/cascades/summary';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import { confirmAction } from '$lib/confirm.svelte';
	import { getMeta } from '$lib/local/meta';
	import type { UserDb } from '$lib/local/db';
	import { userDb } from '$lib/local/open';
	import { afterLocalWrite, syncState } from '$lib/sync/runtime.svelte';

	let db = $state<UserDb | null>(null);
	let list = $state<CascadeSummary[]>([]);
	let count = $state(0);
	/** No lexicon on the server: known only online, and asked only while there are no cascades. */
	let noCatalog = $state(false);
	let retentionDays = $state(30);

	async function refresh() {
		if (!db) return;
		list = await cascadeSummaries(db, navigator.onLine);
		count = (await allCascades(db)).length;
		retentionDays = (await getMeta(db, 'server')).trash_retention_days;
	}

	onMount(() => {
		void (async () => {
			if (!session.userId) return;
			db = await userDb(session.userId, session.username);
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

	async function trash(s: CascadeSummary) {
		const ok = await confirmAction({
			title: `Move “${s.cascade.name}” to the Trash?`,
			body: `You can restore it from the Trash for ${retentionDays} days. After that it is deleted forever.`,
			action: 'Move to Trash'
		});
		if (ok) await write({ type: 'trash_cascade', cascade_id: s.cascade.id });
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
</main>
