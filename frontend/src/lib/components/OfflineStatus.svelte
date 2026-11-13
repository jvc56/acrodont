<script lang="ts">
	// The header's offline status (PLAN.md § On the device → Installing the app):
	// an icon saying whether this device can open Acrodont with no connection and
	// whether the browser keeps what is studied here, with the details on a hover,
	// tap or click; and, while the browser offers it, Install.
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import HardDriveDownloadIcon from '@lucide/svelte/icons/hard-drive-download';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { install, offline } from '$lib/sw/offline.svelte';
	import { shellText, storageText } from '$lib/sw/install';

	/** All is well: it opens offline and the data is kept. */
	const good = $derived(offline.shell === 'ready' && offline.kept === true);
	const warn = $derived(offline.shell === 'unsupported' || (offline.shell === 'ready' && offline.kept === false));
	const label = $derived(
		offline.shell === 'ready' ? 'Ready offline' : offline.shell === 'preparing' ? 'Getting ready for offline' : 'Not available offline'
	);
</script>

<div class="flex items-center gap-2">
	{#if offline.offer}
		<!-- Not on a phone, where the header has no room for it: the icon's details offer Install there. -->
		<Button class="max-sm:hidden" size="sm" variant="outline" onclick={install} aria-label="Install Acrodont" title="Install Acrodont: open it from its own icon, with or without a connection">
			<DownloadIcon class="size-4" aria-hidden="true" />
			<span>Install</span>
		</Button>
	{/if}
	<Popover.Root>
		<Popover.Trigger
			type="button"
			class="inline-flex shrink-0 rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {good
				? 'text-green-600'
				: warn
					? 'text-amber-500'
					: 'text-muted-foreground'}"
			aria-label={label}
			data-offline={offline.shell}
			data-kept={offline.kept === null ? 'unknown' : String(offline.kept)}
			openOnHover
			openDelay={100}
			closeDelay={100}
		>
			<HardDriveDownloadIcon class="size-4 {offline.shell === 'preparing' ? 'animate-pulse' : ''}" aria-hidden="true" />
		</Popover.Trigger>
		<Popover.Content
			side="bottom"
			align="end"
			class="grid w-72 gap-2 p-3 text-xs leading-snug"
			role="tooltip"
			onOpenAutoFocus={(e: Event) => e.preventDefault()}
		>
			<p class="font-medium">{shellText(offline.shell)}</p>
			{#if offline.shell !== 'unsupported'}<p>{storageText(offline.kept)}</p>{/if}
			{#if !offline.installed}
				{#if offline.offer}
					<Button size="sm" variant="outline" onclick={install}>Install Acrodont</Button>
				{:else if offline.ios}
					<p>To install it, tap Share, then Add to Home Screen.</p>
				{/if}
			{/if}
		</Popover.Content>
	</Popover.Root>
</div>
