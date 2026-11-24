<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { initSession, session } from '$lib/auth/session.svelte';
	import { keepNoticesFor, startSync, tabMaySync } from '$lib/sync/runtime.svelte';
	import { applyUpdate, updates, watchUpdates } from '$lib/sw/client.svelte';
	import { askToKeepData, watchOffline } from '$lib/sw/offline.svelte';
	import InstallTip from '$lib/components/InstallTip.svelte';
	import Notices from '$lib/components/Notices.svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { documentTitle, pageTitle } from '$lib/title.svelte';

	let { children } = $props();

	// Every page except these requires a logged-in user (PLAN.md § Accounts).
	// The root is the Cascades page: signed out, it goes to the log-in page.
	const PUBLIC = [
		'/login',
		// Signs in itself (local stacks only); it must not be sent to /login first.
		'/dev-login',
		'/register',
		'/register/check-email',
		'/confirm-email',
		'/reset-password',
		'/reset-password/confirm'
	];

	// The signed-in header is on every page but these: the sign-in pages, and
	// the player, which keeps the whole screen for the quiz.
	const PLAYER = /^\/cascades\/[0-9a-f-]{36}$/;
	const showHeader = $derived(
		!!session.userId && !PUBLIC.includes(page.url.pathname) && !PLAYER.test(page.url.pathname)
	);

	// The tab's title (lib/title): Search's, shown on its own or over a quiz, or the page's own.
	const title = $derived(documentTitle(page.url.pathname === '/search' || !!page.state.search, pageTitle.name));

	onMount(() => {
		initSession();
		void watchUpdates();
		watchOffline();
	});

	// Signed in, there is study to keep: ask the browser to keep it.
	$effect(() => {
		if (session.userId) void askToKeepData();
	});

	// Sync runs while an account is signed in, this tab still belongs to it, and
	// no newer build has been activated in another tab, whether or not it took
	// the database: a tab that cannot sync, or that syncs as a build the server
	// may no longer take, must not hold the lock the updated tab is waiting for.
	$effect(() => {
		const id = session.userId;
		if (!id || !tabMaySync(session, updates.updatedElsewhere)) return;
		return startSync(id);
	});

	// An account's sync notices leave the screen when it logs out of this tab.
	$effect(() => {
		keepNoticesFor(session.userId);
	});

	$effect(() => {
		if (!session.ready) return;
		const path = page.url.pathname;
		// A deleted account goes to the log-in page, where it could make a new one.
		if (!session.userId && session.toLanding) {
			session.toLanding = false;
			if (path !== '/login') goto('/login', { replaceState: true });
			return;
		}
		if (!session.userId && !PUBLIC.includes(path)) goto('/login', { replaceState: true });
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} type="image/svg+xml" />
	<title>{title}</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	{#if updates.ready && !updates.updatedElsewhere}
		<p role="status" class="bg-muted px-4 py-2 text-center text-sm">
			A new version is ready.
			<button class="underline" onclick={applyUpdate}>Reload</button>
		</p>
	{/if}
	{#if session.updatedInAnotherTab || updates.updatedElsewhere}
		<!-- PLAN.md § On the device: the old build's tab keeps running and never reloads by itself. -->
		<p role="status" class="bg-muted px-4 py-2 text-center text-sm">
			Acrodont was updated in another tab — reload to continue
		</p>
	{/if}
	<Notices />
	{#if session.ready}
		{#if showHeader}<AppHeader />{/if}
		{#if showHeader}<InstallTip />{/if}
		{@render children()}
	{/if}
	<ConfirmDialog />
</div>
