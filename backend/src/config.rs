//! Configuration from environment variables (PLAN.md § Configuration).
//!
//! A malformed value fails startup rather than falling back to a default.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::str::FromStr;

/// The hard ceiling on questions per quiz; `MAX_QUIZ_QUESTIONS` may only lower it.
pub const QUESTION_CEILING: u32 = 300_000;

/// Cascades one sync request may name in `question_rows_for`: a protocol
/// bound, not a quota (STORAGE_LIMIT_PLAN.md § S4). A device holding rows for
/// more splits them across requests.
pub const MAX_QUESTION_ROWS_FOR: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailBackend {
    Console,
    Ses,
    /// Console, plus one file per message in `MAIL_OUTBOX_DIR`, for tests and
    /// `scripts/stack.py` (no log scraping).
    File,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub session_signing_key: [u8; 32],
    pub bind_addr: SocketAddr,
    pub session_ttl_seconds: u64,
    pub secure_cookies: bool,
    pub mail_backend: MailBackend,
    pub mail_from: String,
    pub mail_outbox_dir: Option<String>,
    pub mail_max_per_second: u32,
    pub public_url: String,
    pub max_quiz_questions: u32,
    /// An account's server storage in bytes (STORAGE_LIMIT_PLAN.md § S2);
    /// `users.storage_limit_bytes` replaces it for one account.
    pub max_storage_bytes_per_user: u64,
    pub search_timeout_ms: u64,
    pub search_concurrency: u32,
    pub export_concurrency: u32,
    pub trash_retention_days: u32,
    pub sync_retention_days: u32,
    pub sync_max_ops: u32,
    pub min_app_version: u64,
    pub purge_interval_seconds: u64,
    pub purge_max_quizzes_per_user_per_run: u32,
    pub admin_upload_max_bytes: u64,
    pub api_max_body_bytes: u64,
    pub sync_rate_per_minute: u32,
    pub download_rate_per_minute: u32,
    pub search_rate_per_minute: u32,
    pub export_rate_per_minute: u32,
    pub admin_upload_rate_per_minute: u32,
    pub catalog_rate_per_minute: u32,
    pub login_failures_per_ip_per_minute: u32,
    pub login_failures_per_username_per_minute: u32,
    pub auth_rate_per_ip_per_minute: u32,
    /// Password resets an hour, per caller, per address named and per link.
    pub reset_rate_per_hour: u32,
    pub catalog_reconcile_seconds: u64,
    pub trusted_proxy_hops: u32,
    /// `POST /api/dev/login` for `./scripts/dev.py`. Refused with secure
    /// cookies, so a TLS deployment cannot start with it on.
    pub dev_login: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("configuration error: {0}")]
pub struct ConfigError(pub String);

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(env: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let r = Reader { env };
        let key_hex = r.required("SESSION_SIGNING_KEY")?;
        let session_signing_key = parse_key(&key_hex)
            .ok_or_else(|| ConfigError("SESSION_SIGNING_KEY must be 32 bytes as hex".into()))?;
        let mail_backend = match r.string("MAIL_BACKEND", "console").as_str() {
            "console" => MailBackend::Console,
            "ses" => MailBackend::Ses,
            "file" => MailBackend::File,
            other => {
                return Err(ConfigError(format!(
                    "MAIL_BACKEND must be console, ses or file, not {other:?}"
                )));
            }
        };
        let mail_outbox_dir = r.get("MAIL_OUTBOX_DIR").filter(|v| !v.is_empty()).map(str::to_owned);
        if mail_backend == MailBackend::File && mail_outbox_dir.is_none() {
            return Err(ConfigError("MAIL_BACKEND=file needs MAIL_OUTBOX_DIR".into()));
        }
        let secure_cookies = r.parse_bool("SECURE_COOKIES", false)?;
        let dev_login = r.parse_bool("DEV_LOGIN", false)?;
        if dev_login && secure_cookies {
            return Err(ConfigError(
                "DEV_LOGIN=true is for a local stack, and refused with SECURE_COOKIES=true".into(),
            ));
        }
        let max_quiz_questions: u32 = r.parse("MAX_QUIZ_QUESTIONS", QUESTION_CEILING)?;
        if max_quiz_questions > QUESTION_CEILING || max_quiz_questions == 0 {
            return Err(ConfigError(format!(
                "MAX_QUIZ_QUESTIONS must be 1..={QUESTION_CEILING}"
            )));
        }
        let search_concurrency: u32 = r.parse("SEARCH_CONCURRENCY", 2)?;
        if search_concurrency == 0 {
            return Err(ConfigError("SEARCH_CONCURRENCY must be at least 1".into()));
        }
        let export_concurrency: u32 = r.parse("EXPORT_CONCURRENCY", 2)?;
        if export_concurrency == 0 {
            return Err(ConfigError("EXPORT_CONCURRENCY must be at least 1".into()));
        }
        let max_storage_bytes_per_user: u64 = r.parse("MAX_STORAGE_BYTES_PER_USER", 10_000_000)?;
        if max_storage_bytes_per_user == 0 || max_storage_bytes_per_user > i64::MAX as u64 {
            return Err(ConfigError("MAX_STORAGE_BYTES_PER_USER must be at least 1".into()));
        }
        Ok(Config {
            database_url: r.required("DATABASE_URL")?,
            session_signing_key,
            bind_addr: r.parse("BIND_ADDR", "0.0.0.0:8080".parse().unwrap())?,
            session_ttl_seconds: r.parse("SESSION_TTL_SECONDS", 2_592_000)?,
            secure_cookies,
            mail_backend,
            mail_from: r.string("MAIL_FROM", "no-reply@acrodont.local"),
            mail_outbox_dir,
            mail_max_per_second: r.parse_rate("MAIL_MAX_PER_SECOND", 1)?,
            public_url: r.string("PUBLIC_URL", "http://localhost:5173"),
            max_quiz_questions,
            max_storage_bytes_per_user,
            search_timeout_ms: r.parse("SEARCH_TIMEOUT_MS", 2000)?,
            search_concurrency,
            export_concurrency,
            trash_retention_days: r.parse("TRASH_RETENTION_DAYS", 30)?,
            sync_retention_days: r.parse("SYNC_RETENTION_DAYS", 30)?,
            sync_max_ops: r.parse("SYNC_MAX_OPS", 500)?,
            min_app_version: r.parse("MIN_APP_VERSION", 0)?,
            purge_interval_seconds: r.parse("PURGE_INTERVAL_SECONDS", 3600)?,
            purge_max_quizzes_per_user_per_run: r
                .parse("PURGE_MAX_QUIZZES_PER_USER_PER_RUN", 5000)?,
            admin_upload_max_bytes: r.parse("ADMIN_UPLOAD_MAX_BYTES", 104_857_600)?,
            api_max_body_bytes: r.parse("API_MAX_BODY_BYTES", 16_777_216)?,
            sync_rate_per_minute: r.parse_rate("SYNC_RATE_PER_MINUTE", 120)?,
            download_rate_per_minute: r.parse_rate("DOWNLOAD_RATE_PER_MINUTE", 120)?,
            search_rate_per_minute: r.parse_rate("SEARCH_RATE_PER_MINUTE", 30)?,
            export_rate_per_minute: r.parse_rate("EXPORT_RATE_PER_MINUTE", 10)?,
            admin_upload_rate_per_minute: r.parse_rate("ADMIN_UPLOAD_RATE_PER_MINUTE", 10)?,
            catalog_rate_per_minute: r.parse_rate("CATALOG_RATE_PER_MINUTE", 300)?,
            login_failures_per_ip_per_minute: r
                .parse_rate("LOGIN_FAILURES_PER_IP_PER_MINUTE", 10)?,
            login_failures_per_username_per_minute: r
                .parse_rate("LOGIN_FAILURES_PER_USERNAME_PER_MINUTE", 10)?,
            auth_rate_per_ip_per_minute: r.parse_rate("AUTH_RATE_PER_IP_PER_MINUTE", 30)?,
            reset_rate_per_hour: r.parse_rate("RESET_RATE_PER_HOUR", 5)?,
            catalog_reconcile_seconds: r.parse("CATALOG_RECONCILE_SECONDS", 60)?,
            trusted_proxy_hops: r.parse("TRUSTED_PROXY_HOPS", 0)?,
            dev_login,
        })
    }
}

struct Reader<'a> {
    env: &'a HashMap<String, String>,
}

impl Reader<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }

    fn required(&self, key: &str) -> Result<String, ConfigError> {
        match self.get(key) {
            Some(v) if !v.is_empty() => Ok(v.to_owned()),
            _ => Err(ConfigError(format!("{key} is required"))),
        }
    }

    fn string(&self, key: &str, default: &str) -> String {
        self.get(key).unwrap_or(default).to_owned()
    }

    fn parse<T: FromStr>(&self, key: &str, default: T) -> Result<T, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some(v) => v
                .trim()
                .parse()
                .map_err(|_| ConfigError(format!("{key} has a malformed value {v:?}"))),
        }
    }

    /// A rate of zero would make a bucket that never refills.
    fn parse_rate(&self, key: &str, default: u32) -> Result<u32, ConfigError> {
        let v: u32 = self.parse(key, default)?;
        if v == 0 {
            return Err(ConfigError(format!("{key} must be at least 1")));
        }
        Ok(v)
    }

    fn parse_bool(&self, key: &str, default: bool) -> Result<bool, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some("true") => Ok(true),
            Some("false") => Ok(false),
            Some(v) => Err(ConfigError(format!(
                "{key} must be true or false, not {v:?}"
            ))),
        }
    }
}

fn parse_key(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HashMap<String, String> {
        HashMap::from([
            ("DATABASE_URL".into(), "postgres://x".into()),
            ("SESSION_SIGNING_KEY".into(), "00".repeat(32)),
        ])
    }

    #[test]
    fn defaults_apply() {
        let c = Config::from_map(&base()).unwrap();
        assert_eq!(c.session_ttl_seconds, 2_592_000);
        assert_eq!(c.max_quiz_questions, 300_000);
        assert_eq!(c.max_storage_bytes_per_user, 10_000_000);
        assert_eq!(c.export_concurrency, 2);
        assert!(!c.dev_login);
        assert_eq!(c.search_concurrency, 2);
        assert_eq!(c.api_max_body_bytes, 16_777_216);
        assert_eq!(c.mail_backend, MailBackend::Console);
        assert_eq!(c.bind_addr.to_string(), "0.0.0.0:8080");
    }

    #[test]
    fn malformed_values_fail() {
        for (k, v) in [
            ("SESSION_TTL_SECONDS", "abc"),
            ("SECURE_COOKIES", "yes"),
            ("MAIL_BACKEND", "smtp"),
            ("MAX_QUIZ_QUESTIONS", "300001"),
            ("MAX_STORAGE_BYTES_PER_USER", "0"),
            ("MAX_STORAGE_BYTES_PER_USER", "100 MB"),
            ("EXPORT_CONCURRENCY", "0"),
            ("MAIL_MAX_PER_SECOND", "0"),
            ("DEV_LOGIN", "yes"),
            ("SESSION_SIGNING_KEY", "abcd"),
        ] {
            let mut env = base();
            env.insert(k.into(), v.into());
            assert!(Config::from_map(&env).is_err(), "{k}={v} accepted");
        }
    }

    #[test]
    fn dev_login_is_refused_with_secure_cookies() {
        let mut env = base();
        env.insert("DEV_LOGIN".into(), "true".into());
        assert!(Config::from_map(&env).unwrap().dev_login);
        env.insert("SECURE_COOKIES".into(), "true".into());
        let err = Config::from_map(&env).unwrap_err();
        assert!(err.0.contains("DEV_LOGIN"), "{err}");
    }

    #[test]
    fn file_mail_needs_an_outbox() {
        let mut env = base();
        env.insert("MAIL_BACKEND".into(), "file".into());
        assert!(Config::from_map(&env).is_err());
        env.insert("MAIL_OUTBOX_DIR".into(), "/tmp/outbox".into());
        assert_eq!(Config::from_map(&env).unwrap().mail_backend, MailBackend::File);
    }

    #[test]
    fn required_values() {
        let mut env = base();
        env.remove("DATABASE_URL");
        assert!(Config::from_map(&env).is_err());
    }
}
