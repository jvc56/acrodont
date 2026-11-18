//! Root words (PLAN.md § Filter reference, Root Word), from the definitions
//! alone. A definition's senses are separated by ` / `. A sense is a **form
//! of** another word when it starts with an all-capitals word that is in the
//! same lexicon, followed by a comma, a space, a period or nothing: CSW24's
//! `EATS: EAT, to consume food [v]`, `ABSENTMINDEDLY: ABSENTMINDED [adv]` and
//! the typo `SQUIRMINGLY: SQUIRMING. wriggling [adv]`.
//!
//! A word is a root when none of its senses is a form of another word, or
//! when some but not all are and another word in the lexicon is a form of it:
//! `SUBDUED: SUBDUE, to bring under control [v] / quiet and serious [adj]` is
//! a root because `SUBDUEDLY: SUBDUED, quiet and serious [adv]` points to it.
//! A word whose every sense is a form of another word is never a root. A
//! lexicon whose definitions do not follow this convention has every word a
//! root.

/// The all-capitals word a sense starts with, when it is followed by a comma,
/// a space, a period or nothing: the word the sense may be a form of.
pub fn sense_root(sense: &str) -> Option<&str> {
    let s = sense.trim_start();
    let end = s.find(|c: char| !c.is_ascii_uppercase()).unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    match s[end..].chars().next() {
        None | Some(',' | ' ' | '.') => Some(&s[..end]),
        _ => None,
    }
}

/// Which of the words are roots, given each word's definition, by id, and
/// `find`, which gives the id of the word an all-capitals word names, if the
/// lexicon holds it.
pub fn roots(definitions: &[&str], find: impl Fn(&str) -> Option<u32>) -> Vec<bool> {
    let n = definitions.len();
    // Whether another word is a form of this one.
    let mut has_derived = vec![false; n];
    // Per word: whether any sense is a form of another word, and whether any is its own.
    let mut senses = Vec::with_capacity(n);
    for (i, d) in definitions.iter().enumerate() {
        let (mut form, mut own) = (false, false);
        for sense in d.split(" / ") {
            match sense_root(sense).and_then(&find) {
                Some(p) => {
                    form = true;
                    if p as usize != i {
                        has_derived[p as usize] = true;
                    }
                }
                None => own = true,
            }
        }
        senses.push((form, own));
    }
    senses.iter().enumerate().map(|(i, &(form, own))| own && (!form || has_derived[i])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sense_names_its_root_by_a_capitals_word_then_a_comma_space_period_or_nothing() {
        assert_eq!(sense_root("EAT, to consume food [v]"), Some("EAT"));
        assert_eq!(sense_root("ABSENTMINDED [adv]"), Some("ABSENTMINDED"));
        assert_eq!(sense_root("SQUIRMING. wriggling [adv]"), Some("SQUIRMING"));
        assert_eq!(sense_root(" MUDEJAR (Arabic) a Muslim [n]"), Some("MUDEJAR"));
        assert_eq!(sense_root("EAT"), Some("EAT"));
        assert_eq!(sense_root("to consume food [v -ED, -ING, -S]"), None);
        assert_eq!(sense_root("(Hawaiian) a volcanic rock [n -S]"), None);
        assert_eq!(sense_root("EATs, a typo"), None);
        assert_eq!(sense_root("UK-style [adj]"), None);
        assert_eq!(sense_root(""), None);
    }

    /// The cases the criteria were checked against on CSW24.
    #[test]
    fn roots_follow_the_csw_convention() {
        let lexicon = [
            ("EAT", "to consume food [v ATE, EATEN, EATING, EATS]"),
            ("EATS", "EAT, to consume food [v]"),
            ("EATER", "one who eats [n -S]"),
            ("BIZARRE", "strange [adj]"),
            ("ABSENTMINDED", "preoccupied [adj ABSENTMINDEDLY]"),
            ("ABSENTMINDEDLY", "ABSENTMINDED [adv]"),
            ("SQUIRMING", "wriggling [adj SQUIRMINGLY]"),
            ("SQUIRMINGLY", "SQUIRMING. wriggling [adv]"),
            ("SUBDUE", "to bring under control [v -D, -ING, -S]"),
            ("SUBDUED", "SUBDUE, to bring under control [v] / quiet and serious [adj SUBDUEDLY]"),
            ("SUBDUEDLY", "SUBDUED, quiet and serious [adv]"),
            ("BEGIN", "to start [v BEGAN, BEGUN, BEGINNING, BEGINS]"),
            ("BEGUN", "BEGIN, to start [v] / a beginning [n]"),
            ("ANESTRI", "ANESTRUS, a period of sexual dormancy [n]"),
            ("LEAVES", "LEAF, a plant organ [n] / LEAVE, to go away [v]"),
            ("LEAF", "a plant organ [n -S] / to turn pages [v -ED, -ING, -S]"),
            ("LEAVE", "to go away [v -S]"),
        ];
        let defs: Vec<&str> = lexicon.iter().map(|(_, d)| *d).collect();
        let find = |w: &str| lexicon.iter().position(|(x, _)| *x == w).map(|i| i as u32);
        let roots = roots(&defs, find);
        let root = |w: &str| roots[lexicon.iter().position(|(x, _)| *x == w).unwrap()];
        for w in ["EAT", "EATER", "BIZARRE", "ABSENTMINDED", "SQUIRMING", "SUBDUE", "LEAF", "LEAVE"] {
            assert!(root(w), "{w} is a root: none of its senses is a form of another word");
        }
        for w in ["EATS", "ABSENTMINDEDLY", "SQUIRMINGLY", "SUBDUEDLY", "LEAVES"] {
            assert!(!root(w), "{w} is no root: every sense is a form of another word");
        }
        // Mixed: a root only when another word is a form of it.
        assert!(root("SUBDUED"), "SUBDUEDLY points to it");
        assert!(!root("BEGUN"), "nothing points to it");
        // A sense naming a word the lexicon does not hold is the word's own.
        assert!(root("ANESTRI"));
    }

    #[test]
    fn a_lexicon_without_the_convention_has_every_word_a_root() {
        let defs = ["anys: years [n]", "any: a year [n -S]", ""];
        assert_eq!(roots(&defs, |_| None), vec![true, true, true]);
    }
}
