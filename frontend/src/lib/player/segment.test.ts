// The status bar's Level and Segment rows (PLAN.md § Taking a quiz → Desktop layout).
import { describe, expect, it } from 'vitest';
import type { QuizRow } from '$lib/local/rows';
import type { Opts } from '$lib/cascade/rules';
import { segmentText, statusRows } from './segment';

/** A quiz row with only what the rows read. */
function quiz(o: Partial<QuizRow> & { id: string; level: number; question_count: number }): QuizRow {
	return {
		cascade_id: 'c',
		origin: 'source',
		origin_quiz_id: null,
		origin_attempt: null,
		origin_segment_end: null,
		status: 'active',
		segment_chain: false,
		attempt: 1,
		correct_count: 0,
		missed_count: 0,
		cursor: 0,
		run_start: 0,
		shuffle_seed: '1',
		questions_hash: '1',
		...o
	} as QuizRow;
}

const none = () => null;
/** The cascade's options, which every level reads: off, and in fives. */
const OFF: Opts = { segment_size: 0, progression: 'ladder' };
const FIVES: Opts = { segment_size: 5, progression: 'ladder' };
const WIDE: Opts = { segment_size: 100, progression: 'ladder' };

describe('the status bar rows', () => {
	it('a level with no segments has a Level row only', () => {
		const q = quiz({ id: 'a', level: 1, question_count: 27 });
		expect(statusRows(OFF, q, [q], 3, none)).toEqual({ level: q, played: true, segment: null });
		expect(segmentText(OFF, q)).toBeNull();
		// A segment size the level does not reach is no segments at all.
		expect(statusRows(WIDE, q, [q], 0, none).segment).toBeNull();
	});

	it('a segmented level counts the card, the grades and the length within its segment', () => {
		// 27 questions in fives: the card at position 8 is the fourth of segment 2; the last segment holds two.
		const q = quiz({ id: 'a', level: 2, question_count: 27, cursor: 8, run_start: 5, correct_count: 5, missed_count: 3 });
		const grades = ['correct', 'correct', 'missed', 'correct', 'missed', 'correct', 'missed', 'correct', null, null] as const;
		const rows = statusRows(FIVES, q, [q], 8, (p) => grades[p]);
		expect(rows.level).toBe(q);
		expect(rows.segment).toEqual({ segment: 2, total: 6, pass: 1, position: 4, length: 5, correct: 2, missed: 1 });
		expect(segmentText(FIVES, q)).toBe('segment 2 of 6');
		const last = quiz({ id: 'a', level: 2, question_count: 27, cursor: 26, run_start: 25 });
		expect(statusRows(FIVES, last, [last], 26, none).segment).toMatchObject({ segment: 6, total: 6, position: 2, length: 2 });
	});

	it('a drill is its segment’s next pass, with the Level row on the level above', () => {
		const level = quiz({ id: 'L', level: 2, question_count: 27, cursor: 10, run_start: 10, correct_count: 6, missed_count: 4 });
		const drill = quiz({
			id: 'd1', level: 3, question_count: 2, segment_chain: true, origin: 'segment',
			origin_quiz_id: 'L', origin_attempt: 1, origin_segment_end: 10, correct_count: 1, missed_count: 0
		});
		const rows = statusRows(FIVES, drill, [level, drill], 1, none);
		expect(rows.level).toBe(level);
		expect(rows.played).toBe(false);
		expect(rows.segment).toEqual({ segment: 2, total: 6, pass: 2, position: 2, length: 2, correct: 1, missed: 0 });

		// Its one miss drilled again is the third pass; a reshuffled attempt of that, the fourth.
		const first = { ...drill, status: 'cleared' } as QuizRow;
		const again = quiz({ id: 'd2', level: 3, question_count: 1, segment_chain: true, origin: 'drill_replacement', origin_quiz_id: 'd1', origin_attempt: 1 });
		expect(statusRows(FIVES, again, [level, first, again], 0, none).segment).toMatchObject({ segment: 2, total: 6, pass: 3, position: 1, length: 1 });
		expect(statusRows(FIVES, { ...again, attempt: 2 }, [level, first, again], 0, none).segment).toMatchObject({ pass: 4 });

		// With the earlier drill purged from the Trash, the level above still names the segment.
		const orphan = { ...again, origin_quiz_id: null } as QuizRow;
		const kept = statusRows(FIVES, orphan, [level, orphan], 0, none);
		expect(kept.level).toBe(level);
		expect(kept.segment).toMatchObject({ segment: 2, total: 6, pass: 2 });
	});

	it('a drill whose cascade is no longer studied in segments is shown as a level of its own', () => {
		const level = quiz({ id: 'L', level: 2, question_count: 27, cursor: 10, run_start: 10 });
		const drill = quiz({ id: 'd1', level: 3, question_count: 2, segment_chain: true, origin: 'segment', origin_quiz_id: 'L', origin_segment_end: 10 });
		expect(statusRows(OFF, drill, [level, drill], 0, none)).toEqual({ level: drill, played: true, segment: null });
	});
});
