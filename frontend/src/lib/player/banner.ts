// The banners after moving on from the last card of an attempt or of a run
// (PLAN.md § Finishing a quiz). Everything is computed from what this device
// did; a finish that comes out differently on the server gets its notice from
// the rebase.
import type { Progression } from '$lib/cascade/rules';

export interface FinishFacts {
	level: number;
	correct: number;
	count: number;
	misses: number;
	threshold: number;
	progression: Progression;
	outcome: string;
	/** Chain quizzes: cleared with no misses returns to the parent's run. */
	segmentChain: boolean;
	completion?: { levels: number; attempts: number };
	/** The level and run the user returns to, for a cleared chain quiz. */
	back?: { level: number; run: number; runs: number };
}

/** Whole percent, rounded down, so a score just short of the threshold never reads as it. */
export function percent(correct: number, count: number): number {
	return count === 0 ? 0 : Math.floor((correct * 100) / count);
}

/** "1 missed question", "5 missed questions". */
const missed = (n: number) => `${n} missed ${n === 1 ? 'question' : 'questions'}`;

export function finishBanner(f: FinishFacts): string {
	const p = percent(f.correct, f.count);
	const n = f.level;
	// A drill of a segment's misses is part of its segment, not a level the user is told of
	// (the status bar keeps to the segmented level above it): its banners say "Drill".
	if (f.segmentChain) {
		if (f.outcome === 'reshuffled') return 'Drill: 0%. Reshuffled. Try again.';
		if (f.outcome === 'replaced' || (f.outcome === 'cleared' && f.misses > 0))
			return `Drill: ${p}%. Now drilling its ${f.misses} missed ${f.misses === 1 ? 'question' : 'questions'}.`;
		if (f.outcome === 'cleared' && f.back) return `Drill done. Back to Level ${f.back.level}, segment ${f.back.run} of ${f.back.runs}.`;
	}
	switch (f.outcome) {
		case 'completed':
			return `Level 1: 100%. Cascade complete after ${f.completion!.levels} ${f.completion!.levels === 1 ? 'level' : 'levels'} and ${f.completion!.attempts} ${f.completion!.attempts === 1 ? 'pass' : 'passes'}.`;
		case 'reshuffled':
			return `Level ${n}: 0%. Reshuffled. Try again.`;
		case 'descended':
			if (n === 1) return `Level 1: ${p}%. Reshuffled, and its ${missed(f.misses)} ${f.misses === 1 ? 'is' : 'are'} now Level 2.`;
			return `Level ${n}: ${p}%, and ${f.threshold}% is needed to clear. Level ${n} is reshuffled and waiting. Down to Level ${n + 1} with ${missed(f.misses)}.`;
		case 'replaced':
			return `Level ${n}: ${p}%. Replaced with its ${missed(f.misses)}.`;
		case 'cleared':
			if (f.misses > 0) return `Level ${n} cleared with ${p}%. Its ${missed(f.misses)} ${f.misses === 1 ? 'is' : 'are'} now Level ${n}.`;
			return `Level ${n} cleared with 100%. Back to Level ${n - 1}.`;
		default:
			return '';
	}
}

export function runBanner(o: { outcome: string; run: number; runs: number; misses: number; level: number }): string {
	if (o.outcome === 'drilled') return `Segment ${o.run} of ${o.runs} done, ${o.misses} missed. Now drilling them.`;
	return `Segment ${o.run} of ${o.runs} done, nothing missed. On to segment ${o.run + 1}.`;
}
