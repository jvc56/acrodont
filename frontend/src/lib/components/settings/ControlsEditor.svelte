<script lang="ts">
	// Controls (PLAN.md § Controls): any number of bindings per action, captured
	// by pressing a key, clicking or scrolling inside a capture box; Escape
	// cancels and cannot be bound; a stroke moves from another action with a
	// notice; every action keeps one binding; Reset to defaults. Saved on this
	// device (lib/player/controls); after a change, or a reset, it offers to use
	// this device's controls for all of the account's devices (lib/settings/device).
	/** What a punctuation key shows where the browser has no keyboard layout map (Firefox). */
	const PUNCTUATION: Record<string, string> = {
		Comma: ',',
		Period: '.',
		Slash: '/',
		Semicolon: ';',
		Quote: "'",
		BracketLeft: '[',
		BracketRight: ']',
		Minus: '-',
		Equal: '=',
		Backquote: '`',
		Backslash: '\\'
	};
	import { Button } from '$lib/components/ui/button';
	import ApplyWider from '$lib/components/settings/ApplyWider.svelte';
	import { afterLocalWrite } from '$lib/sync/runtime.svelte';
	import { confirmAction } from '$lib/confirm.svelte';
	import { controls } from '$lib/player/controls.svelte';
	import { bind, DEFAULT_BINDINGS, keyStroke, mayNotReceive, mouseStroke, unbind, wheelStroke, type Action, type Binding, type Stroke } from '$lib/player/bindings';

	// The caller loads `controls` for the signed-in user first.
	const bindings = $derived(controls.value);

	const ACTIONS: { action: Action; label: string }[] = [
		{ action: 'show_next', label: 'Show / Next' },
		{ action: 'toggle_grade', label: 'Toggle grade' },
		{ action: 'previous', label: 'Previous' }
	];

	let capturing = $state<Action | null>(null);
	let notice = $state<string | null>(null);
	let layout = $state<Map<string, string> | null>(null);

	$effect(() => {
		const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
		kb?.getLayoutMap?.().then((m) => (layout = m)).catch(() => undefined);
	});

	function label(b: Stroke): string {
		const mods = [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && 'Meta'].filter(Boolean).join('+');
		let base: string;
		if (b.kind === 'key') base = layout?.get(b.code)?.toUpperCase() ?? PUNCTUATION[b.code] ?? b.code.replace(/^Key/, '').replace(/^Digit/, '');
		else if (b.kind === 'wheel') base = `Wheel ${b.code}`;
		else base = `${b.code[0].toUpperCase()}${b.code.slice(1)} click`;
		return mods ? `${mods}+${base}` : base;
	}

	/** The offer after the last change: what was done, keyed by the change so a second one starts afresh. */
	let offer = $state<{ saved: string; serial: number } | null>(null);

	async function save(next: Binding[], saved = 'Saved on this device') {
		await controls.set(next);
		offer = { saved, serial: (offer?.serial ?? 0) + 1 };
	}

	const everyDevice = [
		{
			key: 'devices',
			label: 'all your devices',
			done: 'Used for all your devices',
			run: async () => {
				await controls.share();
				afterLocalWrite();
			}
		}
	];

	async function captured(s: Stroke | null) {
		if (!capturing || !s) return;
		const r = bind(bindings, capturing, s);
		capturing = null;
		if (r.refused) {
			notice = 'That binding can’t be added.';
			return;
		}
		notice = r.moved ? `${label(s)} moved from ${ACTIONS.find((a) => a.action === r.moved)!.label}.` : null;
		if (mayNotReceive(s)) notice = `${notice ?? ''} The browser or system may keep ${label(s)} for itself.`.trim();
		await save(r.bindings);
	}

	function onKey(e: KeyboardEvent) {
		e.preventDefault();
		// The key is the binding's alone: Escape cancels the capture, not the Settings around it.
		e.stopPropagation();
		if (e.code === 'Escape') {
			capturing = null;
			return;
		}
		if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
		void captured(keyStroke(e));
	}
</script>

<div id="controls" class="grid gap-4 text-sm">
	{#each ACTIONS as a (a.action)}
		<div>
			<p class="font-medium">{a.label}</p>
			<ul class="mt-1 flex flex-wrap gap-2">
				{#each bindings.filter((b) => b.action === a.action) as b, i (i)}
					<li class="flex items-center gap-1 rounded bg-muted px-2 py-1">
						{label(b)}
						<button aria-label="Remove binding" onclick={() => save(unbind(bindings, b))}>×</button>
					</li>
				{/each}
				<li><Button size="sm" variant="outline" onclick={() => (capturing = a.action)}>Add binding</Button></li>
			</ul>
		</div>
	{/each}
	{#if capturing}
		<!-- The capture box: press a key, click or scroll here; Escape cancels. -->
		<div
			class="rounded border-2 border-dashed p-6 text-center"
			role="button"
			tabindex="0"
			onkeydown={onKey}
			onmousedown={(e) => {
				e.preventDefault();
				void captured(mouseStroke(e));
			}}
			oncontextmenu={(e) => e.preventDefault()}
			onwheel={(e) => {
				e.preventDefault();
				void captured(wheelStroke(e));
			}}
			{@attach (el: HTMLElement) => el.focus()}
		>
			Press a key, click or scroll here. Escape cancels.
			{#if bindings.some((b) => b.kind === 'wheel')}
				<p class="text-xs text-muted-foreground">A bound wheel direction won’t scroll the quiz area; long answers still show a scrollbar.</p>
			{/if}
		</div>
	{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
	<Button
		variant="outline"
		onclick={async () => {
			const ok = await confirmAction({
				title: 'Reset the controls to their defaults?',
				body: 'Every binding you added or removed on this device is replaced by the defaults. Your other devices keep their own, unless you then use the defaults for them too.',
				action: 'Reset to defaults'
			});
			if (ok) await save(DEFAULT_BINDINGS, 'Reset on this device');
		}}>Reset controls to defaults</Button
	>
	{#if offer}
		{#key offer.serial}<ApplyWider saved={offer.saved} offers={everyDevice} />{/key}
	{/if}
</div>
