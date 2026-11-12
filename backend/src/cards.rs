//! A level's questions and their grades, packed (PLAN.md § Storage limit,
//! the `quiz_cards` table): one row per chunk of up to 256 of the level's
//! questions in idx order. A chunk's questions are stored as the differences
//! between them, and its grades as two bits a question followed by one short
//! record per graded question (device, sync sequence, time to the second). A
//! question's position in the attempt is not stored; [`order`] computes it
//! from the seed.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::cascade::order::shuffle;
use crate::cascade::rules::Grade;

/// Questions per chunk.
pub const CHUNK: usize = 256;

/// One question's stored state in its chunk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct State {
    /// 0 ungraded, 1 correct, 2 missed.
    pub grade: u8,
    /// Device time of the grade, whole seconds since 1970.
    pub at: Option<i64>,
    pub seq: Option<i64>,
    /// 1-based into the chunk's `devices`.
    pub by: Option<u8>,
}

/// One stored chunk.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub quiz_id: Uuid,
    pub first_idx: i32,
    /// The chunk's questions, ascending; `None` for the Source quiz's run
    /// `first_idx, first_idx + 1, …`.
    pub idxs: Option<Vec<u32>>,
    /// Each question's state, by slot.
    pub states: Vec<State>,
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

/// A time as stored: cut to the whole second.
pub fn to_second(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp(at.timestamp(), 0).unwrap_or(at)
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// The varint at `*p`, advancing it; `None` past the end or over 64 bits.
fn take_varint(bytes: &[u8], p: &mut usize) -> Option<u64> {
    let (mut v, mut shift) = (0u64, 0u32);
    loop {
        let b = *bytes.get(*p)?;
        *p += 1;
        if shift >= 64 {
            return None;
        }
        v |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Some(v);
        }
        shift += 7;
    }
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// A chunk's questions after its first, as varint differences.
pub fn encode_idxs(idxs: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(idxs.len());
    for w in idxs.windows(2) {
        put_varint(&mut out, u64::from(w[1] - w[0]));
    }
    out
}

fn decode_idxs(first: i32, bytes: &[u8]) -> Option<Vec<u32>> {
    let mut out = vec![first as u32];
    let mut p = 0;
    while p < bytes.len() {
        let d = take_varint(bytes, &mut p)?;
        out.push(out.last()?.checked_add(u32::try_from(d).ok()?)?);
    }
    Some(out)
}

/// The `cards` column for these states: `None` when nothing is graded.
pub fn encode_states(states: &[State]) -> Option<Vec<u8>> {
    if states.iter().all(|s| s.grade == 0) {
        return None;
    }
    let mut out = vec![0u8; states.len().div_ceil(4)];
    for (slot, s) in states.iter().enumerate() {
        out[slot / 4] |= (s.grade & 3) << (2 * (slot % 4));
    }
    let mut recs: Vec<(i64, usize, i64, u8)> = states
        .iter()
        .enumerate()
        .filter(|(_, s)| s.grade != 0)
        .filter_map(|(slot, s)| Some((s.seq?, slot, s.at?, s.by.unwrap_or(0))))
        .collect();
    recs.sort_unstable();
    let (mut seq, mut at) = (0i64, 0i64);
    for (s, slot, a, by) in recs {
        out.push(slot as u8);
        out.push(by);
        put_varint(&mut out, (s - seq).max(0) as u64);
        put_varint(&mut out, zigzag(a - at));
        (seq, at) = (s, a);
    }
    Some(out)
}

fn decode_states(n: usize, cards: Option<&[u8]>) -> Option<Vec<State>> {
    let mut out = vec![State::default(); n];
    let Some(bytes) = cards else { return Some(out) };
    let bits = n.div_ceil(4);
    if bytes.len() < bits {
        return None;
    }
    for (slot, s) in out.iter_mut().enumerate() {
        s.grade = (bytes[slot / 4] >> (2 * (slot % 4))) & 3;
    }
    let (mut p, mut seq, mut at) = (bits, 0i64, 0i64);
    while p < bytes.len() {
        let slot = usize::from(*bytes.get(p)?);
        let by = *bytes.get(p + 1)?;
        p += 2;
        seq = seq.checked_add(i64::try_from(take_varint(bytes, &mut p)?).ok()?)?;
        at = at.checked_add(unzigzag(take_varint(bytes, &mut p)?))?;
        let s = out.get_mut(slot)?;
        (s.seq, s.at, s.by) = (Some(seq), Some(at), (by != 0).then_some(by));
    }
    Some(out)
}

type Row = (Uuid, i32, i16, Option<Vec<u8>>, Option<Vec<u8>>, Vec<Uuid>, i64);

impl Chunk {
    fn from_row(r: Row) -> Result<Chunk, sqlx::Error> {
        let (quiz_id, first_idx, n, idxs, cards, devices, updated_seq) = r;
        let bad = || sqlx::Error::Decode(format!("quiz_cards chunk ({quiz_id}, {first_idx}) does not decode").into());
        let n = n as usize;
        let idxs = match idxs {
            None => None,
            Some(b) => Some(decode_idxs(first_idx, &b).filter(|v| v.len() == n).ok_or_else(bad)?),
        };
        let states = decode_states(n, cards.as_deref()).ok_or_else(bad)?;
        Ok(Chunk { quiz_id, first_idx, idxs, states, devices, updated_seq })
    }

    pub fn len(&self) -> usize {
        self.states.len()
    }

    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }

    pub fn idx(&self, slot: usize) -> u32 {
        match &self.idxs {
            Some(v) => v[slot],
            None => (self.first_idx as usize + slot) as u32,
        }
    }

    pub fn slot_of(&self, idx: u32) -> Option<usize> {
        match &self.idxs {
            Some(v) => v.binary_search(&idx).ok(),
            None => {
                let s = i64::from(idx) - i64::from(self.first_idx);
                (s >= 0 && (s as usize) < self.len()).then_some(s as usize)
            }
        }
    }

    pub fn card(&self, slot: usize) -> Card {
        let s = self.states[slot];
        Card {
            idx: self.idx(slot),
            grade: grade_of(s.grade),
            graded_at: s.at.and_then(|t| DateTime::from_timestamp(t, 0)),
            graded_seq: s.seq,
            graded_by: s.by.and_then(|i| self.devices.get(usize::from(i) - 1).copied()),
        }
    }

    pub fn cards(&self) -> impl Iterator<Item = Card> + '_ {
        (0..self.len()).map(|s| self.card(s))
    }

    /// Sets one question's grade here, in memory; [`store`] writes it. The
    /// time is kept to the second.
    pub fn set(&mut self, slot: usize, grade: Grade, at: DateTime<Utc>, seq: i64, device: Uuid) {
        let by = match self.devices.iter().position(|d| *d == device) {
            Some(i) => i + 1,
            None => {
                self.devices.push(device);
                self.devices.len()
            }
        };
        // A chunk names at most 255 devices; one past that is not named, and
        // its grade is then decided by sequence and time like another device's.
        let by = u8::try_from(by).ok();
        self.states[slot] = State { grade: grade_byte(Some(grade)), at: Some(at.timestamp()), seq: Some(seq), by };
        self.updated_seq = self.updated_seq.max(seq);
    }
}

macro_rules! columns {
    () => {
        "quiz_id, first_idx, n, idxs, cards, devices, updated_seq"
    };
}

fn chunks_of(rows: Vec<Row>) -> Result<Vec<Chunk>, sqlx::Error> {
    rows.into_iter().map(Chunk::from_row).collect()
}

/// Stores a new level's questions, all ungraded. `idxs` ascending; the Source
/// quiz's are `0 … n−1`, kept implicit.
pub async fn insert(conn: &mut PgConnection, quiz: Uuid, idxs: &[u32], source: bool, seq: i64) -> Result<(), sqlx::Error> {
    if idxs.is_empty() {
        return Ok(());
    }
    let firsts: Vec<i32> = idxs.chunks(CHUNK).map(|c| c[0] as i32).collect();
    let ns: Vec<i16> = idxs.chunks(CHUNK).map(|c| c.len() as i16).collect();
    let packed: Vec<Option<Vec<u8>>> = idxs.chunks(CHUNK).map(|c| (!source).then(|| encode_idxs(c))).collect();
    sqlx::query(
        "INSERT INTO quiz_cards (quiz_id, first_idx, n, idxs, updated_seq)
         SELECT $1, u.first, u.n, u.idxs, $5 FROM UNNEST($2::int4[], $3::int2[], $4::bytea[]) AS u(first, n, idxs)",
    )
    .bind(quiz)
    .bind(&firsts)
    .bind(&ns)
    .bind(&packed)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// Every chunk of a quiz, in idx order.
pub async fn load(conn: &mut PgConnection, quiz: Uuid) -> Result<Vec<Chunk>, sqlx::Error> {
    let rows: Vec<Row> = sqlx::query_as(concat!("SELECT ", columns!(), " FROM quiz_cards WHERE quiz_id = $1 ORDER BY first_idx"))
        .bind(quiz)
        .fetch_all(conn)
        .await?;
    chunks_of(rows)
}

/// The chunks holding the questions in `from … to−1` (idx), in idx order.
pub async fn load_range(conn: &mut PgConnection, quiz: Uuid, from: i32, to: i32) -> Result<Vec<Chunk>, sqlx::Error> {
    let rows: Vec<Row> = sqlx::query_as(concat!(
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
    .await?;
    chunks_of(rows)
}

/// The chunk that would hold `idx`, if the quiz has the question.
pub async fn chunk_of(conn: &mut PgConnection, quiz: Uuid, idx: u32) -> Result<Option<(Chunk, usize)>, sqlx::Error> {
    let r: Option<Row> = sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM quiz_cards WHERE quiz_id = $1 AND first_idx <= $2 ORDER BY first_idx DESC LIMIT 1"
    ))
    .bind(quiz)
    .bind(idx as i32)
    .fetch_optional(conn)
    .await?;
    let Some(c) = r.map(Chunk::from_row).transpose()? else { return Ok(None) };
    Ok(c.slot_of(idx).map(|s| (c, s)))
}

/// The quiz's questions, ascending, read without their grades.
pub async fn members(conn: &mut PgConnection, quiz: Uuid) -> Result<Vec<u32>, sqlx::Error> {
    let rows: Vec<(i32, i16, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT first_idx, n, idxs FROM quiz_cards WHERE quiz_id = $1 ORDER BY first_idx").bind(quiz).fetch_all(conn).await?;
    let mut out = Vec::new();
    for (first, n, idxs) in rows {
        match idxs {
            Some(b) => out.extend(
                decode_idxs(first, &b)
                    .filter(|v| v.len() == n as usize)
                    .ok_or_else(|| sqlx::Error::Decode(format!("quiz_cards chunk ({quiz}, {first}) does not decode").into()))?,
            ),
            None => out.extend((first..first + i32::from(n)).map(|i| i as u32)),
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

/// Writes a chunk's grades and devices as they are in memory.
pub async fn store(conn: &mut PgConnection, chunk: &Chunk) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE quiz_cards SET cards = $3, devices = $4, updated_seq = greatest(updated_seq, $5)
         WHERE quiz_id = $1 AND first_idx = $2",
    )
    .bind(chunk.quiz_id)
    .bind(chunk.first_idx)
    .bind(encode_states(&chunk.states))
    .bind(&chunk.devices)
    .bind(chunk.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
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
    let mut c = chunk.clone();
    c.set(slot, grade, at, seq, device);
    store(conn, &c).await
}

/// Clears every grade of a quiz, for a new attempt.
pub async fn reset(conn: &mut PgConnection, quiz: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE quiz_cards SET cards = NULL, devices = '{}' WHERE quiz_id = $1 AND cards IS NOT NULL")
        .bind(quiz)
        .execute(conn)
        .await?;
    Ok(())
}

/// A cleared quiz keeps each question's grade, which an export from the Trash
/// reads, and drops the grades' times, sequences and devices: nothing pulls
/// a cleared quiz's questions, and a restore starts a new attempt.
pub async fn strip(conn: &mut PgConnection, quiz: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE quiz_cards SET cards = substr(cards, 1, (n + 3) / 4), devices = '{}'
         WHERE quiz_id = $1 AND cards IS NOT NULL",
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
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT c.quiz_id, c.first_idx, c.n, c.idxs, c.cards, c.devices, c.updated_seq
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
        let chunks = chunks_of(rows)?;
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

    fn chunk(first: i32, idxs: Option<Vec<u32>>, n: usize) -> Chunk {
        Chunk { quiz_id: Uuid::nil(), first_idx: first, idxs, states: vec![State::default(); n], devices: vec![], updated_seq: 1 }
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
        c.set(1, Grade::Missed, DateTime::from_timestamp_millis(1_700_000_000_999).unwrap(), 5, d);
        assert_eq!(c.card(1).grade, Some(Grade::Missed));
        assert_eq!(c.card(1).graded_by, Some(d));
        assert_eq!(c.card(1).graded_at, DateTime::from_timestamp(1_700_000_000, 0), "kept to the second");
        assert_eq!(c.updated_seq, 5);
        assert_eq!(c.card(0).grade, None);
        assert_eq!(c.card(0).graded_by, None);
    }

    #[test]
    fn idxs_pack_as_differences() {
        let v = vec![4, 9, 30, 299_999];
        let b = encode_idxs(&v);
        assert_eq!(b, [5, 21, 0xC1, 0xA7, 0x12], "one byte each below 128, then a varint");
        assert_eq!(decode_idxs(4, &b), Some(v));
        assert_eq!(decode_idxs(7, &[]), Some(vec![7]));
        assert_eq!(decode_idxs(4, &[0x80]), None, "a cut varint");
    }

    #[test]
    fn states_round_trip() {
        assert_eq!(encode_states(&[State::default(); 9]), None, "nothing graded is NULL");
        assert_eq!(decode_states(9, None), Some(vec![State::default(); 9]));
        // Grades out of sequence order, times going backwards, two devices,
        // an unnamed device and a 64-bit sequence.
        let mut s = vec![State::default(); 256];
        s[0] = State { grade: 1, at: Some(1_800_000_000), seq: Some(12), by: Some(1) };
        s[5] = State { grade: 2, at: Some(1_799_999_000), seq: Some(13), by: Some(2) };
        s[255] = State { grade: 2, at: Some(1_800_000_007), seq: Some(3), by: None };
        s[100] = State { grade: 1, at: Some(-5), seq: Some(i64::MAX), by: Some(255) };
        let b = encode_states(&s).unwrap();
        assert_eq!(decode_states(256, Some(&b)), Some(s.clone()));
        // The layout the migration's quiz_card_rows reads: 64 bytes of
        // grades, then (slot, device, sequence, time) in sequence order.
        assert_eq!(b[0], 0b01, "slot 0 correct; slot 5 is in the next byte");
        assert_eq!(b[1], 0b10 << 2);
        assert_eq!(&b[64..68], [255, 0, 3, 0x8E], "the lowest sequence first");
        // A cleared quiz's chunk is its grades alone.
        let stripped = decode_states(256, Some(&b[..64])).unwrap();
        assert_eq!(stripped[5], State { grade: 2, at: None, seq: None, by: None });
        assert_eq!(encode_states(&stripped).unwrap(), &b[..64]);
        // Too short for its grades, or cut inside a record.
        assert_eq!(decode_states(256, Some(&b[..10])), None);
        assert_eq!(decode_states(256, Some(&b[..66])), None);
        assert_eq!(decode_states(2, Some(&[0b0110, 9, 1, 1, 0])), None, "a slot the chunk does not have");
    }

    #[test]
    fn times_are_cut_to_the_second() {
        let t = DateTime::from_timestamp_millis(1_700_000_000_999).unwrap();
        assert_eq!(to_second(t), DateTime::from_timestamp(1_700_000_000, 0).unwrap());
    }
}
