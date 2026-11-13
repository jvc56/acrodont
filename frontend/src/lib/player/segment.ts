// The status bar's two rows (PLAN.md § Taking a quiz → Desktop layout). The
// Level row describes the level being worked through; under it, when that
// level is studied in segments, the Segment row gives the same figures for
// the segment the user is in, or for the drill of that segment's misses.
//
// A drill is its own quiz one level down (a segment chain), but to the user
// it is part of the segment: while one is played the Level row stays on the
// segmented level above it, and the Segment row counts the drill as the
// segment's next pass.
import { runIndicator } from '$lib/cascade/rules';
import { quizState } from '$lib/local/apply';
import type { QuizRow } from '$lib/local/rows';

export interface SegmentRow {
	/** Which segment of the level, from 1, and how many the level has. */
	segment: number;
	total: number;
	/** 1 for the segment itself; 2, 3, … for each pass of the drill of its misses. */
	pass: number;
	/** The card shown, from 1, of the segment's (or the drill's) questions. */
	position: number;
	length: number;
	correct: number;
	missed: number;
}

export interface StatusRows {
	/** The quiz the Level row describes: the one played, or the segmented level whose segment it drills. */
	level: QuizRow;
	/** Whether `level` is the quiz played: its card position is then the card shown, not its cursor. */
	played: boolean;
	segment: SegmentRow | null;
}

type Grade = 'correct' | 'missed' | null | undefined;

/** The effective segment size of a quiz as the rules see it; 0 when it is not segmented. */
function sizeOf(q: QuizRow): number {
	return q.segment_chain || q.segment_size === 0 || q.segment_size >= q.question_count ? 0 : q.segment_size;
}

/**
 * The drill `quiz` belongs to: the segmented quiz above it, which of its
 * segments ended where the drill began, and the pass this is. Null when
 * `quiz` is not a drill, or its level is no longer studied in segments.
 */
function drillOf(quiz: QuizRow, quizzes: QuizRow[]): { parent: QuizRow; segment: number; total: number; pass: number } | null {
	if (!quiz.segment_chain) return null;
	const byId = new Map(quizzes.map((q) => [q.id, q]));
	// Back through the drills this one replaced, to the one a segment's misses made.
	let passes = quiz.attempt;
	let first: QuizRow | undefined = quiz;
	for (let hops = 0; first && first.origin !== 'segment' && hops < 10_000; hops++) {
		first = first.origin_quiz_id ? byId.get(first.origin_quiz_id) : undefined;
		if (first) passes += first.attempt;
	}
	// A purged drill breaks the trail: the level above, whose run boundary the drill began at, still stands.
	const parent =
		(first?.origin_quiz_id ? byId.get(first.origin_quiz_id) : undefined) ??
		quizzes.find((q) => q.status === 'active' && q.level === quiz.level - 1 && !q.segment_chain);
	if (!parent) return null;
	const size = sizeOf(parent);
	if (size === 0) return null;
	const end = first?.origin_segment_end ?? parent.run_start;
	return {
		parent,
		segment: Math.max(1, Math.ceil(end / size)),
		total: Math.floor((parent.question_count - 1) / size) + 1,
		pass: 1 + passes
	};
}

/**
 * What the status bar shows for the quiz being played: `pos` is the position
 * of the card shown, and `gradeAt` the grade of the question at a position of
 * the quiz played, in this pass.
 */
export function statusRows(quiz: QuizRow, quizzes: QuizRow[], pos: number, gradeAt: (position: number) => Grade): StatusRows {
	const drill = drillOf(quiz, quizzes);
	if (drill) {
		return {
			level: drill.parent,
			played: false,
			segment: {
				segment: drill.segment,
				total: drill.total,
				pass: drill.pass,
				position: pos + 1,
				length: quiz.question_count,
				correct: quiz.correct_count,
				missed: quiz.missed_count
			}
		};
	}
	const ri = runIndicator(quizState(quiz));
	if (!ri) return { level: quiz, played: true, segment: null };
	let correct = 0;
	let missed = 0;
	for (let p = quiz.run_start; p < quiz.run_start + ri.length; p++) {
		const g = gradeAt(p);
		if (g === 'correct') correct++;
		else if (g === 'missed') missed++;
	}
	return {
		level: quiz,
		played: true,
		segment: {
			segment: ri.run,
			total: ri.total,
			pass: 1,
			// A card shown from before the segment (never by the rules) still reads as its first.
			position: Math.min(ri.length, Math.max(1, pos - quiz.run_start + 1)),
			length: ri.length,
			correct,
			missed
		}
	};
}

/** `segment 2 of 6`, for the level list. */
export function segmentText(q: QuizRow): string | null {
	const ri = runIndicator(quizState(q));
	return ri ? `segment ${ri.run} of ${ri.total}` : null;
}
