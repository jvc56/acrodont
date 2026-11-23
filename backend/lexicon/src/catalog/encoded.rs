//! A built [`LexiconIndex`] as bytes, so a device builds a lexicon once per
//! revision and later only reads it back (PLAN.md § Search page → Lexicon
//! packs): building CSW24 takes seconds on a phone, reading it back a
//! fraction of that.
//!
//! What is cheap to derive is not stored: each word's letter counts, the
//! words of each alphagram, the length buckets and the two lookups. Every
//! number is little-endian. A different [`FORMAT`] is refused, and the
//! device builds the index afresh.

use std::collections::HashMap;
use std::sync::Arc;

use super::index::{LexiconIndex, WordEntry, MAX_WORD_TILES};
use super::tiles::{Distribution, Tile};

const MAGIC: &[u8; 4] = b"ACRL";
/// Bumped whenever the layout or what an index holds changes.
pub const FORMAT: u32 = 1;

struct Writer(Vec<u8>);

impl Writer {
    fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.bytes(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }
    fn tiles(&mut self, t: &[Tile]) {
        self.u16(t.len() as u16);
        self.bytes(t);
    }
    fn text(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.bytes(s.as_bytes());
    }
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

type Read<T> = Result<T, String>;

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Read<&'a [u8]> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("The saved index is cut short.")?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn array<const N: usize>(&mut self) -> Read<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("took N"))
    }
    fn u8(&mut self) -> Read<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Read<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }
    fn u32(&mut self) -> Read<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    fn tiles(&mut self) -> Read<Box<[Tile]>> {
        let n = self.u16()? as usize;
        Ok(self.take(n)?.into())
    }
    fn text(&mut self) -> Read<Box<str>> {
        let n = self.u32()? as usize;
        let s = std::str::from_utf8(self.take(n)?).map_err(|_| "The saved index holds text that is not UTF-8.")?;
        Ok(s.into())
    }
}

impl LexiconIndex {
    /// The index as bytes for [`LexiconIndex::decode`].
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer(Vec::with_capacity(self.approx_bytes / 2));
        w.bytes(MAGIC);
        w.u32(FORMAT);
        w.bytes(&self.id.to_le_bytes());
        w.text(&self.name);
        w.bytes(&self.definitions_revision.to_le_bytes());
        w.bytes(&self.playability_revision.to_le_bytes());
        w.u32(self.max_num_anagrams);
        w.u32(self.max_order_rank);
        w.bytes(&self.build_ms.to_le_bytes());
        w.bytes(&(self.approx_bytes as u64).to_le_bytes());
        w.u32(self.alphagrams.len() as u32);
        for a in &self.alphagrams {
            w.tiles(a);
        }
        w.u32(self.words.len() as u32);
        for e in &self.words {
            w.tiles(&e.tiles);
            w.u32(e.alphagram);
            w.u8(e.num_vowels);
            w.u8(e.num_unique_letters);
            w.u16(e.point_value);
            w.u32(e.num_anagrams);
            w.tiles(&e.front_hooks);
            w.tiles(&e.back_hooks);
            w.u8(u8::from(e.has_front_inner_hook) | u8::from(e.has_back_inner_hook) << 1 | u8::from(e.is_root) << 2);
            w.bytes(&e.combinations.to_le_bytes());
            for o in [e.probability_order, e.min_probability_order, e.max_probability_order, e.playability_order, e.min_playability_order, e.max_playability_order] {
                w.u32(o);
            }
            w.bytes(&e.playability.to_le_bytes());
            w.u16(e.pos);
            w.text(&e.definition);
        }
        w.0
    }

    /// An index [`LexiconIndex::encode`] wrote, over `distribution`, which
    /// must be the one it was built with.
    pub fn decode(bytes: &[u8], distribution: Arc<Distribution>) -> Result<Self, String> {
        let start = crate::clock::now_ms();
        let mut r = Reader { b: bytes, at: 0 };
        if r.take(4)? != MAGIC {
            return Err("This is not a saved lexicon index.".into());
        }
        let format = r.u32()?;
        if format != FORMAT {
            return Err(format!("The saved index is format {format}, not {FORMAT}."));
        }
        let id = i16::from_le_bytes(r.array()?);
        let name = r.text()?.into_string();
        let definitions_revision = i32::from_le_bytes(r.array()?);
        let playability_revision = i32::from_le_bytes(r.array()?);
        let max_num_anagrams = r.u32()?;
        let max_order_rank = r.u32()?;
        let _built_ms = u64::from_le_bytes(r.array()?);
        let approx_bytes = u64::from_le_bytes(r.array()?) as usize;
        let n_alpha = r.u32()? as usize;
        let mut alphagrams = Vec::with_capacity(n_alpha);
        for _ in 0..n_alpha {
            alphagrams.push(r.tiles()?);
        }
        let n = r.u32()? as usize;
        let tiles_in_bag = distribution.len();
        let mut words = Vec::with_capacity(n);
        let mut alphagram_words: Vec<Vec<u32>> = vec![Vec::new(); n_alpha];
        let mut by_length: Vec<Vec<u32>> = vec![Vec::new(); MAX_WORD_TILES + 1];
        for i in 0..n {
            let tiles = r.tiles()?;
            if tiles.iter().any(|&t| usize::from(t) >= tiles_in_bag) || tiles.len() > MAX_WORD_TILES {
                return Err("The saved index does not fit this letter distribution.".into());
            }
            let alphagram = r.u32()?;
            alphagram_words.get_mut(alphagram as usize).ok_or("The saved index names an alphagram it lacks.")?.push(i as u32);
            by_length[tiles.len()].push(i as u32);
            let (num_vowels, num_unique_letters, point_value, num_anagrams) = (r.u8()?, r.u8()?, r.u16()?, r.u32()?);
            let (front_hooks, back_hooks, flags) = (r.tiles()?, r.tiles()?, r.u8()?);
            let combinations = u128::from_le_bytes(r.array()?);
            let mut o = [0u32; 6];
            for v in &mut o {
                *v = r.u32()?;
            }
            let playability = f64::from_le_bytes(r.array()?);
            let pos = r.u16()?;
            let definition = r.text()?;
            words.push(WordEntry {
                counts: distribution.counts(&tiles).into_boxed_slice(),
                length: tiles.len() as u8,
                tiles,
                alphagram,
                num_vowels,
                num_unique_letters,
                point_value,
                num_anagrams,
                front_hooks,
                back_hooks,
                has_front_inner_hook: flags & 1 != 0,
                has_back_inner_hook: flags & 2 != 0,
                is_root: flags & 4 != 0,
                combinations,
                probability_order: o[0],
                min_probability_order: o[1],
                max_probability_order: o[2],
                playability_order: o[3],
                min_playability_order: o[4],
                max_playability_order: o[5],
                playability,
                pos,
                definition,
            });
        }
        if r.at != bytes.len() {
            return Err("The saved index has bytes left over.".into());
        }
        let word_lookup: HashMap<Box<[Tile]>, u32> = words.iter().enumerate().map(|(i, w)| (w.tiles.clone(), i as u32)).collect();
        let alphagram_lookup: HashMap<Box<[Tile]>, u32> = alphagrams.iter().enumerate().map(|(i, a)| (a.clone(), i as u32)).collect();
        Ok(LexiconIndex {
            id,
            name,
            definitions_revision,
            playability_revision,
            distribution,
            words,
            word_lookup,
            alphagrams,
            alphagram_words,
            alphagram_lookup,
            by_length,
            max_num_anagrams,
            max_order_rank,
            build_ms: (crate::clock::now_ms() - start) as u64,
            approx_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::index::RawWord;
    use super::super::tiles::tests::tiledef;
    use super::*;

    fn dist() -> Arc<Distribution> {
        let mut t = vec![tiledef("?", "?", 2, 0, false)];
        for (i, c) in ('A'..='Z').enumerate() {
            let l = c.to_string();
            t.push(tiledef(&l, &l.to_lowercase(), 1 + (i % 9) as u16, 1 + (i % 10) as u16, "AEIOU".contains(c)));
        }
        Arc::new(Distribution::new(1, "english", t))
    }

    fn built(d: &Arc<Distribution>, definitions: bool) -> LexiconIndex {
        let words = [
            ("A", "the first letter [indefinite_article]"),
            ("AT", "in the position of [prep]"),
            ("TA", "an expression of thanks [interj]"),
            ("EAT", "to consume food [v]"),
            ("EATS", "EAT, to consume food [v]"),
            ("TEA", "a drink [n -S]"),
            ("TEAS", "TEA, a drink [n]"),
            ("SEAT", "a place to sit [n -S] / to put in a place to sit [v -ED, -ING, -S]"),
            ("ETA", "a Greek letter, \"quoted\", with a comma [n -S]"),
        ];
        let raw = words
            .iter()
            .enumerate()
            .map(|(i, (w, def))| RawWord { tiles: d.parse_magpie(w, false).unwrap(), playability: (i * 7 % 5) as f64, definition: if definitions { (*def).into() } else { String::new() } })
            .collect();
        LexiconIndex::build(3, "T", d.clone(), raw)
    }

    fn same(a: &LexiconIndex, b: &LexiconIndex) {
        assert_eq!(format!("{:?}", a.words), format!("{:?}", b.words));
        assert_eq!(a.alphagrams, b.alphagrams);
        assert_eq!(a.alphagram_words, b.alphagram_words);
        assert_eq!(a.by_length, b.by_length);
        assert_eq!(a.word_lookup, b.word_lookup);
        assert_eq!(a.alphagram_lookup, b.alphagram_lookup);
        assert_eq!((a.id, &a.name, a.definitions_revision, a.playability_revision), (b.id, &b.name, b.definitions_revision, b.playability_revision));
        assert_eq!((a.max_num_anagrams, a.max_order_rank), (b.max_num_anagrams, b.max_order_rank));
    }

    #[test]
    fn an_index_read_back_is_the_index_built() {
        let d = dist();
        for defs in [false, true] {
            let a = built(&d, defs);
            same(&a, &LexiconIndex::decode(&a.encode(), d.clone()).unwrap());
        }
    }

    #[test]
    fn definitions_set_later_are_definitions_built_in() {
        let d = dist();
        let mut later = LexiconIndex::decode(&built(&d, false).encode(), d.clone()).unwrap();
        let full = built(&d, true);
        later.set_definitions(full.words.iter().map(|w| w.definition.to_string()).collect()).unwrap();
        same(&later, &full);
        assert!(later.set_definitions(vec![String::new()]).is_err(), "one definition per word");
    }

    #[test]
    fn damage_is_refused() {
        let d = dist();
        let bytes = built(&d, true).encode();
        assert!(LexiconIndex::decode(&bytes[..bytes.len() - 1], d.clone()).is_err());
        let mut other = bytes.clone();
        other[4] = 99;
        assert!(LexiconIndex::decode(&other, d.clone()).unwrap_err().contains("format 99"));
        assert!(LexiconIndex::decode(b"nope", d).is_err());
    }
}
