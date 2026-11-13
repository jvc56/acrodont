//! `POST /api/search/preview` (PLAN.md § API → Catalog and search) and the
//! search runner shared with cascade creation.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::validate::{validate, TargetInfo};
use super::wire::{parse_tree, PathError, QuizType, WireGroup};
use super::{SearchError, SearchSpec, Target};
use crate::app::AppState;
use crate::auth::Session;
use crate::catalog::index::{LeaveSetIndex, LexiconIndex};
use crate::catalog::tiles::Tile;
use crate::error::{ApiError, ApiResult};
use crate::extract::ApiJson;

/// Preview returns the count and the first 20 questions.
pub const SAMPLE_SIZE: usize = 20;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/search/preview", post(preview))
}

pub fn path_errors(errors: Vec<PathError>) -> ApiError {
    ApiError::BadRequest(json!({ "errors": errors }))
}

/// A validated search, ready to run.
pub struct Prepared {
    pub lexicon: Arc<LexiconIndex>,
    pub leaves: Option<Arc<LeaveSetIndex>>,
    pub quiz_type: QuizType,
    pub spec: SearchSpec,
    pub tree: WireGroup,
}

/// Which of a lexicon's leave value sets a Leave Value search runs on.
#[derive(Clone, Copy)]
pub enum LeaveChoice<'a> {
    /// The lexicon's newest set.
    Newest,
    /// The set of this name: what the builder's choice sends.
    Named(&'a str),
    /// The set a cascade already uses: Start over keeps it.
    Id(i32),
}

/// Parses and validates `filters` against the named lexicon (and, for a Leave
/// Value quiz, the chosen set of its leave values; the choice means nothing to
/// the other quiz types). Errors are `400 { errors: [{ path, field, message }] }`.
pub fn prepare(
    state: &AppState,
    lexicon: &str,
    quiz_type: QuizType,
    filters: &Value,
    choice: LeaveChoice,
) -> ApiResult<Prepared> {
    let snap = state.catalog.snapshot();
    let Some(lex) = snap.lexicon_by_name(lexicon).cloned() else {
        return Err(path_errors(vec![PathError::new(&[], "lexicon", format!("There is no lexicon named {lexicon}."))]));
    };
    let leaves = if !quiz_type.is_leave() {
        snap.newest_leave_set(lex.id).cloned()
    } else {
        match choice {
            LeaveChoice::Newest => Some(snap.newest_leave_set(lex.id).cloned().ok_or_else(|| {
                path_errors(vec![PathError::new(&[], "lexicon", format!("{lexicon} has no leave values."))])
            })?),
            LeaveChoice::Named(name) => Some(snap.leave_set_named(lex.id, name).cloned().ok_or_else(|| {
                path_errors(vec![PathError::new(
                    &[],
                    "leave_set",
                    format!("{lexicon} has no leave values named {name}."),
                )])
            })?),
            // The cascade pins the set, so it exists; this instance may not have built it yet.
            LeaveChoice::Id(id) => Some(
                snap.leave_sets
                    .get(&id)
                    .filter(|s| s.lexicon_id == lex.id)
                    .cloned()
                    .ok_or(ApiError::Unavailable { retry_after_secs: 5 })?,
            ),
        }
    };
    let tree = parse_tree(filters).map_err(path_errors)?;
    let info = TargetInfo { lexicon: &lex, leaves: leaves.as_ref(), snapshot: &snap };
    let spec = validate(&tree, quiz_type, Some(&info)).map_err(path_errors)?.expect("a target gives a spec");
    Ok(Prepared { lexicon: lex, leaves, quiz_type, spec, tree })
}

/// Runs a prepared search under the `SEARCH_CONCURRENCY` semaphore: a
/// request that waits longer than `SEARCH_TIMEOUT_MS` for a permit gets
/// `503` with `Retry-After`, never `422`; an admitted search that passes its
/// deadline is `422` "search too broad".
pub async fn run(state: &AppState, p: &Prepared) -> ApiResult<Vec<Box<[Tile]>>> {
    let timeout = Duration::from_millis(state.config.search_timeout_ms);
    let permit = match tokio::time::timeout(timeout, state.search_permits.clone().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => return Err(ApiError::Unavailable { retry_after_secs: 1 }),
    };
    let lexicon = p.lexicon.clone();
    let leaves = p.leaves.clone();
    let quiz_type = p.quiz_type;
    let spec = p.spec.clone();
    let deadline = Instant::now() + timeout;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let target = match (&leaves, quiz_type.is_leave()) {
            (Some(s), true) => Target::Leaves(s),
            _ => Target::Words(&lexicon),
        };
        super::search(target, quiz_type, &spec, deadline)
    })
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    result.map_err(|SearchError::TooBroad| {
        ApiError::Unprocessable(json!({ "error": "search_too_broad", "message": "search too broad" }))
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewBody {
    lexicon: String,
    quiz_type: QuizType,
    filters: Value,
    /// A Leave Value search: the lexicon's set of this name. Absent: its newest.
    #[serde(default)]
    leave_set: Option<String>,
}

impl PreviewBody {
    fn choice(&self) -> LeaveChoice<'_> {
        self.leave_set.as_deref().map_or(LeaveChoice::Newest, LeaveChoice::Named)
    }
}

async fn preview(
    State(state): State<AppState>,
    Session(user): Session,
    ApiJson(body): ApiJson<PreviewBody>,
) -> ApiResult<Json<Value>> {
    state.limits.search.check(&user.id)?;
    let prepared = prepare(&state, &body.lexicon, body.quiz_type, &body.filters, body.choice())?;
    let keys = run(&state, &prepared).await?;
    let dist = &prepared.lexicon.distribution;
    let sample: Vec<String> = keys.iter().take(SAMPLE_SIZE).map(|k| dist.to_magpie(k)).collect();
    // What a cascade made from this search would hold as created, with the
    // keys' real bytes (STORAGE_LIMIT_PLAN.md § S6).
    let key_bytes: i64 = keys.iter().map(|k| dist.to_magpie(k).len() as i64).sum();
    let storage_bytes = crate::storage::new_cascade_bytes(keys.len() as i64, key_bytes, crate::storage::spec_bytes(&prepared.tree));
    Ok(Json(json!({
        "count": keys.len(),
        "sample": sample,
        "over_cap": keys.len() > state.config.max_quiz_questions as usize,
        "storage_bytes": storage_bytes,
    })))
}
