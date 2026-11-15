//! Auth and account endpoints (PLAN.md § API → Auth and account, § Authentication).

use std::net::IpAddr;
use std::sync::OnceLock;

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::mail::{self, Email};
use crate::auth::password;
use crate::auth::session::{
    self, CSRF_COOKIE, ClearCookies, CurrentUser, SESSION_COOKIE, Session, SessionCookies,
    UnboundSession, csrf_matches,
};
use crate::error::{ApiError, ApiResult, FieldError};
use crate::extract::ApiJson;

pub fn router(state: &AppState) -> Router<AppState> {
    let router = Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/confirm-email", post(confirm_email))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/reset-password", post(reset_password))
        .route(
            "/api/auth/reset-password/confirm",
            post(reset_password_confirm),
        )
        .route("/api/auth/me", get(me))
        .route(
            "/api/account/sign-out-everywhere",
            post(sign_out_everywhere),
        )
        .route("/api/account/password", post(change_password))
        .route("/api/account", delete(delete_account));
    // Only on a local stack: the route does not exist otherwise, so production
    // answers 404 (config.rs refuses DEV_LOGIN with SECURE_COOKIES).
    if state.config.dev_login {
        router.route("/api/dev/login", post(dev_login))
    } else {
        router
    }
}

/// The client address per-IP limits key on.
pub struct ClientIp(pub IpAddr);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(crate::net::client_ip(
            parts,
            state.config.trusted_proxy_hops,
        )))
    }
}

fn sha256(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

/// Sends an email after the response. The caller has taken the address's
/// slot (`EmailCaps::try_reserve`).
fn queue_mail(state: &AppState, email: Email) {
    let mailer = state.mailer.clone();
    tokio::spawn(async move {
        let to = mail::address_tag(&email.to);
        if let Err(e) = mailer.send(email).await {
            tracing::error!(alarm = "mail_failed", %to, error = %e, "sending email failed");
        }
    });
}

fn is_valid_username(u: &str) -> bool {
    (3..=32).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// No whitespace and no control character: an address holds neither, and a
/// NUL among them is one Postgres takes in no text parameter, so the lookup
/// that follows would fail (a `500` at register, and a `mail_failed` alarm
/// from a reset request that any visitor can send) instead of being refused.
///
/// And ASCII only. SES takes no address whose local part is not 7-bit ASCII
/// (it does not support SMTPUTF8) and takes a domain only in its ASCII
/// (Punycode, `xn--`) form: so says the SES `SendEmail` API reference, and
/// nothing here was tried against SES. An address it refuses is a
/// `mail_failed` alarm, which any visitor could then raise by registering one.
fn email_error(e: &str) -> Option<&'static str> {
    const INVALID: &str = "Enter a valid email address.";
    let n = e.chars().count();
    if !(3..=254).contains(&n) || e.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some(INVALID);
    }
    match e.rsplit_once('@') {
        Some((local, domain)) if !local.is_empty() && !domain.is_empty() && !domain.contains('@') => {}
        _ => return Some(INVALID),
    }
    if !e.is_ascii() {
        return Some("We can't send mail to an address with accented or non-Latin characters.");
    }
    None
}

fn is_valid_email(e: &str) -> bool {
    email_error(e).is_none()
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RegisterBody {
    username: String,
    email: String,
    password: String,
}

/// The advisory lock registrations and confirmations take in turn (an
/// arbitrary constant).
const REGISTER_LOCK: i64 = 0x5746_5245_4749_5354;

/// Registration closes once this many accounts hold a place (PLAN.md §
/// Authentication). Fixed here on purpose, not configured: raising it is a
/// release. A stack with `DEV_LOGIN` on (local only; production refuses it)
/// does not apply it, since the end-to-end journeys register an account per
/// spec on a stack that is kept between runs.
pub const MAX_ACCOUNTS: i64 = 750;

/// The same answer for a new registration and an address already in use.
fn registered() -> Response {
    (StatusCode::ACCEPTED, Json(json!({}))).into_response()
}

fn username_taken_error() -> ApiError {
    ApiError::Fields(vec![FieldError::new("username", "That username is taken.")])
}

async fn register_lock(tx: &mut sqlx::PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT 1 AS "one!" FROM pg_advisory_xact_lock($1)"#, REGISTER_LOCK)
        .fetch_one(tx)
        .await?;
    Ok(())
}

/// A registration makes no account: it keeps the request's username and
/// password hash with a confirmation code of its own
/// (`pending_registrations`), and the account is made from that row when its
/// code is confirmed. So registering again for an address not yet confirmed
/// is how a lost mail is sent again, with whatever username and password the
/// new request gives; and whoever registered an address first, its owner or a
/// stranger, the account gets the username and password of the registration
/// whose link is followed.
async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<RegisterBody>,
) -> ApiResult<Response> {
    state.limits.auth_ip.check(&ip)?;
    let username = body.username.trim().to_owned();
    let email = body.email.trim().to_owned();

    let mut errors = Vec::new();
    let username_ok = is_valid_username(&username);
    if !username_ok {
        errors.push(FieldError::new(
            "username",
            "Use 3–32 letters, digits or underscores.",
        ));
    }
    let email_ok = match email_error(&email) {
        Some(message) => {
            errors.push(FieldError::new("email", message));
            false
        }
        None => true,
    };
    errors.extend(password::check_strength("password", &body.password, &username, &email).await?);
    // A taken username is a field error, checked before anything that sends
    // email. An address that is no address is no one's own: it reaches no
    // query (it may hold a NUL, which Postgres takes in no text).
    let own = if email_ok { email.as_str() } else { "" };
    if username_ok && username_taken(&state.db, &username, own).await? {
        errors.push(FieldError::new("username", "That username is taken."));
    }
    if !errors.is_empty() {
        return Err(ApiError::Fields(errors));
    }

    // Hashed on every path, stored or not, so every branch takes the same time.
    let hash = password::hash(body.password).await?;

    let mut tx = state.db.begin().await?;
    // MAX_ACCOUNTS. Registrations and confirmations take turns under a
    // transaction lock, so two at the limit cannot both pass it, and two
    // addresses cannot both come to hold one username. Checked for every
    // registration, before looking the address up, so a closed site says the
    // same to everyone and reveals nothing about which addresses have accounts.
    register_lock(&mut tx).await?;
    // What holds a place: an account, and an address with a registration
    // whose code is still valid, once however many registrations it has. An
    // abandoned registration frees its place when its code expires, without
    // waiting for the purge task.
    let accounts = sqlx::query_scalar!(
        r#"SELECT (SELECT count(*) FROM users)
                + (SELECT count(DISTINCT email) FROM pending_registrations WHERE expires_at > now()) AS "n!""#
    )
    .fetch_one(&mut *tx)
    .await?;
    if accounts >= MAX_ACCOUNTS && !state.config.dev_login {
        return Err(ApiError::Forbidden("registration_closed"));
    }

    let existing = sqlx::query_scalar!(
        r#"SELECT email::text AS "email!" FROM users WHERE email = $1::citext"#,
        &email as &str,
    )
    .fetch_optional(&mut *tx)
    .await?;

    // Again, now that no other registration can come between the check and
    // the row.
    if existing.is_none() && username_taken(&mut *tx, &username, &email).await? {
        return Err(username_taken_error());
    }
    // The address's mail caps, before anything is kept: a registration whose
    // mail would not be sent has a code no one can ever follow, so it is
    // answered like any other and neither stored nor sent.
    if !state.email_caps.try_reserve(&email, ip) {
        tracing::info!("email cap reached; registration not kept, nothing sent");
        return Ok(registered());
    }
    let mail = match existing {
        Some(address) => mail::account_exists_email(&state.config.public_url, &address),
        None => {
            let code = session::random_token();
            sqlx::query!(
                "INSERT INTO pending_registrations (username, email, password_hash, code_hash, expires_at)
                 VALUES ($1::citext, $2::citext, $3, $4, now() + interval '24 hours')",
                &username as &str,
                &email as &str,
                hash,
                sha256(&code),
            )
            .execute(&mut *tx)
            .await?;
            mail::confirmation_email(&state.config.public_url, &email, &username, &code)
        }
    };
    tx.commit().await?;
    queue_mail(&state, mail);
    Ok(registered())
}

/// Whether `username` is another's: an account's, or a registration's whose
/// code is still valid and which is for another address than `email`. An
/// address's own registrations do not hold a username against it, so someone
/// registering again (the mail was lost) keeps the name they chose.
async fn username_taken<'e>(
    db: impl sqlx::PgExecutor<'e>,
    username: &str,
    email: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM users WHERE username = $1::citext)
               OR EXISTS (SELECT 1 FROM pending_registrations
                          WHERE username = $1::citext AND email <> $2::citext AND expires_at > now())
               AS "taken!""#,
        username,
        email,
    )
    .fetch_one(db)
    .await
}

// ---------------------------------------------------------------------------
// Confirm email
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ConfirmBody {
    code: String,
}

/// Makes the account from the registration the code belongs to: that
/// registration's username and password, whichever others the address has.
/// Those go with it, so no other link for the address works afterwards, and
/// a second use of this one finds nothing.
async fn confirm_email(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<ConfirmBody>,
) -> ApiResult<StatusCode> {
    state.limits.auth_ip.check(&ip)?;
    let invalid = || ApiError::bad_request("invalid_code");
    let mut tx = state.db.begin().await?;
    register_lock(&mut tx).await?;
    let pending = sqlx::query!(
        r#"DELETE FROM pending_registrations
           WHERE code_hash = $1 AND expires_at > now()
           RETURNING username::text AS "username!", email::text AS "email!", password_hash"#,
        sha256(body.code.trim()),
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(invalid)?;
    // While its code is valid a registration's username and address are no
    // one else's (`register` sees to it under the same lock), so a conflict
    // here is an account made by hand in SQL: the code is refused and stays.
    let made = sqlx::query_scalar!(
        "INSERT INTO users (username, email, password_hash) VALUES ($1::citext, $2::citext, $3)
         ON CONFLICT DO NOTHING RETURNING id",
        pending.username,
        pending.email,
        pending.password_hash,
    )
    .fetch_optional(&mut *tx)
    .await?;
    if made.is_none() {
        return Err(invalid());
    }
    sqlx::query!("DELETE FROM pending_registrations WHERE email = $1::citext", pending.email)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Login, me, logout
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

#[derive(Serialize)]
pub struct Me {
    user_id: Uuid,
    username: String,
    is_admin: bool,
    trash_retention_days: u32,
    max_quiz_questions: u32,
    /// The account's server storage and its effective limit, in bytes
    /// (STORAGE_LIMIT_PLAN.md § S1).
    storage_bytes: i64,
    max_storage_bytes: i64,
}

fn me_body(state: &AppState, id: Uuid, username: String, is_admin: bool, storage: (i64, Option<i64>)) -> Me {
    let usage = crate::storage::Usage::new(storage.0, storage.1, state.config.max_storage_bytes_per_user);
    Me {
        user_id: id,
        username,
        is_admin,
        trash_retention_days: state.config.trash_retention_days,
        max_quiz_questions: state.config.max_quiz_questions,
        storage_bytes: usage.used,
        max_storage_bytes: usage.limit,
    }
}

/// A hash to verify against when the username does not exist.
fn dummy_hash() -> &'static str {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| {
        use argon2::password_hash::PasswordHasher;
        argon2::Argon2::default()
            .hash_password(b"acrodont-dummy-password")
            .expect("hash")
            .to_string()
    })
}

struct LoginUser {
    id: Uuid,
    username: String,
    password_hash: String,
    is_admin: bool,
    session_generation: i32,
    storage_bytes: i64,
    storage_limit_bytes: Option<i64>,
}

/// What a login's username and password named.
enum Verified {
    Account(LoginUser),
    /// No account, but the password of the username's latest registration
    /// still waiting for its address to be confirmed.
    Unconfirmed,
    Wrong,
}

/// The account `username` names when `password` is its password. Every
/// branch costs one verify: an account's hash, else the hash of the
/// username's latest registration whose code is still valid (so the page can
/// say the address is not confirmed yet, to someone who knows the password
/// and to no one else), else a dummy's.
async fn verified_user(state: &AppState, username: &str, password: String) -> ApiResult<Verified> {
    let row = sqlx::query_as!(
        LoginUser,
        "SELECT id, username::text AS \"username!\", password_hash,
                is_admin, session_generation, storage_bytes, storage_limit_bytes
         FROM users WHERE username = $1",
        username,
    )
    .fetch_optional(&state.db)
    .await?;
    let pending = match row {
        Some(_) => None,
        None => {
            sqlx::query_scalar!(
                "SELECT password_hash FROM pending_registrations
                 WHERE username = $1::citext AND expires_at > now()
                 ORDER BY created_at DESC, id LIMIT 1",
                username,
            )
            .fetch_optional(&state.db)
            .await?
        }
    };
    state
        .argon2_verifies
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(match (row, pending) {
        (Some(r), _) => {
            if password::verify(password, r.password_hash.clone()).await? {
                Verified::Account(r)
            } else {
                Verified::Wrong
            }
        }
        (None, Some(hash)) => {
            if password::verify(password, hash).await? {
                Verified::Unconfirmed
            } else {
                Verified::Wrong
            }
        }
        (None, None) => {
            password::verify(password, dummy_hash().to_owned()).await?;
            Verified::Wrong
        }
    })
}

async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<LoginBody>,
) -> ApiResult<Response> {
    let username = body.username.trim();
    // No account has a name of another shape, so this one is refused as a
    // wrong guess is, before it can cost a hash or become a limiter's key:
    // the body may be megabytes long.
    if !is_valid_username(username) {
        return Err(ApiError::Unauthorized);
    }
    let username_key = username.to_lowercase();
    // A token is taken from both failure buckets before any Argon2 verify,
    // and the request refused when either has none; both are given back
    // unless the verify fails. Peeking first and taking afterwards let every
    // request of a burst through.
    state.limits.login_fail_ip.reserve(&ip)?;
    if let Err(limited) = state.limits.login_fail_username.reserve(&username_key) {
        state.limits.login_fail_ip.refund(&ip);
        return Err(limited);
    }
    // And one from the username's bucket of logins, which a right password
    // spends too: each costs a verify, so the holder of one password could
    // otherwise keep every hashing turn busy. Taken last, so a request the
    // failure buckets refuse spends none of it.
    if let Err(limited) = state.limits.login_username.reserve(&username_key) {
        state.limits.login_fail_ip.refund(&ip);
        state.limits.login_fail_username.refund(&username_key);
        return Err(limited);
    }
    let outcome = verified_user(&state, username, body.password).await;
    // Only a failed verify keeps its failure tokens: not a login that
    // succeeds, and not one that was never judged (a `503` for a hashing
    // turn, an error). The login token is kept by every verify that ran.
    if !matches!(outcome, Ok(Verified::Wrong)) {
        state.limits.login_fail_ip.refund(&ip);
        state.limits.login_fail_username.refund(&username_key);
    }
    if outcome.is_err() {
        state.limits.login_username.refund(&username_key);
    }
    let user = match outcome? {
        Verified::Account(user) => user,
        Verified::Unconfirmed => return Err(ApiError::Forbidden("email_unconfirmed")),
        Verified::Wrong => return Err(ApiError::Unauthorized),
    };
    let cookies = SessionCookies::issue(&state, user.id, user.session_generation, None);
    Ok((
        cookies,
        Json(me_body(&state, user.id, user.username, user.is_admin, (user.storage_bytes, user.storage_limit_bytes))),
    )
        .into_response())
}

/// Exempt from the account binding: it reports whose cookie the browser
/// holds, and re-sets the CSRF cookie so a client holding only the session
/// cookie recovers a usable token.
async fn me(
    State(state): State<AppState>,
    jar: CookieJar,
    UnboundSession(user): UnboundSession,
) -> Response {
    let csrf = jar
        .get(CSRF_COOKIE)
        .map(|c| c.value().to_owned())
        .filter(|v| !v.is_empty());
    let cookies = SessionCookies::csrf_for(&state, &user.claims, csrf);
    (
        cookies,
        Json(me_body(&state, user.id, user.username, user.is_admin, (user.storage_bytes, user.storage_limit_bytes))),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct DevLoginBody {
    username: String,
}

/// `./scripts/dev.py --login-as USER`: a session for an existing
/// account without its password, answered exactly as `/api/auth/login` is, so
/// the SPA's `/dev-login` page adopts it the way a login would. Registered
/// only when `DEV_LOGIN=true`, which a TLS deployment refuses to start with.
async fn dev_login(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<DevLoginBody>,
) -> ApiResult<Response> {
    let user = sqlx::query!(
        "SELECT id, username::text AS \"username!\", is_admin, session_generation,
                storage_bytes, storage_limit_bytes
         FROM users WHERE username = $1",
        body.username.trim() as &str,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    let cookies = SessionCookies::issue(&state, user.id, user.session_generation, None);
    let storage = (user.storage_bytes, user.storage_limit_bytes);
    Ok((cookies, Json(me_body(&state, user.id, user.username, user.is_admin, storage))).into_response())
}

/// Clears both cookies. Needs neither a session nor a CSRF token when no
/// session cookie arrives; with one, it is CSRF-checked like any other write.
/// Exempt from the account binding. Never `401`.
async fn logout(State(state): State<AppState>, jar: CookieJar, headers: HeaderMap) -> Response {
    let has_session_cookie = jar
        .get(SESSION_COOKIE)
        .is_some_and(|c| !c.value().is_empty());
    if has_session_cookie && !csrf_matches(&jar, &headers) {
        return ApiError::Forbidden("csrf").into_response();
    }
    (
        ClearCookies(state.config.secure_cookies),
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ResetBody {
    email: String,
}

/// Always the same answer; the lookup and the email happen after the
/// response, so both branches take the same time.
async fn reset_password(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<ResetBody>,
) -> ApiResult<Response> {
    state.limits.auth_ip.check(&ip)?;
    let email = body.email.trim().to_owned();
    // No account has an address of another shape. The same answer as for any
    // address, and before the address becomes a limiter's key: the body may
    // be megabytes long.
    if !is_valid_email(&email) {
        return Ok((StatusCode::ACCEPTED, Json(json!({}))).into_response());
    }
    // Checked against the caller and against the address named: the first
    // bounds bulk probing, the second stops one address being buried in reset
    // mail from many sources. The same answer for every address either way.
    state.limits.reset.check(&format!("ip:{ip}"))?;
    state.limits.reset.check(&format!("em:{}", email.to_lowercase()))?;
    let st = state.clone();
    tokio::spawn(async move {
        if let Err(e) = send_reset(&st, ip, &email).await {
            tracing::error!(alarm = "mail_failed", error = %e, "password reset failed");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(json!({}))).into_response())
}

async fn send_reset(state: &AppState, ip: IpAddr, email: &str) -> anyhow::Result<()> {
    let user = sqlx::query!(
        "SELECT id, username::text AS \"username!\", email::text AS \"email!\" FROM users
         WHERE email = $1",
        email as &str,
    )
    .fetch_optional(&state.db)
    .await?;
    let Some(user) = user else { return Ok(()) };
    if !state.email_caps.try_reserve(&user.email, ip) {
        return Ok(());
    }
    let token = session::random_token();
    sqlx::query!(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')",
        user.id,
        sha256(&token),
    )
    .execute(&state.db)
    .await?;
    state
        .mailer
        .send(mail::reset_email(
            &state.config.public_url,
            &user.email,
            &user.username,
            &token,
        ))
        .await
}

#[derive(Deserialize)]
pub struct ResetConfirmBody {
    token: String,
    password: String,
}

async fn reset_password_confirm(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<ResetConfirmBody>,
) -> ApiResult<Response> {
    state.limits.auth_ip.check(&ip)?;
    let token_hash = sha256(body.token.trim());
    let invalid = || ApiError::bad_request("invalid_token");
    // The link first, read without a lock: a wrong or spent one costs neither
    // a score nor a hash.
    let account = sqlx::query!(
        r#"SELECT u.username::text AS "username!", u.email::text AS "email!"
           FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()"#,
        token_hash,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(invalid)?;
    // A link refused a weak password still works, so each scoring is counted
    // against the link too: replayed from many addresses, it would otherwise
    // be a queue of scorings no per-address limit bounds. Counted once a turn
    // is held, so a request turned away busy (503) spends none of the owner's tries.
    let turn = password::scoring_turn().await?;
    let link: String = token_hash.iter().map(|b| format!("{b:02x}")).collect();
    state.limits.reset.check(&format!("tok:{link}"))?;
    // Registration's rule: not the username, not the address.
    let errors = password::score_in_turn(turn, "password", &body.password, &account.username, &account.email).await?;
    if !errors.is_empty() {
        return Err(ApiError::Fields(errors));
    }
    // Hashed before the transaction, so the wait holds no lock.
    let hash = password::hash(body.password).await?;

    let mut tx = state.db.begin().await?;
    // The account first, then its token; a delete that commits meanwhile
    // leaves no account to lock.
    sqlx::query!(
        "SELECT u.id FROM users u JOIN password_reset_tokens t ON t.user_id = u.id
         WHERE t.token_hash = $1 FOR NO KEY UPDATE OF u",
        token_hash,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(invalid)?;
    let user_id = sqlx::query_scalar!(
        "UPDATE password_reset_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING user_id",
        token_hash,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(invalid)?;
    // Every other outstanding link is spent too, so an earlier one cannot be
    // replayed, and the generation bump signs out every session, an
    // attacker's included: a reset is what someone does who suspects another
    // person has access.
    sqlx::query!(
        "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        user_id
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE users SET password_hash = $2, session_generation = session_generation + 1
         WHERE id = $1",
        user_id,
        hash,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // This browser's session goes with the rest: signing in with the new
    // password is the confirmation.
    Ok((ClearCookies(state.config.secure_cookies), StatusCode::NO_CONTENT).into_response())
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/// Password re-entry for Sign out everywhere and Delete account. Tries share
/// Change password's bucket: a session cookie alone must not be a way to
/// guess the account's password at full speed.
async fn check_password(state: &AppState, user: &CurrentUser, password: String) -> ApiResult<()> {
    // The try is counted once a hashing turn is held: a request turned away
    // busy (503) was never judged, and spends none of the account's tries.
    let turn = password::hashing_turn().await?;
    state.limits.reset.check(&format!("pw:{}", user.id))?;
    let hash = sqlx::query_scalar!("SELECT password_hash FROM users WHERE id = $1", user.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if password::verify_in_turn(turn, password, hash).await {
        Ok(())
    } else {
        Err(ApiError::Fields(vec![FieldError::new(
            "password",
            "That password is not right.",
        )]))
    }
}

#[derive(Deserialize)]
pub struct PasswordBody {
    password: String,
}

/// Bumps `session_generation` and re-issues this device's cookies, so every
/// other session is refused while this one keeps working.
async fn sign_out_everywhere(
    State(state): State<AppState>,
    Session(user): Session,
    ApiJson(body): ApiJson<PasswordBody>,
) -> ApiResult<Response> {
    check_password(&state, &user, body.password).await?;
    let generation = sqlx::query_scalar!(
        "UPDATE users SET session_generation = session_generation + 1 WHERE id = $1
         RETURNING session_generation",
        user.id
    )
    .fetch_optional(&state.db)
    .await?
    // The account was deleted since the password was checked: its session is void.
    .ok_or(ApiError::Unauthorized)?;
    Ok((
        SessionCookies::issue(&state, user.id, generation, None),
        StatusCode::NO_CONTENT,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

/// A signed-in change of password: the current one proves it is the owner,
/// the new one meets the strength rule a reset's does. Like Sign out
/// everywhere it bumps `session_generation` and re-issues this device's
/// cookies, so every other session is refused while this one keeps working;
/// and it spends the account's outstanding reset links, which were asked for
/// under the old password.
async fn change_password(
    State(state): State<AppState>,
    Session(user): Session,
    ApiJson(body): ApiJson<ChangePasswordBody>,
) -> ApiResult<Response> {
    // Each try costs a hash and maybe a scoring, and is a guess at the
    // password: bounded per account, as a reset link's tries are. Counted
    // once a hashing turn is held, so a request turned away busy (503)
    // spends none.
    let turn = password::hashing_turn().await?;
    state.limits.reset.check(&format!("pw:{}", user.id))?;
    let account = sqlx::query!(
        r#"SELECT username::text AS "username!", email::text AS "email!", password_hash
           FROM users WHERE id = $1"#,
        user.id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    if !password::verify_in_turn(turn, body.current_password, account.password_hash).await {
        return Err(ApiError::Fields(vec![FieldError::new(
            "current_password",
            "That password is not right.",
        )]));
    }
    let errors =
        password::check_strength("new_password", &body.new_password, &account.username, &account.email).await?;
    if !errors.is_empty() {
        return Err(ApiError::Fields(errors));
    }
    // Hashed before the transaction, so the wait holds no lock.
    let hash = password::hash(body.new_password).await?;
    let mut tx = state.db.begin().await?;
    let generation = sqlx::query_scalar!(
        "UPDATE users SET password_hash = $2, session_generation = session_generation + 1
         WHERE id = $1 RETURNING session_generation",
        user.id,
        hash,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::Unauthorized)?;
    sqlx::query!(
        "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        user.id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((
        SessionCookies::issue(&state, user.id, generation, None),
        StatusCode::NO_CONTENT,
    )
        .into_response())
}

/// A single `DELETE FROM users`: everything the user owns cascades.
async fn delete_account(
    State(state): State<AppState>,
    Session(user): Session,
    ApiJson(body): ApiJson<PasswordBody>,
) -> ApiResult<Response> {
    check_password(&state, &user, body.password).await?;
    sqlx::query!("DELETE FROM users WHERE id = $1", user.id)
        .execute(&state.db)
        .await?;
    Ok((
        ClearCookies(state.config.secure_cookies),
        StatusCode::NO_CONTENT,
    )
        .into_response())
}
