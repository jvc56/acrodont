//! Exports (PLAN.md § Exporting words, § API → `POST /api/cascades/:id/export-token`
//! and `GET /api/cascades/:id/export`). The token request checks the session,
//! `X-Acrodont-User`, the cascade and quiz and `EXPORT_RATE_PER_MINUTE`, and
//! answers a single-use URL valid for 60 seconds: a PASETO under the export
//! key bound to the user and a hash of the choices. The download needs no
//! header — the token is its proof of account — and answers `204` for an
//! expired, reused or mismatched token, which the device's hidden frame
//! discards. The file streams as it is formatted; a reader that takes nothing
//! for 30 seconds is dropped, and the export's permit with it.

pub mod format;

use std::collections::{BTreeMap, HashMap};

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::session::Session;
use crate::catalog::tiles::Tile;
use crate::error::{ApiError, ApiResult};
use crate::extract::ApiJson;
use format::{Choices, Column, ExportInput, Format, Grade, Lines, Order, QuizType, Scope, Which};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/cascades/{id}/export-token", post(export_token))
        .route("/api/cascades/{id}/export", get(export))
}

const TOKEN_SECONDS: i64 = 60;

#[derive(Serialize, Deserialize)]
struct ExportClaims {
    uid: Uuid,
    cascade: Uuid,
    /// SHA-256 of the canonical choices.
    h: String,
    exp: DateTime<Utc>,
    jti: Uuid,
}

/// The choices, validated, with their canonical query string.
struct Parsed {
    choices: Choices,
    quiz_id: Option<Uuid>,
    definitions: bool,
    hooks: bool,
    query: String,
}

fn bad(field: &str) -> ApiError {
    ApiError::bad_request(field)
}

/// Parses the choices from a query or a JSON body flattened to strings.
fn parse(q: &HashMap<String, String>) -> ApiResult<Parsed> {
    let get = |k: &str| q.get(k).map(String::as_str);
    let scope = match get("scope") {
        Some("cascade") | None => Scope::Cascade,
        Some("quiz") => Scope::Quiz,
        _ => return Err(bad("scope")),
    };
    let quiz_id = match get("quiz_id") {
        Some(s) if !s.is_empty() => Some(s.parse::<Uuid>().map_err(|_| bad("quiz_id"))?),
        _ => None,
    };
    if (scope == Scope::Quiz) != quiz_id.is_some() {
        return Err(bad("quiz_id"));
    }
    let which = match get("which").unwrap_or("all") {
        "all" => Which::All,
        "correct" => Which::Correct,
        "missed" => Which::Missed,
        "ungraded" => Which::Ungraded,
        _ => return Err(bad("which")),
    };
    let format = match get("format").unwrap_or("txt") {
        "txt" => Format::Txt,
        "csv" => Format::Csv,
        _ => return Err(bad("format")),
    };
    let lines = match get("lines") {
        None => None,
        Some("answers") => Some(Lines::Answers),
        Some("questions") => Some(Lines::Questions),
        _ => return Err(bad("lines")),
    };
    let columns = match get("columns") {
        None => None,
        Some(s) => Some(
            s.split(',')
                .map(|c| match c {
                    "question" => Ok(Column::Question),
                    "answer" => Ok(Column::Answer),
                    "definition" => Ok(Column::Definition),
                    "hooks" => Ok(Column::Hooks),
                    "grade" => Ok(Column::Grade),
                    _ => Err(bad("columns")),
                })
                .collect::<ApiResult<Vec<_>>>()?,
        ),
    };
    if format == Format::Txt && lines.is_none() || format == Format::Csv && columns.as_ref().is_none_or(Vec::is_empty) {
        return Err(bad(if format == Format::Txt { "lines" } else { "columns" }));
    }
    let order = match get("order").unwrap_or("study") {
        "study" => Order::Study,
        "alphabetical" => Order::Alphabetical,
        _ => return Err(bad("order")),
    };
    let flag = |k: &str| match get(k).unwrap_or("0") {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(bad(k)),
    };
    let definitions = flag("definitions")?;
    let hooks = flag("hooks")?;
    let decimals: u32 = get("decimals").unwrap_or("1").parse().map_err(|_| bad("decimals"))?;
    if decimals > 3 {
        return Err(bad("decimals"));
    }
    // Canonical: every choice that shapes the bytes, in a fixed order.
    let mut canon = BTreeMap::new();
    for k in ["scope", "quiz_id", "which", "format", "lines", "columns", "order", "definitions", "hooks", "decimals"] {
        if let Some(v) = get(k) {
            canon.insert(k, v.to_owned());
        }
    }
    let query = canon
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    Ok(Parsed {
        choices: Choices { scope, level: None, which, format, lines, columns, order, decimals },
        quiz_id,
        definitions,
        hooks,
        query,
    })
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b',' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn hash(query: &str) -> String {
    Sha256::digest(query.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The cascade and, for a quiz export, the quiz: `404` for another user's, a
/// purged one, or a quiz that is not this cascade's.
async fn owned(state: &AppState, user: Uuid, cascade: Uuid, quiz: Option<Uuid>) -> ApiResult<()> {
    let found = sqlx::query_scalar!("SELECT id FROM cascades WHERE id = $1 AND user_id = $2", cascade, user)
        .fetch_optional(&state.db)
        .await?;
    if found.is_none() {
        return Err(ApiError::NotFound);
    }
    if let Some(q) = quiz {
        let found = sqlx::query_scalar!("SELECT id FROM quizzes WHERE id = $1 AND cascade_id = $2", q, cascade)
            .fetch_optional(&state.db)
            .await?;
        if found.is_none() {
            return Err(ApiError::NotFound);
        }
    }
    Ok(())
}

async fn export_token(
    State(state): State<AppState>,
    Session(user): Session,
    Path(cascade): Path<Uuid>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResult<Response> {
    let obj = body.as_object().ok_or_else(|| bad("body"))?;
    let q: HashMap<String, String> = obj
        .iter()
        .map(|(k, v)| {
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Bool(b) => if *b { "1" } else { "0" }.to_owned(),
                Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","),
                other => other.to_string(),
            };
            (k.clone(), s)
        })
        .collect();
    let p = parse(&q)?;
    owned(&state, user.id, cascade, p.quiz_id).await?;
    state.limits.export.check(&user.id)?;
    let claims = ExportClaims {
        uid: user.id,
        cascade,
        h: hash(&p.query),
        exp: state.clock.now() + Duration::seconds(TOKEN_SECONDS),
        jti: Uuid::new_v4(),
    };
    let token = state.keys.seal_export(&claims);
    let url = format!("/api/cascades/{cascade}/export?{}&token={}", p.query, urlencode(&token));
    Ok(Json(json!({ "url": url })).into_response())
}

/// How long a server export waits for a permit before answering 503.
const EXPORT_PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(50);

/// Entries in one chunk of the stream.
const EXPORT_ROWS_PER_CHUNK: usize = 2000;
/// Chunks formatted ahead of the reader.
const EXPORT_CHUNKS_AHEAD: usize = 8;
/// How long one chunk waits for the reader to take it. Past this the reader
/// has stalled: the export is cut and its permit freed, since with
/// EXPORT_CONCURRENCY 1 a download nobody is reading would otherwise hold
/// every other export off. Nginx buffers the export (docker/nginx.conf.template),
/// so in production the reader here is Nginx, which reads as fast as the file
/// is made; this is what is left when it does not.
const EXPORT_SEND_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// The file as a stream, formatted on a blocking thread that holds `permit`
/// until the last chunk is taken, the reader goes away, or one chunk has waited
/// `wait` for a reader that takes nothing. A stream cut for that last reason
/// ends in an error, never as if the file were whole: the connection is then
/// closed without the end of the body, which a client reads as a failed
/// download and not as a short file.
fn stream(
    input: ExportInput,
    permit: tokio::sync::OwnedSemaphorePermit,
    rows_per_chunk: usize,
    wait: std::time::Duration,
) -> impl tokio_stream::Stream<Item = Result<Bytes, std::io::Error>> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::mpsc::error::SendTimeoutError;
    use tokio_stream::StreamExt;

    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(EXPORT_CHUNKS_AHEAD);
    let cut = std::sync::Arc::new(AtomicBool::new(false));
    let runtime = tokio::runtime::Handle::current();
    let stalled = cut.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Once the reader is gone or has stalled, the rest is not sent; the
        // formatter then runs to its end over nothing, which takes no time
        // beside what the permit was already held for.
        let mut open = true;
        format::format_each(&input, rows_per_chunk, &mut |chunk| {
            if !open {
                return;
            }
            match runtime.block_on(tx.send_timeout(Bytes::from(chunk), wait)) {
                Ok(()) => {}
                Err(SendTimeoutError::Closed(_)) => open = false,
                Err(SendTimeoutError::Timeout(_)) => {
                    open = false;
                    // Set before `tx` is dropped, so the stream's end sees it.
                    stalled.store(true, Ordering::SeqCst);
                    tracing::warn!(wait_secs = wait.as_secs(), "an export's reader took nothing: the export is cut and its permit freed");
                }
            }
        });
    });
    // The chunks, then one more item that is an error only when the export was cut.
    tokio_stream::wrappers::ReceiverStream::new(rx).map(Some).chain(tokio_stream::once(None)).filter_map(move |chunk| match chunk {
        Some(bytes) => Some(Ok(bytes)),
        None => cut
            .load(Ordering::SeqCst)
            .then(|| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the export's reader stalled"))),
    })
}

async fn export(
    State(state): State<AppState>,
    Path(cascade): Path<Uuid>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let nothing = || Ok(StatusCode::NO_CONTENT.into_response());
    let Some(claims) = q.get("token").and_then(|t| state.keys.open_export::<ExportClaims>(t)) else {
        return nothing();
    };
    let Ok(p) = parse(&q) else { return nothing() };
    if claims.cascade != cascade || claims.h != hash(&p.query) || claims.exp <= state.clock.now() {
        return nothing();
    }
    // EXPORT_CONCURRENCY: peak memory is the catalog plus this many exports,
    // whatever the number of users (BIRDTEST_LESSONS_PLAN.md COST-1). Taken
    // before the token is spent, so a request that gives up wastes nothing;
    // the permit then lives as long as the stream, which a reader that takes
    // nothing for EXPORT_SEND_WAIT ends.
    let permit = match tokio::time::timeout(EXPORT_PERMIT_WAIT, state.export_permits.clone().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => return Err(ApiError::Unavailable { retry_after_secs: 10 }),
    };
    // One use, recorded where any task sees it.
    let spent = sqlx::query!(
        "INSERT INTO export_tokens_spent (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        claims.jti,
        claims.exp
    )
    .execute(&state.db)
    .await?;
    if spent.rows_affected() == 0 {
        return nothing();
    }
    owned(&state, claims.uid, cascade, p.quiz_id).await?;
    let (input, name) = load(&state, cascade, &p).await?;
    let filename = format::export_filename(&name, p.choices.scope, input.choices.level, p.choices.which, p.choices.format);
    let content_type = match p.choices.format {
        Format::Txt => "text/plain; charset=utf-8",
        Format::Csv => "text/csv; charset=utf-8",
    };
    let mut resp = Body::from_stream(stream(input, permit, EXPORT_ROWS_PER_CHUNK, EXPORT_SEND_WAIT)).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    let disposition = format!("attachment; filename=\"{filename}\"");
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(|_| bad("filename"))?);
    Ok(resp)
}

/// The formatter's input from the database and the catalog.
async fn load(state: &AppState, cascade: Uuid, p: &Parsed) -> ApiResult<(ExportInput, String)> {
    let c = sqlx::query!(
        r#"SELECT name, quiz_type::text AS "quiz_type!", lexicon_id FROM cascades WHERE id = $1"#,
        cascade
    )
    .fetch_one(&state.db)
    .await?;
    let quiz_type = match c.quiz_type.as_str() {
        "anagram" => QuizType::Anagram,
        "definition" => QuizType::Definition,
        _ => QuizType::LeaveValue,
    };
    let keys = crate::cascade::routes::question_keys(&state.db, cascade).await?;
    let snap = state.catalog.snapshot();
    let lex = snap.lexicons.get(&c.lexicon_id).ok_or(ApiError::Unavailable { retry_after_secs: 5 })?;
    let dist = &lex.distribution;
    let leaves = snap.leave_set_for(lex.id);
    let tiles: Vec<String> = dist.tiles.iter().map(|t| t.letter.clone()).collect();
    let mut questions = Vec::with_capacity(keys.len());
    for (idx, key) in keys.iter().enumerate() {
        let mut q = format::Question { idx: idx as i32, key: key.clone(), ..Default::default() };
        match quiz_type {
            QuizType::Anagram => {
                let alpha: Vec<Tile> = dist.parse_magpie(key, false).unwrap_or_default();
                q.words = Some(
                    lex.anagrams(&alpha)
                        .map(|w| format::Word {
                            word: dist.to_magpie(&w.tiles),
                            definition: p.definitions.then(|| w.definition.to_string()),
                            front_hooks: p.hooks.then(|| dist.to_magpie(&w.front_hooks)),
                            back_hooks: p.hooks.then(|| dist.to_magpie(&w.back_hooks)),
                        })
                        .collect(),
                );
            }
            QuizType::Definition => {
                let tiles = dist.parse_magpie(key, false).unwrap_or_default();
                if let Some(w) = lex.find(&tiles) {
                    q.definition = Some(w.definition.to_string());
                    q.front_hooks = Some(dist.to_magpie(&w.front_hooks));
                    q.back_hooks = Some(dist.to_magpie(&w.back_hooks));
                }
            }
            QuizType::LeaveValue => {
                let tiles = dist.parse_magpie(key, true).unwrap_or_default();
                q.value = leaves.and_then(|s| s.find(&tiles)).map(|l| l.value);
            }
        }
        questions.push(q);
    }
    // Quizzes: every active one (the cascade-wide selection), or the one named.
    let quiz_rows = sqlx::query!(
        r#"SELECT id, level, status::text AS "status!", shuffle_seed FROM quizzes WHERE cascade_id = $1"#,
        cascade
    )
    .fetch_all(&state.db)
    .await?;
    let mut quizzes = Vec::new();
    let mut level = None;
    for qr in quiz_rows {
        let named = p.quiz_id == Some(qr.id);
        if !(qr.status == "active" || named) {
            continue;
        }
        if named {
            level = Some(qr.level);
        }
        let mut conn = state.db.acquire().await?;
        let cards = crate::cards::cards(&mut conn, qr.id).await?;
        // The attempt's order, from its seed.
        let order = crate::cards::order(&cards, crate::cascade::order::from_i64(qr.shuffle_seed));
        let grades = cards
            .iter()
            .filter_map(|c| {
                let g = match c.grade? {
                    crate::cascade::rules::Grade::Correct => Grade::Correct,
                    crate::cascade::rules::Grade::Missed => Grade::Missed,
                };
                Some((c.idx.to_string(), g))
            })
            .collect();
        quizzes.push(format::Quiz {
            level: qr.level,
            active: qr.status == "active",
            order: order.iter().map(|&i| i as i32).collect(),
            grades,
            pick: Some(named || p.quiz_id.is_none()),
        });
    }
    let mut choices = p.choices.clone();
    choices.level = level;
    Ok((ExportInput { name: c.name.clone(), quiz_type, tiles, questions, quizzes, choices }, c.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;
    use tokio_stream::StreamExt;

    /// `n` one-line questions: with one row a chunk, `n` chunks.
    fn input(n: usize) -> ExportInput {
        let questions: Vec<Value> = (0..n).map(|i| json!({ "idx": i, "key": format!("KEY{i}") })).collect();
        serde_json::from_value(json!({
            "name": "stream", "quiz_type": "anagram", "tiles": [], "questions": questions,
            "quizzes": [{ "level": 1, "active": true, "order": (0..n).collect::<Vec<_>>(), "grades": {} }],
            "choices": { "scope": "cascade", "which": "all", "format": "txt", "lines": "questions", "order": "study", "decimals": 1 },
        }))
        .unwrap()
    }

    async fn permit(permits: &std::sync::Arc<tokio::sync::Semaphore>) -> tokio::sync::OwnedSemaphorePermit {
        permits.clone().acquire_owned().await.unwrap()
    }

    /// A reader that keeps reading gets the whole file, however long a chunk
    /// would have been allowed to wait, and the permit is back at the end.
    #[tokio::test]
    async fn a_reader_that_reads_gets_the_whole_file() {
        let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let s = stream(input(100), permit(&permits).await, 1, StdDuration::from_millis(200));
        tokio::pin!(s);
        let mut file = Vec::new();
        while let Some(chunk) = s.next().await {
            file.extend_from_slice(&chunk.expect("a read export does not end in an error"));
            // Slower than the formatter, but never stalled for the whole wait.
            tokio::time::sleep(StdDuration::from_millis(2)).await;
        }
        let want: String = (0..100).map(|i| format!("KEY{i}\n")).collect();
        assert_eq!(String::from_utf8(file).unwrap(), want);
        let _ = tokio::time::timeout(StdDuration::from_secs(5), permits.acquire()).await.expect("the permit came back").unwrap();
    }

    /// A reader that stops reading holds the only permit no longer than one
    /// chunk's wait; what it reads afterwards ends in an error, not as a file
    /// that looks whole.
    #[tokio::test]
    async fn a_reader_that_stops_reading_is_dropped_and_its_permit_freed() {
        let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let s = stream(input(100), permit(&permits).await, 1, StdDuration::from_millis(200));
        tokio::pin!(s);
        // It takes one chunk and then nothing.
        assert_eq!(&s.next().await.unwrap().unwrap()[..], b"KEY0\n");
        assert!(
            tokio::time::timeout(StdDuration::from_millis(50), permits.acquire()).await.is_err(),
            "the permit is held while the export has only begun to wait"
        );
        // Another export gets the permit once the wait has passed, with the
        // first reader still holding its stream.
        let next = tokio::time::timeout(StdDuration::from_secs(5), permits.acquire()).await;
        drop(next.expect("a stalled reader kept the only export permit").unwrap());
        // The stalled reader comes back: what was formatted ahead, then an error.
        let mut chunks = 1;
        let mut last = None;
        while let Some(chunk) = s.next().await {
            match chunk {
                Ok(_) => chunks += 1,
                Err(e) => last = Some(e.kind()),
            }
        }
        assert!(chunks < 100, "the whole file was formatted for a reader that had stalled");
        assert_eq!(last, Some(std::io::ErrorKind::TimedOut), "a cut export must not end as a whole file");
    }

    /// A reader that goes away frees the permit at once, without the wait.
    #[tokio::test]
    async fn a_reader_that_goes_away_frees_the_permit() {
        let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let s = stream(input(100), permit(&permits).await, 1, StdDuration::from_secs(600));
        drop(s);
        let _ = tokio::time::timeout(StdDuration::from_secs(5), permits.acquire()).await.expect("the permit came back").unwrap();
    }
}
