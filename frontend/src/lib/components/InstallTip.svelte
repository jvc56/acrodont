<script lang="ts">
	// On an iPhone or iPad, which never offers to install, a one-time tip on how
	// (PLAN.md § On the device → Installing the app). Dismissed, it stays gone on
	// this browser; with no storage to remember that, it comes back next time.
	import { offline } from '$lib/sw/offline.svelte';

	const KEY = 'acrodont.installTipDismissed';
	let dismissed = $state(read());

	function read(): boolean {
		try {
			return localStorage.getItem(KEY) === '1';
		} catch {
			return false;
		}
	}

	function dismiss() {
		dismissed = true;
		try {
			localStorage.setItem(KEY, '1');
		} catch {
			// Gone for this visit only.
		}
	}
</script>

{#if offline.ios && !offline.installed && !dismissed}
	<p role="status" class="flex items-center justify-center gap-3 bg-muted px-4 py-2 text-center text-sm" data-install-tip>
		<span>To study with no connection, add Acrodont to your Home Screen: tap Share, then Add to Home Screen.</span>
		<button class="shrink-0 underline" onclick={dismiss}>Dismiss</button>
	</p>
{/if}
