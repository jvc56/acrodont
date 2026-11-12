//! The pull (PLAN.md § The sync cycle → Pull). Rows with `updated_seq` past
//! the cursor and at most the ceiling, in table order — cascades, quizzes,
//! quiz attempts, quiz questions, tombstones — each table by primary key, at
//! most `PAGE_ROWS` rows of any kind per page. The page token fixes the
//! ceiling and `question_rows_for`, so a paged pull is one snapshot.

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use uuid::Uuid;

use super::PAGE_ROWS;
use crate::cascade::order::from_i64;
use crate::cascade::rows::{self, CascadeRow, QuizRow};
use crate::cascade::rules::{Grade, Outcome};

pub const TABLES: [&str; 5] = ["cascades", "quizzes", "quiz_attempts", "quiz_questions", "tombstones"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageToken {
    /// The user the pull belongs to.
    pub u: Uuid,
    /// The cursor, or `None` for a full pull.
    pub cur: Option<i64>,
    /// The ceiling: the sequence the first page's push took.
    pub ceil: i64,
    /// `question_rows_for`, fixed for the whole pull.
    pub qrf: Vec<Uuid>,
    /// The table to resume in and the primary key it stopped at.
    pub table: usize,
    pub after: Vec<String>,
}

impl PageToken {
    pub fn encode(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect("token"))
    }

    pub fn decode(s: &str) -> Option<Self> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AttemptRow {
    pub quiz_id: Uuid,
    pub attempt: i32,
    pub question_count: i32,
    pub correct_count: i32,
    pub missed_count: i32,
    pub outcome: Outcome,
    #[serde(with = "rows::u64_text")]
    pub shuffle_seed: i64,
    pub finished_at: DateTime<Utc>,
    #[serde(with = "rows::seq_text")]
    pub updated_seq: i64,
}

/// A quiz's graded rows in this page, as parallel arrays, with the lowest
/// `updated_seq` among them.
#[derive(Debug, Clone, Serialize, Default)]
pub struct QuestionGroup {
    pub quiz_id: Uuid,
    pub question_idx: Vec<i32>,
    pub grade: Vec<Grade>,
    pub graded_at: Vec<DateTime<Utc>>,
    pub min_updated_seq: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tombstone {
    pub entity: String,
    pub entity_id: Uuid,
    pub seq: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Changes {
    pub cascades: Vec<CascadeRow>,
    pub quizzes: Vec<QuizRow>,
    pub quiz_attempts: Vec<AttemptRow>,
    pub quiz_questions: Vec<QuestionGroup>,
    pub tombstones: Vec<Tombstone>,
}

/// The cascade rows of a page: `$1` user, `$2`..`$3` the sequence range,
/// `$4` the last id sent, `$5` the limit. Public so the scale test can
/// `EXPLAIN` the query the pull runs.
pub fn cascades_sql() -> String {
    format!(
        "{} WHERE c.user_id = $1 AND c.updated_seq > $2 AND c.updated_seq <= $3 AND c.id > $4
         ORDER BY c.id LIMIT $5",
        rows::CASCADE_SELECT
    )
}

/// The quiz rows of a page, bound as [`cascades_sql`].
pub fn quizzes_sql() -> String {
    format!(
        "{} WHERE q.user_id = $1 AND q.updated_seq > $2 AND q.updated_seq <= $3 AND q.id > $4
         ORDER BY q.id LIMIT $5",
        rows::QUIZ_SELECT
    )
}

/// The attempt rows of a page: `$4`, `$5` the last (quiz, attempt) sent, `$6` the limit.
pub const ATTEMPTS_SQL: &str = "SELECT quiz_id, attempt, question_count, correct_count, missed_count, outcome, shuffle_seed,
        finished_at, updated_seq
 FROM quiz_attempts
 WHERE user_id = $1 AND updated_seq > $2 AND updated_seq <= $3 AND (quiz_id, attempt) > ($4, $5)
 ORDER BY quiz_id, attempt LIMIT $6";

/// One page from `start`. Returns the changes and the token for the next
/// page, if the page filled.
pub async fn page(conn: &mut PgConnection, start: &PageToken) -> Result<(Changes, Option<PageToken>), sqlx::Error> {
    let user = start.u;
    let floor = start.cur.unwrap_or(-1);
    let ceil = start.ceil;
    let mut out = Changes::default();
    let mut left = PAGE_ROWS;
    for table in start.table..TABLES.len() {
        let after: &[String] = if table == start.table { &start.after } else { &[] };
        let fetch = left + 1;
        let next = |after: Vec<String>| PageToken { table, after, ..start.clone() };
        match table {
            0 => {
                let last = after.first().and_then(|s| s.parse::<Uuid>().ok()).unwrap_or(Uuid::nil());
                let mut rows: Vec<CascadeRow> = sqlx::query_as(sqlx::AssertSqlSafe(cascades_sql()))
                .bind(user)
                .bind(floor)
                .bind(ceil)
                .bind(last)
                .bind(fetch)
                .fetch_all(&mut *conn)
                .await?;
                if rows.len() as i64 > left {
                    rows.truncate(left as usize);
                    let k = rows.last().map(|r| r.id.to_string()).unwrap_or_default();
                    out.cascades = rows;
                    return Ok((out, Some(next(vec![k]))));
                }
                left -= rows.len() as i64;
                out.cascades = rows;
            }
            1 => {
                let last = after.first().and_then(|s| s.parse::<Uuid>().ok()).unwrap_or(Uuid::nil());
                let mut rows: Vec<QuizRow> = sqlx::query_as(sqlx::AssertSqlSafe(quizzes_sql()))
                .bind(user)
                .bind(floor)
                .bind(ceil)
                .bind(last)
                .bind(fetch)
                .fetch_all(&mut *conn)
                .await?;
                if rows.len() as i64 > left {
                    rows.truncate(left as usize);
                    let k = rows.last().map(|r| r.id.to_string()).unwrap_or_default();
                    out.quizzes = rows;
                    return Ok((out, Some(next(vec![k]))));
                }
                left -= rows.len() as i64;
                out.quizzes = rows;
            }
            2 => {
                let last_quiz = after.first().and_then(|s| s.parse::<Uuid>().ok()).unwrap_or(Uuid::nil());
                let last_attempt: i32 = after.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                let mut rows: Vec<AttemptRow> = sqlx::query_as(ATTEMPTS_SQL)
                .bind(user)
                .bind(floor)
                .bind(ceil)
                .bind(last_quiz)
                .bind(last_attempt)
                .bind(fetch)
                .fetch_all(&mut *conn)
                .await?;
                if rows.len() as i64 > left {
                    rows.truncate(left as usize);
                    let k = rows.last().map(|r| vec![r.quiz_id.to_string(), r.attempt.to_string()]).unwrap_or_default();
                    out.quiz_attempts = rows;
                    return Ok((out, Some(next(k))));
                }
                left -= rows.len() as i64;
                out.quiz_attempts = rows;
            }
            3 => {
                if start.qrf.is_empty() {
                    continue;
                }
                let last_quiz = after.first().and_then(|s| s.parse::<Uuid>().ok()).unwrap_or(Uuid::nil());
                let last_idx: i32 = after.get(1).and_then(|s| s.parse().ok()).unwrap_or(-1);
                // Graded rows of active quizzes of the cascades in question_rows_for.
                let mut rows = crate::cards::graded_since(
                    conn,
                    user,
                    &start.qrf,
                    floor,
                    ceil,
                    last_quiz,
                    last_idx,
                    fetch.max(0) as usize,
                )
                .await?;
                let more = rows.len() as i64 > left;
                if more {
                    rows.truncate(left as usize);
                }
                let key = rows.last().map(|r| vec![r.0.to_string(), r.1.to_string()]).unwrap_or_default();
                left -= rows.len() as i64;
                let mut groups: Vec<QuestionGroup> = Vec::new();
                let mut mins: Vec<i64> = Vec::new();
                for (quiz, idx, grade, at, seq) in rows {
                    if groups.last().map(|g| g.quiz_id) != Some(quiz) {
                        groups.push(QuestionGroup { quiz_id: quiz, ..Default::default() });
                        mins.push(seq);
                    }
                    let g = groups.last_mut().unwrap();
                    g.question_idx.push(idx);
                    g.grade.push(grade);
                    g.graded_at.push(at);
                    let m = mins.last_mut().unwrap();
                    *m = (*m).min(seq);
                }
                for (g, m) in groups.iter_mut().zip(mins) {
                    g.min_updated_seq = m.to_string();
                }
                out.quiz_questions = groups;
                if more {
                    return Ok((out, Some(next(key))));
                }
            }
            _ => {
                if start.cur.is_none() {
                    // A full pull carries no tombstones.
                    continue;
                }
                let last_entity = after.first().cloned().unwrap_or_default();
                let last_id = after.get(1).and_then(|s| s.parse::<Uuid>().ok()).unwrap_or(Uuid::nil());
                let mut rows: Vec<(String, Uuid, i64)> = sqlx::query_as(
                    "SELECT entity::text, entity_id, seq FROM sync_tombstones
                     WHERE user_id = $1 AND seq > $2 AND seq <= $3 AND (entity::text, entity_id) > ($4, $5)
                     ORDER BY entity::text, entity_id LIMIT $6",
                )
                .bind(user)
                .bind(floor)
                .bind(ceil)
                .bind(&last_entity)
                .bind(last_id)
                .bind(fetch)
                .fetch_all(&mut *conn)
                .await?;
                let more = rows.len() as i64 > left;
                if more {
                    rows.truncate(left as usize);
                }
                let key = rows.last().map(|r| vec![r.0.clone(), r.1.to_string()]).unwrap_or_default();
                out.tombstones =
                    rows.into_iter().map(|(entity, entity_id, seq)| Tombstone { entity, entity_id, seq: seq.to_string() }).collect();
                if more {
                    return Ok((out, Some(next(key))));
                }
            }
        }
    }
    Ok((out, None))
}

pub fn hash_text(v: i64) -> String {
    from_i64(v).to_string()
}
