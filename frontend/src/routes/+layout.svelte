<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { initSession, session } from '$lib/auth/session.svelte';
	import { startSync } from '$lib/sync/runtime.svelte';
	import { applyUpdate, updates, watchUpdates } from '$lib/sw/client.svelte';
	import Notices from '$lib/components/Notices.svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';

	let { children } = $props();

	// Every page except these requires a logged-in user (PLAN.md § Accounts).
	const PUBLIC = [
		'/',
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
		!!session.userId && (page.url.pathname === '/' || !PUBLIC.includes(page.url.pathname)) && !PLAYER.test(page.url.pathname)
	);

	onMount(() => {
		initSession();
		void watchUpdates();
	});

	// Sync runs while an account is signed in and this tab still belongs to it.
	$effect(() => {
		const id = session.userId;
		if (!id || session.signedOutInAnotherTab) return;
		return startSync(id);
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
	<link rel="icon" href={favicon} />
	<title>Wordfall</title>
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
			Wordfall was updated in another tab — reload to continue
		</p>
	{/if}
	<Notices />
	{#if session.ready}
		{#if showHeader}<AppHeader />{/if}
		{@render children()}
	{/if}
</div>
