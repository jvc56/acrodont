<script lang="ts">
	// Below a setting's row (PLAN.md § Settings → Where a setting applies):
	//
	// - After a change, the offer: where the value now is ("✓ Saved for this
	//   cascade on this device"), what moving it replaced, and one button for
	//   each wider place it can be moved to. It stays until Settings closes.
	// - When the row's chip is pressed, the 2×2 of places: the value each holds,
	//   or "Not set", which one is in use, and Clear for each that holds one.
	import { DEFINITIONS, PLACE_NAMES, SAVED_IN, settingText, widerThan, WIDER_NAMES, type Place, type SettingKey } from '$lib/settings/layers';
	import { settings } from '$lib/settings/store.svelte';
	import PlaceGlyph from './PlaceGlyph.svelte';

	let { key, label }: { key: SettingKey; label: string } = $props();

	const offer = $derived(settings.offers[key]);
	const from = $derived(settings.sourceOf(key));
	const open = $derived(settings.expanded === key);
	const wider = $derived(offer ? widerThan(offer.place) : []);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function run(fn: () => Promise<void>) {
		busy = true;
		error = null;
		try {
			await fn();
		} catch (e) {
			console.error('a setting could not be changed', e);
			error = 'That couldn’t be saved. Try again.';
		} finally {
			busy = false;
		}
	}

	const ORDER: Record<Place, number> = { both: 1, cascade: 2, device: 3, all: 4 };
	const text = (v: unknown) => settingText(key, v as never);
</script>

{#snippet cell(p: Place)}
	{@const held = settings.heldIn(p, key)}
	<div
		class="flex min-h-9 items-center justify-between gap-2 rounded-md border px-2 py-1 {from === p ? 'border-sky-500 bg-sky-500/10' : ''}"
		data-place={p}
		data-in-use={from === p || undefined}
	>
		<span class="min-w-0">
			<span class="text-muted-foreground">{ORDER[p]}.</span>
			{#if held === undefined}<span class="text-muted-foreground">Not set</span>{:else}<span class="font-medium">{text(held)}</span>{/if}
			{#if from === p}<span class="text-sky-700 dark:text-sky-400"> · in use</span>{/if}
		</span>
		{#if held !== undefined}
			<button
				type="button"
				class="shrink-0 text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
				disabled={busy}
				aria-label={`Clear: ${PLACE_NAMES[p]}`}
				onclick={() => run(() => settings.clearIn(key, p))}>Clear</button
			>
		{/if}
	</div>
{/snippet}

{#if offer}
	{#key offer.serial}
		<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs" role="status" data-offer={key}>
			<span class="text-green-700 dark:text-green-500">✓ {SAVED_IN[offer.place]}</span>
			{#if offer.replaced.length}<span class="text-muted-foreground">· Replaced {offer.replaced.join(' and ')}</span>{/if}
			{#if wider.length}
				<span class="text-muted-foreground">· Use it for</span>
				{#each wider as p (p)}
					<button
						type="button"
						class="inline-flex h-6 items-center gap-1.5 rounded-full border px-2 hover:bg-muted disabled:opacity-50"
						disabled={busy}
						data-widen={p}
						onclick={() => run(() => settings.moveTo(key, p))}
					>
						<PlaceGlyph place={p} />{WIDER_NAMES[p]}
					</button>
				{/each}
			{/if}
		</div>
	{/key}
{/if}

{#if open}
	<div class="space-y-2 rounded-md border bg-muted/30 p-3 text-xs" data-places={key}>
		<p class="text-muted-foreground">
			{label} in each place. The first that holds a value is used, in the order of the numbers; with none, the default
			({text(DEFINITIONS[key].default)}){from === 'default' ? ', in use' : ''}.
		</p>
		<div class="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-1.5">
			<span></span>
			<span class="font-medium text-muted-foreground">This device</span>
			<span class="font-medium text-muted-foreground">Every device</span>
			<span class="self-center pr-1 font-medium text-muted-foreground">This cascade</span>
			{@render cell('both')}
			{@render cell('cascade')}
			<span class="self-center pr-1 font-medium text-muted-foreground">Every cascade</span>
			{@render cell('device')}
			{@render cell('all')}
		</div>
	</div>
{/if}
{#if error}<p class="text-right text-xs text-destructive" role="alert">{error}</p>{/if}
