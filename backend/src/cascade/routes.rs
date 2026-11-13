//! `POST /api/cascades`, `POST /api/cascades/:id/duplicate` and
//! `GET /api/cascades/:id/cards` (PLAN.md § API → Cascades and sync).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::order::{questions_hash, to_i64};
use super::rows::{self, AnswerMode, Progression};
use crate::app::AppState;
use crate::auth::{CurrentUser, Session};
use crate::catalog::tiles::Tile;
use crate::error::{ApiError, ApiResult};
use crate::extract::ApiJson;
use crate::search::routes::{path_errors, prepare, run, Prepared};
use crate::search::store::{copy_spec, insert_spec, load_spec, SpecKind};
use crate::search::wire::{tree_to_json, PathError, QuizType};
use crate::storage;

pub const MAX_CARDS_PER_PAGE: i64 = 10_000;
pub const MAX_KEYS_PER_PAGE: i64 = 100_000;
/// Cards named one by one with `idx=`: what the player reads ahead, in the
/// quiz's own order, while the cascade's pages are still downloading.
pub const MAX_CARDS_BY_IDX: usize = 1_000;
/// A device timestamp ahead of the server by more than this is stored at the limit.
pub const MAX_FUTURE: Duration = Duration::minutes(5);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/cascades", post(create))
        .route("/api/cascades/{id}/duplicate", post(duplicate))
        .route("/api/cascades/{id}/cards", get(cards))
}

/// Device time, clamped to the server's now + 5 minutes.
pub fn clamp_at(state: &AppState, at: DateTime<Utc>) -> DateTime<Utc> {
    at.min(state.clock.now() + MAX_FUTURE)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
    id: Uuid,
    source_quiz_id: Uuid,
    device_id: Uuid,
    at: DateTime<Utc>,
    name: String,
    lexicon: String,
    quiz_type: QuizType,
    clear_threshold: i64,
    segment_size: i64,
    progression: Progression,
    require_alphabetical: bool,
    answer_mode: AnswerMode,
    filters: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicateBody {
    id: Uuid,
    source_quiz_id: Uuid,
    device_id: Uuid,
    at: DateTime<Utc>,
}

struct NewCascade {
    id: Uuid,
    source_quiz_id: Uuid,
    device_id: Uuid,
    at: DateTime<Utc>,
    name: String,
    clear_threshold: i16,
    segment_size: i32,
    progression: Progression,
    require_alphabetical: bool,
    answer_mode: AnswerMode,
    /// Duplicate copies the original's; a new cascade takes the column defaults.
    display: Option<Display>,
    /// Duplicate copies the original's spec; creation stores the request's tree.
    copy_of_spec: Option<Uuid>,
}

/// What a card shows and what a reveal marks (PLAN.md § Settings): the
/// cascade's own, set by `set_cascade_options`.
struct Display {
    show_definitions: bool,
    show_hooks: bool,
    reveal_correct: bool,
    show_found_count: bool,
    show_probability: bool,
    definition_column: bool,
    leave_value_decimals: i16,
}

fn check_fields(state: &AppState, name: &str, threshold: i64, segment_size: i64) -> Result<(), ApiError> {
    let mut errors = Vec::new();
    let n = name.chars().count();
    if n == 0 || n > 200 {
        errors.push(PathError::new(&[], "name", "The name must be 1–200 characters."));
    }
    if !(1..=100).contains(&threshold) {
        errors.push(PathError::new(&[], "clear_threshold", "The clear threshold is 1–100."));
    }
    let cap = i64::from(state.config.max_quiz_questions);
    if segment_size != 0 && !(5..=cap).contains(&segment_size) {
        errors.push(PathError::new(&[], "segment_size", format!("The segment size is 0 (off) or 5–{cap}.")));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(path_errors(errors))
    }
}

/// An account's cascades each have their own name, the Trash included
/// (`UNIQUE (user_id, name)`): a `400` on the field `name`.
fn name_taken(name: &str) -> ApiError {
    path_errors(vec![PathError::new(
        &[],
        "name",
        format!("You already have a cascade named “{name}”. Each cascade needs its own name, the Trash included."),
    )])
}

async fn is_name_taken(db: &sqlx::PgPool, user: Uuid, name: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar!("SELECT 1 AS \"one!\" FROM cascades WHERE user_id = $1 AND name = $2", user, name)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// The name Duplicate gives its new cascade: the original's with the next
/// free number after it, "Sevens" → "Sevens (2)" → "Sevens (3)". The
/// original's own number, if it has one, is replaced; a name at the
/// 200-character limit is cut to make room.
async fn numbered_name(db: &sqlx::PgPool, user: Uuid, original: &str) -> Result<String, sqlx::Error> {
    let base = match original.rsplit_once(" (") {
        Some((b, n)) if !b.is_empty() && n.ends_with(')') && n[..n.len() - 1].parse::<u32>().is_ok_and(|n| n >= 2) => b,
        _ => original,
    };
    let mut n: u32 = 2;
    loop {
        let suffix = format!(" ({n})");
        let room = 200 - suffix.chars().count();
        let candidate: String = base.chars().take(room).chain(suffix.chars()).collect();
        if !is_name_taken(db, user, &candidate).await? {
            return Ok(candidate);
        }
        n += 1;
    }
}

async fn existing(state: &AppState, user: &CurrentUser, id: Uuid) -> ApiResult<Option<Response>> {
    let mut conn = state.db.acquire().await?;
    let owner = sqlx::query_scalar!("SELECT user_id FROM cascades WHERE id = $1", id)
        .fetch_optional(&mut *conn)
        .await?;
    match owner {
        None => Ok(None),
        Some(o) if o != user.id => Err(ApiError::conflict("invalid")),
        Some(_) => {
            let cascade = rows::cascade(&mut conn, user.id, id).await?.ok_or(ApiError::NotFound)?;
            let source = rows::source_quiz(&mut conn, id).await?.ok_or(ApiError::NotFound)?;
            let seq = sqlx::query_scalar!("SELECT sync_seq FROM users WHERE id = $1", user.id)
                .fetch_one(&mut *conn)
                .await?;
            Ok(Some(
                (StatusCode::OK, Json(json!({ "cascade": cascade, "source_quiz": source, "sync_seq": seq.to_string() })))
                    .into_response(),
            ))
        }
    }
}

/// Runs the search before any transaction, then stores the cascade in one
/// short transaction that locks the user's row and checks the storage limit
/// (STORAGE_LIMIT_PLAN.md § S2) against what the new cascade will hold.
async fn store(state: &AppState, user: &CurrentUser, n: NewCascade, p: Prepared) -> ApiResult<Response> {
    if let Some(r) = existing(state, user, n.id).await? {
        return Ok(r);
    }
    let taken = sqlx::query_scalar!("SELECT 1 AS \"one!\" FROM quizzes WHERE id = $1", n.source_quiz_id)
        .fetch_optional(&state.db)
        .await?;
    if taken.is_some() {
        return Err(ApiError::conflict("invalid"));
    }
    // A cheap check refuses an account already at its limit without spending
    // a search; what the cascade needs is not known until the search has run.
    let usage = user.storage(state);
    if !usage.fits(1) {
        return Err(usage.refusal(0));
    }
    let keys = run(state, &p).await?;
    if keys.is_empty() {
        return Err(ApiError::Unprocessable(json!({ "error": "empty", "message": "The search matched nothing." })));
    }
    if keys.len() > state.config.max_quiz_questions as usize {
        return Err(ApiError::Unprocessable(json!({ "error": "over_cap", "count": keys.len(),
            "limit": state.config.max_quiz_questions })));
    }
    let dist = &p.lexicon.distribution;
    let key_text: Vec<String> = keys.iter().map(|k| dist.to_magpie(k)).collect();
    let key_bytes: i64 = key_text.iter().map(|k| k.len() as i64).sum();
    // Duplicate's copy holds the same entries as the tree it was loaded into.
    let needed = storage::new_cascade_bytes(keys.len() as i64, key_bytes, storage::spec_bytes(&p.tree));
    let count_q = keys.len() as i32;
    // One key per line, each ending with its line break.
    let question_keys: String = key_text.iter().flat_map(|k| [k.as_str(), "\n"]).collect();
    let seed: u64 = rand::random();
    let all: Vec<u32> = (0..count_q as u32).collect();
    let hash = questions_hash(&all);
    let at = clamp_at(state, n.at);

    let mut tx = state.db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user.id).fetch_one(&mut *tx).await?;
    let race = sqlx::query_scalar!("SELECT user_id FROM cascades WHERE id = $1", n.id)
        .fetch_optional(&mut *tx)
        .await?;
    if race.is_some() {
        drop(tx);
        return existing(state, user, n.id).await?.ok_or(ApiError::conflict("invalid"));
    }
    // Checked under the lock, so two creations cannot both take the last space.
    let usage = storage::usage(&mut tx, user.id, state.config.max_storage_bytes_per_user).await?;
    if !usage.fits(needed) {
        return Err(usage.refusal(needed));
    }
    let seq = sqlx::query_scalar!("UPDATE users SET sync_seq = sync_seq + 1 WHERE id = $1 RETURNING sync_seq", user.id)
        .fetch_one(&mut *tx)
        .await?;
    // The account's other devices hear of the new cascade once this commits (sync::notify).
    crate::sync::notify::changed(&mut tx, user.id, Some(n.device_id)).await?;
    let spec_id = match n.copy_of_spec {
        Some(original) => copy_spec(&mut tx, user.id, original).await?,
        None => insert_spec(&mut tx, user.id, p.quiz_type, &p.tree, SpecKind::Cascade).await?,
    };
    let leave_set_id = if p.quiz_type.is_leave() { p.leaves.as_ref().map(|s| s.id) } else { None };
    let inserted = sqlx::query!(
        "INSERT INTO cascades (id, user_id, name, quiz_type, lexicon_id, leave_set_id, spec_id, clear_threshold,
                               segment_size, progression, require_alphabetical, options_changed_at, options_seq,
                               options_device_id, question_count, depth, peak_depth, updated_seq, answer_mode,
                               storage_bytes, question_keys)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, 1, $13, $16, $17, $18)",
        n.id,
        user.id,
        n.name,
        p.quiz_type as QuizType,
        p.lexicon.id,
        leave_set_id,
        spec_id,
        n.clear_threshold,
        n.segment_size,
        n.progression as Progression,
        n.require_alphabetical,
        at,
        seq,
        n.device_id,
        count_q,
        n.answer_mode as AnswerMode,
        needed,
        question_keys,
    )
    .execute(&mut *tx)
    .await;
    match inserted {
        Ok(_) => {}
        // Taken between the check before the search and now.
        Err(sqlx::Error::Database(d)) if d.constraint() == Some("cascades_user_id_name_key") => {
            return Err(name_taken(&n.name));
        }
        Err(e) => return Err(e.into()),
    }
    storage::add_to_user(&mut tx, user.id, needed).await?;
    if let Some(d) = &n.display {
        sqlx::query!(
            "UPDATE cascades SET show_definitions = $2, show_hooks = $3, reveal_correct = $4, leave_value_decimals = $5,
                                 show_found_count = $6, show_probability = $7, definition_column = $8
             WHERE id = $1",
            n.id,
            d.show_definitions,
            d.show_hooks,
            d.reveal_correct,
            d.leave_value_decimals,
            d.show_found_count,
            d.show_probability,
            d.definition_column,
        )
        .execute(&mut *tx)
        .await?;
    }
    // The Source quiz takes a copy of the cascade's options.
    let inserted = sqlx::query!(
        "INSERT INTO quizzes (id, cascade_id, user_id, level, origin, segment_size, progression,
                              require_alphabetical, options_changed_at, options_seq, options_device_id,
                              shuffle_seed, questions_hash, question_count, created_seq, updated_seq)
         VALUES ($1, $2, $3, 1, 'source', $4, $5, $6, $7, $8, $9, $10, $11, $12, $8, $8)",
        n.source_quiz_id,
        n.id,
        user.id,
        n.segment_size,
        n.progression as Progression,
        n.require_alphabetical,
        at,
        seq,
        n.device_id,
        to_i64(seed),
        to_i64(hash),
        count_q,
    )
    .execute(&mut *tx)
    .await;
    match inserted {
        Ok(_) => {}
        Err(sqlx::Error::Database(d)) if d.constraint() == Some("quizzes_pkey") => {
            return Err(ApiError::conflict("invalid"));
        }
        Err(e) => return Err(e.into()),
    }
    crate::cards::insert(&mut tx, n.source_quiz_id, &all, true, seq).await?;
    tx.commit().await?;

    let mut conn = state.db.acquire().await?;
    let cascade = rows::cascade(&mut conn, user.id, n.id).await?.ok_or(ApiError::NotFound)?;
    let source = rows::source_quiz(&mut conn, n.id).await?.ok_or(ApiError::NotFound)?;
    Ok((StatusCode::CREATED, Json(json!({ "cascade": cascade, "source_quiz": source, "sync_seq": seq.to_string() })))
        .into_response())
}

async fn create(
    State(state): State<AppState>,
    Session(user): Session,
    ApiJson(b): ApiJson<CreateBody>,
) -> ApiResult<Response> {
    state.limits.search.check(&user.id)?;
    check_fields(&state, &b.name, b.clear_threshold, b.segment_size)?;
    // A repeated request returns what the first one made, before any search.
    if let Some(r) = existing(&state, &user, b.id).await? {
        return Ok(r);
    }
    // Refused before the search is spent on it.
    if is_name_taken(&state.db, user.id, &b.name).await? {
        return Err(name_taken(&b.name));
    }
    let p = prepare(&state, &b.lexicon, b.quiz_type, &b.filters)?;
    let n = NewCascade {
        id: b.id,
        source_quiz_id: b.source_quiz_id,
        device_id: b.device_id,
        at: b.at,
        name: b.name,
        clear_threshold: b.clear_threshold as i16,
        segment_size: b.segment_size as i32,
        progression: b.progression,
        require_alphabetical: b.require_alphabetical,
        answer_mode: b.answer_mode,
        display: None,
        copy_of_spec: None,
    };
    store(&state, &user, n, p).await
}

/// A new cascade named after the original with the next free number
/// ([`numbered_name`]), a private copy of the same filters, and
/// the same threshold, quiz options, answer mode and display settings. Subject
/// to the storage limit.
async fn duplicate(
    State(state): State<AppState>,
    Session(user): Session,
    Path(original): Path<Uuid>,
    ApiJson(b): ApiJson<DuplicateBody>,
) -> ApiResult<Response> {
    state.limits.search.check(&user.id)?;
    if let Some(r) = existing(&state, &user, b.id).await? {
        return Ok(r);
    }
    let mut conn = state.db.acquire().await?;
    let row = sqlx::query!(
        r#"SELECT c.name, c.spec_id, c.clear_threshold, c.segment_size, c.progression AS "progression: Progression",
                  c.require_alphabetical, c.answer_mode AS "answer_mode: AnswerMode", c.show_definitions,
                  c.show_hooks, c.reveal_correct, c.show_found_count, c.show_probability, c.definition_column,
                  c.leave_value_decimals, l.name AS lexicon
           FROM cascades c JOIN lexicons l ON l.id = c.lexicon_id WHERE c.id = $1 AND c.user_id = $2"#,
        original,
        user.id
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(ApiError::NotFound)?;
    let (quiz_type, tree) = load_spec(&mut conn, row.spec_id).await?.ok_or(ApiError::NotFound)?;
    drop(conn);
    let name = numbered_name(&state.db, user.id, &row.name).await?;
    let p = prepare(&state, &row.lexicon, quiz_type, &tree_to_json(&tree))?;
    let n = NewCascade {
        id: b.id,
        source_quiz_id: b.source_quiz_id,
        device_id: b.device_id,
        at: b.at,
        name,
        clear_threshold: row.clear_threshold,
        segment_size: row.segment_size,
        progression: row.progression,
        require_alphabetical: row.require_alphabetical,
        answer_mode: row.answer_mode,
        display: Some(Display {
            show_definitions: row.show_definitions,
            show_hooks: row.show_hooks,
            reveal_correct: row.reveal_correct,
            show_found_count: row.show_found_count,
            show_probability: row.show_probability,
            definition_column: row.definition_column,
            leave_value_decimals: row.leave_value_decimals,
        }),
        copy_of_spec: Some(row.spec_id),
    };
    store(&state, &user, n, p).await
}

// ---------------------------------------------------------------------------
// Card pages
// ---------------------------------------------------------------------------

fn int_param(q: &HashMap<String, String>, name: &str) -> Result<Option<i64>, ApiError> {
    match q.get(name) {
        None => Ok(None),
        Some(v) => v.parse::<i64>().map(Some).map_err(|_| ApiError::bad_request(&format!("invalid_{name}"))),
    }
}

fn flag(q: &HashMap<String, String>, name: &str) -> Result<bool, ApiError> {
    match q.get(name).map(String::as_str) {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        Some(_) => Err(ApiError::bad_request(&format!("invalid_{name}"))),
    }
}

/// Answer cards `[{ idx, key, answer }]` for `from`…`from+limit−1`, or for the
/// comma-separated question indexes in `idx` (at most `MAX_CARDS_BY_IDX`, in
/// idx order, for the player's read-ahead), or with `keys=1` the keys alone as
/// `{ from, keys }`. Served `private, no-store`: the device keeps every byte
/// in IndexedDB, and a second copy in the HTTP cache would sit outside every
/// budget.
async fn cards(
    State(state): State<AppState>,
    Session(user): Session,
    Path(cascade_id): Path<Uuid>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    state.limits.download.check(&user.id)?;
    let keys_only = flag(&q, "keys")?;
    let hooks = flag(&q, "hooks")?;
    let definitions = flag(&q, "definitions")?;
    // Either a range or a list of indexes, never both; keys come only by range.
    let listed: Option<Vec<i32>> = match q.get("idx") {
        None => None,
        Some(_) if keys_only || q.contains_key("from") || q.contains_key("limit") => {
            return Err(ApiError::bad_request("invalid_idx"));
        }
        Some(v) => {
            let list = v
                .split(',')
                .map(|x| x.parse::<i32>().ok().filter(|n| *n >= 0))
                .collect::<Option<Vec<i32>>>()
                .ok_or_else(|| ApiError::bad_request("invalid_idx"))?;
            if list.is_empty() || list.len() > MAX_CARDS_BY_IDX {
                return Err(ApiError::bad_request("invalid_idx"));
            }
            Some(list)
        }
    };
    let (from, limit) = if listed.is_some() {
        (0, 0)
    } else {
        let from = int_param(&q, "from")?.ok_or_else(|| ApiError::bad_request("missing_from"))?;
        let limit = int_param(&q, "limit")?.ok_or_else(|| ApiError::bad_request("missing_limit"))?;
        let max = if keys_only { MAX_KEYS_PER_PAGE } else { MAX_CARDS_PER_PAGE };
        if from < 0 || limit < 1 || limit > max {
            return Err(ApiError::bad_request("invalid_range"));
        }
        (from, limit)
    };
    if keys_only && (q.contains_key("hooks") || q.contains_key("definitions")) {
        return Err(ApiError::bad_request("keys_only"));
    }
    let row = sqlx::query!(
        r#"SELECT c.quiz_type AS "quiz_type: QuizType", c.lexicon_id, l.definitions_revision,
                  ls.values_revision AS "leave_values_revision?"
           FROM cascades c JOIN lexicons l ON l.id = c.lexicon_id
           LEFT JOIN leave_sets ls ON ls.id = c.leave_set_id
           WHERE c.id = $1 AND c.user_id = $2"#,
        cascade_id,
        user.id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    let all = question_keys(&state.db, cascade_id).await?;
    let rows: Vec<(i32, String)> = match &listed {
        Some(list) => {
            let mut want: Vec<i32> = list.iter().copied().filter(|&i| i >= 0 && (i as usize) < all.len()).collect();
            want.sort_unstable();
            want.dedup();
            want.into_iter().map(|i| (i, all[i as usize].clone())).collect()
        }
        None => {
            let end = (from.saturating_add(limit)).min(all.len() as i64);
            (from.min(end)..end).map(|i| (i as i32, all[i as usize].clone())).collect()
        }
    };
    let body = if keys_only {
        let keys: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
        json!({ "from": from, "keys": keys })
    } else {
        let snap = state.catalog.snapshot();
        let lex = snap.lexicons.get(&row.lexicon_id).ok_or(ApiError::Unavailable { retry_after_secs: 5 })?;
        // Definitions are being replaced and this instance has not built the
        // new index yet: a device would store the old text as the new
        // revision's, so cards that carry definitions wait for it.
        let with_definitions = row.quiz_type == QuizType::Definition || (row.quiz_type == QuizType::Anagram && definitions);
        if with_definitions && lex.definitions_revision < row.definitions_revision {
            return Err(ApiError::Unavailable { retry_after_secs: 5 });
        }
        let dist = &lex.distribution;
        let leaves = snap.leave_set_for(lex.id);
        // And likewise while a leave set's values are being replaced.
        if let (QuizType::LeaveValue, Some(named)) = (row.quiz_type, row.leave_values_revision)
            && leaves.is_none_or(|s| s.values_revision < named)
        {
            return Err(ApiError::Unavailable { retry_after_secs: 5 });
        }
        let mut cards = Vec::with_capacity(rows.len());
        for (idx, question_key) in &rows {
            let answer = match row.quiz_type {
                QuizType::Anagram => {
                    let alpha: Vec<Tile> = dist.parse_magpie(question_key, false).unwrap_or_default();
                    let words: Vec<Value> = lex
                        .anagrams(&alpha)
                        .map(|w| {
                            let mut o = serde_json::Map::new();
                            o.insert("word".into(), json!(dist.to_magpie(&w.tiles)));
                            if hooks {
                                // The word's rank by probability among the words of
                                // its length, which a device can show beside its hooks.
                                o.insert("probability_order".into(), json!(w.probability_order));
                                o.insert("front_hooks".into(), json!(dist.to_magpie(&w.front_hooks)));
                                o.insert("back_hooks".into(), json!(dist.to_magpie(&w.back_hooks)));
                                o.insert("front_inner".into(), json!(w.has_front_inner_hook));
                                o.insert("back_inner".into(), json!(w.has_back_inner_hook));
                            }
                            if definitions {
                                o.insert("definition".into(), json!(&*w.definition));
                            }
                            Value::Object(o)
                        })
                        .collect();
                    Value::Array(words)
                }
                QuizType::Definition => {
                    let tiles = dist.parse_magpie(question_key, false).unwrap_or_default();
                    json!(lex.find(&tiles).map(|w| &*w.definition))
                }
                QuizType::LeaveValue => {
                    let tiles = dist.parse_magpie(question_key, true).unwrap_or_default();
                    // The shortest text that round-trips the stored f64.
                    json!(leaves.and_then(|s| s.find(&tiles)).map(|l| l.value))
                }
            };
            let mut card = json!({ "idx": idx, "key": question_key, "answer": answer });
            // A Definition card with hooks asked for carries its word's hooks
            // and inner hooks beside the definition, which stays the answer.
            if hooks && row.quiz_type == QuizType::Definition {
                let tiles = dist.parse_magpie(question_key, false).unwrap_or_default();
                if let Some(w) = lex.find(&tiles) {
                    card["word"] = json!({
                        "word": dist.to_magpie(&w.tiles),
                        "probability_order": w.probability_order,
                        "front_hooks": dist.to_magpie(&w.front_hooks),
                        "back_hooks": dist.to_magpie(&w.back_hooks),
                        "front_inner": w.has_front_inner_hook,
                        "back_inner": w.has_back_inner_hook,
                    });
                }
            }
            cards.push(card);
        }
        Value::Array(cards)
    };
    let mut resp = Json(body).into_response();
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(resp)
}

/// A cascade's question keys, by idx (`cascades.question_keys`).
pub async fn question_keys(db: &sqlx::PgPool, cascade: Uuid) -> Result<Vec<String>, sqlx::Error> {
    let text: Option<String> = sqlx::query_scalar("SELECT question_keys FROM cascades WHERE id = $1")
        .bind(cascade)
        .fetch_optional(db)
        .await?;
    Ok(text.map(|t| split_keys(&t)).unwrap_or_default())
}

/// The keys of a `question_keys` text, each ending with its line break.
pub fn split_keys(text: &str) -> Vec<String> {
    text.split_terminator('\n').map(str::to_owned).collect()
}
