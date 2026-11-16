<script lang="ts">
	// Under a setting's name (PLAN.md § Settings → Where a setting applies): where
	// its value applies, as two switches, "For [this cascade | all cascades] on
	// [this device | all devices]". They show the place the value comes from;
	// while it comes from none (the default), they start at this cascade on this
	// device and show where a change will be saved. Pressing the other half of a
	// switch moves the value there. Reset, while a place holds one, takes it out.
	// (Nothing here is named with the setting's name, which names its control.)
	import { placeAt, sidesOf, type Side, type Sides, type SettingKey } from '$lib/settings/layers';
	import { settings } from '$lib/settings/store.svelte';

	let { key, label }: { key: SettingKey; label: string } = $props();

	const from = $derived(settings.sourceOf(key));
	const sides = $derived(sidesOf(settings.placeOf(key)));
	const replaced = $derived(settings.replaced[key]);
	let busy = false;
	let error = $state<string | null>(null);

	/** Runs one change at a time; a press while one is saving is let go, so a switch is never disabled. */
	async function run(fn: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await fn();
		} catch (e) {
			console.error('a setting could not be moved', e);
			error = 'That couldn’t be saved. Try again.';
		} finally {
			busy = false;
		}
	}

	function pick(axis: keyof Sides, side: Side) {
		if (sides[axis] === side) return;
		void run(() => settings.moveTo(key, placeAt({ ...sides, [axis]: side })));
	}
</script>

{#snippet toggle(axis: keyof Sides, here: string, every: string)}
	<span class="inline-flex rounded-full border p-0.5" role="group" aria-label={`Which ${axis}`} data-axis={axis}>
		{#each [['this', here], ['all', every]] as const as [side, text] (side)}
			<button
				type="button"
				class="h-6 rounded-full px-2.5 whitespace-nowrap {sides[axis] === side ? 'bg-primary font-medium text-primary-foreground' : 'text-foreground hover:bg-muted'}"
				aria-pressed={sides[axis] === side}
				data-side={side}
				onclick={() => pick(axis, side)}>{text}</button
			>
		{/each}
	</span>
{/snippet}

<div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" data-places={key} data-source={from}>
	<span>For</span>
	{@render toggle('cascades', 'this cascade', 'all cascades')}
	<span>on</span>
	{@render toggle('devices', 'this device', 'all devices')}
	{#if from !== 'default'}
		<button
			type="button"
			class="ml-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
			title={`Take ${label} out of where it is set`}
			data-reset
			onclick={() => run(() => settings.reset(key))}>Reset</button
		>
	{/if}
</div>
{#if replaced}<p class="mt-1 text-xs text-muted-foreground" role="status">{replaced}</p>{/if}
{#if error}<p class="mt-1 text-xs text-destructive" role="alert">{error}</p>{/if}
