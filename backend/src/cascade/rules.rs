//! The cascade rules as pure functions (PLAN.md § Cascade Rules, § Rule
//! implementation, § Operations). The same rules live in TypeScript in
//! `frontend/src/lib/cascade/`, and both pass the shared vectors in
//! `contract-fixtures/cascade/`.
//!
//! Each function takes the cascade's and the quiz's state and returns what
//! must change; the caller (the sync endpoint, or the in-memory model the
//! vectors run) writes it. The completion counters are the one thing these
//! functions change themselves, on the `CascadeState` they are given, so no
//! caller can forget them.

use serde::{Deserialize, Serialize};

use super::order::reset_seed;
use super::rows::{Origin, Progression};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "grade", rename_all = "snake_case")]
pub enum Grade {
    Correct,
    Missed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "finish_outcome", rename_all = "snake_case")]
pub enum Outcome {
    Cleared,
    Replaced,
    Descended,
    Completed,
    Reshuffled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Cleared => "cleared",
            Outcome::Replaced => "replaced",
            Outcome::Descended => "descended",
            Outcome::Completed => "completed",
            Outcome::Reshuffled => "reshuffled",
        }
    }
}

/// The fixed vocabulary of rejection reasons, which monitoring counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NotFound,
    Trashed,
    NotActive,
    NotDeepest,
    StaleAttempt,
    Ungraded,
    BadSegment,
    DuplicateSegment,
    Stale,
    NotCleared,
    NotTrashed,
    BadCursor,
    /// A finish from an account past five times its storage limit.
    StorageLimit,
    Invalid,
    Error,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NotFound => "not_found",
            Reason::Trashed => "trashed",
            Reason::NotActive => "not_active",
            Reason::NotDeepest => "not_deepest",
            Reason::StaleAttempt => "stale_attempt",
            Reason::Ungraded => "ungraded",
            Reason::BadSegment => "bad_segment",
            Reason::DuplicateSegment => "duplicate_segment",
            Reason::Stale => "stale",
            Reason::NotCleared => "not_cleared",
            Reason::NotTrashed => "not_trashed",
            Reason::BadCursor => "bad_cursor",
            Reason::StorageLimit => "storage_limit",
            Reason::Invalid => "invalid",
            Reason::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Opts {
    pub segment_size: u32,
    pub progression: Progression,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeState {
    pub clear_threshold: u32,
    pub opts: Opts,
    pub depth: u32,
    pub peak_depth: u32,
    pub attempts_since_completion: u32,
    pub trashed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuizState {
    pub level: u32,
    pub origin: Origin,
    pub segment_chain: bool,
    pub attempt: u32,
    pub seed: u64,
    pub question_count: u32,
    pub cursor: u32,
    pub run_start: u32,
    pub active: bool,
}

/// A quiz a rule creates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewQuiz {
    pub level: u32,
    pub origin: Origin,
    /// Ascending.
    pub questions: Vec<u32>,
    pub seed: u64,
    pub segment_chain: bool,
    pub origin_attempt: u32,
    pub origin_segment_end: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishResult {
    /// Level ≥ 2 only: the quiz goes to the Trash; a replacement at the same
    /// level, or none (the level is removed).
    Finished { cleared: bool, replacement: Option<NewQuiz> },
    /// Ladder, or the Source quiz under any progression: the quiz is reset
    /// and a new quiz created at level + 1.
    Descended { reset_seed: u64, new_level: NewQuiz },
    /// The Source quiz with no misses: reset in place; the cascade completes.
    /// `levels` and `attempts` are the counters before they reset.
    Completed { reset_seed: u64, levels: u32, attempts: u32 },
    /// Nothing correct: reset in place.
    Reshuffled { reset_seed: u64 },
}

impl FinishResult {
    pub fn outcome(&self) -> Outcome {
        match self {
            FinishResult::Finished { cleared: true, .. } => Outcome::Cleared,
            FinishResult::Finished { cleared: false, .. } => Outcome::Replaced,
            FinishResult::Descended { .. } => Outcome::Descended,
            FinishResult::Completed { .. } => Outcome::Completed,
            FinishResult::Reshuffled { .. } => Outcome::Reshuffled,
        }
    }

    pub fn new_quiz(&self) -> Option<&NewQuiz> {
        match self {
            FinishResult::Finished { replacement, .. } => replacement.as_ref(),
            FinishResult::Descended { new_level, .. } => Some(new_level),
            _ => None,
        }
    }

    pub fn reset_seed(&self) -> Option<u64> {
        match self {
            FinishResult::Descended { reset_seed, .. }
            | FinishResult::Completed { reset_seed, .. }
            | FinishResult::Reshuffled { reset_seed } => Some(*reset_seed),
            FinishResult::Finished { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmentResult {
    /// The run's misses, one level down, a segment chain.
    Drilled(NewQuiz),
    /// Nothing missed in the run.
    Continued,
}

/// A restored quiz: the new deepest level, with a new attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    pub level: u32,
    pub attempt: u32,
    pub seed: u64,
    /// The cascade was trashed and comes back with it.
    pub cascade_restored: bool,
}

/// The segment size the rules read for a quiz: the cascade's, which every
/// level reads (no quiz holds a copy), but 0 for a chain, for 0, and at or
/// above the question count.
pub fn effective_segment_size(c: &CascadeState, q: &QuizState) -> u32 {
    let s = c.opts.segment_size;
    if q.segment_chain || s == 0 || s >= q.question_count {
        0
    } else {
        s
    }
}

/// The smallest multiple of the segment size above the cursor and below the
/// question count; `None` when segments are off, at or above the count, or
/// for a chain — so nothing ever divides by the size.
pub fn next_boundary(c: &CascadeState, q: &QuizState) -> Option<u32> {
    let s = effective_segment_size(c, q);
    if s == 0 {
        return None;
    }
    let b = (q.cursor / s + 1) * s;
    (b < q.question_count).then_some(b)
}

/// `run a of b · c of d`, from the current segment size (PLAN.md § Segments →
/// How a run is numbered). `None` for an unsegmented quiz.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunIndicator {
    pub run: u32,
    pub total: u32,
    pub position: u32,
    pub length: u32,
}

impl std::fmt::Display for RunIndicator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "run {} of {} · {} of {}", self.run, self.total, self.position, self.length)
    }
}

pub fn run_indicator(c: &CascadeState, q: &QuizState) -> Option<RunIndicator> {
    let s = effective_segment_size(c, q);
    if s == 0 {
        return None;
    }
    let end = next_boundary(c, q).unwrap_or(q.question_count);
    Some(RunIndicator {
        run: q.run_start / s + 1,
        total: (q.question_count - 1) / s + 1,
        position: q.cursor - q.run_start + 1,
        length: end - q.run_start,
    })
}

// ---------------------------------------------------------------------------
// Checks, in the order the rejection reasons are decided
// ---------------------------------------------------------------------------

/// A trashed cascade is frozen; a cleared quiz takes nothing but a restore or purge.
pub fn check_live(c: &CascadeState, q: &QuizState) -> Result<(), Reason> {
    if c.trashed {
        return Err(Reason::Trashed);
    }
    if !q.active {
        return Err(Reason::NotActive);
    }
    Ok(())
}

pub fn check_attempt(q: &QuizState, attempt: u32, attempt_seed: u64) -> Result<(), Reason> {
    if attempt != q.attempt || attempt_seed != q.seed {
        return Err(Reason::StaleAttempt);
    }
    Ok(())
}

pub fn check_deepest(c: &CascadeState, q: &QuizState) -> Result<(), Reason> {
    if q.level != c.depth {
        return Err(Reason::NotDeepest);
    }
    Ok(())
}

/// Not below `run_start`, and below the next boundary, or the question count
/// when there is none.
pub fn check_move_cursor(c: &CascadeState, q: &QuizState, position: u32) -> Result<(), Reason> {
    let limit = next_boundary(c, q).unwrap_or(q.question_count);
    if position < q.run_start || position >= limit {
        return Err(Reason::BadCursor);
    }
    Ok(())
}

/// The segment end's own validity: a segment size, a multiple of it, strictly
/// inside the quiz. The duplicate and cursor checks come after (see `finish_segment`).
pub fn check_segment_end(c: &CascadeState, q: &QuizState, end: u32) -> Result<(), Reason> {
    let s = c.opts.segment_size;
    if q.segment_chain || s == 0 || !end.is_multiple_of(s) || end == 0 || end >= q.question_count {
        return Err(Reason::BadSegment);
    }
    Ok(())
}

/// A run that has been passed cannot be finished again.
pub fn check_segment_past_cursor(q: &QuizState, end: u32) -> Result<(), Reason> {
    if end <= q.cursor {
        return Err(Reason::BadSegment);
    }
    Ok(())
}

/// Option values: segment size 0 or 5 to the cap; progression is typed already.
pub fn check_segment_size(size: i64, cap: u32) -> Result<u32, Reason> {
    if size == 0 || (5..=i64::from(cap)).contains(&size) {
        Ok(size as u32)
    } else {
        Err(Reason::Invalid)
    }
}

/// A clear threshold is a whole percentage from 1 to 100.
pub fn check_clear_threshold(t: i64) -> Result<u32, Reason> {
    if (1..=100).contains(&t) {
        Ok(t as u32)
    } else {
        Err(Reason::Invalid)
    }
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

fn push_depth(c: &mut CascadeState) {
    c.depth += 1;
    c.peak_depth = c.peak_depth.max(c.depth);
}

/// Finishing an attempt (PLAN.md § Cascade Rules, § The Source quiz,
/// § Progression). `misses` are the missed question indexes, ascending.
/// Every finish counts toward `attempts_since_completion`; a descent raises
/// `peak_depth`; a completion reports both and resets them to 1 and 0.
pub fn finish(c: &mut CascadeState, q: &QuizState, correct: u32, misses: Vec<u32>, seed: u64) -> FinishResult {
    let count = q.question_count;
    let missed = misses.len() as u32;
    // Compared exactly, in integers.
    let passed = u64::from(correct) * 100 >= u64::from(c.clear_threshold) * u64::from(count);
    c.attempts_since_completion += 1;
    let reset = reset_seed(seed);
    let new_quiz = |level: u32, origin: Origin, chain: bool, questions: Vec<u32>, origin_attempt| NewQuiz {
        level,
        origin,
        questions,
        seed,
        segment_chain: chain,
        origin_attempt,
        origin_segment_end: None,
    };
    if q.level == 1 {
        if missed == 0 {
            let (levels, attempts) = (c.peak_depth, c.attempts_since_completion);
            c.peak_depth = 1;
            c.attempts_since_completion = 0;
            return FinishResult::Completed { reset_seed: reset, levels, attempts };
        }
        if correct == 0 {
            return FinishResult::Reshuffled { reset_seed: reset };
        }
        // The Source quiz's misses always go down, whatever the score.
        let n = new_quiz(2, Origin::Descent, false, misses, q.attempt);
        push_depth(c);
        return FinishResult::Descended { reset_seed: reset, new_level: n };
    }
    if correct == 0 {
        return FinishResult::Reshuffled { reset_seed: reset };
    }
    // The cascade's progression, which every level reads; a chain is Drill for life.
    let progression = if q.segment_chain { Progression::Drill } else { c.opts.progression };
    if progression == Progression::Ladder && !passed {
        let n = new_quiz(q.level + 1, Origin::Descent, false, misses, q.attempt);
        push_depth(c);
        return FinishResult::Descended { reset_seed: reset, new_level: n };
    }
    // Cleared, or under Drill replaced: the quiz goes to the Trash.
    if misses.is_empty() {
        c.depth -= 1;
        return FinishResult::Finished { cleared: passed, replacement: None };
    }
    let origin = if passed { Origin::ClearReplacement } else { Origin::DrillReplacement };
    let n = new_quiz(q.level, origin, q.segment_chain, misses, q.attempt);
    FinishResult::Finished { cleared: passed, replacement: Some(n) }
}

/// Moving on from the last question of a run that is not the last run.
/// `run_misses` are the questions missed in positions `run_start` … `end − 1`,
/// ascending. The caller sets the cursor and `run_start` to `end`.
pub fn finish_segment(c: &mut CascadeState, q: &QuizState, run_misses: Vec<u32>, end: u32, seed: u64) -> SegmentResult {
    if run_misses.is_empty() {
        return SegmentResult::Continued;
    }
    let n = NewQuiz {
        level: q.level + 1,
        origin: Origin::Segment,
        questions: run_misses,
        seed,
        segment_chain: true,
        origin_attempt: q.attempt,
        origin_segment_end: Some(end),
    };
    push_depth(c);
    SegmentResult::Drilled(n)
}

/// Restoring a cleared quiz: the new deepest level, attempt + 1, shuffled
/// with the seed unmodified. A trashed cascade comes back with it.
pub fn restore_quiz(c: &mut CascadeState, q: &QuizState, seed: u64) -> Restored {
    let cascade_restored = c.trashed;
    c.trashed = false;
    push_depth(c);
    Restored { level: c.depth, attempt: q.attempt + 1, seed, cascade_restored }
}
