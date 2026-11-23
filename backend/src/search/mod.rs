//! The search engine (PLAN.md § Search Engine): the `lexicon` crate's, shared
//! with the browser's search, plus the server's routes and saved searches.

#[cfg(test)]
mod contract;
pub mod routes;
pub mod saved;
pub mod store;
#[cfg(test)]
mod tests;

pub use lexicon::search::*;
