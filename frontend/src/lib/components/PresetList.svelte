<script lang="ts">
	// The account's presets on the Cascades page, under the Trash (PLAN.md §
	// Settings → Presets): Defaults, built in, then the presets by name. Each
	// can be edited (its own page), copied under a new name, renamed, given a
	// cascade's settings, or deleted; Defaults can only be copied. A new preset
	// starts from Defaults or from a cascade. Every change needs a connection,
	// as on the server; none changes a cascade, which keeps the values it was given.
	import { Button } from '$lib/components/ui/button';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import { confirmAction } from '$lib/confirm.svelte';
	import type { UserDb } from '$lib/local/db';
	import type { CascadeRow } from '$lib/local/rows';
	import { SECTION } from '$lib/settings-info';
	import { reachable } from '$lib/settings/cascade';
	import { settingsFor } from '$lib/settings/places';
	import { nextFreeName, presetFailure, presetNameError } from '$lib/settings/preset-actions';
	import { defaultsPreset, deletePreset, isDefaults, presetFrom, presetList, renamePreset, savePreset, type Preset } from '$lib/settings/presets';
	import { afterLocalWrite, syncState } from '$lib/sync/runtime.svelte';

	let { db }: { db: UserDb } = $props();

	let presets = $state<Preset[]>([]);
	let cascades = $state<CascadeRow[]>([]);
	/** The one form open under a row: copying, renaming, or taking a cascade's settings. */
	let open = $state<{ kind: 'copy' | 'rename' | 'from'; id: string } | null>(null);
	let text = $state('');
	let fromCascade = $state('');
	/** New preset: whether its form is open, its name, and what it starts from ('defaults' or a cascade's id). */
	let making = $state(false);
	let newName = $state('');
	let newFrom = $state('defaults');
	let busy = $state(false);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);

	async function load() {
		presets = await presetList(db);
		cascades = (await reachable(db)).sort((a, b) => a.name.localeCompare(b.name));
	}

	$effect(() => {
		void syncState.settingsTick;
		void load();
	});

	function show(kind: 'copy' | 'rename' | 'from', p: Preset) {
		open = { kind, id: p.id };
		making = false;
		error = null;
		message = null;
		text = kind === 'copy' ? nextFreeName(p.name, presets) : p.name;
		fromCascade = '';
	}

	/** Runs one change: offline, it says so and sends nothing; then the list and a sync. */
	async function run(doing: string, done: string, fn: () => Promise<string>) {
		if (busy) return;
		error = null;
		message = null;
		if (!navigator.onLine) {
			error = `${doing} needs a connection.`;
			return;
		}
		busy = true;
		try {
			message = await fn();
			open = null;
			await load();
			afterLocalWrite();
		} catch (e) {
			error = presetFailure(e, doing, done);
		} finally {
			busy = false;
		}
	}

	/** A name for a new preset (a copy, or one made here): one no other preset holds. */
	function freshNameError(name: string): string | null {
		const e = presetNameError(name, null, presets);
		if (e) return e;
		return presets.some((o) => !isDefaults(o) && o.name === name) ? 'You already have a preset with that name.' : null;
	}

	async function copy(p: Preset) {
		const name = text.trim();
		error = freshNameError(name);
		if (error) return;
		await run('Copying a preset', 'copied', async () => {
			await savePreset(db, { ...$state.snapshot(p), id: crypto.randomUUID(), name });
			return `Copied “${p.name}” as “${name}”.`;
		});
	}

	async function rename(p: Preset) {
		const name = text.trim();
		if (name === p.name) {
			open = null;
			return;
		}
		error = presetNameError(name, p.id, presets);
		if (error) return;
		await run('Renaming a preset', 'renamed', async () => {
			await renamePreset(db, p.id, name);
			return `Renamed “${p.name}” to “${name}”.`;
		});
	}

	/** A preset from what a cascade shows on this device: every setting, and its rules. */
	async function fromThe(c: CascadeRow, id: string, name: string): Promise<Preset> {
		return presetFrom(id, name, await settingsFor(db, c), c);
	}

	async function takeFrom(p: Preset) {
		const c = cascades.find((o) => o.id === fromCascade);
		if (!c) return;
		const ok = await confirmAction({
			title: `Give “${p.name}” the settings of “${c.name}”?`,
			body: 'The preset takes the cascade’s settings as they are on this device, and its three rules. Cascades the preset was applied to, or made with, keep their settings.',
			action: 'Copy settings'
		});
		if (!ok) return;
		await run('Changing a preset', 'saved', async () => {
			await savePreset(db, await fromThe(c, p.id, p.name));
			return `“${p.name}” now has the settings of “${c.name}”.`;
		});
	}

	async function remove(p: Preset) {
		error = null;
		message = null;
		const ok = await confirmAction({
			title: `Delete the preset “${p.name}”?`,
			body: 'Cascades made with it, or that it was applied to, keep their settings.',
			action: 'Delete'
		});
		if (!ok) return;
		await run('Deleting a preset', 'deleted', async () => {
			await deletePreset(db, p.id);
			return `Deleted “${p.name}”.`;
		});
	}

	async function create() {
		const name = newName.trim();
		error = freshNameError(name);
		if (error) return;
		const c = cascades.find((o) => o.id === newFrom);
		await run('Making a preset', 'made', async () => {
			const id = crypto.randomUUID();
			await savePreset(db, c ? await fromThe(c, id, name) : { ...defaultsPreset(), id, name });
			newName = '';
			newFrom = 'defaults';
			making = false;
			return c ? `Made “${name}” from “${c.name}”.` : `Made “${name}” from the defaults.`;
		});
	}
</script>

<section id="presets" class="space-y-3" aria-labelledby="presets-heading" data-preset-section>
	<div class="flex items-center gap-2">
		<h2 id="presets-heading" class="text-lg font-semibold">Presets</h2>
		<InfoTip text={SECTION.presets_list} label="About presets" />
	</div>
	<ul class="divide-y rounded-lg border">
		{#each presets as p (p.id)}
			<li class="px-4 py-2.5" data-preset-row={p.name}>
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
					<span class="min-w-0 flex-1 basis-full font-medium break-words sm:basis-0 sm:truncate">
						{#if isDefaults(p)}{p.name} <span class="text-sm font-normal text-muted-foreground">(built in)</span>
						{:else}<a class="underline-offset-2 hover:underline" href={`/presets/${p.id}`}>{p.name}</a>{/if}
					</span>
					<div class="flex flex-wrap gap-1">
						{#if !isDefaults(p)}<Button size="sm" variant="ghost" href={`/presets/${p.id}`} aria-label={`Edit “${p.name}”`}>Edit</Button>{/if}
						<Button size="sm" variant="ghost" aria-label={`Copy “${p.name}”`} onclick={() => show('copy', p)}>Copy</Button>
						{#if !isDefaults(p)}
							<Button size="sm" variant="ghost" aria-label={`Rename “${p.name}”`} onclick={() => show('rename', p)}>Rename</Button>
							<Button size="sm" variant="ghost" aria-label={`Copy a cascade’s settings to “${p.name}”`} disabled={!cascades.length} onclick={() => show('from', p)}
								>Copy from a cascade…</Button
							>
							<Button size="sm" variant="ghost" class="hover:text-destructive" aria-label={`Delete “${p.name}”`} onclick={() => remove(p)}>Delete</Button>
						{/if}
					</div>
				</div>
				{#if open?.id === p.id}
					<div class="mt-2 flex flex-wrap items-center justify-end gap-2 text-sm">
						{#if open.kind === 'from'}
							<label for="preset-from" class="sr-only">Cascade whose settings “{p.name}” takes</label>
							<select id="preset-from" class="max-w-full min-w-0 flex-1 rounded border bg-background px-2 py-1 sm:max-w-xs" bind:value={fromCascade}>
								<option value="" disabled>Choose a cascade</option>
								{#each cascades as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
							</select>
							<Button size="sm" variant="outline" disabled={!fromCascade || busy} onclick={() => takeFrom(p)}>Copy settings</Button>
						{:else}
							<label for="preset-text" class="sr-only">{open.kind === 'copy' ? `Name of the copy of “${p.name}”` : `New name for “${p.name}”`}</label>
							<input
								id="preset-text"
								class="max-w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1 sm:max-w-xs"
								type="text"
								maxlength="100"
								bind:value={text}
								oninput={() => (error = null)}
								onkeydown={(e) => {
									if (e.key === 'Enter') void (open?.kind === 'copy' ? copy(p) : rename(p));
									if (e.key === 'Escape') open = null;
								}}
								{@attach (el: HTMLInputElement) => el.focus()}
							/>
							<Button size="sm" variant="outline" disabled={busy || !text.trim()} onclick={() => (open?.kind === 'copy' ? copy(p) : rename(p))}
								>{open.kind === 'copy' ? 'Make copy' : 'Save name'}</Button
							>
						{/if}
						<Button size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
	<!-- Opened by New preset, so the cascades it can start from are listed only then. -->
	{#if making}
		<div class="flex flex-wrap items-center justify-end gap-2 text-sm" data-new-preset>
			<label for="new-preset-name" class="sr-only">New preset’s name</label>
			<input
				id="new-preset-name"
				class="max-w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1 sm:max-w-xs"
				type="text"
				maxlength="100"
				placeholder="New preset’s name"
				bind:value={newName}
				oninput={() => (error = null)}
				onkeydown={(e) => {
					if (e.key === 'Enter') void create();
					if (e.key === 'Escape') making = false;
				}}
				{@attach (el: HTMLInputElement) => el.focus()}
			/>
			<label for="new-preset-from" class="sr-only">New preset starts from</label>
			<select id="new-preset-from" class="max-w-full min-w-0 rounded border bg-background px-2 py-1" bind:value={newFrom}>
				<option value="defaults">From the defaults</option>
				{#each cascades as c (c.id)}<option value={c.id}>From “{c.name}”</option>{/each}
			</select>
			<Button size="sm" disabled={busy || !newName.trim()} onclick={create}>Make preset</Button>
			<Button size="sm" variant="ghost" onclick={() => (making = false)}>Cancel</Button>
		</div>
	{:else}
		<div class="flex justify-end">
			<Button
				size="sm"
				variant="outline"
				onclick={() => {
					making = true;
					open = null;
					error = null;
					message = null;
				}}>New preset</Button
			>
		</div>
	{/if}
	{#if error}<p class="text-right text-sm text-destructive" role="alert" data-preset-error>{error}</p>{/if}
	{#if message}<p class="text-right text-sm text-green-700 dark:text-green-500" role="status" data-preset-message>✓ {message}</p>{/if}
</section>
