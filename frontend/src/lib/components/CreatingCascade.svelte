<script lang="ts">
	// What creating a cascade is doing while it does it: the server's search,
	// then storing the questions on this device (the long part for a large
	// cascade), with how far along it is. Shown over the page until the player opens.
	import CheckIcon from '@lucide/svelte/icons/check';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Progress } from '$lib/components/ui/progress';

	let {
		title = 'Creating your cascade',
		stage,
		progress = 0,
		count = null
	}: {
		title?: string;
		/** `server`: the search and the new rows on the server; `device`: storing them here. */
		stage: 'server' | 'device';
		/** 0–1 while stage is `device`. */
		progress?: number;
		count?: number | null;
	} = $props();

	const steps = $derived([
		{ label: 'Finding the questions', state: stage === 'server' ? 'active' : 'done' },
		{
			label: count === null ? 'Saving them on this device' : `Saving ${count.toLocaleString()} questions on this device`,
			state: stage === 'device' ? 'active' : 'waiting'
		}
	]);
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="presentation">
	<div class="w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg" role="alertdialog" aria-label={title} aria-busy="true">
		<div class="flex items-center gap-3">
			<LoaderCircleIcon class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
			<h2 class="text-lg font-semibold">{title}</h2>
		</div>
		<ol class="mt-4 grid gap-2 text-sm">
			{#each steps as s (s.label)}
				<li class="flex items-center gap-2" class:text-muted-foreground={s.state === 'waiting'}>
					<span class="flex size-4 items-center justify-center" aria-hidden="true">
						{#if s.state === 'done'}<CheckIcon class="size-4 text-green-600" />{:else if s.state === 'active'}<span class="size-1.5 rounded-full bg-foreground"></span>{/if}
					</span>
					{s.label}
				</li>
			{/each}
		</ol>
		{#if stage === 'device'}
			<Progress class="mt-4" value={Math.round(progress * 100)} max={100} aria-label="Saved on this device" />
			<p class="mt-2 text-right text-xs text-muted-foreground" role="status">{Math.round(progress * 100)}%</p>
		{/if}
	</div>
</div>
