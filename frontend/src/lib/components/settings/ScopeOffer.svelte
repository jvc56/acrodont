<script lang="ts">
	// The offer under a change made for this cascade on this device (PLAN.md §
	// Settings → Where a setting applies): "✓ Saved for this cascade on this
	// device · Also apply to: this cascade on all devices · all N cascades on
	// this device · all N cascades on all devices". Each takes one tap and
	// stays done until Settings closes; the widest covers the other two. With
	// one cascade, only this cascade on all devices is offered. Nothing shows
	// until the setting (or the preset applied, `id`) is changed.
	import type { Widening } from '$lib/settings/cascade';
	import { settings } from '$lib/settings/store.svelte';
	import ApplyWider from './ApplyWider.svelte';

	let { id, saved = 'Saved for this cascade on this device' }: { id: string; saved?: string } = $props();

	const offer = $derived(settings.offers[id]);

	function widenings(n: number): Widening[] {
		const to = (scope: 'cascade' | 'device' | 'all', label: string, covers?: string[]): Widening => ({
			key: scope,
			label,
			done: `Applied to ${label}`,
			covers,
			run: async () => {
				if (!(await settings.widen(id, scope))) throw new Error('the change was refused');
			}
		});
		const one = to('cascade', 'this cascade on all devices');
		if (n < 2) return [one];
		return [one, to('device', `all ${n} cascades on this device`), to('all', `all ${n} cascades on all devices`, ['cascade', 'device'])];
	}
</script>

{#if offer}
	<!-- Keyed by the change, so a second change starts a fresh offer. -->
	{#key offer.serial}
		<div class="mt-1" data-offer={id}><ApplyWider {saved} offers={widenings(settings.reach)} lead="Also apply to:" /></div>
	{/key}
{/if}
