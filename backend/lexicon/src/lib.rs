//! The lexicon index and the search engine, with no I/O (PLAN.md § Catalog
//! Indexes, § Search Engine). The server (`acrodont`) and the browser's
//! WebAssembly build (`search-wasm`, PLAN.md § Search page) run this same
//! code, so a search returns the same words on both.

pub mod catalog;
pub mod clock;
pub mod search;
