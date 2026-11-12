<script lang="ts">
	// The answer Show / Next reveals (PLAN.md § Taking a quiz → Answers):
	// anagrams one per line in the card's order, hooks Zyzzyva-style and
	// lower-cased only for single ASCII letters; a definition's text; a leave
	// value at the user's decimals, '-' only for a negative one. A word's row
	// is five columns: its probability order (when this device shows it), front
	// hooks, the word with its inner-hook dots, back hooks, and its definition,
	// which this device can put centred under the word instead (and a narrow
	// screen always does).
	// Unfound words are highlighted after a typed-mode reveal; before it, only the
	// words typed so far show, bare: no hooks, inner hooks or definitions, which
	// would give hints. The words and a leave value are drawn in the answer font
	// and size (lib/player/display), which match the question's by default. Every
	// size is scaled by the CSS variable --fit, which the player lowers to fit the
	// answer on the screen.
	import TileText from '$lib/components/TileText.svelte';
	import { leaveValueText } from '$lib/cascade/leave';
	import { textStyle } from '$lib/player/display.svelte';
	import type { CascadeRow } from '$lib/local/rows';

	interface Word {
		word: string;
		front_hooks?: string;
		back_hooks?: string;
		/** Whether the word less its first (front) or last (back) tile is a word: the inner hooks. */
		front_inner?: boolean;
		back_inner?: boolean;
		definition?: string;
		/** Rank by probability among the lexicon's words of this length. */
		probability_order?: number;
	}

	let {
		quizType,
		answer,
		settings,
		found = null,
		font = 'Inter',
		size = 36,
		spacing = 0,
		definition = { font: 'Inter', size: 20, spacing: 0 },
		word = null,
		typing = null,
		definitionColumn = true,
		probability = false
	}: {
		quizType: string;
		answer: unknown;
		/** The cascade's settings for what an answer shows. */
		settings: Pick<CascadeRow, 'show_definitions' | 'show_hooks' | 'leave_value_decimals'>;
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
		/** This device's choice: a definition in a column of its own after the back hooks, or centred under its word. */
		definitionColumn?: boolean;
		/** This device's choice: each word's probability order in a column before the front hooks. */
		probability?: boolean;
	} = $props();
	/** A text style whose size follows the player's fit factor. */
	const fitted = (style: string) => style.replace(/font-size: ([\d.]+)px;/, 'font-size: calc($1px * var(--fit, 1));');
	/**
	 * Probability | front hooks | word | back hooks | definition. The outer two
	 * share what is left equally and each hook cell is as wide as the wider
	 * side's hooks (it holds the other side's too, unseen), so the words sit in
	 * one straight column, centred, whatever the other columns hold.
	 */
	const columns = 'grid-template-columns: minmax(0, 1fr) auto auto auto minmax(0, 1fr);';
	let definitionStyle = $derived(
		fitted(textStyle(definition.font, definition.size, definition.spacing)).replace('line-height: 1.2;', 'line-height: 1.4;')
	);
	let answerStyle = $derived(fitted(textStyle(font, size, spacing)));

	let all = $derived(Array.isArray(answer) ? (answer as Word[]) : []);
	let words = $derived(typing ? all.filter((w) => typing.includes(w.word)) : all);
	let hooks = $derived(!typing && settings.show_hooks !== false);
	let definitions = $derived(!typing && settings.show_definitions !== false);
	/** Typed mode: the word typed last, green among the others. */
	let latest = $derived(typing?.at(-1) ?? null);
	let showProbability = $derived(!typing && probability);
	let missingDefinitions = $derived(quizType === 'anagram' && definitions && words.some((w) => w.definition === undefined));
</script>

{#snippet hookCell(mine: string | undefined, other: string | undefined, side: 'front' | 'back')}
	<!-- This side's hooks over the other side's, unseen, so both hook columns are equally wide. -->
	<span
		class="inline-grid text-[0.75em] font-normal text-muted-foreground"
		class:justify-self-end={side === 'front'}
		class:justify-items-end={side === 'front'}
		class:justify-self-start={side === 'back'}
		style={`grid-column: ${side === 'front' ? 2 : 4};`}
		data-hooks={side}
	>
		<span style="grid-area: 1 / 1;">{#if mine}<TileText text={mine} lower />{/if}</span>
		<span class="invisible" style="grid-area: 1 / 1;" aria-hidden="true">{#if other}<TileText text={other} lower />{/if}</span>
	</span>
{/snippet}

{#snippet hooked(w: Word, hooks: boolean, missing = false, last = false)}
	<!-- The probability order, front hooks right-aligned, the word with its inner-hook dots, back hooks left-aligned. -->
	<span class="justify-self-end text-[0.75em] font-normal text-muted-foreground tabular-nums" style="grid-column: 1;" data-probability>
		{#if showProbability && w.probability_order}{w.probability_order}{/if}
	</span>
	{@render hookCell(hooks ? w.front_hooks : undefined, hooks ? w.back_hooks : undefined, 'front')}
	<span
		data-answer
		data-latest={last || undefined}
		class="justify-self-start font-semibold whitespace-nowrap"
		class:text-destructive={missing}
		class:text-green-600={last}
		style="grid-column: 3;"
	>
		<span class:invisible={!(hooks && w.front_inner)} aria-hidden={!(hooks && w.front_inner)}>·</span><TileText text={w.word} /><span
			class:invisible={!(hooks && w.back_inner)}
			aria-hidden={!(hooks && w.back_inner)}>·</span
		>
	</span>
	{@render hookCell(hooks ? w.back_hooks : undefined, hooks ? w.front_hooks : undefined, 'back')}
{/snippet}

{#snippet definitionCell(text: string)}
	<!-- In its own column after the back hooks, or (this device's choice, and always on a narrow screen) centred under the word. -->
	<div class="definition font-normal text-muted-foreground" class:own-column={definitionColumn} style={definitionStyle} data-definition>
		{text}
	</div>
{/snippet}

{#if quizType === 'anagram'}
	<!-- A list of the anagrams; each item is `display: contents`, so its cells stay in the grid's columns. -->
	<div role="list" class="grid w-full items-baseline gap-x-3" style={`${columns} ${answerStyle} row-gap: calc(0.5rem * var(--fit, 1));`} data-typing={typing ? '' : undefined}>
		{#each words as w (w.word)}
			<div role="listitem" class="contents">
				{@render hooked(w, hooks, !typing && found !== null && !found.includes(w.word), w.word === latest)}
				{#if definitions && w.definition}{@render definitionCell(w.definition)}{/if}
			</div>
		{/each}
	</div>
	{#if missingDefinitions}
		<p class="mt-2 text-center text-sm text-muted-foreground">Definitions are downloading.</p>
	{/if}
{:else if quizType === 'definition'}
	<!-- The word with its hooks and inner hooks, and the definition: prose, in the definitions' own typeface and size. -->
	{#if word}
		<div class="grid w-full items-baseline gap-x-3" style={`${columns} ${answerStyle} row-gap: 1rem;`}>
			{@render hooked(word, true)}
			<div class="definition" class:own-column={definitionColumn} style={definitionStyle} data-definition>{String(answer)}</div>
		</div>
	{:else}
		<p class="mx-auto max-w-2xl text-center" style={definitionStyle}>{String(answer)}</p>
	{/if}
{:else}
	<p class="text-center font-semibold" style={answerStyle}>{leaveValueText(Number(answer), settings.leave_value_decimals ?? 1)}</p>
{/if}

<style>
	/* Under the word: a row of its own across every column, centred. */
	.definition {
		grid-column: 1 / -1;
		justify-self: center;
		max-width: 42rem;
		text-align: center;
	}
	/* A column of its own, where the screen has room for one. */
	@media (min-width: 640px) {
		.definition.own-column {
			grid-column: 5;
			justify-self: start;
			max-width: none;
			text-align: left;
		}
	}
</style>
