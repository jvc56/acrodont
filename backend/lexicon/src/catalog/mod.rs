//! A lexicon's words and their derived attributes (PLAN.md § Catalog Indexes).

pub mod encoded;
pub mod index;
pub mod pos;
pub mod probability;
pub mod roots;
pub mod tiles;

/// The two revisions of a lexicon's words: `lexicons.definitions_revision`
/// and `lexicons.playability_revision`. The words are one stored text, so a
/// text is the one read at a pair of them, and a replacement of either part
/// applies only while both are still the pair it read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Revisions {
    pub definitions: i32,
    pub playability: i32,
}

impl Revisions {
    /// Whether an index read at `self` is no older than `other` in either part.
    pub fn covers(self, other: Revisions) -> bool {
        self.definitions >= other.definitions && self.playability >= other.playability
    }
}
