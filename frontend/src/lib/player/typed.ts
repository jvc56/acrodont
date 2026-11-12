// Typed mode for Anagram quizzes (PLAN.md § Taking a quiz → Typed mode). The
// input is upper-cased, trimmed and converted to tiles; a word that is one of
// the answers joins the found list, one already entered is ignored, one that is
// not an anagram of the question (other tiles, or another count) is rejected
// and left in the input, and any other anagram is wrong. With alphabetical
// order on, each answer has to be the first one not yet entered: one that skips
// an earlier answer is still found but marked out of order, which misses the
// card at once. Finding every answer does not end the card: Enter on an empty
// input does.
import { BLANK, compareTiles, type Distribution } from '$lib/tiles';

export interface TypedState {
	/** Found answers (MAGPIE notation), in alphabetical order. */
	found: string[];
	/** Found answers entered out of order. */
	outOfOrder: string[];
	/** Wrong entries, as typed: counted against the grade, never shown. */
	wrong: string[];
}

export type Submit =
	| { kind: 'found'; word: string }
	| { kind: 'out_of_order'; word: string }
	| { kind: 'already' }
	/** Not an anagram of the question: left in the input, and no effect on the grade. */
	| { kind: 'not_anagram' }
	| { kind: 'wrong' }
	/** Enter on an empty input: Show / Next. */
	| { kind: 'empty' };

export function emptyTyped(): TypedState {
	return { found: [], outOfOrder: [], wrong: [] };
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Whether `typed` uses exactly the question's tiles, in any order. A blank in
 * the question stands for any one tile, so the typed word must hold every
 * other question tile, and as many tiles in all.
 */
export function isAnagramOf(typed: number[], question: number[]): boolean {
	if (typed.length !== question.length) return false;
	const left = new Map<number, number>();
	for (const t of typed) left.set(t, (left.get(t) ?? 0) + 1);
	for (const t of question) {
		if (t === BLANK) continue;
		const n = left.get(t) ?? 0;
		if (n === 0) return false;
		left.set(t, n - 1);
	}
	return true;
}

/** Enter pressed with `text` in the input; returns the new state and what happened. */
export function submitTyped(
	state: TypedState,
	text: string,
	answers: string[],
	question: number[],
	dist: Distribution,
	alphabetical: boolean
): { state: TypedState; result: Submit } {
	const trimmed = text.trim().toUpperCase();
	if (!trimmed) return { state, result: { kind: 'empty' } };
	let tiles: number[];
	try {
		tiles = dist.parseTyped(trimmed, false);
	} catch {
		// Text that is not even tiles of this distribution cannot be an anagram.
		return { state, result: { kind: 'not_anagram' } };
	}
	if (!isAnagramOf(tiles, question)) return { state, result: { kind: 'not_anagram' } };
	const answer = answers.find((a) => same(dist.parseMagpie(a, false), tiles));
	if (!answer) return { state: { ...state, wrong: [...state.wrong, trimmed] }, result: { kind: 'wrong' } };
	if (state.found.includes(answer)) return { state, result: { kind: 'already' } };
	const found = [...state.found, answer].sort((a, b) => compareTiles(dist.parseMagpie(a, false), dist.parseMagpie(b, false)));
	// In alphabetical order, an answer still to find that sorts before this one was skipped.
	if (alphabetical && answers.some((a) => !state.found.includes(a) && compareTiles(dist.parseMagpie(a, false), tiles) < 0)) {
		return { state: { ...state, found, outOfOrder: [...state.outOfOrder, answer] }, result: { kind: 'out_of_order', word: answer } };
	}
	return { state: { ...state, found }, result: { kind: 'found', word: answer } };
}

/** Every anagram found. */
export function allFound(state: TypedState, answers: string[]): boolean {
	return answers.every((a) => state.found.includes(a));
}

/** Correct only if every anagram was found with no wrong entries (out-of-order ones count as wrong). */
export function typedGrade(state: TypedState, answers: string[]): 'correct' | 'missed' {
	return allFound(state, answers) && state.wrong.length === 0 && state.outOfOrder.length === 0 ? 'correct' : 'missed';
}
