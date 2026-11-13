//! Catalog rows in Postgres: loading them into indexes, and writing uploads.

use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::index::RawWord;
use super::tiles::{Distribution, Tile, TileDef};
use super::upload::ParsedDistribution;

pub struct Items {
    pub distributions: Vec<i16>,
    /// (lexicon id, distribution id)
    pub lexicons: Vec<(i16, i16)>,
    /// (leave set id, lexicon id)
    pub leave_sets: Vec<(i32, i16)>,
}

pub async fn list_items(db: &PgPool) -> Result<Items, sqlx::Error> {
    let distributions = sqlx::query_scalar!("SELECT id FROM letter_distributions ORDER BY id")
        .fetch_all(db)
        .await?;
    let lexicons = sqlx::query!("SELECT id, letter_distribution_id FROM lexicons ORDER BY id")
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|r| (r.id, r.letter_distribution_id))
        .collect();
    let leave_sets = sqlx::query!("SELECT id, lexicon_id FROM leave_sets ORDER BY id")
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|r| (r.id, r.lexicon_id))
        .collect();
    Ok(Items {
        distributions,
        lexicons,
        leave_sets,
    })
}

pub async fn load_distribution(db: &PgPool, id: i16) -> Result<Option<Distribution>, sqlx::Error> {
    let Some(name) = sqlx::query_scalar!("SELECT name FROM letter_distributions WHERE id = $1", id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let tiles = sqlx::query!(
        "SELECT letter, blank_letter, count, value, is_vowel FROM letter_distribution_tiles
         WHERE letter_distribution_id = $1 ORDER BY position",
        id
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| TileDef {
        letter: r.letter,
        blank_letter: r.blank_letter,
        count: r.count as u16,
        value: r.value as u16,
        is_vowel: r.is_vowel,
    })
    .collect();
    Ok(Some(Distribution::new(id, name, tiles)))
}

/// zstd's level for a lexicon's words and a leave set's leaves: written once
/// per upload and read once per instance, so the smallest text wins. CSW24's
/// 280,887 words take about ten seconds, its 914,624 leaves about twenty-five.
const ZSTD_LEVEL: i32 = 19;

/// The most a packed text may decompress to: an upload is at most 100 MB.
const MAX_TEXT_BYTES: usize = 256 << 20;

/// A lexicon's words as `lexicon_words.words` stores them: one line per
/// word, `word TAB playability TAB definition LF`, compressed. A playability
/// is written in the shortest decimal that reads back to the same number.
pub fn pack_words<'a>(words: impl Iterator<Item = (&'a str, f64, &'a str)>) -> std::io::Result<Vec<u8>> {
    let mut text = String::new();
    for (word, playability, definition) in words {
        debug_assert!(!word.contains(['\t', '\n']) && !definition.contains(['\t', '\n']));
        text.push_str(word);
        text.push('\t');
        text.push_str(&playability.to_string());
        text.push('\t');
        text.push_str(definition);
        text.push('\n');
    }
    zstd::bulk::compress(text.as_bytes(), ZSTD_LEVEL)
}

/// A leave set's leaves as `leave_values.leaves` stores them: one line per
/// leave, `leave TAB value LF`, compressed.
pub fn pack_leaves<'a>(leaves: impl Iterator<Item = (&'a str, f64)>) -> std::io::Result<Vec<u8>> {
    let mut text = String::new();
    for (leave, value) in leaves {
        debug_assert!(!leave.contains(['\t', '\n']));
        text.push_str(leave);
        text.push('\t');
        text.push_str(&value.to_string());
        text.push('\n');
    }
    zstd::bulk::compress(text.as_bytes(), ZSTD_LEVEL)
}

fn unpack(packed: &[u8]) -> anyhow::Result<String> {
    Ok(String::from_utf8(zstd::bulk::decompress(packed, MAX_TEXT_BYTES)?)?)
}

/// The words of a packed text, in stored order: (word, playability, definition).
pub fn unpack_words(packed: &[u8]) -> anyhow::Result<Vec<(String, f64, String)>> {
    let text = unpack(packed)?;
    let mut out = Vec::new();
    for line in text.split_terminator('\n') {
        let mut f = line.splitn(3, '\t');
        let (Some(word), Some(p), Some(definition)) = (f.next(), f.next(), f.next()) else {
            anyhow::bail!("stored word line {line:?} does not have three fields");
        };
        let playability: f64 = p.parse().map_err(|_| anyhow::anyhow!("stored playability {p:?} is not a number"))?;
        out.push((word.to_owned(), playability, definition.to_owned()));
    }
    Ok(out)
}

/// The leaves of a packed text, in stored order: (leave, value).
pub fn unpack_leaves(packed: &[u8]) -> anyhow::Result<Vec<(String, f64)>> {
    let text = unpack(packed)?;
    let mut out = Vec::new();
    for line in text.split_terminator('\n') {
        let Some((leave, v)) = line.split_once('\t') else {
            anyhow::bail!("stored leave line {line:?} does not have two fields");
        };
        let value: f64 = v.parse().map_err(|_| anyhow::anyhow!("stored leave value {v:?} is not a number"))?;
        out.push((leave.to_owned(), value));
    }
    Ok(out)
}

/// Stored words are canonical MAGPIE notation, validated on upload.
pub async fn load_lexicon(
    db: &PgPool,
    id: i16,
    dist: &Distribution,
) -> anyhow::Result<Option<(String, Vec<RawWord>)>> {
    let Some(name) = sqlx::query_scalar!("SELECT name FROM lexicons WHERE id = $1", id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let Some(packed) = sqlx::query_scalar!("SELECT words FROM lexicon_words WHERE lexicon_id = $1", id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(Some((name, Vec::new())));
    };
    let dist = dist.clone();
    // Decompressing and parsing a whole lexicon is CPU work.
    let words = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<RawWord>> {
        let rows = unpack_words(&packed)?;
        let mut words = Vec::with_capacity(rows.len());
        for (word, playability, definition) in rows {
            let tiles = dist
                .parse_magpie(&word, false)
                .map_err(|e| anyhow::anyhow!("stored word {word:?} does not parse: {e}"))?;
            words.push(RawWord { tiles, playability, definition });
        }
        Ok(words)
    })
    .await??;
    Ok(Some((name, words)))
}

pub async fn load_leaves(
    db: &PgPool,
    id: i32,
    dist: &Distribution,
) -> anyhow::Result<Option<(String, Vec<(Vec<Tile>, f64)>)>> {
    let Some(name) = sqlx::query_scalar!("SELECT name FROM leave_sets WHERE id = $1", id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let Some(packed) = sqlx::query_scalar!("SELECT leaves FROM leave_values WHERE leave_set_id = $1", id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(Some((name, Vec::new())));
    };
    let dist = dist.clone();
    let out = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<(Vec<Tile>, f64)>> {
        let rows = unpack_leaves(&packed)?;
        let mut out = Vec::with_capacity(rows.len());
        for (leave, value) in rows {
            let tiles = dist
                .parse_magpie(&leave, true)
                .map_err(|e| anyhow::anyhow!("stored leave {leave:?} does not parse: {e}"))?;
            out.push((tiles, value));
        }
        Ok(out)
    })
    .await??;
    Ok(Some((name, out)))
}

pub async fn insert_distribution(
    tx: &mut PgConnection,
    name: &str,
    uploaded_by: Uuid,
    parsed: &ParsedDistribution,
) -> Result<i16, sqlx::Error> {
    let id = sqlx::query_scalar!(
        "INSERT INTO letter_distributions (name, uploaded_by) VALUES ($1, $2) RETURNING id",
        name,
        uploaded_by
    )
    .fetch_one(&mut *tx)
    .await?;
    for (pos, (t, fw)) in parsed.tiles.iter().zip(&parsed.fullwidth).enumerate() {
        sqlx::query!(
            "INSERT INTO letter_distribution_tiles
               (letter_distribution_id, position, letter, blank_letter, count, value, is_vowel,
                fullwidth_letter, fullwidth_blank_letter)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            id,
            pos as i16,
            t.letter,
            t.blank_letter,
            t.count as i16,
            t.value as i16,
            t.is_vowel,
            fw.as_ref().map(|f| f.0.as_str()),
            fw.as_ref().map(|f| f.1.as_str()),
        )
        .execute(&mut *tx)
        .await?;
    }
    Ok(id)
}

pub async fn insert_lexicon(
    tx: &mut PgConnection,
    name: &str,
    dist_id: i16,
    uploaded_by: Uuid,
    word_count: usize,
    packed: &[u8],
) -> Result<i16, sqlx::Error> {
    let id = sqlx::query_scalar!(
        "INSERT INTO lexicons (name, letter_distribution_id, word_count, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING id",
        name,
        dist_id,
        word_count as i32,
        uploaded_by
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!("INSERT INTO lexicon_words (lexicon_id, words) VALUES ($1, $2)", id, packed).execute(&mut *tx).await?;
    Ok(id)
}

pub async fn insert_leave_set(
    tx: &mut PgConnection,
    lexicon_id: i16,
    name: &str,
    uploaded_by: Uuid,
    leave_count: usize,
    packed: &[u8],
) -> Result<i32, sqlx::Error> {
    let id = sqlx::query_scalar!(
        "INSERT INTO leave_sets (lexicon_id, name, leave_count, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id",
        lexicon_id,
        name,
        leave_count as i32,
        uploaded_by
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query!("INSERT INTO leave_values (leave_set_id, leaves) VALUES ($1, $2)", id, packed).execute(&mut *tx).await?;
    Ok(id)
}

pub async fn notify(tx: &mut PgConnection) -> Result<(), sqlx::Error> {
    // Delivered when the transaction commits.
    sqlx::query!("SELECT pg_notify('catalog_changed', '')")
        .fetch_one(tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_words_and_leaves_read_back_exactly() {
        // Playabilities and values keep every bit; a definition keeps its
        // punctuation; bracketed tiles and the blank pass through.
        let words = [("A[NY]S", 3000.0, "years [n] / more | text"), ("CASA", 636.675, "a house"), ("ZA", 0.1 + 0.2, "pizza")];
        let packed = pack_words(words.iter().copied()).unwrap();
        let back = unpack_words(&packed).unwrap();
        assert_eq!(back.len(), 3);
        for ((w, p, d), (bw, bp, bd)) in words.iter().zip(&back) {
            assert_eq!((w, d), (&bw.as_str(), &bd.as_str()));
            assert_eq!(p.to_bits(), bp.to_bits());
        }
        let leaves = [("?", 28.292), ("?EIRS", -0.378), ("QU", -1_000_000.0), ("Z", 1e-9)];
        let packed = pack_leaves(leaves.iter().copied()).unwrap();
        let back = unpack_leaves(&packed).unwrap();
        assert_eq!(back.len(), 4);
        for ((l, v), (bl, bv)) in leaves.iter().zip(&back) {
            assert_eq!(l, &bl.as_str());
            assert_eq!(v.to_bits(), bv.to_bits());
        }
        assert!(unpack_words(&pack_leaves(leaves.iter().copied()).unwrap()).is_err(), "two fields are not a word line");
        assert!(unpack_leaves(b"not zstd").is_err());
    }
}
