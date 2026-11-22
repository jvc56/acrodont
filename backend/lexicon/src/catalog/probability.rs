//! Combinations (PLAN.md § Probability and probability order), following
//! Zyzzyva's `LetterBag::getNumCombinations` with two blanks: the number of
//! distinct draws from the bag that spell the word, allowing up to two of the
//! bag's blanks to stand in. Exact integers; Zyzzyva's doubles are exact for
//! every value a real bag produces.

use super::tiles::{BLANK, Distribution};

pub fn choose(n: u32, k: u32) -> u128 {
    if k > n {
        return 0;
    }
    let k = k.min(n - k);
    let mut r: u128 = 1;
    for i in 0..k {
        r = r * u128::from(n - i) / u128::from(i + 1);
    }
    r
}

/// How many of a tile a word or leave can hold, plus one: the size of each
/// row of [`Distribution::choose`]'s table.
pub const CHOOSE_K: usize = 16;

/// `C(count in bag, k)` for each tile and each `k < CHOOSE_K`: every product
/// below needs only these, so a distribution works them out once instead of
/// once per word (a whole lexicon's build spent most of its time here).
pub fn choose_table(counts_in_bag: impl Iterator<Item = u16>) -> Vec<[u128; CHOOSE_K]> {
    counts_in_bag
        .map(|n| std::array::from_fn(|k| choose(u32::from(n), k as u32)))
        .collect()
}

fn choose_in_bag(dist: &Distribution, t: usize, n: u8) -> u128 {
    match dist.choose.get(t).and_then(|row| row.get(usize::from(n))) {
        Some(&c) => c,
        None => choose(u32::from(dist.tiles[t].count), u32::from(n)),
    }
}

/// The product over `tiles` (ascending) of `C(count in bag, count in word)`,
/// skipping tiles the word holds none of.
fn product_over(dist: &Distribution, counts: &[u8], tiles: impl Iterator<Item = usize>) -> u128 {
    let mut p: u128 = 1;
    for t in tiles {
        let n = counts[t];
        if n > 0 {
            p = p.saturating_mul(choose_in_bag(dist, t, n));
            if p == 0 {
                return 0;
            }
        }
    }
    p
}

/// The product over each distinct tile of `C(count in bag, count in word)`.
fn product(dist: &Distribution, counts: &[u8]) -> u128 {
    product_over(dist, counts, 0..counts.len())
}

/// A word's combinations with up to two blanks. `counts` is the word's
/// per-tile count vector; a word holds no blank.
pub fn word_combinations(dist: &Distribution, counts: &[u8]) -> u128 {
    word_combinations_fast(dist, counts).unwrap_or_else(|| word_combinations_each(dist, counts))
}

/// The same sum, multiplied out term by term: the reference, and the answer
/// whenever [`word_combinations_fast`] would overflow.
pub fn word_combinations_each(dist: &Distribution, counts: &[u8]) -> u128 {
    let blanks = u32::from(dist.blank_count());
    let mut c = counts.to_vec();
    // Only the word's own tiles: every other factor is C(n, 0) = 1.
    let distinct: Vec<usize> = (0..c.len()).filter(|&t| c[t] > 0).collect();
    let mut total = product_over(dist, &c, distinct.iter().copied());
    if blanks >= 1 {
        let one = choose(blanks, 1);
        for &t in &distinct {
            c[t] -= 1;
            total += one * product_over(dist, &c, distinct.iter().copied());
            c[t] += 1;
        }
    }
    if blanks >= 2 {
        let two = choose(blanks, 2);
        for (i, &t) in distinct.iter().enumerate() {
            // The same tile twice, when the word holds it at least twice.
            if c[t] >= 2 {
                c[t] -= 2;
                total += two * product_over(dist, &c, distinct.iter().copied());
                c[t] += 2;
            }
            for &u in &distinct[i + 1..] {
                c[t] -= 1;
                c[u] -= 1;
                total += two * product_over(dist, &c, distinct.iter().copied());
                c[t] += 1;
                c[u] += 1;
            }
        }
    }
    total
}

/// [`word_combinations`] in O(d²) for a word of d distinct tiles, from
/// prefix and suffix products of its factors instead of each term's own
/// product; `None` if any step would overflow, where the term-by-term sum
/// (which saturates) is the answer. Exact integers either way, so the two
/// agree whenever this one answers.
fn word_combinations_fast(dist: &Distribution, counts: &[u8]) -> Option<u128> {
    let blanks = u32::from(dist.blank_count());
    let distinct: Vec<usize> = (0..counts.len()).filter(|&t| counts[t] > 0).collect();
    let d = distinct.len();
    // f: the tile at its count; g1, g2: with one or two of it left to blanks.
    let f: Vec<u128> = distinct.iter().map(|&t| choose_in_bag(dist, t, counts[t])).collect();
    let g1: Vec<u128> = distinct.iter().map(|&t| choose_in_bag(dist, t, counts[t] - 1)).collect();
    let mut prefix = vec![1u128; d + 1];
    for i in 0..d {
        prefix[i + 1] = prefix[i].checked_mul(f[i])?;
    }
    let mut suffix = vec![1u128; d + 1];
    for i in (0..d).rev() {
        suffix[i] = suffix[i + 1].checked_mul(f[i])?;
    }
    let mut total = prefix[d];
    if blanks >= 1 {
        let one = choose(blanks, 1);
        for i in 0..d {
            total = total.checked_add(one.checked_mul(prefix[i].checked_mul(g1[i])?.checked_mul(suffix[i + 1])?)?)?;
        }
    }
    if blanks >= 2 {
        let two = choose(blanks, 2);
        for i in 0..d {
            if counts[distinct[i]] >= 2 {
                let g2 = choose_in_bag(dist, distinct[i], counts[distinct[i]] - 2);
                total = total.checked_add(two.checked_mul(prefix[i].checked_mul(g2)?.checked_mul(suffix[i + 1])?)?)?;
            }
            // m: the factors before j, with tile i one short.
            let mut m = prefix[i].checked_mul(g1[i])?;
            for j in i + 1..d {
                total = total.checked_add(two.checked_mul(m.checked_mul(g1[j])?.checked_mul(suffix[j + 1])?)?)?;
                m = m.checked_mul(f[j])?;
            }
        }
    }
    Some(total)
}

/// A leave's combinations: the blank is an ordinary tile at the bag's blank
/// count, with no blank substitution.
pub fn leave_combinations(dist: &Distribution, counts: &[u8]) -> u128 {
    debug_assert!(counts.len() == dist.len());
    let _ = BLANK;
    product(dist, counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tiles::Tile;
    use crate::catalog::tiles::tests::tiledef;

    fn bag(blanks: u16) -> Distribution {
        Distribution::new(
            1,
            "tiny",
            vec![
                tiledef("?", "?", blanks, 0, false),
                tiledef("A", "a", 3, 1, true),
                tiledef("B", "b", 2, 3, false),
                tiledef("C", "c", 1, 3, false),
                tiledef("D", "d", 2, 2, false),
            ],
        )
    }

    /// Every subset of physical tiles of the word's length that spells it with
    /// at most two blanks.
    fn brute_force(dist: &Distribution, word: &[Tile]) -> u128 {
        let mut physical: Vec<Tile> = Vec::new();
        for (t, d) in dist.tiles.iter().enumerate() {
            for _ in 0..d.count {
                physical.push(t as Tile);
            }
        }
        let need = dist.counts(word);
        let n = physical.len();
        let k = word.len();
        let mut total = 0u128;
        for mask in 0u32..(1 << n) {
            if mask.count_ones() as usize != k {
                continue;
            }
            let mut have = vec![0u8; dist.len()];
            for (i, &t) in physical.iter().enumerate() {
                if mask & (1 << i) != 0 {
                    have[t as usize] += 1;
                }
            }
            let blanks = have[0];
            if blanks > 2 {
                continue;
            }
            if (1..dist.len()).all(|t| have[t] <= need[t]) {
                total += 1;
            }
        }
        total
    }

    #[test]
    fn combinations_match_brute_force_for_two_one_and_no_blanks() {
        for blanks in [2u16, 1, 0] {
            let d = bag(blanks);
            for w in [
                "A", "AB", "AA", "AAB", "ABCD", "BBD", "AAA", "ABBD", "CC", "AAAB", "DDBB",
            ] {
                let tiles = d.parse_magpie(w, false).unwrap();
                assert_eq!(
                    word_combinations(&d, &d.counts(&tiles)),
                    brute_force(&d, &tiles),
                    "{w} with {blanks} blanks"
                );
            }
        }
    }

    #[test]
    fn leave_combinations_count_the_blank_as_a_tile() {
        let d = bag(2);
        let t = d.parse_magpie("?AB", true).unwrap();
        assert_eq!(leave_combinations(&d, &d.counts(&t)), 2 * 3 * 2);
        let t = d.parse_magpie("??", true).unwrap();
        assert_eq!(leave_combinations(&d, &d.counts(&t)), 1);
    }

    #[test]
    fn the_quick_sum_is_the_term_by_term_sum() {
        // Every count vector of up to 15 tiles over a five-tile bag with two
        // blanks, including counts the bag cannot supply.
        let d = Distribution::new(
            1,
            "t",
            vec![tiledef("?", "?", 2, 0, false), tiledef("A", "a", 9, 1, true), tiledef("B", "b", 2, 3, false), tiledef("C", "c", 1, 3, false), tiledef("D", "d", 4, 2, false)],
        );
        let mut n = 0;
        for a in 0..=6u8 {
            for b in 0..=4u8 {
                for c in 0..=3u8 {
                    for e in 0..=5u8 {
                        if a + b + c + e == 0 || a + b + c + e > 15 {
                            continue;
                        }
                        let counts = [0, a, b, c, e];
                        assert_eq!(word_combinations(&d, &counts), word_combinations_each(&d, &counts), "{counts:?}");
                        n += 1;
                    }
                }
            }
        }
        assert!(n > 500);
    }
}
