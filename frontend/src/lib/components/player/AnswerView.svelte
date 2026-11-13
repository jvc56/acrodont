<script lang="ts">
	// The answer Show / Next reveals (PLAN.md § Taking a quiz → Answers):
	// anagrams one per line in the card's order, hooks Zyzzyva-style and
	// lower-cased only for single ASCII letters; a definition's text, a line for
	// each part of speech; a leave value at the user's decimals, '-' only for a
	// negative one. A word's row is five columns: its probability order (when
	// the cascade shows it), front hooks, the word with its inner-hook dots,
	// back hooks, and its definition, which the cascade can put centred under
	// the word instead (and a narrow screen always does). The word is in the
	// middle of the row whatever sits either side; each hook column is as wide
	// as its widest hooks and no wider; the definition takes the room that is
	// left, up to this device's limit. The probability order, hooks and word
	// share one line, and that line and the definition are centred on each
	// other however many lines the definition wraps to; a short part of
	// speech ("[n -S]") is never split.
	// Unfound words are highlighted after a typed-mode reveal; before it, only the
	// words typed so far show, bare: no hooks, inner hooks or definitions, which
	// would give hints. The words and a leave value are drawn in the answer font
	// and size (lib/player/display), which match the question's by default. Every
	// size is scaled by the CSS variable --fit, which the player lowers to fit the
	// answer on the screen.
	import TileText from '$lib/components/TileText.svelte';
	import { definitionLines, splitTag, unbroken } from '$lib/cascade/definition';
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
		definitionWidth = 0,
		hookSize = 27
	}: {
		quizType: string;
		answer: unknown;
		/** The cascade's settings for what an answer shows. */
		settings: Pick<CascadeRow, 'show_definitions' | 'show_hooks' | 'leave_value_decimals'> & Partial<Pick<CascadeRow, 'show_probability' | 'definition_column'>>;
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
		/** This device's choice: the definition column's greatest width in px; 0 is all the room there is. */
		definitionWidth?: number;
		/** This device's choice: the size of the hooks and the probability order, in px. */
		hookSize?: number;
	} = $props();
	/** A text style whose size follows the player's fit factor. */
	const fitted = (style: string) => style.replace(/font-size: ([\d.]+)px;/, 'font-size: calc($1px * var(--fit, 1));');
	let definitionStyle = $derived(
		fitted(textStyle(definition.font, definition.size, definition.spacing)).replace('line-height: 1.2;', 'line-height: 1.4;')
	);
	let answerStyle = $derived(fitted(textStyle(font, size, spacing)));
	let hookStyle = $derived(`font-size: calc(${hookSize}px * var(--fit, 1));`);
	/**
	 * For the rows' stylesheet: the definition column's limit, and the two sizes
	 * a word's line holds, which every cell of the line is given (see .strut).
	 */
	let rowVars = $derived(
		`--answer-size: calc(${size}px * var(--fit, 1)); --hook-size: calc(${hookSize}px * var(--fit, 1));` +
			(definitionWidth > 0 ? ` --definition-width: ${definitionWidth}px;` : '')
	);

	let all = $derived(Array.isArray(answer) ? (answer as Word[]) : []);
	let words = $derived(typing ? all.filter((w) => typing.includes(w.word)) : all);
	let hooks = $derived(!typing && settings.show_hooks !== false);
	let definitions = $derived(!typing && settings.show_definitions !== false);
	/** Typed mode: the word typed last, green among the others. */
	let latest = $derived(typing?.at(-1) ?? null);
	/** The cascade's choice: a definition in a column of its own after the back hooks, or centred under its word. */
	let definitionColumn = $derived(settings.definition_column !== false);
	let showProbability = $derived(!typing && settings.show_probability === true);
	let missingDefinitions = $derived(quizType === 'anagram' && definitions && words.some((w) => w.definition === undefined));

	/** Hooks as TileText draws them with `lower`: single ASCII letters lower-cased, a multi-character tile as written. */
	const drawn = (h: string) => h.replace(/\[[^\]]*\]|[A-Z]/g, (m) => (m.length === 1 ? m.toLowerCase() : m));
	/**
	 * Every row's hooks on one side, a line each: drawn unseen in each row's
	 * hook cell, they make the cell as wide as the side's widest hooks, so the
	 * cells of a side are one column. (In a stylesheet's `content`, so the
	 * other rows' hooks are not part of a row's text.)
	 */
	const widest = (rows: Word[], side: 'front_hooks' | 'back_hooks') =>
		rows
			.map((w) => drawn(w[side] ?? ''))
			.filter((h) => h !== '')
			.join('\n');
</script>

{#snippet hookCell(mine: string | undefined, sizes: string, side: 'front' | 'back')}
	<span class="hooks inline-grid font-normal text-muted-foreground" class:justify-items-end={side === 'front'} style={hookStyle} data-hooks={side}>
		<span style="grid-area: 1 / 1;"><span class="strut"></span>{#if mine}<TileText text={mine} lower />{/if}</span>
		{#if sizes}<span class="sizer" style="grid-area: 1 / 1;" data-sizes={sizes} aria-hidden="true"></span>{/if}
	</span>
{/snippet}

{#snippet lines(text: string)}
	<!-- A line for each part of speech; a short part of speech stays whole when its line wraps. -->
	{#each definitionLines(text) as line, i (i)}
		{@const [meaning, tag] = splitTag(line)}
		<span class="line" data-line>{unbroken(meaning)}{#if tag}<span class="whitespace-nowrap">{unbroken(tag)}</span>{/if}</span>
	{/each}
{/snippet}

{#snippet row(w: Word, hooks: boolean, peers: Word[], text: string | undefined, muted: boolean, missing = false, last = false)}
	<!-- Left of the word: the probability order, then the front hooks, right-aligned against the word. -->
	<span class="left">
		<span class="justify-self-end font-normal text-muted-foreground tabular-nums" style={hookStyle} data-probability>
			<span class="strut"></span>{#if showProbability && w.probability_order}{w.probability_order}{/if}
		</span>
		{@render hookCell(hooks ? w.front_hooks : undefined, hooks ? widest(peers, 'front_hooks') : '', 'front')}
	</span>
	<span
		data-answer
		data-latest={last || undefined}
		class="word font-semibold whitespace-nowrap"
		class:text-destructive={missing}
		class:text-green-600={last}
	>
		<span class="strut"></span><span class:invisible={!(hooks && w.front_inner)} aria-hidden={!(hooks && w.front_inner)}>·</span><TileText text={w.word} /><span
			class:invisible={!(hooks && w.back_inner)}
			aria-hidden={!(hooks && w.back_inner)}>·</span
		>
	</span>
	<!-- Right of the word: the back hooks, then the definition in its column; or (the cascade's choice,
	     and always on a narrow screen) the definition on a row of its own, centred under the word. -->
	<span class="right" class:own-column={definitionColumn}>
		{@render hookCell(hooks ? w.back_hooks : undefined, hooks ? widest(peers, 'back_hooks') : '', 'back')}
		{#if text !== undefined}
			<span class="definition font-normal" class:text-muted-foreground={muted} style={definitionStyle} data-definition>
				{@render lines(text)}
			</span>
		{/if}
	</span>
{/snippet}

{#if quizType === 'anagram'}
	<!-- A list of the anagrams; each item is `display: contents`, so its cells stay in the grid's columns. -->
	<div role="list" class="rows" style={`${answerStyle} ${rowVars} row-gap: calc(0.5rem * var(--fit, 1));`} data-typing={typing ? '' : undefined}>
		{#each words as w (w.word)}
			<div role="listitem" class="contents">
				{@render row(w, hooks, words, definitions ? w.definition : undefined, true, !typing && found !== null && !found.includes(w.word), w.word === latest)}
			</div>
		{/each}
	</div>
	{#if missingDefinitions}
		<p class="mt-2 text-center text-sm text-muted-foreground">Definitions are downloading.</p>
	{/if}
{:else if quizType === 'definition'}
	<!-- The word with its hooks and inner hooks, and the definition: prose, in the definitions' own typeface and size. -->
	{#if word}
		<div class="rows" style={`${answerStyle} ${rowVars} row-gap: 1rem;`}>
			{@render row(word, true, [word], String(answer), false)}
		</div>
	{:else}
		<p class="mx-auto max-w-2xl text-center" style={definitionStyle}>
			{@render lines(String(answer))}
		</p>
	{/if}
{:else}
	<p class="text-center font-semibold" style={answerStyle}>{leaveValueText(Number(answer), settings.leave_value_decimals ?? 0)}</p>
{/if}

<style>
	/* Left of the word | the word | right of the word: the outer two share what is left equally, so the word is in the middle.
	   A row's cells are centred on each other: the word's line on its definition, however tall that is. */
	.rows {
		display: grid;
		width: 100%;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		column-gap: 0.75rem;
	}
	.left {
		grid-column: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 0.75rem;
	}
	.word {
		grid-column: 2;
	}
	/* Every cell of a word's line (probability, hooks, word) holds a letter's height at the word's size and
	   at the hooks' size, unseen and without width. So the cells' lines are equally tall with their baselines
	   at the same height, and centring the cells puts their text on one baseline, whichever size is larger. */
	.strut::before,
	.strut::after {
		content: '\200b';
	}
	.strut::before {
		font-size: var(--answer-size);
	}
	.strut::after {
		font-size: var(--hook-size);
	}
	/* Under the word: the back hooks stay on the word's line, and the definition has a row of its own across every column. */
	.right {
		display: contents;
	}
	.right > .hooks {
		grid-column: 3;
		justify-self: start;
	}
	.definition {
		grid-column: 1 / -1;
		justify-self: center;
		max-width: 42rem;
		text-align: center;
	}
	.line {
		display: block;
	}
	/* The other rows' hooks, taking width and nothing else. */
	.sizer {
		height: 0;
		overflow: hidden;
		visibility: hidden;
		white-space: pre;
	}
	.sizer::before {
		content: attr(data-sizes);
	}
	/* A column of its own, where the screen has room for one: after the back hooks, to the edge of
	   the page or this device's limit. */
	@media (min-width: 640px) {
		.right.own-column {
			grid-column: 3;
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			column-gap: 0.75rem;
		}
		.right.own-column > .hooks {
			grid-column: 1;
		}
		.right.own-column > .definition {
			grid-column: 2;
			justify-self: start;
			max-width: var(--definition-width, none);
			text-align: left;
		}
	}
</style>
