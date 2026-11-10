<script lang="ts">
	// An ⓘ beside a setting's name: hovering or focusing it explains the
	// setting. The text is also the button's description for screen readers.
	import * as Tooltip from '$lib/components/ui/tooltip';
	import InfoIcon from '@lucide/svelte/icons/info';

	let { text }: { text: string } = $props();
</script>

<Tooltip.Provider delayDuration={100}>
	<Tooltip.Root>
		<Tooltip.Trigger
			type="button"
			class="inline-flex shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
			aria-label="About this setting"
			data-info={text}
		>
			<InfoIcon class="size-3.5" aria-hidden="true" />
		</Tooltip.Trigger>
		<Tooltip.Content side="top" role="tooltip" class="max-w-xs text-left leading-snug whitespace-normal">{text}</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
