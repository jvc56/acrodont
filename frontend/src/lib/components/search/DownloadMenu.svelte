<script lang="ts">
	// Download the whole result (PLAN.md § Search page → Download): TXT, a word
	// a line, or CSV with the columns chosen. The worker writes the file, so it
	// works offline and at any size.
	import { Button } from '$lib/components/ui/button';
	import { searchEngine } from '$lib/search/engine.svelte';
	import { CSV_COLUMNS, type CsvColumn } from '$lib/search/protocol';
	import { searchState } from '$lib/search/state.svelte';

	let { filename, disabled = false, onneeddefinitions }: { filename: (ext: 'txt' | 'csv') => string; disabled?: boolean; onneeddefinitions?: () => Promise<boolean> } = $props();

	let open = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);

	const LABELS: Record<CsvColumn, string> = {
		word: 'Word',
		alphagram: 'Alphagram',
		length: 'Length',
		probability_order: 'Probability order',
		playability_order: 'Playability order',
		front_hooks: 'Front hooks',
		back_hooks: 'Back hooks',
		inner_hooks: 'Inner hooks',
		definition: 'Definition'
	};

	function toggle(c: CsvColumn, on: boolean) {
		const set = new Set(searchState.csvColumns);
		if (on) set.add(c);
		else set.delete(c);
		searchState.csvColumns = CSV_COLUMNS.filter((x) => set.has(x));
	}

	async function download() {
		message = null;
		busy = true;
		try {
			const csv = searchState.format === 'csv';
			if (csv && searchState.csvColumns.includes('definition') && onneeddefinitions && !(await onneeddefinitions())) {
				message = 'The definitions need a connection once.';
				return;
			}
			const blob = await searchEngine.file(searchState.format, searchState.csvColumns);
			if (!blob) {
				message = 'The file could not be made.';
				return;
			}
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = filename(searchState.format);
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
			open = false;
		} finally {
			busy = false;
		}
	}
</script>

<div class="relative">
	<Button type="button" size="sm" variant="outline" {disabled} onclick={() => (open = !open)} aria-expanded={open}>Download…</Button>
	{#if open}
		<div class="absolute right-0 z-20 mt-1 grid w-64 gap-3 rounded-md border bg-popover p-3 text-sm shadow-md" role="group" aria-label="Download">
			<fieldset class="grid gap-1">
				<legend class="mb-1 font-medium">Format</legend>
				<label class="flex items-center gap-2"><input type="radio" name="search-format" value="txt" bind:group={searchState.format} /> Text: a word a line</label>
				<label class="flex items-center gap-2"><input type="radio" name="search-format" value="csv" bind:group={searchState.format} /> CSV</label>
			</fieldset>
			{#if searchState.format === 'csv'}
				<fieldset class="grid gap-1">
					<legend class="mb-1 font-medium">Columns</legend>
					{#each CSV_COLUMNS as c (c)}
						<label class="flex items-center gap-2">
							<input type="checkbox" checked={searchState.csvColumns.includes(c)} onchange={(e) => toggle(c, e.currentTarget.checked)} />
							{LABELS[c]}
						</label>
					{/each}
				</fieldset>
			{/if}
			{#if message}<p class="text-destructive">{message}</p>{/if}
			<Button type="button" size="sm" onclick={download} disabled={busy || (searchState.format === 'csv' && searchState.csvColumns.length === 0)}>
				{busy ? 'Making the file…' : 'Download'}
			</Button>
		</div>
	{/if}
</div>
