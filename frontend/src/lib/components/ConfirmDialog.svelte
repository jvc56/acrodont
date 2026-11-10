<script lang="ts">
	// The one confirmation dialog (lib/confirm): its title says what is about to
	// happen, its body whether it can be undone, and the confirming button names
	// the action. Cancel, Escape and a click outside all decline.
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { confirmState } from '$lib/confirm.svelte';

	let c = $derived(confirmState.current);
</script>

<AlertDialog.Root open={c !== null} onOpenChange={(open) => !open && confirmState.answer(false)}>
	<!-- Above every other dialog: a confirmation can be asked from inside one (Save Search…). -->
	<AlertDialog.Content class="z-[60]" overlayClass="z-[60]">
		{#if c}
			<AlertDialog.Header>
				<AlertDialog.Title>{c.title}</AlertDialog.Title>
				{#if c.body}<AlertDialog.Description>{c.body}</AlertDialog.Description>{/if}
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel onclick={() => confirmState.answer(false)}>Cancel</AlertDialog.Cancel>
				<AlertDialog.Action
					variant={c.destructive ? 'destructive' : 'default'}
					onclick={() => confirmState.answer(true)}>{c.action}</AlertDialog.Action
				>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
