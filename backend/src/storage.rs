//! An account's server storage (STORAGE_LIMIT_PLAN.md § S1, § S2): what a
//! cascade or a saved search holds, computed from row counts with fixed
//! per-row sizes, and the one per-account limit checked when something new is
//! made.
//!
//! The per-row sizes are `contract-fixtures/storage.json`, shared with the
//! device's estimate. They are constants here too, so the backend image builds
//! from `backend/` alone; a unit test keeps the two equal, and the integration
//! test `tests/storage.rs` keeps them within ±20% of what Postgres measures.

use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::ApiError;
use crate::search::wire::{Params, WireGroup, WireNode};

/// Bytes per live row, index and tuple overhead included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowBytes {
    pub cascade_row: i64,
    /// A `cascade_questions` row; its key's bytes are added on top.
    pub question_row: i64,
    pub quiz_row: i64,
    /// A `quiz_questions` row, at its graded size, so a level's figure does
    /// not grow as it is studied.
    pub quiz_question_row: i64,
    pub attempt_row: i64,
    /// A spec's `search_specs` row with its group and condition rows.
    pub spec_row: i64,
    /// A `search_condition_words` row; its entry's bytes are added on top.
    pub spec_word_row: i64,
}

pub const ROW_BYTES: RowBytes = RowBytes {
    cascade_row: 380,
    question_row: 94,
    quiz_row: 420,
    quiz_question_row: 188,
    attempt_row: 176,
    spec_row: 380,
    spec_word_row: 100,
};

/// A level (a quiz) of `question_count` questions.
pub fn level_bytes(question_count: i64) -> i64 {
    ROW_BYTES.quiz_row + question_count * ROW_BYTES.quiz_question_row
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
                        uniq.iter().map(|e| ROW_BYTES.spec_word_row + e.len() as i64).sum()
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
    ROW_BYTES.cascade_row + question_count * ROW_BYTES.question_row + key_bytes + level_bytes(question_count) + spec_bytes
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
/// cascade with `seq` so the change reaches every device's pull.
pub async fn add_to_cascade(conn: &mut PgConnection, user: Uuid, cascade: Uuid, delta: i64, seq: i64) -> Result<(), sqlx::Error> {
    if delta == 0 {
        return Ok(());
    }
    sqlx::query!(
        "UPDATE cascades SET storage_bytes = storage_bytes + $2, updated_seq = $3 WHERE id = $1",
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
    sqlx::query!("UPDATE users SET storage_bytes = storage_bytes + $2 WHERE id = $1", user, delta)
        .execute(conn)
        .await?;
    Ok(())
}

/// What purging these quizzes frees, per cascade: each quiz's level and its
/// attempt rows.
pub async fn quizzes_bytes(conn: &mut PgConnection, quizzes: &[Uuid]) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT q.cascade_id,
                  sum($2::int8 + q.question_count::int8 * $3::int8
                      + $4::int8 * (SELECT count(*) FROM quiz_attempts a WHERE a.quiz_id = q.id))::int8 AS "bytes!"
           FROM quizzes q WHERE q.id = ANY($1) GROUP BY q.cascade_id"#,
        quizzes,
        ROW_BYTES.quiz_row,
        ROW_BYTES.quiz_question_row,
        ROW_BYTES.attempt_row,
    )
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|r| (r.cascade_id, r.bytes)).collect())
}

/// A spec's figure from its stored rows.
pub async fn measure_spec(conn: &mut PgConnection, spec: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT ($2::int8 + coalesce(sum($3::int8 + octet_length(entry)), 0))::int8 AS "bytes!"
           FROM search_condition_words WHERE spec_id = $1"#,
        spec,
        ROW_BYTES.spec_row,
        ROW_BYTES.spec_word_row,
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
                  (SELECT count(*) FROM cascade_questions WHERE cascade_id = c.id) AS "questions!",
                  (SELECT coalesce(sum(octet_length(question_key)), 0)::int8 FROM cascade_questions
                    WHERE cascade_id = c.id) AS "key_bytes!",
                  (SELECT count(*) FROM quizzes WHERE cascade_id = c.id) AS "quizzes!",
                  (SELECT count(*) FROM quiz_questions qq JOIN quizzes q ON q.id = qq.quiz_id
                    WHERE q.cascade_id = c.id) AS "quiz_questions!",
                  (SELECT count(*) FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
                    WHERE q.cascade_id = c.id) AS "attempts!"
           FROM cascades c WHERE c.id = $1"#,
        cascade
    )
    .fetch_one(&mut *conn)
    .await?;
    let b = ROW_BYTES;
    Ok(b.cascade_row
        + r.questions * b.question_row
        + r.key_bytes
        + r.quizzes * b.quiz_row
        + r.quiz_questions * b.quiz_question_row
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
        assert_eq!(level_bytes(0), b.quiz_row);
        assert_eq!(level_bytes(1000), b.quiz_row + 1000 * b.quiz_question_row);
        // 1,000 questions of 7-byte keys and a spec with no word list.
        assert_eq!(
            new_cascade_bytes(1000, 7000, b.spec_row),
            b.cascade_row + 1000 * (b.question_row + 7) + b.quiz_row + 1000 * b.quiz_question_row + b.spec_row
        );
        // A length condition costs nothing past the spec's row; word-list
        // entries are counted once each, duplicates dropped, keys by byte.
        let tree = parse_tree(&json!({ "op": "and", "children": [
            { "type": "length", "negated": false, "min": 7, "max": 8 },
            { "op": "or", "children": [
                { "type": "in_word_list", "negated": false, "entries": ["QI", "QI", "ZA", "ÉTÉ"] } ] } ] }))
        .unwrap();
        assert_eq!(spec_bytes(&tree), b.spec_row + 3 * b.spec_word_row + 2 + 2 + 5);
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
