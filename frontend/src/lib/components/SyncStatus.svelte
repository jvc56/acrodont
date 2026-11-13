<script lang="ts">
	// The sync status (PLAN.md § Frontend: synced, syncing, offline with pending
	// work, log in to sync, reload to keep syncing, not enough room on this
	// device, signed out in another tab). It says what is happening as it
	// happens: changes waiting, then Syncing… while the device talks to the
	// server, then Synced. The box keeps a fixed width with its label flush
	// right, so a changing label never shifts what sits beside it.
	import { session } from '$lib/auth/session.svelte';
	import { applyUpdate } from '$lib/sw/client.svelte';
	import { syncState } from '$lib/sync/runtime.svelte';

	/**
	 * Quiet (the player, with its sync status or its status bar hidden): the
	 * everyday labels are not shown, only what needs attention.
	 */
	/**
	 * Compact (the site's header): on a phone an everyday label is its dot
	 * alone, and a tap on the dot shows or hides the word; what needs
	 * attention always has its words.
	 */
	let { quiet = false, compact = false }: { quiet?: boolean; compact?: boolean } = $props();
	let shown = $state(false);
	const EVERYDAY = new Set(['Synced', 'Syncing…', 'Waiting to sync']);

	let text = $derived.by(() => {
		if (session.signedOutInAnotherTab) return 'Signed out in another tab';
		if (session.needsLogin || syncState.status === 'needs_login') return 'Log in to sync';
		switch (syncState.status) {
			case 'reload':
				return 'Reload to keep syncing';
			case 'no_room':
				return 'Not enough room on this device';
			case 'offline':
				return 'Offline';
			case 'syncing':
				return 'Syncing…';
			default:
				if (syncState.pending === null) return 'Syncing…';
				// No count: one answer is two changes (its grade and the cursor move), so
				// a number would read as answers and be wrong.
				if (syncState.pending > 0) return 'Waiting to sync';
				return 'Synced';
		}
	});
</script>

<!-- Flush right in a fixed box: "Synced" stays in the corner, and a longer label grows to the left.
     On a phone the box fits its label, so the header stays on one line. -->
{#if !(quiet && EVERYDAY.has(text))}
<div class="flex max-w-40 min-w-0 items-center sm:w-40 sm:shrink-0 justify-end gap-2 text-sm whitespace-nowrap" role="status" title={text}>
	<span class="inline-block h-2 w-2 shrink-0 rounded-full {compact && EVERYDAY.has(text) ? 'max-sm:hidden' : ''}" class:bg-green-600={text === 'Synced'} class:bg-muted-foreground={text !== 'Synced'}></span>
	{#if syncState.status === 'reload'}
		<button class="truncate underline" onclick={applyUpdate}>{text}</button>
	{:else if text === 'Log in to sync'}
		<a class="truncate underline" href="/login">{text}</a>
	{:else if compact && EVERYDAY.has(text)}
		<button type="button" class="-m-2 p-2 sm:hidden" aria-label={shown ? 'Hide the sync status' : 'Show the sync status'} aria-expanded={shown} onclick={() => (shown = !shown)}>
			<span class="block h-2 w-2 rounded-full" class:bg-green-600={text === 'Synced'} class:bg-muted-foreground={text !== 'Synced'}></span>
		</button>
		<span class="truncate {shown ? '' : 'max-sm:sr-only'}">{text}</span>
	{:else}
		<span class="truncate">{text}</span>
	{/if}
</div>
{/if}
