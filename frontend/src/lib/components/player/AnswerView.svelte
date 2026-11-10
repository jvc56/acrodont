<script lang="ts">
	// The answer Show / Next reveals (PLAN.md § Taking a quiz → Answers):
	// anagrams one per line in the card's order, hooks Zyzzyva-style and
	// lower-cased only for single ASCII letters, definitions beneath; a
	// definition's text; a leave value at the user's decimals, '-' only for a negative one.
	// Unfound words are highlighted after a typed-mode reveal; before it, only the
	// words typed so far show, bare: no hooks, inner hooks or definitions, which
	// would give hints. The words and a leave value are drawn in the answer font
	// and size (lib/player/display), which match the question's by default. Every
	// size is scaled by the CSS variable --fit, which the player lowers to fit the
	// answer on the screen.
	import TileText from '$lib/components/TileText.svelte';
	import { leaveValueText } from '$lib/cascade/leave';
	import { textStyle } from '$lib/player/display.svelte';
	import type { PreferencesRow } from '$lib/local/rows';

	interface Word {
		word: string;
		front_hooks?: string;
		back_hooks?: string;
		/** Whether the word less its first (front) or last (back) tile is a word: the inner hooks. */
		front_inner?: boolean;
		back_inner?: boolean;
		definition?: string;
	}

	let {
		quizType,
		answer,
		prefs,
		found = null,
		font = 'Inter',
		size = 36,
		spacing = 0,
		definition = { font: 'Inter', size: 20, spacing: 0 },
		word = null,
		typing = null
	}: {
		quizType: string;
		answer: unknown;
		prefs: PreferencesRow;
		/** Words found in typed mode; the others are highlighted. */
		found?: string[] | null;
		/** Any font name the device has. */
		font?: string;
		/** px */
		size?: number;
		/** Extra letter spacing in em; 0 is the browser's normal. */
		spacing?: number;
		/** Definitions' own typeface, size (px) and spacing: a Definition quiz's answer and the line under each anagram. */
		definition?: { font: string; size: number; spacing: number };
		/** A Definition card's word with its hooks, shown above the definition. */
		word?: Word | null;
		/** Typed mode before the reveal: the words found so far, shown bare. */
		typing?: string[] | null;
	} = $props();
	/** A text style whose size follows the player's fit factor. */
	const fitted = (style: string) => style.replace(/font-size: ([\d.]+)px;/, 'font-size: calc($1px * var(--fit, 1));');
	/** Hooks, front | word | back: equal side columns put the words in one straight column, centred. */
	const columns = 'grid-template-columns: 1fr auto 1fr;';
	let definitionStyle = $derived(
		fitted(textStyle(definition.font, definition.size, definition.spacing)).replace('line-height: 1.2;', 'line-height: 1.4;')
	);
	let answerStyle = $derived(fitted(textStyle(font, size, spacing)));

	let all = $derived(Array.isArray(answer) ? (answer as Word[]) : []);
	let words = $derived(typing ? all.filter((w) => typing.includes(w.word)) : all);
	let hooks = $derived(!typing && prefs.anagram_show_hooks);
	let definitions = $derived(!typing && prefs.anagram_show_definitions);
	let missingDefinitions = $derived(quizType === 'anagram' && definitions && words.some((w) => w.definition === undefined));
</script>

{#snippet hooked(w: Word, hooks: boolean, missing = false)}
	<!-- Front hooks right-aligned, the word with its inner-hook dots, back hooks left-aligned. -->
	<span class="justify-self-end text-[0.75em] font-normal text-muted-foreground">
		{#if hooks && w.front_hooks}<TileText text={w.front_hooks} lower />{/if}
	</span>
	<span data-answer class="justify-self-start font-semibold whitespace-nowrap" class:text-destructive={missing}>
		<span class:invisible={!(hooks && w.front_inner)} aria-hidden={!(hooks && w.front_inner)}>·</span><TileText text={w.word} /><span
			class:invisible={!(hooks && w.back_inner)}
			aria-hidden={!(hooks && w.back_inner)}>·</span
		>
	</span>
	<span class="justify-self-start text-[0.75em] font-normal text-muted-foreground">
		{#if hooks && w.back_hooks}<TileText text={w.back_hooks} lower />{/if}
	</span>
{/snippet}

{#if quizType === 'anagram'}
	<!-- A list of the anagrams; each item is `display: contents`, so its cells stay in the grid's columns. -->
	<div role="list" class="grid w-full items-baseline gap-x-3" style={`${columns} ${answerStyle} row-gap: calc(0.5rem * var(--fit, 1));`} data-typing={typing ? '' : undefined}>
		{#each words as w (w.word)}
			<div role="listitem" class="contents">
				{@render hooked(w, hooks, !typing && found !== null && !found.includes(w.word))}
				{#if definitions && w.definition}
					<div class="mx-auto max-w-2xl text-center font-normal text-muted-foreground" style={`grid-column: 1 / -1; ${definitionStyle}`}>
						{w.definition}
					</div>
				{/if}
			</div>
		{/each}
	</div>
	{#if missingDefinitions}
		<p class="mt-2 text-center text-sm text-muted-foreground">Definitions are downloading.</p>
	{/if}
{:else if quizType === 'definition'}
	<!-- The word with its hooks and inner hooks, then the definition: prose, in the definitions' own typeface and size. -->
	{#if word}
		<div class="mb-4 grid w-full items-baseline gap-x-3" style={`${columns} ${answerStyle}`}>
			{@render hooked(word, true)}
		</div>
	{/if}
	<p class="mx-auto max-w-2xl text-center" style={definitionStyle}>{String(answer)}</p>
{:else}
	<p class="text-center font-semibold" style={answerStyle}>{leaveValueText(Number(answer), prefs.leave_value_decimals)}</p>
{/if}
