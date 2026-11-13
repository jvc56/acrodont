//! An account's server storage (PLAN.md § Storage limit): what a cascade or a
//! saved search holds, computed from counts with fixed sizes, and the one
//! per-account limit checked when something new is made.
//!
//! The sizes are `contract-fixtures/storage.json`, shared with the device's
//! estimate. They are constants here too, so the backend image builds from
//! `backend/` alone; a unit test keeps the two equal, and the integration test
//! `tests/storage.rs` checks them against what Postgres measures.

use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::ApiError;
use crate::search::wire::{Params, WireGroup, WireNode};

/// Bytes per live row or packed entry, index and tuple overhead included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowBytes {
    pub cascade_row: i64,
    /// A question in `cascades.question_keys`: its line break; its key's
    /// bytes are added on top.
    pub question: i64,
    pub quiz_row: i64,
    /// A `quiz_cards` row (a chunk of up to 256 questions), without its questions.
    pub chunk_row: i64,
    /// One question of a level in its chunk, at its graded size (its grade
    /// and its record), so a level's figure does not grow as it is studied.
    pub card: i64,
    /// A level's question index, stored as its difference from the one
    /// before, for every level but the Source quiz.
    pub card_idx: i64,
    pub attempt_row: i64,
    /// A spec's `search_specs` row with its group and condition rows.
    pub spec_row: i64,
    /// An In Word List entry in `search_conditions.entries`: its line break;
    /// its bytes are added on top.
    pub spec_word: i64,
}

pub const ROW_BYTES: RowBytes = RowBytes {
    cascade_row: 380,
    question: 1,
    quiz_row: 430,
    chunk_row: 200,
    card: 8,
    card_idx: 1,
    attempt_row: 210,
    spec_row: 380,
    spec_word: 1,
};

/// A level (a quiz) of `question_count` questions; `source` for the Source
/// quiz, whose question indexes are implied.
pub fn level_bytes(question_count: i64, source: bool) -> i64 {
    let b = ROW_BYTES;
    let chunks = (question_count + crate::cards::CHUNK as i64 - 1) / crate::cards::CHUNK as i64;
    b.quiz_row + chunks * b.chunk_row + question_count * (b.card + if source { 0 } else { b.card_idx })
}

/// One finished attempt's row.
pub fn attempt_bytes() -> i64 {
    ROW_BYTES.attempt_row
}

/// A spec: its row, and each In Word List entry as stored (deduplicated per
/// condition, as `insert_spec` stores them).
pub fn spec_bytes(tree: &WireGroup) -> i64 {
    fn words(g: &WireGroup) -> i64 {
        g.children
            .iter()
            .map(|c| match c {
                WireNode::Group(sub) => words(sub),
                WireNode::Condition(cond) => match &cond.params {
                    Params::Entries(entries) => {
                        let mut uniq: Vec<&String> = entries.iter().collect();
                        uniq.sort();
                        uniq.dedup();
                        uniq.iter().map(|e| ROW_BYTES.spec_word + e.len() as i64).sum()
                    }
                    _ => 0,
                },
            })
            .sum()
    }
    ROW_BYTES.spec_row + words(tree)
}

/// A cascade as created: its row, its questions with their keys' bytes, the
/// Source quiz as one level, and its spec.
pub fn new_cascade_bytes(question_count: i64, key_bytes: i64, spec_bytes: i64) -> i64 {
    ROW_BYTES.cascade_row + question_count * ROW_BYTES.question + key_bytes + level_bytes(question_count, true) + spec_bytes
}

/// The account's figure and its effective limit, for `/api/auth/me`, every
/// sync response and the refusals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub used: i64,
    pub limit: i64,
}

impl Usage {
    pub fn new(used: i64, override_limit: Option<i64>, default_limit: u64) -> Self {
        Usage { used, limit: override_limit.unwrap_or(i64::try_from(default_limit).unwrap_or(i64::MAX)) }
    }

    pub fn json(&self) -> serde_json::Value {
        json!({ "used": self.used, "limit": self.limit })
    }

    /// `409 { error: "storage_limit", used, limit, needed }`.
    pub fn refusal(&self, needed: i64) -> ApiError {
        ApiError::Conflict(json!({ "error": "storage_limit", "used": self.used, "limit": self.limit, "needed": needed }))
    }

    /// Whether `needed` more bytes fit. Nothing new fits once the account is
    /// at its limit; a change that adds nothing is never refused.
    pub fn fits(&self, needed: i64) -> bool {
        needed <= 0 || self.used.saturating_add(needed) <= self.limit
    }
}

/// The account's usage now; under the user row's lock, the figure the check uses.
pub async fn usage(conn: &mut PgConnection, user: Uuid, default_limit: u64) -> Result<Usage, sqlx::Error> {
    let r = sqlx::query!("SELECT storage_bytes, storage_limit_bytes FROM users WHERE id = $1", user)
        .fetch_one(conn)
        .await?;
    Ok(Usage::new(r.storage_bytes, r.storage_limit_bytes, default_limit))
}

/// Adds `delta` to a cascade's figure and its user's total, stamping the
/// cascade with `seq` so the change reaches every device's pull. A figure
/// never goes below zero: what a purge frees is counted again from the rows
/// with today's `ROW_BYTES`, and rows stored under other constants would
/// otherwise take the figure negative, fail its CHECK and stop the purge.
/// The recount corrects the total either way.
pub async fn add_to_cascade(conn: &mut PgConnection, user: Uuid, cascade: Uuid, delta: i64, seq: i64) -> Result<(), sqlx::Error> {
    if delta == 0 {
        return Ok(());
    }
    sqlx::query!(
        "UPDATE cascades SET storage_bytes = greatest(storage_bytes + $2, 0), updated_seq = $3 WHERE id = $1",
        cascade,
        delta,
        seq
    )
    .execute(&mut *conn)
    .await?;
    add_to_user(conn, user, delta).await
}

pub async fn add_to_user(conn: &mut PgConnection, user: Uuid, delta: i64) -> Result<(), sqlx::Error> {
    if delta == 0 {
        return Ok(());
    }
    sqlx::query!("UPDATE users SET storage_bytes = greatest(storage_bytes + $2, 0) WHERE id = $1", user, delta)
        .execute(conn)
        .await?;
    Ok(())
}

/// What purging these quizzes frees, per cascade: each quiz's level and its
/// attempt rows.
pub async fn quizzes_bytes(conn: &mut PgConnection, quizzes: &[Uuid]) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT q.cascade_id,
                  sum($2::int8 + ((q.question_count::int8 + 255) / 256) * $3::int8
                      + q.question_count::int8 * ($4::int8 + CASE WHEN q.origin = 'source' THEN 0 ELSE $5::int8 END)
                      + $6::int8 * (SELECT count(*) FROM quiz_attempts a WHERE a.quiz_id = q.id))::int8 AS "bytes!"
           FROM quizzes q WHERE q.id = ANY($1) GROUP BY q.cascade_id"#,
        quizzes,
        ROW_BYTES.quiz_row,
        ROW_BYTES.chunk_row,
        ROW_BYTES.card,
        ROW_BYTES.card_idx,
        ROW_BYTES.attempt_row,
    )
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|r| (r.cascade_id, r.bytes)).collect())
}

/// A spec's figure from its stored rows.
pub async fn measure_spec(conn: &mut PgConnection, spec: Uuid) -> Result<i64, sqlx::Error> {
    // Each entry ends with its line break, so the text's length is the
    // entries' bytes plus one `spec_word` for each.
    sqlx::query_scalar!(
        r#"SELECT ($2::int8 + coalesce(sum(octet_length(entries)), 0))::int8 AS "bytes!"
           FROM search_conditions WHERE spec_id = $1"#,
        spec,
        ROW_BYTES.spec_row,
    )
    .fetch_one(conn)
    .await
}

/// A cascade's figure counted again from every row it holds: a scan of its
/// questions and levels, for tests and for setting up rows written straight
/// to the database. The server keeps `cascades.storage_bytes` without it.
pub async fn measure_cascade(conn: &mut PgConnection, cascade: Uuid) -> Result<i64, sqlx::Error> {
    let r = sqlx::query!(
        r#"SELECT c.spec_id,
                  octet_length(c.question_keys)::int8 AS "keys_and_breaks!",
                  (SELECT count(*) FROM quizzes WHERE cascade_id = c.id) AS "quizzes!",
                  (SELECT count(*) FROM quiz_cards k JOIN quizzes q ON q.id = k.quiz_id
                    WHERE q.cascade_id = c.id) AS "chunks!",
                  (SELECT coalesce(sum(k.n), 0)::int8 FROM quiz_cards k JOIN quizzes q ON q.id = k.quiz_id
                    WHERE q.cascade_id = c.id) AS "cards!",
                  (SELECT coalesce(sum(k.n) FILTER (WHERE k.idxs IS NOT NULL), 0)::int8 FROM quiz_cards k JOIN quizzes q ON q.id = k.quiz_id
                    WHERE q.cascade_id = c.id) AS "indexed!",
                  (SELECT count(*) FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
                    WHERE q.cascade_id = c.id) AS "attempts!"
           FROM cascades c WHERE c.id = $1"#,
        cascade
    )
    .fetch_one(&mut *conn)
    .await?;
    let b = ROW_BYTES;
    // Each key ends with its line break, so the text's length is the keys'
    // bytes plus one `question` per question.
    Ok(b.cascade_row
        + r.keys_and_breaks
        + r.quizzes * b.quiz_row
        + r.chunks * b.chunk_row
        + r.cards * b.card
        + r.indexed * b.card_idx
        + r.attempts * b.attempt_row
        + measure_spec(conn, r.spec_id).await?)
}

/// The users whose total differs from the sum of their cascades' and saved
/// searches' figures, each corrected and logged. Run by the purge task.
pub async fn recount_users(db: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    let drifted = sqlx::query!(
        r#"WITH sums AS (
               SELECT u.id,
                      u.storage_bytes AS kept,
                      (coalesce((SELECT sum(storage_bytes) FROM cascades c WHERE c.user_id = u.id), 0)
                       + coalesce((SELECT sum(storage_bytes) FROM saved_searches s WHERE s.user_id = u.id), 0))::int8 AS counted
               FROM users u)
           SELECT id, kept, counted AS "counted!" FROM sums WHERE kept IS DISTINCT FROM counted"#
    )
    .fetch_all(db)
    .await?;
    let mut fixed = 0;
    for d in drifted {
        // Recounted under the user's lock, so a change between the two reads is not taken for drift.
        let mut tx = db.begin().await?;
        sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", d.id).fetch_one(&mut *tx).await?;
        let r = sqlx::query!(
            r#"SELECT storage_bytes AS kept,
                      (coalesce((SELECT sum(storage_bytes) FROM cascades WHERE user_id = $1), 0)
                       + coalesce((SELECT sum(storage_bytes) FROM saved_searches WHERE user_id = $1), 0))::int8 AS "counted!"
               FROM users WHERE id = $1"#,
            d.id
        )
        .fetch_one(&mut *tx)
        .await?;
        if r.kept != r.counted {
            tracing::warn!(user = %d.id, kept = r.kept, counted = r.counted, "storage total drifted; recounted");
            sqlx::query!("UPDATE users SET storage_bytes = $2 WHERE id = $1", d.id, r.counted).execute(&mut *tx).await?;
            fixed += 1;
        }
        tx.commit().await?;
    }
    Ok(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::wire::parse_tree;

    #[test]
    fn the_constants_are_the_shared_fixture() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contract-fixtures/storage.json");
        let shared: RowBytes = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
        assert_eq!(shared, ROW_BYTES);
    }

    #[test]
    fn the_formula_against_hand_computed_rows() {
        let b = ROW_BYTES;
        assert_eq!(level_bytes(0, false), b.quiz_row);
        // 1,000 questions are four chunks.
        assert_eq!(level_bytes(1000, true), b.quiz_row + 4 * b.chunk_row + 1000 * b.card);
        assert_eq!(level_bytes(1000, false), b.quiz_row + 4 * b.chunk_row + 1000 * (b.card + b.card_idx));
        assert_eq!(level_bytes(256, false) - b.quiz_row, b.chunk_row + 256 * (b.card + b.card_idx));
        assert_eq!(level_bytes(257, true) - b.quiz_row, 2 * b.chunk_row + 257 * b.card);
        // 1,000 questions of 7-byte keys and a spec with no word list.
        assert_eq!(
            new_cascade_bytes(1000, 7000, b.spec_row),
            b.cascade_row + 1000 * (b.question + 7) + b.quiz_row + 4 * b.chunk_row + 1000 * b.card + b.spec_row
        );
        // A length condition costs nothing past the spec's row; word-list
        // entries are counted once each, duplicates dropped, keys by byte.
        let tree = parse_tree(&json!({ "op": "and", "children": [
            { "type": "length", "negated": false, "min": 7, "max": 8 },
            { "op": "or", "children": [
                { "type": "in_word_list", "negated": false, "entries": ["QI", "QI", "ZA", "ÉTÉ"] } ] } ] }))
        .unwrap();
        assert_eq!(spec_bytes(&tree), b.spec_row + 3 * b.spec_word + 2 + 2 + 5);
    }

    #[test]
    fn the_limit_check() {
        let u = Usage { used: 90, limit: 100 };
        assert!(u.fits(10));
        assert!(!u.fits(11));
        assert!(u.fits(0) && u.fits(-5), "a change that adds nothing is never refused");
        let full = Usage { used: 100, limit: 100 };
        assert!(!full.fits(1));
        let over = Usage { used: 120, limit: 100 };
        assert!(!over.fits(1) && over.fits(-10));
        assert_eq!(Usage::new(5, None, 100_000_000).limit, 100_000_000);
        assert_eq!(Usage::new(5, Some(7), 100_000_000).limit, 7);
    }
}
