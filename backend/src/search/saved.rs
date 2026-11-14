//! Saved searches (PLAN.md § API → Catalog and search): `GET /api/searches`,
//! `GET /api/searches/:id`, `POST /api/searches`, `DELETE /api/searches/:id`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::routes::path_errors;
use super::store::{insert_spec, load_spec, SpecKind};
use super::validate::validate;
use super::wire::{parse_tree, tree_to_json, PathError, QuizType};
use crate::app::AppState;
use crate::auth::Session;
use crate::error::{ApiError, ApiResult};
use crate::extract::ApiJson;
use crate::storage;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/searches", get(list).post(save))
        .route("/api/searches/{id}", get(load).delete(remove))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Summary {
    id: Uuid,
    name: String,
    quiz_type: QuizType,
    word_list_entries: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

async fn summary(conn: &mut sqlx::PgConnection, user_id: Uuid, id: Uuid) -> Result<Option<Summary>, sqlx::Error> {
    sqlx::query_as!(
        Summary,
        r#"SELECT s.id, s.name, p.quiz_type AS "quiz_type: QuizType",
                  (SELECT coalesce(sum(length(c.entries) - length(replace(c.entries, E'\n', ''))), 0)::int8
                   FROM search_conditions c WHERE c.spec_id = s.spec_id) AS "word_list_entries!",
                  s.created_at, s.updated_at
           FROM saved_searches s JOIN search_specs p ON p.id = s.spec_id
           WHERE s.id = $1 AND s.user_id = $2"#,
        id,
        user_id
    )
    .fetch_optional(conn)
    .await
}

/// The user's saved searches without their trees, so the list stays small
/// however many 300,000-entry lists a user keeps.
async fn list(State(state): State<AppState>, Session(user): Session) -> ApiResult<Json<Vec<Summary>>> {
    let rows = sqlx::query_as!(
        Summary,
        r#"SELECT s.id, s.name, p.quiz_type AS "quiz_type: QuizType",
                  (SELECT coalesce(sum(length(c.entries) - length(replace(c.entries, E'\n', ''))), 0)::int8
                   FROM search_conditions c WHERE c.spec_id = s.spec_id) AS "word_list_entries!",
                  s.created_at, s.updated_at
           FROM saved_searches s JOIN search_specs p ON p.id = s.spec_id
           WHERE s.user_id = $1 ORDER BY s.name"#,
        user.id
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// One saved search's whole tree, in the shape `POST` accepts. Shares the
/// search bucket: it reads up to 300,000 word-list rows.
async fn load(State(state): State<AppState>, Session(user): Session, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    state.limits.search.check(&user.id)?;
    let mut conn = state.db.acquire().await?;
    let row = sqlx::query!("SELECT name, spec_id FROM saved_searches WHERE id = $1 AND user_id = $2", id, user.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(ApiError::NotFound)?;
    let (quiz_type, tree) = load_spec(&mut conn, row.spec_id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "id": id, "name": row.name, "quiz_type": quiz_type, "filters": tree_to_json(&tree) })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveBody {
    id: Uuid,
    name: String,
    quiz_type: QuizType,
    filters: Value,
    #[serde(default)]
    overwrite: bool,
}

async fn save(State(state): State<AppState>, Session(user): Session, ApiJson(b): ApiJson<SaveBody>) -> ApiResult<Response> {
    state.limits.search.check(&user.id)?;
    // A request whose id the server already holds for this user returns that
    // saved search unchanged; one held by another user is refused.
    let owner = sqlx::query_scalar!("SELECT user_id FROM saved_searches WHERE id = $1", b.id)
        .fetch_optional(&state.db)
        .await?;
    match owner {
        Some(o) if o != user.id => return Err(ApiError::conflict("invalid")),
        Some(_) => {
            let s = summary(&mut *state.db.acquire().await?, user.id, b.id).await?.ok_or(ApiError::NotFound)?;
            return Ok((StatusCode::OK, Json(s)).into_response());
        }
        None => {}
    }
    let n = b.name.chars().count();
    let mut errors = Vec::new();
    if n == 0 || n > 100 {
        errors.push(PathError::new(&[], "name", "The name must be 1–100 characters."));
    } else if b.name.contains('\0') {
        errors.push(PathError::new(&[], "name", super::validate::NOT_STORABLE));
    }
    // The tree is validated as it is for a preview, for everything that does
    // not need a lexicon.
    let tree = match parse_tree(&b.filters) {
        Ok(t) => Some(t),
        Err(e) => {
            errors.extend(e);
            None
        }
    };
    if let Some(t) = &tree
        && let Err(e) = validate(t, b.quiz_type, None) {
            errors.extend(e);
        }
    if !errors.is_empty() {
        return Err(path_errors(errors));
    }
    let tree = tree.expect("validated");
    let bytes = storage::spec_bytes(&tree);

    let mut tx = state.db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user.id).fetch_one(&mut *tx).await?;
    let same_name = sqlx::query!(
        "SELECT id, spec_id, storage_bytes FROM saved_searches WHERE user_id = $1 AND name = $2",
        user.id,
        b.name
    )
    .fetch_optional(&mut *tx)
    .await?;
    if same_name.is_some() && !b.overwrite {
        return Err(ApiError::conflict("name_taken"));
    }
    // Checked after locking the user's row, so two saves cannot both take the
    // last space; an overwrite needs only what it adds to the one it replaces.
    let needed = bytes - same_name.as_ref().map_or(0, |o| o.storage_bytes);
    let usage = storage::usage(&mut tx, user.id, state.config.max_storage_bytes_per_user).await?;
    if !usage.fits(needed) {
        return Err(usage.refusal(needed));
    }
    if let Some(old) = &same_name {
        sqlx::query!("DELETE FROM saved_searches WHERE id = $1", old.id).execute(&mut *tx).await?;
        sqlx::query!("DELETE FROM search_specs WHERE id = $1", old.spec_id).execute(&mut *tx).await?;
    }
    let spec_id = insert_spec(&mut tx, user.id, b.quiz_type, &tree, SpecKind::SavedSearch).await?;
    sqlx::query!(
        "INSERT INTO saved_searches (id, user_id, name, spec_id, storage_bytes) VALUES ($1, $2, $3, $4, $5)",
        b.id,
        user.id,
        b.name,
        spec_id,
        bytes
    )
    .execute(&mut *tx)
    .await?;
    storage::add_to_user(&mut tx, user.id, needed).await?;
    tx.commit().await?;
    let s = summary(&mut *state.db.acquire().await?, user.id, b.id).await?.ok_or(ApiError::NotFound)?;
    Ok((StatusCode::CREATED, Json(s)).into_response())
}

/// Deletes a saved search and its spec, and frees what it held. The user's
/// row is locked first, the order a save takes.
async fn remove(State(state): State<AppState>, Session(user): Session, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user.id).fetch_one(&mut *tx).await?;
    let gone = sqlx::query!(
        "DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING spec_id, storage_bytes",
        id,
        user.id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;
    sqlx::query!("DELETE FROM search_specs WHERE id = $1", gone.spec_id).execute(&mut *tx).await?;
    storage::add_to_user(&mut tx, user.id, -gone.storage_bytes).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
