<script lang="ts">
	// The offer under a change just made (PLAN.md § Settings): it says where the
	// change was saved, then offers to make it more widely, one tap each. It
	// stays until the dialog closes, so it is never gone before it is read. An
	// offer taken marks the ones it covers done with it.
	import type { Widening } from '$lib/settings/cascade';

	let { saved, offers, lead = 'Also use for:' }: { saved: string; offers: Widening[]; lead?: string } = $props();

	let done = $state<string[]>([]);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	async function take(o: Widening) {
		busy = o.key;
		error = null;
		try {
			await o.run();
			done = [...done, o.key, ...(o.covers ?? []).filter((k) => !done.includes(k))];
		} catch (e) {
			console.error('widening a setting failed', e);
			error = 'That couldn’t be saved. Try again.';
		} finally {
			busy = null;
		}
	}

	const open = $derived(offers.filter((o) => !done.includes(o.key)));
	// A covered offer reads done without a line of its own: the one that covered it says so.
	const taken = $derived(offers.filter((o) => done.includes(o.key) && !offers.some((c) => c.key !== o.key && done.includes(c.key) && c.covers?.includes(o.key))));
</script>

<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs" role="status" data-widen>
	<span class="text-green-700 dark:text-green-500">✓ {saved}</span>
	{#each taken as o (o.key)}
		<span class="text-green-700 dark:text-green-500">· ✓ {o.done}</span>
	{/each}
	{#if open.length}
		<span class="text-muted-foreground">· {lead}</span>
		{#each open as o, i (o.key)}
			{#if i}<span class="text-muted-foreground" aria-hidden="true">·</span>{/if}
			<button class="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy !== null} onclick={() => take(o)}>{o.label}</button>
		{/each}
	{/if}
	{#if error}<span class="w-full text-right text-destructive">{error}</span>{/if}
</div>
