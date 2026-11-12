//! A level's questions and their grades, packed (PLAN.md § Storage limit,
//! the `quiz_cards` table): one row per chunk of up to 256 of the level's
//! questions in idx order, each question's grade, time, sync sequence and
//! device at the same place in the chunk's arrays. A question's position in
//! the attempt is not stored; [`order`] computes it from the seed.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::cascade::order::shuffle;
use crate::cascade::rules::Grade;

/// Questions per chunk.
pub const CHUNK: usize = 256;

/// One stored chunk.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Chunk {
    pub quiz_id: Uuid,
    pub first_idx: i32,
    /// The chunk's questions, ascending; `None` for the Source quiz's run
    /// `first_idx, first_idx + 1, …`.
    pub idxs: Option<Vec<i32>>,
    /// 0 ungraded, 1 correct, 2 missed.
    pub grades: Vec<u8>,
    pub graded_at: Vec<Option<DateTime<Utc>>>,
    pub graded_seq: Vec<Option<i64>>,
    /// 1-based into `devices`.
    pub graded_by: Vec<Option<i16>>,
    pub devices: Vec<Uuid>,
    pub updated_seq: i64,
}

/// One question's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Card {
    pub idx: u32,
    pub grade: Option<Grade>,
    pub graded_at: Option<DateTime<Utc>>,
    pub graded_seq: Option<i64>,
    pub graded_by: Option<Uuid>,
}

pub fn grade_byte(g: Option<Grade>) -> u8 {
    match g {
        None => 0,
        Some(Grade::Correct) => 1,
        Some(Grade::Missed) => 2,
    }
}

fn grade_of(b: u8) -> Option<Grade> {
    match b {
        1 => Some(Grade::Correct),
        2 => Some(Grade::Missed),
        _ => None,
    }
}

impl Chunk {
    pub fn len(&self) -> usize {
        self.grades.len()
    }

    pub fn is_empty(&self) -> bool {
        self.grades.is_empty()
    }

    pub fn idx(&self, slot: usize) -> u32 {
        match &self.idxs {
            Some(v) => v[slot] as u32,
            None => (self.first_idx as usize + slot) as u32,
        }
    }

    pub fn slot_of(&self, idx: u32) -> Option<usize> {
        match &self.idxs {
            Some(v) => v.binary_search(&(idx as i32)).ok(),
            None => {
                let s = i64::from(idx) - i64::from(self.first_idx);
                (s >= 0 && (s as usize) < self.len()).then_some(s as usize)
            }
        }
    }

    pub fn card(&self, slot: usize) -> Card {
        Card {
            idx: self.idx(slot),
            grade: grade_of(self.grades[slot]),
            graded_at: self.graded_at[slot],
            graded_seq: self.graded_seq[slot],
            graded_by: self.graded_by[slot].and_then(|i| self.devices.get(i as usize - 1).copied()),
        }
    }

    pub fn cards(&self) -> impl Iterator<Item = Card> + '_ {
        (0..self.len()).map(|s| self.card(s))
    }
}

macro_rules! columns {
    () => {
        "quiz_id, first_idx, idxs, grades, graded_at, graded_seq, graded_by, devices, updated_seq"
    };
}

/// Stores a new level's questions, all ungraded. `idxs` ascending; the Source
/// quiz's are `0 … n−1`, kept implicit.
pub async fn insert(conn: &mut PgConnection, quiz: Uuid, idxs: &[u32], source: bool, seq: i64) -> Result<(), sqlx::Error> {
    if idxs.is_empty() {
        return Ok(());
    }
    let v: Vec<i32> = idxs.iter().map(|&i| i as i32).collect();
    sqlx::query(
        "INSERT INTO quiz_cards (quiz_id, first_idx, idxs, grades, graded_at, graded_seq, graded_by, updated_seq)
         SELECT $1, ($2::int4[])[k * 256 + 1],
                CASE WHEN $3 THEN NULL ELSE ($2::int4[])[k * 256 + 1 : k * 256 + m] END,
                decode(repeat('00', m), 'hex'),
                array_fill(NULL::timestamptz, ARRAY[m]), array_fill(NULL::int8, ARRAY[m]),
                array_fill(NULL::int2, ARRAY[m]), $4
         FROM generate_series(0, (cardinality($2::int4[]) - 1) / 256) AS k,
              LATERAL (SELECT least(256, cardinality($2::int4[]) - k * 256) AS m) AS l",
    )
    .bind(quiz)
    .bind(&v)
    .bind(source)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// Every chunk of a quiz, in idx order.
pub async fn load(conn: &mut PgConnection, quiz: Uuid) -> Result<Vec<Chunk>, sqlx::Error> {
    sqlx::query_as(concat!("SELECT ", columns!(), " FROM quiz_cards WHERE quiz_id = $1 ORDER BY first_idx"))
        .bind(quiz)
        .fetch_all(conn)
        .await
}

/// The chunks holding the questions in `from … to−1` (idx), in idx order.
pub async fn load_range(conn: &mut PgConnection, quiz: Uuid, from: i32, to: i32) -> Result<Vec<Chunk>, sqlx::Error> {
    sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM quiz_cards
         WHERE quiz_id = $1 AND first_idx < $3
           AND first_idx >= coalesce((SELECT max(first_idx) FROM quiz_cards WHERE quiz_id = $1 AND first_idx <= $2), 0)
         ORDER BY first_idx"
    ))
    .bind(quiz)
    .bind(from)
    .bind(to)
    .fetch_all(conn)
    .await
}

/// The chunk that would hold `idx`, if the quiz has the question.
pub async fn chunk_of(conn: &mut PgConnection, quiz: Uuid, idx: u32) -> Result<Option<(Chunk, usize)>, sqlx::Error> {
    let c: Option<Chunk> = sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM quiz_cards WHERE quiz_id = $1 AND first_idx <= $2 ORDER BY first_idx DESC LIMIT 1"
    ))
    .bind(quiz)
    .bind(idx as i32)
    .fetch_optional(conn)
    .await?;
    Ok(c.and_then(|c| c.slot_of(idx).map(|s| (c, s))))
}

/// The quiz's questions, ascending, read without their grades.
pub async fn members(conn: &mut PgConnection, quiz: Uuid) -> Result<Vec<u32>, sqlx::Error> {
    let rows: Vec<(i32, Option<Vec<i32>>, i32)> = sqlx::query_as(
        "SELECT first_idx, idxs, octet_length(grades) FROM quiz_cards WHERE quiz_id = $1 ORDER BY first_idx",
    )
    .bind(quiz)
    .fetch_all(conn)
    .await?;
    let mut out = Vec::new();
    for (first, idxs, n) in rows {
        match idxs {
            Some(v) => out.extend(v.into_iter().map(|i| i as u32)),
            None => out.extend((first..first + n).map(|i| i as u32)),
        }
    }
    Ok(out)
}

/// Every question's state, in idx order.
pub async fn cards(conn: &mut PgConnection, quiz: Uuid) -> Result<Vec<Card>, sqlx::Error> {
    Ok(load(conn, quiz).await?.iter().flat_map(|c| c.cards().collect::<Vec<_>>()).collect())
}

/// The quiz's questions in the order of the attempt played under `seed`.
pub fn order(cards: &[Card], seed: u64) -> Vec<u32> {
    let idx: Vec<u32> = cards.iter().map(|c| c.idx).collect();
    shuffle(&idx, seed)
}

/// Each question's grade by idx.
pub fn grades_by_idx(cards: &[Card]) -> HashMap<u32, Option<Grade>> {
    cards.iter().map(|c| (c.idx, c.grade)).collect()
}

/// Sets one question's grade in its chunk.
pub async fn set_grade(
    conn: &mut PgConnection,
    chunk: &Chunk,
    slot: usize,
    grade: Grade,
    at: DateTime<Utc>,
    seq: i64,
    device: Uuid,
) -> Result<(), sqlx::Error> {
    let mut devices = chunk.devices.clone();
    let by = match devices.iter().position(|d| *d == device) {
        Some(i) => i + 1,
        None => {
            devices.push(device);
            devices.len()
        }
    };
    let i = slot as i32 + 1;
    sqlx::query(
        "UPDATE quiz_cards SET grades = set_byte(grades, $3 - 1, $4), graded_at[$3] = $5, graded_seq[$3] = $6,
                               graded_by[$3] = $7, devices = $8, updated_seq = greatest(updated_seq, $6)
         WHERE quiz_id = $1 AND first_idx = $2",
    )
    .bind(chunk.quiz_id)
    .bind(chunk.first_idx)
    .bind(i)
    .bind(i32::from(grade_byte(Some(grade))))
    .bind(at)
    .bind(seq)
    .bind(by as i16)
    .bind(&devices)
    .execute(conn)
    .await?;
    Ok(())
}

/// Clears every grade of a quiz, for a new attempt.
pub async fn reset(conn: &mut PgConnection, quiz: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE quiz_cards SET grades = decode(repeat('00', octet_length(grades)), 'hex'),
                               graded_at = array_fill(NULL::timestamptz, ARRAY[octet_length(grades)]),
                               graded_seq = array_fill(NULL::int8, ARRAY[octet_length(grades)]),
                               graded_by = array_fill(NULL::int2, ARRAY[octet_length(grades)]),
                               devices = '{}'
         WHERE quiz_id = $1",
    )
    .bind(quiz)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn delete(conn: &mut PgConnection, quizzes: &[Uuid]) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM quiz_cards WHERE quiz_id = ANY($1)").bind(quizzes).execute(conn).await?;
    Ok(())
}

/// A pull's page of graded questions (PLAN.md § The sync cycle): those of the
/// user's active quizzes in `cascades` graded at a sequence in `floor+1 …
/// ceil`, after `(after_quiz, after_idx)`, in (quiz, idx) order, at most
/// `limit` of them.
#[allow(clippy::too_many_arguments)]
pub async fn graded_since(
    conn: &mut PgConnection,
    user: Uuid,
    cascades: &[Uuid],
    floor: i64,
    ceil: i64,
    after_quiz: Uuid,
    after_idx: i32,
    limit: usize,
) -> Result<Vec<(Uuid, i32, Grade, DateTime<Utc>, i64)>, sqlx::Error> {
    const BATCH: i64 = 64;
    let mut out = Vec::new();
    // The chunk holding after_idx, then every later one.
    let start: i32 = sqlx::query_scalar(
        "SELECT coalesce((SELECT max(first_idx) FROM quiz_cards WHERE quiz_id = $1 AND first_idx <= $2), -1)",
    )
    .bind(after_quiz)
    .bind(after_idx)
    .fetch_one(&mut *conn)
    .await?;
    let (mut kq, mut kf, mut inclusive) = (after_quiz, start, true);
    loop {
        let chunks: Vec<Chunk> = sqlx::query_as(
            "SELECT c.quiz_id, c.first_idx, c.idxs, c.grades, c.graded_at, c.graded_seq, c.graded_by, c.devices, c.updated_seq
             FROM quiz_cards c JOIN quizzes q ON q.id = c.quiz_id
             WHERE q.user_id = $1 AND q.status = 'active' AND q.cascade_id = ANY($2) AND c.updated_seq > $3
               AND (CASE WHEN $6 THEN (c.quiz_id, c.first_idx) >= ($4, $5) ELSE (c.quiz_id, c.first_idx) > ($4, $5) END)
             ORDER BY c.quiz_id, c.first_idx LIMIT $7",
        )
        .bind(user)
        .bind(cascades)
        .bind(floor)
        .bind(kq)
        .bind(kf)
        .bind(inclusive)
        .bind(BATCH)
        .fetch_all(&mut *conn)
        .await?;
        let done = (chunks.len() as i64) < BATCH;
        for c in &chunks {
            for card in c.cards() {
                let (Some(g), Some(at), Some(seq)) = (card.grade, card.graded_at, card.graded_seq) else { continue };
                if seq <= floor || seq > ceil || (c.quiz_id, card.idx as i32) <= (after_quiz, after_idx) {
                    continue;
                }
                out.push((c.quiz_id, card.idx as i32, g, at, seq));
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
        match chunks.last() {
            Some(c) if !done => {
                (kq, kf, inclusive) = (c.quiz_id, c.first_idx, false);
            }
            _ => return Ok(out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(first: i32, idxs: Option<Vec<i32>>, n: usize) -> Chunk {
        Chunk {
            quiz_id: Uuid::nil(),
            first_idx: first,
            idxs,
            grades: vec![0; n],
            graded_at: vec![None; n],
            graded_seq: vec![None; n],
            graded_by: vec![None; n],
            devices: vec![],
            updated_seq: 1,
        }
    }

    #[test]
    fn slots_and_idxs() {
        let s = chunk(256, None, 10);
        assert_eq!(s.idx(3), 259);
        assert_eq!(s.slot_of(259), Some(3));
        assert_eq!(s.slot_of(266), None);
        assert_eq!(s.slot_of(255), None);
        let l = chunk(4, Some(vec![4, 9, 30]), 3);
        assert_eq!(l.idx(2), 30);
        assert_eq!(l.slot_of(9), Some(1));
        assert_eq!(l.slot_of(10), None);
    }

    #[test]
    fn a_card_reads_its_device_and_grade() {
        let mut c = chunk(0, None, 2);
        let d = Uuid::from_u128(7);
        c.grades[1] = 2;
        c.graded_by[1] = Some(1);
        c.devices = vec![d];
        assert_eq!(c.card(1).grade, Some(Grade::Missed));
        assert_eq!(c.card(1).graded_by, Some(d));
        assert_eq!(c.card(0).grade, None);
        assert_eq!(c.card(0).graded_by, None);
    }
}
