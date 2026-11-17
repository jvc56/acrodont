//! Presets (PLAN.md § Settings → Presets): every setting's value and a
//! cascade's three rules, saved under a name, to apply to a cascade or to
//! start one with. `PUT /api/presets/:id` saves one (a new one, or a
//! replacement of the one with that id), `PATCH /api/presets/:id` renames it
//! and `DELETE /api/presets/:id` deletes it. All three need a connection, as
//! saved searches do. Each change bumps the account's `presets_version`, and
//! the next sync response of each device whose version differs carries the
//! whole list, which the device keeps to apply a preset offline.
//!
//! The built-in Defaults preset is the frontend's own and is never stored, so
//! its name is refused here.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::Session;
use crate::cascade::rows::Progression;
use crate::cascade::{rules, settings};
use crate::error::{ApiError, ApiResult};
use crate::extract::ApiJson;
use crate::search::routes::path_errors;
use crate::search::wire::PathError;

/// At most this many presets per account. Like the account's settings, they
/// are outside the storage limit, so they are bounded here instead.
pub const MAX_PRESETS: i64 = 50;
/// The built-in preset's name, which no stored preset may take (any case).
pub const DEFAULTS_NAME: &str = "Defaults";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/presets/{id}", put(save).patch(rename).delete(remove))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Preset {
    pub id: Uuid,
    pub name: String,
    pub settings: Value,
    pub clear_threshold: i16,
    pub segment_size: i32,
    pub progression: Progression,
    pub updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT id, name, settings, clear_threshold, segment_size, progression, updated_at FROM setting_presets";

/// The account's presets, by name.
pub async fn all(conn: &mut PgConnection, user: Uuid) -> Result<Vec<Preset>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE user_id = $1 ORDER BY name, id")))
        .bind(user)
        .fetch_all(conn)
        .await
}

async fn one(conn: &mut PgConnection, user: Uuid, id: Uuid) -> Result<Option<Preset>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = $1 AND user_id = $2")))
        .bind(id)
        .bind(user)
        .fetch_optional(conn)
        .await
}

/// A preset's name: 1–100 characters, none of them NUL, and not Defaults.
fn check_name(name: &str, errors: &mut Vec<PathError>) {
    let n = name.chars().count();
    if n == 0 || n > 100 {
        errors.push(PathError::new(&[], "name", "The name must be 1–100 characters."));
    } else if name.contains('\0') {
        errors.push(PathError::new(&[], "name", crate::search::validate::NOT_STORABLE));
    } else if name.trim().eq_ignore_ascii_case(DEFAULTS_NAME) {
        errors.push(PathError::new(&[], "name", "“Defaults” is the built-in preset’s name."));
    }
}

/// Locks the user's row, so two changes to the account's presets (the count
/// against MAX_PRESETS, a name) are made one after the other, and bumps the
/// version every device compares.
async fn lock_and_bump(conn: &mut PgConnection, user: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("UPDATE users SET presets_version = presets_version + 1 WHERE id = $1 RETURNING presets_version")
        .bind(user)
        .fetch_one(conn)
        .await
}

/// Whether another of the account's presets holds `name`.
async fn name_held(conn: &mut PgConnection, user: Uuid, id: Uuid, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM setting_presets WHERE user_id = $1 AND name = $2 AND id <> $3)")
        .bind(user)
        .bind(name)
        .bind(id)
        .fetch_one(conn)
        .await
}

/// Who holds a preset id: nobody, this user, or another one.
async fn owner(conn: &mut PgConnection, id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT user_id FROM setting_presets WHERE id = $1").bind(id).fetch_optional(conn).await
}

fn answer(status: StatusCode, p: Preset, version: i64) -> Response {
    (status, Json(json!({ "preset": p, "presets_version": version.to_string() }))).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveBody {
    name: String,
    settings: Value,
    clear_threshold: i64,
    segment_size: i64,
    progression: Progression,
}

/// Saves a preset under `id`: a new one (`201`), or the replacement of the
/// account's preset with that id (`200`). A name another of the account's
/// presets holds is `409 name_taken`: the device asks the user first, then
/// replaces that preset by its id. A new preset past MAX_PRESETS is
/// `409 preset_limit`.
async fn save(
    State(state): State<AppState>,
    Session(user): Session,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<SaveBody>,
) -> ApiResult<Response> {
    state.limits.sync.check(&user.id)?;
    let mut errors = Vec::new();
    check_name(&b.name, &mut errors);
    let values = settings::values_of(&b.settings);
    if values.is_err() {
        errors.push(PathError::new(&[], "settings", "The settings are not ones a preset can hold."));
    }
    if rules::check_clear_threshold(b.clear_threshold).is_err() {
        errors.push(PathError::new(&[], "clear_threshold", "The clear threshold is 1–100."));
    }
    let cap = state.config.max_quiz_questions;
    if rules::check_segment_size(b.segment_size, cap).is_err() {
        errors.push(PathError::new(&[], "segment_size", format!("The segment size is 0 (off) or 5–{cap}.")));
    }
    if !errors.is_empty() {
        return Err(path_errors(errors));
    }
    let values = Value::Object(values.expect("checked"));

    let mut tx = state.db.begin().await?;
    let version = lock_and_bump(&mut tx, user.id).await?;
    let existing = owner(&mut tx, id).await?;
    if existing.is_some_and(|o| o != user.id) {
        return Err(ApiError::conflict("invalid"));
    }
    if name_held(&mut tx, user.id, id, &b.name).await? {
        return Err(ApiError::conflict("name_taken"));
    }
    if existing.is_none() {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM setting_presets WHERE user_id = $1")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_PRESETS {
            return Err(ApiError::conflict("preset_limit"));
        }
    }
    sqlx::query(
        "INSERT INTO setting_presets (id, user_id, name, settings, clear_threshold, segment_size, progression)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, settings = EXCLUDED.settings,
             clear_threshold = EXCLUDED.clear_threshold, segment_size = EXCLUDED.segment_size,
             progression = EXCLUDED.progression, updated_at = now()",
    )
    .bind(id)
    .bind(user.id)
    .bind(&b.name)
    .bind(&values)
    .bind(b.clear_threshold as i16)
    .bind(b.segment_size as i32)
    .bind(b.progression)
    .execute(&mut *tx)
    .await?;
    let p = one(&mut tx, user.id, id).await?.ok_or(ApiError::NotFound)?;
    crate::sync::notify::changed(&mut tx, user.id, None).await?;
    tx.commit().await?;
    let status = if existing.is_some() { StatusCode::OK } else { StatusCode::CREATED };
    Ok(answer(status, p, version))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameBody {
    name: String,
}

/// A new name for one of the account's presets; `409 name_taken` when
/// another holds it.
async fn rename(
    State(state): State<AppState>,
    Session(user): Session,
    Path(id): Path<Uuid>,
    ApiJson(b): ApiJson<RenameBody>,
) -> ApiResult<Response> {
    state.limits.sync.check(&user.id)?;
    let mut errors = Vec::new();
    check_name(&b.name, &mut errors);
    if !errors.is_empty() {
        return Err(path_errors(errors));
    }
    let mut tx = state.db.begin().await?;
    let version = lock_and_bump(&mut tx, user.id).await?;
    if owner(&mut tx, id).await? != Some(user.id) {
        return Err(ApiError::NotFound);
    }
    if name_held(&mut tx, user.id, id, &b.name).await? {
        return Err(ApiError::conflict("name_taken"));
    }
    sqlx::query("UPDATE setting_presets SET name = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(&b.name)
        .execute(&mut *tx)
        .await?;
    let p = one(&mut tx, user.id, id).await?.ok_or(ApiError::NotFound)?;
    crate::sync::notify::changed(&mut tx, user.id, None).await?;
    tx.commit().await?;
    Ok(answer(StatusCode::OK, p, version))
}

/// Deletes one of the account's presets. Cascades made with it keep their
/// values: a cascade holds its preset's values, never a reference to it.
async fn remove(State(state): State<AppState>, Session(user): Session, Path(id): Path<Uuid>) -> ApiResult<Response> {
    state.limits.sync.check(&user.id)?;
    let mut tx = state.db.begin().await?;
    let version = lock_and_bump(&mut tx, user.id).await?;
    let gone = sqlx::query("DELETE FROM setting_presets WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if gone.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    crate::sync::notify::changed(&mut tx, user.id, None).await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(json!({ "presets_version": version.to_string() }))).into_response())
}
