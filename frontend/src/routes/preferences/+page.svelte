<script lang="ts">
	// The Preferences page (PLAN.md § Preferences): every setting that is not
	// one cascade's own, in three groups by where it applies — every cascade
	// (synced), the defaults new cascades start with (synced), and this device
	// (its display and its controls, never synced). A default just changed
	// offers to give the cascades you already have the same value. A cascade's
	// own settings are in that cascade's Preferences, in the player.
	import { SCOPE } from '$lib/settings-info';
	import * as Card from '$lib/components/ui/card';
	import { session } from '$lib/auth/session.svelte';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import type { UserDb } from '$lib/local/db';
	import { getMeta } from '$lib/local/meta';
	import { userDb } from '$lib/local/open';
	import { preferencesView } from '$lib/local/preferences';
	import type { PreferencesRow } from '$lib/local/rows';
	import AccountPreferences from '$lib/components/preferences/AccountPreferences.svelte';
	import ControlsEditor from '$lib/components/preferences/ControlsEditor.svelte';
	import DisplaySettings from '$lib/components/player/DisplaySettings.svelte';
	import { controls } from '$lib/player/controls.svelte';
	import { display } from '$lib/player/display.svelte';
	import { applyToAll, reachable, type CascadeFields } from '$lib/preferences/widen';
	import { afterLocalWrite, syncState } from '$lib/sync/runtime.svelte';
	import { onMount } from 'svelte';

	let db = $state<UserDb | null>(null);
	let prefs = $state<PreferencesRow | null>(null);
	let maxQuiz = $state(130_000);

	async function refreshPrefs() {
		if (db) prefs = await preferencesView(db);
	}

	async function savePref(field: keyof PreferencesRow, value: unknown) {
		if (!db) return;
		await applyLocally(db, { type: 'set_preferences', [field]: value } as NewOp);
		afterLocalWrite();
		await refreshPrefs();
	}

	const everyCascade = {
		count: async (f: CascadeFields) => (db ? (await reachable(db, f)).length : 0),
		apply: async (f: CascadeFields) => {
			if (!db) return;
			await applyToAll(db, f);
			afterLocalWrite();
		}
	};

	onMount(() => {
		void (async () => {
			if (!session.userId) return;
			const d = await userDb(session.userId, session.username);
			maxQuiz = (await getMeta(d, 'server')).max_quiz_questions;
			await Promise.all([display.load(d), controls.load(d)]);
			db = d;
			await refreshPrefs();
		})();
	});

	// A pull may change the preferences row.
	$effect(() => {
		void syncState.changed.tick;
		void refreshPrefs();
	});
</script>

{#snippet scope(title: string, badge: string, text: string)}
	<Card.Header>
		<div class="flex flex-wrap items-center gap-2">
			<Card.Title>{title}</Card.Title>
			<span class="rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">{badge}</span>
		</div>
		<Card.Description>{text}</Card.Description>
	</Card.Header>
{/snippet}

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold">Preferences</h1>
		<p class="text-sm text-muted-foreground">
			A cascade’s own threshold, answer mode and level options are in its Preferences, in the player.
		</p>
	</div>

	{#if db && prefs}
		<section aria-label="Every cascade"><Card.Root id="every-cascade">
			{@render scope('Every cascade', 'Account · synced', SCOPE.every)}
			<Card.Content><AccountPreferences {prefs} {maxQuiz} part="every" save={savePref} /></Card.Content>
		</Card.Root></section>
		<section aria-label="New cascades"><Card.Root id="new-cascades">
			{@render scope('New cascades', 'Account · synced', SCOPE.defaults)}
			<Card.Content><AccountPreferences {prefs} {maxQuiz} part="defaults" save={savePref} {everyCascade} /></Card.Content>
		</Card.Root></section>
		<section aria-label="This device"><Card.Root id="display">
			{@render scope('This device', 'Not synced', SCOPE.device)}
			<Card.Content class="grid gap-6">
				<DisplaySettings />
				<div class="grid gap-3 border-t pt-4">
					<h3 class="text-sm font-semibold">Controls</h3>
					<ControlsEditor />
				</div>
			</Card.Content>
		</Card.Root></section>
	{/if}
</main>
