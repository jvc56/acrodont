<script lang="ts">
	// An ⓘ beside a setting's name, explaining the setting: hovering it with a
	// mouse shows the text, and a tap or a click (or Enter on the focused ⓘ)
	// keeps it open until a tap elsewhere, so it works on a phone too. The text
	// opens for a screen reader as for anyone else.
	import * as Popover from '$lib/components/ui/popover';
	import InfoIcon from '@lucide/svelte/icons/info';

	let { text }: { text: string } = $props();
</script>

<Popover.Root>
	<Popover.Trigger
		type="button"
		class="inline-flex shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		aria-label="About this setting"
		data-info={text}
		openOnHover
		openDelay={100}
		closeDelay={100}
	>
		<InfoIcon class="size-3.5" aria-hidden="true" />
	</Popover.Trigger>
	<Popover.Content side="top" class="w-auto max-w-xs p-3 text-left text-xs leading-snug" role="tooltip" onOpenAutoFocus={(e: Event) => e.preventDefault()}>
		{text}
	</Popover.Content>
</Popover.Root>
