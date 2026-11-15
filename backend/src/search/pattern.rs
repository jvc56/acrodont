//! Patterns (PLAN.md § Pattern syntax) and their matchers (§ Search Engine →
//! Pattern matching).
//!
//! The canonical text form is tokens separated by single spaces: `.` any
//! single tile, `*` any run, `?` the blank, a tile's letter, or a set
//! `[A NY]` whose tiles are separated by single spaces. Brackets in a pattern
//! always mean a set, never MAGPIE's multi-character notation.

use crate::catalog::tiles::{Distribution, Tile, BLANK};

/// A set of tiles as a 256-bit bitset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TileSet([u64; 4]);

impl TileSet {
    pub fn all() -> Self {
        TileSet([u64::MAX; 4])
    }

    pub fn insert(&mut self, t: Tile) {
        self.0[(t >> 6) as usize] |= 1 << (t & 63);
    }

    pub fn contains(&self, t: Tile) -> bool {
        self.0[(t >> 6) as usize] & (1 << (t & 63)) != 0
    }

    pub fn len(&self) -> u32 {
        self.0.iter().map(|w| w.count_ones()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn from_tiles(tiles: &[Tile]) -> Self {
        let mut s = TileSet::default();
        for &t in tiles {
            s.insert(t);
        }
        s
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tok {
    Tile(Tile),
    Any,
    Star,
    Set(TileSet, Vec<Tile>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    pub toks: Vec<Tok>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternError {
    /// Not in canonical form (spacing, case, an empty token).
    NotCanonical,
    UnbalancedBracket,
    EmptyBracket,
    /// `?` where the quiz type has no blank.
    Blank,
    UnknownTile(String),
    Empty,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PatternError::NotCanonical => write!(f, "the pattern is not in canonical form"),
            PatternError::UnbalancedBracket => write!(f, "unbalanced bracket"),
            PatternError::EmptyBracket => write!(f, "empty brackets"),
            PatternError::Blank => write!(f, "use `.` for any single tile"),
            PatternError::UnknownTile(t) => write!(f, "'{t}' is not a tile of this distribution"),
            PatternError::Empty => write!(f, "the pattern is empty"),
        }
    }
}

/// A token of canonical text before tiles are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawTok<'a> {
    Any,
    Star,
    Blank,
    Letter(&'a str),
    Set(Vec<&'a str>),
}

/// Splits canonical pattern text into tokens, checking only the syntax, so
/// it runs without a distribution (a saved search carries none).
pub fn tokenize(text: &str) -> Result<Vec<RawTok<'_>>, PatternError> {
    if text.is_empty() {
        return Err(PatternError::Empty);
    }
    let mut out = Vec::new();
    let mut rest = text;
    loop {
        let (tok, after) = if let Some(inner_start) = rest.strip_prefix('[') {
            let Some(end) = inner_start.find(']') else {
                return Err(PatternError::UnbalancedBracket);
            };
            let inner = &inner_start[..end];
            if inner.contains('[') {
                return Err(PatternError::UnbalancedBracket);
            }
            if inner.is_empty() {
                return Err(PatternError::EmptyBracket);
            }
            let tiles: Vec<&str> = inner.split(' ').collect();
            if tiles.iter().any(|t| t.is_empty()) {
                return Err(PatternError::NotCanonical);
            }
            (RawTok::Set(tiles), &inner_start[end + 1..])
        } else {
            let end = rest.find(' ').unwrap_or(rest.len());
            let tok = &rest[..end];
            let raw = match tok {
                "" => return Err(PatternError::NotCanonical),
                "." => RawTok::Any,
                "*" => RawTok::Star,
                "?" => RawTok::Blank,
                t if t.contains(']') => return Err(PatternError::UnbalancedBracket),
                t if t.contains('[') => return Err(PatternError::UnbalancedBracket),
                t => RawTok::Letter(t),
            };
            (raw, &rest[end..])
        };
        if let RawTok::Letter(l) = &tok
            && l.chars().any(|c| c.is_lowercase()) {
                return Err(PatternError::NotCanonical);
            }
        if let RawTok::Set(tiles) = &tok
            && tiles.iter().any(|l| l.chars().any(|c| c.is_lowercase())) {
                return Err(PatternError::NotCanonical);
            }
        out.push(tok);
        if after.is_empty() {
            return Ok(out);
        }
        match after.strip_prefix(' ') {
            Some(r) if !r.is_empty() && !r.starts_with(' ') => rest = r,
            _ => return Err(PatternError::NotCanonical),
        }
    }
}

/// Whether the tokens hold the blank, which only a leave pattern may.
pub fn has_blank(toks: &[RawTok<'_>]) -> bool {
    toks.iter().any(|t| match t {
        RawTok::Blank => true,
        RawTok::Set(s) => s.contains(&"?"),
        _ => false,
    })
}

/// Resolves canonical pattern text against a distribution.
pub fn parse(text: &str, dist: &Distribution, allow_blank: bool) -> Result<Pattern, PatternError> {
    let raw = tokenize(text)?;
    if !allow_blank && has_blank(&raw) {
        return Err(PatternError::Blank);
    }
    let tile = |l: &str| -> Result<Tile, PatternError> {
        if l == "?" {
            return Ok(BLANK);
        }
        dist.tile_for_letter(l)
            .filter(|&t| t != BLANK)
            .ok_or_else(|| PatternError::UnknownTile(l.to_owned()))
    };
    let mut toks = Vec::with_capacity(raw.len());
    for r in raw {
        toks.push(match r {
            RawTok::Any => Tok::Any,
            RawTok::Star => Tok::Star,
            RawTok::Blank => Tok::Tile(BLANK),
            RawTok::Letter(l) => Tok::Tile(tile(l)?),
            RawTok::Set(ls) => {
                let tiles = ls.into_iter().map(tile).collect::<Result<Vec<_>, _>>()?;
                Tok::Set(TileSet::from_tiles(&tiles), tiles)
            }
        });
    }
    Ok(Pattern { toks })
}

/// Canonical text for a pattern (what `parse` accepts).
pub fn to_text(p: &Pattern, dist: &Distribution) -> String {
    let letter = |t: Tile| if t == BLANK { "?".to_owned() } else { dist.tile(t).letter.clone() };
    p.toks
        .iter()
        .map(|t| match t {
            Tok::Any => ".".to_owned(),
            Tok::Star => "*".to_owned(),
            Tok::Tile(t) => letter(*t),
            Tok::Set(_, tiles) => {
                format!("[{}]", tiles.iter().map(|&t| letter(t)).collect::<Vec<_>>().join(" "))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Anagram and subanagram patterns as literal counts plus wildcard slots.
#[derive(Debug, Clone)]
pub struct Bag {
    pub literals: Vec<u8>,
    pub literal_total: usize,
    /// The distinct slots, one per `.` (all tiles) or set, each with how many
    /// times the pattern holds it.
    pub kinds: Vec<(TileSet, u32)>,
    /// The number of slots, counting repeats.
    pub slot_total: usize,
    pub star: bool,
}

impl Bag {
    pub fn new(p: &Pattern, ntiles: usize) -> Self {
        let mut literals = vec![0u8; ntiles];
        let mut kinds: Vec<(TileSet, u32)> = Vec::new();
        let mut slot_total = 0;
        let mut star = false;
        let mut total = 0;
        for t in &p.toks {
            let set = match t {
                Tok::Tile(t) => {
                    literals[*t as usize] += 1;
                    total += 1;
                    continue;
                }
                Tok::Star => {
                    star = true;
                    continue;
                }
                Tok::Any => TileSet::all(),
                Tok::Set(s, _) => *s,
            };
            slot_total += 1;
            match kinds.iter_mut().find(|(s, _)| *s == set) {
                Some((_, n)) => *n += 1,
                None => kinds.push((set, 1)),
            }
        }
        Bag { literals, literal_total: total, kinds, slot_total, star }
    }

    pub fn only_literals(&self) -> bool {
        self.kinds.is_empty() && !self.star
    }

    /// Anagram Match: the word uses exactly the pattern's tiles; `*` allows extras.
    pub fn anagram(&self, counts: &[u8], len: usize) -> bool {
        let need = self.literal_total + self.slot_total;
        if (self.star && len < need) || (!self.star && len != need) {
            return false;
        }
        let mut rem: Vec<(Tile, u32)> = Vec::new();
        for (t, (&c, &l)) in counts.iter().zip(&self.literals).enumerate() {
            if c < l {
                return false;
            }
            if c > l {
                rem.push((t as Tile, u32::from(c - l)));
            }
        }
        if self.kinds.is_empty() {
            return true;
        }
        // Without `*`, every remaining tile fills a slot; with it, the slots
        // take any of the remaining tiles and the rest are the extras.
        Assignment::new(&self.kinds, &rem).fill(self.slot_total) == self.slot_total
    }

    /// Subanagram Match: every tile of the word can be taken from the pattern.
    pub fn subanagram(&self, counts: &[u8], len: usize) -> bool {
        if self.star {
            return true;
        }
        if len > self.literal_total + self.slot_total {
            return false;
        }
        let mut left: Vec<(Tile, u32)> = Vec::new();
        let mut total = 0;
        for (t, (&c, &l)) in counts.iter().zip(&self.literals).enumerate() {
            if c > l {
                left.push((t as Tile, u32::from(c - l)));
                total += usize::from(c - l);
            }
        }
        if total == 0 {
            return true;
        }
        if total > self.slot_total {
            return false;
        }
        Assignment::new(&self.kinds, &left).fill(total) == total
    }
}

/// Puts tiles into slots that accept them, one tile to a slot: a bipartite
/// matching between the distinct tiles (each with a count) and the distinct
/// slots (each with a count), grown one tile at a time along augmenting
/// paths. Placing one tile looks at each (tile, slot) pair at most once, so a
/// candidate costs at most its length times that, whatever the pattern holds.
struct Assignment<'a> {
    kinds: &'a [(TileSet, u32)],
    tiles: &'a [(Tile, u32)],
    /// `placed[i * kinds.len() + k]`: how many of tile `i` sit in slots of kind `k`.
    placed: Vec<u32>,
    /// How many slots of each kind are taken.
    taken: Vec<u32>,
    seen_kind: Vec<bool>,
    seen_tile: Vec<bool>,
}

impl<'a> Assignment<'a> {
    fn new(kinds: &'a [(TileSet, u32)], tiles: &'a [(Tile, u32)]) -> Self {
        Assignment {
            kinds,
            tiles,
            placed: vec![0; kinds.len() * tiles.len()],
            taken: vec![0; kinds.len()],
            seen_kind: vec![false; kinds.len()],
            seen_tile: vec![false; tiles.len()],
        }
    }

    /// How many tiles can be placed, stopping at `want`.
    fn fill(&mut self, want: usize) -> usize {
        let mut done = 0;
        for i in 0..self.tiles.len() {
            for _ in 0..self.tiles[i].1 {
                if done == want {
                    return done;
                }
                self.seen_kind.fill(false);
                self.seen_tile.fill(false);
                if !self.place(i) {
                    // No further tile of this kind can be placed either.
                    break;
                }
                done += 1;
            }
        }
        done
    }

    /// Places one more of tile `i`, moving tiles already placed if it must.
    fn place(&mut self, i: usize) -> bool {
        self.seen_tile[i] = true;
        let n = self.kinds.len();
        for k in 0..n {
            if self.seen_kind[k] || !self.kinds[k].0.contains(self.tiles[i].0) {
                continue;
            }
            self.seen_kind[k] = true;
            if self.taken[k] < self.kinds[k].1 {
                self.taken[k] += 1;
                self.placed[i * n + k] += 1;
                return true;
            }
            for j in 0..self.tiles.len() {
                if !self.seen_tile[j] && self.placed[j * n + k] > 0 && self.place(j) {
                    self.placed[j * n + k] -= 1;
                    self.placed[i * n + k] += 1;
                    return true;
                }
            }
        }
        false
    }
}

/// Pattern Match: an anchored match of the tokens against the tiles in order.
pub fn matches_in_order(p: &Pattern, tiles: &[Tile]) -> bool {
    // dp[j]: tokens [0, i) can match tiles [0, j).
    let n = tiles.len();
    let mut dp = vec![false; n + 1];
    dp[0] = true;
    for tok in &p.toks {
        let mut next = vec![false; n + 1];
        match tok {
            Tok::Star => {
                let mut any = false;
                for j in 0..=n {
                    any |= dp[j];
                    next[j] = any;
                }
            }
            _ => {
                for j in 0..n {
                    if dp[j] {
                        let ok = match tok {
                            Tok::Tile(t) => tiles[j] == *t,
                            Tok::Any => true,
                            Tok::Set(s, _) => s.contains(tiles[j]),
                            Tok::Star => unreachable!(),
                        };
                        if ok {
                            next[j + 1] = true;
                        }
                    }
                }
            }
        }
        dp = next;
    }
    dp[n]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tiles::tests::catalan_like;

    #[test]
    fn canonical_form() {
        // `N Y`, `[A NY]` and `[ANY]` tokenise as the canonical form says.
        let d = catalan_like();
        let p = parse("N Y", &d, false).unwrap();
        assert_eq!(p.toks.len(), 2);
        let set = parse("[A NY]", &d, false).unwrap();
        assert!(matches!(&set.toks[0], Tok::Set(s, _) if s.len() == 2));
        // `[ANY]` is not canonical: the client sends `[A NY]`.
        assert!(matches!(parse("[ANY]", &d, false), Err(PatternError::UnknownTile(_))));
        for bad in ["N  Y", " N", "N ", "", "n", "[A  NY]", "[A NY", "A]", "[]", "[[A]]"] {
            assert!(parse(bad, &d, false).is_err(), "{bad:?} accepted");
        }
        assert_eq!(parse("? A", &d, false), Err(PatternError::Blank));
        assert!(parse("? A", &d, true).is_ok());
        let p = parse(". [A NY] * S", &d, false).unwrap();
        assert_eq!(to_text(&p, &d), ". [A NY] * S");
    }

    #[test]
    fn in_order_matching() {
        let d = catalan_like();
        let w = d.parse_magpie("CA[NY]A", false).unwrap();
        assert!(matches_in_order(&parse("C . NY A", &d, false).unwrap(), &w));
        assert!(matches_in_order(&parse("C *", &d, false).unwrap(), &w));
        assert!(matches_in_order(&parse("* A", &d, false).unwrap(), &w));
        assert!(matches_in_order(&parse("* [NY S] *", &d, false).unwrap(), &w));
        assert!(!matches_in_order(&parse("C .", &d, false).unwrap(), &w));
        assert!(!matches_in_order(&parse("C A N Y A", &d, false).unwrap(), &w));
    }

    #[test]
    fn bags() {
        let d = catalan_like();
        let casa = d.parse_magpie("CASA", false).unwrap();
        let c = d.counts(&casa);
        let bag = |s: &str| Bag::new(&parse(s, &d, false).unwrap(), d.len());
        assert!(bag("S A C A").anagram(&c, 4));
        assert!(bag("S A C .").anagram(&c, 4));
        assert!(bag("[A S] A C [A S]").anagram(&c, 4));
        assert!(!bag("[C E] A C [A S]").anagram(&c, 4));
        assert!(bag("C *").anagram(&c, 4));
        assert!(!bag("C . *").anagram(&d.counts(&casa[..1]), 1));
        assert!(bag("C A S A E").subanagram(&c, 4));
        assert!(bag("C S . . E").subanagram(&c, 4));
        assert!(!bag("C S . E").subanagram(&c, 4));
        assert!(bag("L *").subanagram(&c, 4));
    }

    /// The matcher before it was a matching: every tile tried in every slot.
    fn brute(slots: &[TileSet], tiles: &[Tile], all_tiles: bool) -> bool {
        fn go(slots: &[TileSet], used: &mut [bool], tiles: &[Tile], i: usize, skips: usize) -> bool {
            if i == tiles.len() {
                return true;
            }
            for s in 0..slots.len() {
                if !used[s] && slots[s].contains(tiles[i]) {
                    used[s] = true;
                    let ok = go(slots, used, tiles, i + 1, skips);
                    used[s] = false;
                    if ok {
                        return true;
                    }
                }
            }
            skips > 0 && go(slots, used, tiles, i + 1, skips - 1)
        }
        // Subanagram places every tile; Anagram fills every slot and may leave tiles over.
        let skips = if all_tiles { 0 } else { tiles.len().saturating_sub(slots.len()) };
        (all_tiles || tiles.len() >= slots.len()) && go(slots, &mut vec![false; slots.len()], tiles, 0, skips)
    }

    #[test]
    fn slots_are_matched_as_the_exhaustive_search_matches_them() {
        // Every pattern of up to four slots drawn from these sets, against
        // every bag of up to five of the tiles 1..=3.
        let sets: Vec<TileSet> =
            [&[1u8][..], &[2], &[1, 2], &[2, 3], &[1, 2, 3]].iter().map(|t| TileSet::from_tiles(t)).collect();
        let mut x: u64 = 7;
        let mut next = |n: usize| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((x >> 33) % n as u64) as usize
        };
        for _ in 0..4000 {
            let slots: Vec<TileSet> = (0..next(5)).map(|_| sets[next(sets.len())]).collect();
            let tiles: Vec<Tile> = (0..next(6)).map(|_| 1 + next(3) as Tile).collect();
            let toks = slots.iter().map(|s| Tok::Set(*s, Vec::new())).collect();
            let plain = Bag::new(&Pattern { toks }, 4);
            let mut toks: Vec<Tok> = slots.iter().map(|s| Tok::Set(*s, Vec::new())).collect();
            toks.push(Tok::Star);
            let starred = Bag::new(&Pattern { toks }, 4);
            let mut counts = [0u8; 4];
            for &t in &tiles {
                counts[t as usize] += 1;
            }
            let n = tiles.len();
            assert_eq!(plain.subanagram(&counts, n), brute(&slots, &tiles, true), "sub {slots:?} {tiles:?}");
            assert_eq!(
                plain.anagram(&counts, n),
                n == slots.len() && brute(&slots, &tiles, true),
                "anagram {slots:?} {tiles:?}"
            );
            assert_eq!(starred.anagram(&counts, n), brute(&slots, &tiles, false), "starred {slots:?} {tiles:?}");
        }
    }

    /// A pattern of one set many times over once cost a factorial of tries for
    /// a word it does not match. The work runs on its own thread so that a
    /// matcher that does not come back fails the test instead of hanging it.
    #[test]
    fn many_identical_sets_are_answered_at_once() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // Tiles 1..=3 stand for A, E, I; tile 4 is in no set.
            let set = TileSet::from_tiles(&[1, 2, 3]);
            let toks: Vec<Tok> = (0..62).map(|_| Tok::Set(set, vec![1, 2, 3])).collect();
            let plain = Bag::new(&Pattern { toks: toks.clone() }, 5);
            let starred = Bag::new(&Pattern { toks: toks.into_iter().chain([Tok::Star]).collect() }, 5);
            // Twelve tiles the sets take, then one they do not.
            let mut out = Vec::new();
            for _ in 0..10_000 {
                out.push(plain.subanagram(&[0, 4, 4, 4, 1], 13));
                out.push(plain.subanagram(&[0, 20, 20, 22, 0], 62));
                out.push(plain.anagram(&[0, 20, 20, 21, 1], 62));
                out.push(starred.anagram(&[0, 20, 20, 21, 30], 91));
                out.push(starred.anagram(&[0, 20, 20, 22, 30], 92));
            }
            let _ = tx.send(out);
        });
        let out = rx.recv_timeout(std::time::Duration::from_secs(20)).expect("the matcher did not come back");
        assert_eq!(out[..5], [false, true, false, false, true]);
    }
}
