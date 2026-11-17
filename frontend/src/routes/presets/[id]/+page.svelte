<script lang="ts">
	// The preset editor (PLAN.md § Settings → Presets): a preset's name, its
	// three rules, and every answer, display and control setting, in the same
	// rows as a cascade's Settings. Each change is saved to the preset at once
	// and needs a connection; no cascade changes with it, since a cascade keeps
	// the values it was given. The built-in Defaults cannot be edited.
	import { onMount, untrack } from 'svelte';
	import { session } from '$lib/auth/session.svelte';
	import AnswerSettings from '$lib/components/settings/AnswerSettings.svelte';
	import ControlsEditor from '$lib/components/settings/ControlsEditor.svelte';
	import DisplaySettings from '$lib/components/player/DisplaySettings.svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import QuizOptionsForm from '$lib/components/QuizOptionsForm.svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import { INFO, SECTION } from '$lib/settings-info';
	import { page } from '$app/state';
	import type { UserDb } from '$lib/local/db';
	import { getMeta } from '$lib/local/meta';
	import { userDb } from '$lib/local/open';
	import { clampPrefill, type QuizOptions } from '$lib/options';
	import { presetNameError } from '$lib/settings/preset-actions';
	import { PresetEditor } from '$lib/settings/preset-editor.svelte';
	import { isDefaults, presetList, type Preset } from '$lib/settings/presets';
	import { provideSettings } from '$lib/settings/source';
	import { syncState } from '$lib/sync/runtime.svelte';

	const editor = new PresetEditor();
	// The rows below read and save the preset, not a cascade.
	provideSettings(editor);

	const id = $derived(page.params.id ?? '');
	let db = $state<UserDb | null>(null);
	let presets = $state<Preset[]>([]);
	let phase = $state<'loading' | 'ready' | 'missing' | 'defaults'>('loading');
	let maxQuiz = $state(300_000);
	let options = $state<QuizOptions>({ segment_size: 0, progression: 'ladder' });
	let nameError = $state<string | null>(null);

	async function load(d: UserDb) {
		presets = await presetList(d);
		const p = presets.find((o) => o.id === id);
		if (!p) {
			phase = 'missing';
			return;
		}
		if (isDefaults(p)) {
			phase = 'defaults';
			return;
		}
		editor.load(d, p);
		options = { segment_size: clampPrefill(p.segment_size, maxQuiz), progression: p.progression };
		phase = 'ready';
	}

	onMount(() => {
		void (async () => {
			if (!session.userId) return;
			const d = await userDb(session.userId, session.username);
			maxQuiz = (await getMeta(d, 'server')).max_quiz_questions;
			db = d;
			await load(d);
		})();
	});

	// A preset not on this device yet may come with the next sync.
	$effect(() => {
		void syncState.settingsTick;
		const d = db;
		if (d && phase === 'missing') void load(d);
	});

	// A failed save put the preset back: the rules' forms show it again.
	$effect(() => {
		if (editor.reverts === 0) return;
		untrack(() => {
			options = { segment_size: clampPrefill(editor.preset.segment_size, maxQuiz), progression: editor.preset.progression };
		});
	});

	async function rename(input: HTMLInputElement) {
		const name = input.value.trim();
		if (name === editor.preset.name) {
			input.value = name;
			return;
		}
		nameError = presetNameError(name, editor.preset.id, presets);
		if (nameError) return;
		if (await editor.rename(name)) presets = db ? await presetList(db) : presets;
		input.value = editor.preset.name;
	}

	function setThreshold(el: HTMLInputElement) {
		const n = Number(el.value);
		if (!Number.isInteger(n) || n < 1 || n > 100) {
			el.value = String(editor.preset.clear_threshold);
			return;
		}
		if (n !== editor.preset.clear_threshold) void editor.setRules({ clear_threshold: n });
	}

	function setOptions(o: QuizOptions) {
		const fields: { segment_size?: number; progression?: QuizOptions['progression'] } = {};
		if (o.segment_size !== editor.preset.segment_size) fields.segment_size = o.segment_size;
		if (o.progression !== editor.preset.progression) fields.progression = o.progression;
		if (Object.keys(fields).length) void editor.setRules(fields);
	}
</script>

{#snippet head(hid: string, title: string, text: string)}
	<div class="-mx-4 space-y-1 border-y bg-muted/60 px-4 py-3 sm:-mx-6 sm:px-6">
		<div class="flex flex-wrap items-center gap-2">
			<h2 id={hid} class="text-lg font-semibold tracking-tight">{title}</h2>
			<InfoTip {text} label="About these settings" />
		</div>
	</div>
{/snippet}

<main class="mx-auto max-w-2xl p-4 sm:p-6">
	<p class="mb-4 text-sm"><a class="underline underline-offset-2" href="/#presets">← Presets</a></p>
	{#if phase === 'loading'}
		<p class="text-muted-foreground" role="status">Loading…</p>
	{:else if phase === 'missing'}
		<p class="text-muted-foreground" role="status" data-preset-missing>
			This preset isn’t on this device. It may have been deleted, or it will come with the next sync.
		</p>
	{:else if phase === 'defaults'}
		<p class="text-muted-foreground" role="status" data-preset-defaults>
			Defaults is built in and can’t be changed. Copy it on the <a class="underline" href="/#presets">Cascades page</a> to make a preset of your own.
		</p>
	{:else}
		<header class="mb-6 space-y-2">
			<h1 class="text-2xl font-semibold">Preset</h1>
			<p class="text-sm text-muted-foreground">{SECTION.preset_editor}</p>
		</header>
		<div class="space-y-10">
			<section class="space-y-4" aria-labelledby="preset-rules">
				{@render head('preset-rules', 'Name and rules', SECTION.preset_rules)}
				<SettingRow label="Name" info={INFO.preset_name} for="preset-name-field">
					<input
						id="preset-name-field"
						class="w-72 max-w-full rounded-md border bg-background px-2 py-1"
						type="text"
						maxlength="100"
						value={editor.preset.name}
						aria-invalid={nameError ? 'true' : undefined}
						oninput={() => (nameError = null)}
						onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
						onchange={(e) => rename(e.currentTarget)}
					/>
				</SettingRow>
				{#if nameError}<p class="text-sm text-destructive" role="alert">{nameError}</p>{/if}
				<SettingRow label="Clear threshold (%)" info={INFO.clear_threshold} for="preset-threshold">
					{#key editor.reverts}
						<input
							id="preset-threshold"
							class="w-24 rounded-md border bg-background px-2 py-1"
							type="number"
							min="1"
							max="100"
							step="1"
							value={editor.preset.clear_threshold}
							onchange={(e) => setThreshold(e.currentTarget)}
						/>
					{/key}
				</SettingRow>
				{#key editor.reverts}
					<QuizOptionsForm bind:options idPrefix="preset-" maxQuizQuestions={maxQuiz} onchange={setOptions} />
				{/key}
			</section>
			<section class="space-y-4" aria-labelledby="preset-answers">
				{@render head('preset-answers', 'Answers', SECTION.preset_answers)}
				<AnswerSettings />
			</section>
			<section class="space-y-4" aria-labelledby="preset-display">
				{@render head('preset-display', 'Display', SECTION.preset_display)}
				<DisplaySettings />
			</section>
			<section class="space-y-4" aria-labelledby="preset-controls">
				{@render head('preset-controls', 'Controls', SECTION.preset_controls)}
				<ControlsEditor />
			</section>
		</div>
		<div class="sticky bottom-0 mt-6 border-t bg-background py-3 text-sm" aria-live="polite">
			{#if editor.error}
				<p class="text-destructive" role="alert" data-preset-error>{editor.error}</p>
			{:else if editor.saved}
				<p class="text-green-700 dark:text-green-500" data-preset-status>✓ Saved</p>
			{:else}
				<p class="text-muted-foreground">Each change is saved to the preset as soon as it is made.</p>
			{/if}
		</div>
	{/if}
</main>
