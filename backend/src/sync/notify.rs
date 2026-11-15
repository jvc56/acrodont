//! Telling an account's other devices that something changed (PLAN.md § The
//! sync cycle → Telling the other devices). Every change that advances an
//! account's `sync_seq` — a push that applied an operation, shared device
//! settings, creating or duplicating a cascade, a purge — sends a Postgres
//! `NOTIFY` on CHANNEL in its own transaction, so it goes out only once the
//! change is committed, and to every instance. Each instance runs one
//! `LISTEN`, started with the first stream, and fans the notes out to the
//! open `GET /api/sync/events` streams of that account, all but the stream of
//! the device that made the change. A device told of a change syncs at once,
//! rather than at its next 30-second sync. Nothing depends on a note arriving:
//! a device still syncs on its own triggers, and a stream (re)opened syncs.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use sqlx::postgres::PgListener;
use sqlx::{PgConnection, PgPool};
use tokio::sync::{OnceCell, broadcast, mpsc};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::session::UnboundSession;
use crate::error::{ApiError, ApiResult};

pub const CHANNEL: &str = "acrodont_changes";
/// A stream ends after this long and the browser opens it again, so the
/// session is checked again and a stream never outlives its session for long.
pub const STREAM_LIFETIME: Duration = Duration::from_secs(300);
/// A comment line this often keeps the stream through the load balancer's
/// and nginx's idle timeouts (120 s).
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

/// One change: whose, and which device made it (`None`: the server, or
/// unknown). A note with no user is for everyone: the listener lost its
/// connection, so a note may have been missed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    pub user: Option<Uuid>,
    pub device: Option<Uuid>,
}

impl Note {
    fn parse(payload: &str) -> Option<Note> {
        let mut parts = payload.split(' ');
        let user = parts.next()?.parse().ok()?;
        let device = parts.next().and_then(|d| d.parse().ok());
        Some(Note { user: Some(user), device })
    }

    /// Whether the stream of `device` for `user` hears this note.
    pub fn reaches(&self, user: Uuid, device: Option<Uuid>) -> bool {
        match self.user {
            None => true,
            Some(u) => u == user && (self.device.is_none() || self.device != device),
        }
    }
}

/// Sends the note in the caller's transaction: it goes out when that commits.
pub async fn changed(conn: &mut PgConnection, user: Uuid, device: Option<Uuid>) -> Result<(), sqlx::Error> {
    let payload = match device {
        Some(d) => format!("{user} {d}"),
        None => user.to_string(),
    };
    sqlx::query("SELECT pg_notify($1, $2)").bind(CHANNEL).bind(payload).execute(conn).await?;
    Ok(())
}

/// What an open past the account's limit is told to wait: the client opens
/// the stream again after a wait of its own, and syncs every 30 seconds
/// meanwhile, so nothing depends on the figure.
const OVER_LIMIT_RETRY_SECS: u64 = 60;

/// This instance's listener and the streams it feeds.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

struct Inner {
    tx: broadcast::Sender<Note>,
    started: OnceCell<()>,
    /// Open streams per account: an account with none has no entry.
    open: Mutex<HashMap<Uuid, u32>>,
    /// Set when the server shuts down: every stream ends, so a graceful
    /// shutdown is not held open by them; the browsers reconnect elsewhere.
    closing: tokio::sync::watch::Sender<bool>,
}

impl Default for Hub {
    fn default() -> Self {
        Hub {
            inner: Arc::new(Inner {
                tx: broadcast::channel(1024).0,
                started: OnceCell::new(),
                open: Mutex::new(HashMap::new()),
                closing: tokio::sync::watch::channel(false).0,
            }),
        }
    }
}

impl Hub {
    /// Ends every stream (server shutdown).
    pub fn close(&self) {
        self.inner.closing.send_replace(true);
    }

    fn closing(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.closing.subscribe()
    }

    /// A place among the account's open streams, held until the value
    /// returned is dropped, or `None` when the account already holds `max`.
    /// A stream costs a task, a receiver and a connection for five minutes,
    /// and without a count one account could hold every connection there is.
    pub fn admit(&self, user: Uuid, max: u32) -> Option<Admitted> {
        let mut open = self.inner.open.lock().expect("stream count lock");
        let n = open.entry(user).or_insert(0);
        if *n >= max {
            return None;
        }
        *n += 1;
        Some(Admitted { hub: self.clone(), user })
    }

    /// The streams the account holds open on this instance.
    pub fn open_streams(&self, user: Uuid) -> u32 {
        self.inner.open.lock().expect("stream count lock").get(&user).copied().unwrap_or(0)
    }

    /// The notes from now on; the first call starts the listener and waits (a
    /// few seconds at most) until it listens, so no change after it is missed.
    pub async fn subscribe(&self, db: &PgPool) -> broadcast::Receiver<Note> {
        let rx = self.inner.tx.subscribe();
        self.inner
            .started
            .get_or_init(|| async {
                let (ready, listening) = tokio::sync::oneshot::channel();
                tokio::spawn(listen(db.clone(), self.inner.tx.clone(), ready));
                let _ = tokio::time::timeout(Duration::from_secs(5), listening).await;
            })
            .await;
        rx
    }
}

/// One stream's place in its account's count, given back when dropped.
pub struct Admitted {
    hub: Hub,
    user: Uuid,
}

impl Drop for Admitted {
    fn drop(&mut self) {
        let mut open = self.hub.inner.open.lock().expect("stream count lock");
        if let Some(n) = open.get_mut(&self.user) {
            *n -= 1;
            if *n == 0 {
                open.remove(&self.user);
            }
        }
    }
}

async fn listen(db: PgPool, tx: broadcast::Sender<Note>, ready: tokio::sync::oneshot::Sender<()>) {
    let mut ready = Some(ready);
    loop {
        let mut listener = match PgListener::connect_with(&db).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "change listener could not connect");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if let Err(e) = listener.listen(CHANNEL).await {
            tracing::warn!(error = %e, "change listener could not listen");
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        if let Some(r) = ready.take() {
            let _ = r.send(());
        }
        loop {
            match listener.try_recv().await {
                Ok(Some(n)) => {
                    if let Some(note) = Note::parse(n.payload()) {
                        let _ = tx.send(note);
                    }
                }
                // The connection dropped; the next call reconnects. Notes sent
                // meanwhile are lost, so every stream is told to sync.
                Ok(None) => {
                    let _ = tx.send(Note { user: None, device: None });
                }
                Err(e) => {
                    tracing::warn!(error = %e, "change listener failed");
                    let _ = tx.send(Note { user: None, device: None });
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
            }
        }
    }
}

/// `GET /api/sync/events?user=<id>&device=<id>`: a Server-Sent Events stream
/// of `changed` events for the signed-in account. `EventSource` cannot send
/// `X-Acrodont-User`, so `user` names the account the tab runs as, with the
/// same check; `device` is the device's id, whose own changes it is not told of.
pub async fn events(
    State(state): State<AppState>,
    UnboundSession(user): UnboundSession,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    if q.get("user").and_then(|s| s.parse::<Uuid>().ok()) != Some(user.id) {
        return Err(ApiError::Unauthorized);
    }
    let device: Option<Uuid> = q.get("device").and_then(|s| s.parse().ok());
    // Both limits are per account and per instance, like every other one: how
    // often it opens a stream, and how many it holds open (a device needs one).
    state.limits.sync_stream.check(&user.id)?;
    let admitted = state
        .changes
        .admit(user.id, state.config.sync_streams_per_user)
        .ok_or(ApiError::TooManyRequests { retry_after_secs: OVER_LIMIT_RETRY_SECS })?;
    let mut notes = state.changes.subscribe(&state.db).await;
    let mut closing = state.changes.closing();
    let (out, stream) = mpsc::channel::<Result<Event, Infallible>>(4);
    let account = user.id;
    tokio::spawn(async move {
        // Held for the stream's life: the task ends when the client goes, the
        // lifetime is up or the server shuts down, and the place is free again.
        let _admitted = admitted;
        let end = tokio::time::sleep(STREAM_LIFETIME);
        tokio::pin!(end);
        loop {
            let tell = tokio::select! {
                _ = &mut end => break,
                _ = out.closed() => break,
                _ = closing.wait_for(|c| *c) => break,
                r = notes.recv() => match r {
                    Ok(n) => n.reaches(account, device),
                    // Fallen behind: something may be among the notes skipped.
                    Err(broadcast::error::RecvError::Lagged(_)) => true,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            // A full channel already holds a `changed` the device has yet to read.
            // The data is not empty: EventSource drops an event whose data is.
            if tell && out.try_send(Ok(Event::default().event("changed").data("1"))).is_err() && out.is_closed() {
                break;
            }
        }
    });
    let mut resp = Sse::new(tokio_stream::wrappers::ReceiverStream::new(stream))
        .keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
        .into_response();
    // nginx passes the stream through as it comes.
    resp.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_reaches_its_account_s_other_devices() {
        let (u, a, b) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let n = Note::parse(&format!("{u} {a}")).unwrap();
        assert_eq!(n, Note { user: Some(u), device: Some(a) });
        assert!(!n.reaches(u, Some(a)), "not the device that made it");
        assert!(n.reaches(u, Some(b)));
        assert!(n.reaches(u, None));
        assert!(!n.reaches(Uuid::new_v4(), Some(b)), "not another account");
        let server = Note::parse(&u.to_string()).unwrap();
        assert!(server.reaches(u, Some(a)));
        assert!(Note { user: None, device: None }.reaches(Uuid::new_v4(), None));
        assert!(Note::parse("nonsense").is_none());
    }

    #[test]
    fn an_account_holds_no_more_streams_than_its_limit() {
        let hub = Hub::default();
        let (alice, bob) = (Uuid::new_v4(), Uuid::new_v4());
        let first = hub.admit(alice, 2).expect("the first");
        let second = hub.admit(alice, 2).expect("the second");
        assert!(hub.admit(alice, 2).is_none(), "a third is refused");
        assert!(hub.admit(bob, 2).is_some(), "another account's count is its own");
        assert_eq!(hub.open_streams(bob), 0, "and a place dropped is given back");
        drop(first);
        assert_eq!(hub.open_streams(alice), 1);
        let third = hub.admit(alice, 2).expect("a place freed is taken again");
        drop((second, third));
        assert_eq!(hub.open_streams(alice), 0);
        assert!(hub.inner.open.lock().unwrap().is_empty(), "an account with no stream has no entry");
    }
}
