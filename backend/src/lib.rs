//! Acrodont backend (PLAN.md § Architecture).

// Row tuples from sqlx::query_as read clearer inline than behind aliases.
#![allow(clippy::type_complexity)]

pub mod app;
pub mod auth;
pub mod cascade;
pub mod catalog;
pub mod clock;
pub mod config;
pub mod error;
pub mod extract;
pub mod health;
pub mod leave;
pub mod net;
pub mod purge;
pub mod rate;
pub mod export;
pub mod search;
pub mod sync;

pub use app::{AppState, build_router};
