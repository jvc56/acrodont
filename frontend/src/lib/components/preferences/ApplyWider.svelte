<script lang="ts">
	// The offer under a setting just changed (PLAN.md § Preferences → Where a
	// setting applies): it says where the change was saved, then offers to use
	// the same value more widely, one tap each. It stays until the page or
	// dialog closes, so it is never gone before it is read.
	import type { Widening } from '$lib/preferences/widen';

	let { saved, offers }: { saved: string; offers: Widening[] } = $props();

	let done = $state<string[]>([]);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	async function take(o: Widening) {
		busy = o.key;
		error = null;
		try {
			await o.run();
			done = [...done, o.key, ...(o.includes ?? [])];
		} catch (e) {
			console.error('widening a setting failed', e);
			error = 'That couldn’t be saved. Try again.';
		} finally {
			busy = null;
		}
	}

	const open = $derived(offers.filter((o) => !done.includes(o.key)));
	const taken = $derived(offers.filter((o) => done.includes(o.key) && !offers.some((p) => p.key !== o.key && done.includes(p.key) && p.includes?.includes(o.key))));
</script>

<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs" role="status" data-widen>
	<span class="text-green-700 dark:text-green-500">✓ {saved}</span>
	{#each taken as o (o.key)}
		<span class="text-green-700 dark:text-green-500">· ✓ {o.done}</span>
	{/each}
	{#if open.length}
		<span class="text-muted-foreground">· Also use for:</span>
		{#each open as o, i (o.key)}
			{#if i}<span class="text-muted-foreground" aria-hidden="true">·</span>{/if}
			<button class="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy !== null} onclick={() => take(o)}>{o.label}</button>
		{/each}
	{/if}
	{#if error}<span class="w-full text-right text-destructive">{error}</span>{/if}
</div>
