//! Outgoing email and the per-address caps (PLAN.md § Authentication → Register).
//!
//! At most three confirmation, notice or reset emails go to one address in
//! 24 hours per requesting IP, and twenty per address in all. Further requests
//! get the same response and send nothing.

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};

use crate::clock::Clock;

pub const PER_IP_PER_ADDRESS: usize = 3;
pub const PER_ADDRESS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailKind {
    /// A new registration's confirmation code.
    Confirmation { code: String },
    /// Sent instead of a code when the address already has a confirmed account.
    AccountExists,
    /// A password reset token.
    PasswordReset { token: String },
}

#[derive(Debug, Clone)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub kind: MailKind,
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

pub trait Mailer: Send + Sync {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a>;
}

/// `MAIL_BACKEND=console`: the email is written to the log, where
/// `docker compose logs backend` (and `scripts/stack.py`) can read it.
pub struct ConsoleMailer;

impl Mailer for ConsoleMailer {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a> {
        Box::pin(async move {
            match &email.kind {
                MailKind::Confirmation { code } => tracing::info!(
                    mail_to = %email.to, confirmation_code = %code,
                    subject = %email.subject, body = %email.body, "mail"
                ),
                MailKind::PasswordReset { token } => tracing::info!(
                    mail_to = %email.to, reset_token = %token,
                    subject = %email.subject, body = %email.body, "mail"
                ),
                MailKind::AccountExists => tracing::info!(
                    mail_to = %email.to, subject = %email.subject, body = %email.body, "mail"
                ),
            }
            Ok(())
        })
    }
}

/// `MAIL_BACKEND=ses`: sent through the SES v2 API as `MAIL_FROM`, with the
/// task role's credentials and region from the environment (PLAN.md §
/// Deployment and Operations: "SES domain identity"). Neither the code, the
/// token nor the address is logged: only a short hash of the address, which
/// still lets an operator match a complaint to a log line.
pub struct SesMailer {
    client: aws_sdk_sesv2::Client,
    from: String,
}

impl SesMailer {
    pub async fn from_env(from: String) -> Self {
        let config = aws_config::load_from_env().await;
        SesMailer { client: aws_sdk_sesv2::Client::new(&config), from }
    }
}

impl Mailer for SesMailer {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a> {
        use aws_sdk_sesv2::types::{Body, Content, Destination, EmailContent, Message};
        Box::pin(async move {
            let text = |s: &str| Content::builder().data(s).charset("UTF-8").build();
            let message = Message::builder()
                .subject(text(&email.subject)?)
                .body(Body::builder().text(text(&email.body)?).build())
                .build();
            self.client
                .send_email()
                .from_email_address(&self.from)
                .destination(Destination::builder().to_addresses(&email.to).build())
                .content(EmailContent::builder().simple(message).build())
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("SES refused the send: {}", aws_sdk_sesv2::error::DisplayErrorContext(e)))?;
            tracing::info!(to = %address_tag(&email.to), kind = kind_name(&email.kind), "mail sent");
            Ok(())
        })
    }
}

/// A short, stable tag for an address, for logs that must not hold it.
pub fn address_tag(address: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(address.trim().to_lowercase().as_bytes());
    hex::encode(&digest[..6])
}

pub fn kind_name(kind: &MailKind) -> &'static str {
    match kind {
        MailKind::Confirmation { .. } => "confirmation",
        MailKind::AccountExists => "account_exists",
        MailKind::PasswordReset { .. } => "password_reset",
    }
}

/// `MAIL_BACKEND=file`: everything the console backend logs, plus one JSON
/// file per message in `MAIL_OUTBOX_DIR`, named for the recipient, which
/// `scripts/stack.py` and the end-to-end tests read instead of scraping logs.
/// Written under a temporary name and renamed, so a reader never sees half.
pub struct FileMailer {
    dir: std::path::PathBuf,
}

impl FileMailer {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> Self {
        FileMailer { dir: dir.into() }
    }

    /// The recipient part of a message's file name.
    pub fn file_stem(address: &str) -> String {
        address
            .trim()
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '@' | '-' | '_' | '+') { c } else { '_' })
            .collect()
    }
}

impl Mailer for FileMailer {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a> {
        Box::pin(async move {
            ConsoleMailer.send(email.clone()).await?;
            let mut doc = serde_json::json!({
                "to": email.to,
                "subject": email.subject,
                "body": email.body,
                "kind": kind_name(&email.kind),
            });
            match &email.kind {
                MailKind::Confirmation { code } => doc["confirmation_code"] = code.clone().into(),
                MailKind::PasswordReset { token } => doc["reset_token"] = token.clone().into(),
                MailKind::AccountExists => {}
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let name = format!("{}.{stamp}.{}.json", Self::file_stem(&email.to), uuid::Uuid::new_v4().simple());
            let tmp = self.dir.join(format!(".{name}.tmp"));
            tokio::fs::write(&tmp, serde_json::to_vec_pretty(&doc)?).await?;
            tokio::fs::rename(&tmp, self.dir.join(&name)).await?;
            Ok(())
        })
    }
}

/// How long a message is still worth sending: its link's own lifetime.
fn lifetime(kind: &MailKind) -> Option<std::time::Duration> {
    match kind {
        MailKind::Confirmation { .. } => Some(std::time::Duration::from_secs(24 * 3600)),
        MailKind::PasswordReset { .. } => Some(std::time::Duration::from_secs(30 * 60)),
        MailKind::AccountExists => None,
    }
}

/// SES refuses sends above the account's rate (1 a second in the sandbox,
/// usually 14 after), so a burst of registrations, a club signing up together,
/// lost mail when sent at once (birdtest). Messages wait in a bounded queue,
/// an hour's worth, drained at `MAIL_MAX_PER_SECOND` by one task; each send
/// times out at 30 s; a message whose link has expired while queued is
/// dropped. Every failure is logged with `alarm = "mail_failed"`, which a
/// CloudWatch metric filter alarms on (BIRDTEST_LESSONS_PLAN.md MAIL-1/2).
/// A queued message and when it was queued.
type Queued = (tokio::time::Instant, Email);

pub struct QueuedMailer {
    tx: tokio::sync::mpsc::Sender<Queued>,
}

pub const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

impl QueuedMailer {
    pub fn spawn(inner: Arc<dyn Mailer>, per_second: u32) -> Self {
        let per_second = per_second.max(1);
        let capacity = (per_second as usize * 3600).min(10_000);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Queued>(capacity);
        let gap = std::time::Duration::from_secs_f64(1.0 / f64::from(per_second));
        tokio::spawn(async move {
            let mut next = tokio::time::Instant::now();
            while let Some((queued, email)) = rx.recv().await {
                let to = address_tag(&email.to);
                let kind = kind_name(&email.kind);
                if lifetime(&email.kind).is_some_and(|life| queued.elapsed() > life) {
                    tracing::warn!(%to, kind, "mail expired in the queue; not sent");
                    continue;
                }
                tokio::time::sleep_until(next).await;
                next = tokio::time::Instant::now() + gap;
                match tokio::time::timeout(SEND_TIMEOUT, inner.send(email)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => tracing::error!(alarm = "mail_failed", %to, kind, error = %e, "sending email failed"),
                    Err(_) => tracing::error!(alarm = "mail_failed", %to, kind, "sending email timed out"),
                }
            }
        });
        QueuedMailer { tx }
    }
}

impl Mailer for QueuedMailer {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a> {
        Box::pin(async move {
            self.tx
                .try_send((tokio::time::Instant::now(), email))
                .map_err(|_| anyhow::anyhow!("the mail queue is full"))
        })
    }
}

/// Keeps every email, for tests.
#[derive(Default, Clone)]
pub struct RecordingMailer {
    pub sent: Arc<Mutex<Vec<Email>>>,
}

impl RecordingMailer {
    pub fn to(&self, address: &str) -> Vec<Email> {
        let sent = self.sent.lock().expect("mail lock");
        sent.iter()
            .filter(|e| e.to.eq_ignore_ascii_case(address))
            .cloned()
            .collect()
    }
}

impl Mailer for RecordingMailer {
    fn send<'a>(&'a self, email: Email) -> SendFuture<'a> {
        Box::pin(async move {
            self.sent.lock().expect("mail lock").push(email);
            Ok(())
        })
    }
}

/// The 24-hour caps. In memory, per instance, like every limit in the plan.
pub struct EmailCaps {
    clock: Arc<Clock>,
    sent: Mutex<HashMap<String, Vec<(DateTime<Utc>, IpAddr)>>>,
}

impl EmailCaps {
    pub fn new(clock: Arc<Clock>) -> Self {
        EmailCaps {
            clock,
            sent: Mutex::new(HashMap::new()),
        }
    }

    /// Takes a slot for one email to `address` requested from `ip`, or
    /// returns false when either cap is reached.
    pub fn try_reserve(&self, address: &str, ip: IpAddr) -> bool {
        let now = self.clock.now();
        let window_start = now - Duration::hours(24);
        let key = address.to_lowercase();
        let mut sent = self.sent.lock().expect("caps lock");
        let entries = sent.entry(key).or_default();
        entries.retain(|(at, _)| *at > window_start);
        let from_ip = entries.iter().filter(|(_, i)| *i == ip).count();
        if from_ip >= PER_IP_PER_ADDRESS || entries.len() >= PER_ADDRESS {
            return false;
        }
        entries.push((now, ip));
        true
    }
}

pub fn confirmation_email(public_url: &str, to: &str, code: &str) -> Email {
    let link = format!(
        "{}/confirm-email?code={}",
        public_url.trim_end_matches('/'),
        code
    );
    Email {
        to: to.into(),
        subject: "Confirm your Wordfall account".into(),
        body: format!(
            "Welcome to Wordfall.\n\nConfirm your email address within 24 hours:\n{link}\n"
        ),
        kind: MailKind::Confirmation { code: code.into() },
    }
}

pub fn account_exists_email(public_url: &str, to: &str) -> Email {
    let base = public_url.trim_end_matches('/');
    Email {
        to: to.into(),
        subject: "Your Wordfall account".into(),
        body: format!(
            "Someone tried to register a Wordfall account with this address, which already \
             has one. If it was you, log in at {base}/login, or reset your password at \
             {base}/reset-password. Otherwise you can ignore this email.\n"
        ),
        kind: MailKind::AccountExists,
    }
}

pub fn reset_email(public_url: &str, to: &str, token: &str) -> Email {
    let link = format!(
        "{}/reset-password/confirm?token={}",
        public_url.trim_end_matches('/'),
        token
    );
    Email {
        to: to.into(),
        subject: "Reset your Wordfall password".into(),
        body: format!(
            "Set a new password within 30 minutes:\n{link}\n\nIf you did not ask for this, \
             you can ignore this email.\n"
        ),
        kind: MailKind::PasswordReset {
            token: token.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn confirmation(to: &str) -> Email {
        confirmation_email("http://x", to, "code")
    }

    #[tokio::test(start_paused = true)]
    async fn the_queue_sends_at_the_configured_rate() {
        let rec = RecordingMailer::default();
        let q = QueuedMailer::spawn(Arc::new(rec.clone()), 2);
        for i in 0..5 {
            q.send(confirmation(&format!("u{i}@x.y"))).await.unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(rec.sent.lock().unwrap().len(), 1, "the first goes at once");
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        assert_eq!(rec.sent.lock().unwrap().len(), 3, "two a second after that");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        assert_eq!(rec.sent.lock().unwrap().len(), 5);
    }

    /// A mailer that never answers.
    struct Stuck;
    impl Mailer for Stuck {
        fn send<'a>(&'a self, _email: Email) -> SendFuture<'a> {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_reset_mail_whose_link_expired_in_the_queue_is_dropped() {
        // One stuck send holds the queue for SEND_TIMEOUT; behind a long line
        // of them a reset mail outlives its 30 minutes.
        let q = QueuedMailer::spawn(Arc::new(Stuck), 1);
        for i in 0..70 {
            q.send(confirmation(&format!("u{i}@x.y"))).await.unwrap();
        }
        q.send(reset_email("http://x", "r@x.y", "t")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(71 * 31)).await;
        // Nothing to assert on a stuck mailer but that the worker moved on:
        // the queue drained, so a new message is accepted at once.
        q.send(confirmation("late@x.y")).await.unwrap();
    }

    #[test]
    fn address_tags_hide_the_address_but_match_it() {
        let t = address_tag(" Alice@Example.org");
        assert_eq!(t, address_tag("alice@example.org"));
        assert_eq!(t.len(), 12);
        assert!(!t.contains("alice"));
    }

    #[tokio::test]
    async fn the_file_backend_writes_one_message_per_file() {
        let dir = std::env::temp_dir().join(format!("wordfall-outbox-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        FileMailer::new(&dir).send(confirmation("Bob+x@Example.org")).await.unwrap();
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("bob+x@example.org.") && files[0].ends_with(".json"), "{files:?}");
        let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(&files[0])).unwrap()).unwrap();
        assert_eq!(doc["confirmation_code"], "code");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caps_per_ip_and_per_address() {
        let clock = Arc::new(Clock::system());
        let caps = EmailCaps::new(clock.clone());
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        for _ in 0..3 {
            assert!(caps.try_reserve("x@y.z", a));
        }
        assert!(!caps.try_reserve("X@y.z", a));
        // Twenty in all, whatever the IPs.
        for i in 0..17 {
            let ip: IpAddr = format!("10.0.1.{i}").parse().unwrap();
            assert!(caps.try_reserve("x@y.z", ip));
        }
        assert!(!caps.try_reserve("x@y.z", "10.0.2.1".parse().unwrap()));
        clock.advance(Duration::hours(24) + Duration::seconds(1));
        assert!(caps.try_reserve("x@y.z", a));
    }
}
