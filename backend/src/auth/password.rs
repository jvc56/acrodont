//! Argon2 hashing and the strength rule a new password meets, at
//! registration and at a reset: its length, then a zxcvbn score of at least 3
//! against the account's username and address (PLAN.md § Authentication).
//! Scoring has turns of its own, off the executor: a crafted password costs
//! zxcvbn close to a second.

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};

use std::time::Duration;

use tokio::sync::{Semaphore, SemaphorePermit};

use crate::error::{ApiError, FieldError};

/// PQ-002: the plan names a length check without bounds; these are the bounds.
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_CHARS: usize = 128;

/// How many passwords may be scored at once, and how long a request waits for
/// a turn before it is told to come back (`503`, Retry-After 10). On the
/// executor a crafted password stalled every request; in turns, a flood of
/// them waits on scoring alone and never on sign-in's hashing.
const SCORING_CONCURRENCY: usize = 2;
const SCORING_QUEUE_WAIT: Duration = Duration::from_secs(10);
static SCORING_TURNS: Semaphore = Semaphore::const_new(SCORING_CONCURRENCY);

/// A turn to score a password, waited for at most `SCORING_QUEUE_WAIT`.
pub async fn scoring_turn() -> Result<SemaphorePermit<'static>, ApiError> {
    match tokio::time::timeout(SCORING_QUEUE_WAIT, SCORING_TURNS.acquire()).await {
        Ok(Ok(turn)) => Ok(turn),
        Ok(Err(_)) => Err(anyhow::anyhow!("the password scoring queue is closed").into()),
        Err(_) => Err(ApiError::Unavailable { retry_after_secs: 10 }),
    }
}

/// [`strength_errors`] in its own turn.
pub async fn check_strength(field: &str, password: &str, username: &str, email: &str) -> Result<Vec<FieldError>, ApiError> {
    score_in_turn(scoring_turn().await?, field, password, username, email).await
}

/// [`strength_errors`] on the blocking pool, in the turn given. The turn goes
/// with the run, and a run whose requester has gone is skipped.
pub async fn score_in_turn(
    turn: SemaphorePermit<'static>,
    field: &str,
    password: &str,
    username: &str,
    email: &str,
) -> Result<Vec<FieldError>, ApiError> {
    let (field, password, username, email) = (field.to_owned(), password.to_owned(), username.to_owned(), email.to_owned());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let _turn = turn;
        if !sender.is_closed() {
            let _ = sender.send(strength_errors(&field, &password, &username, &email));
        }
    });
    receiver
        .await
        .map_err(|_| anyhow::anyhow!("scoring a password did not finish").into())
}

/// The rule, scored against the username, the address and the address's
/// local part: zxcvbn matches each input whole, so the address alone let
/// `jsmith` through for `jsmith@example.com`.
pub fn strength_errors(field: &str, password: &str, username: &str, email: &str) -> Vec<FieldError> {
    let local_part = email.split('@').next().unwrap_or_default();
    let user_inputs: Vec<&str> = [username, email, local_part].into_iter().filter(|c| !c.is_empty()).collect();
    let n = password.chars().count();
    if n < MIN_PASSWORD_CHARS {
        return vec![FieldError::new(
            field,
            format!("Use at least {MIN_PASSWORD_CHARS} characters."),
        )];
    }
    if n > MAX_PASSWORD_CHARS {
        return vec![FieldError::new(
            field,
            format!("Use at most {MAX_PASSWORD_CHARS} characters."),
        )];
    }
    let score = zxcvbn::zxcvbn(password, &user_inputs).score();
    if (score as u8) < 3 {
        return vec![FieldError::new(
            field,
            "This password is too easy to guess. Try a longer phrase of unrelated words.",
        )];
    }
    Vec::new()
}

/// Hashes on a blocking thread, since Argon2 is deliberately slow.
pub async fn hash(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("argon2: {e}"))
    })
    .await?
}

pub async fn verify(password: String, phc: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&phc)
            .map(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dev_passphrase_is_strong_enough() {
        assert!(strength_errors("password", "correct-tile-rack-bingo", "", "").is_empty());
        assert!(!strength_errors("password", "password1", "", "").is_empty());
        assert!(!strength_errors("password", "short", "", "").is_empty());
    }

    #[test]
    fn the_address_local_part_counts_against_a_password() {
        // Strong on its own, weak for the account whose address it is.
        let p = "quintessential.zebracorn";
        assert!(strength_errors("password", p, "", "").is_empty());
        assert!(!strength_errors("password", p, "someone", "quintessential.zebracorn@example.com").is_empty());
    }

    #[tokio::test]
    async fn scoring_runs_in_turns_off_the_executor() {
        let errors = check_strength("password", "password1", "u", "u@example.com").await.unwrap();
        assert_eq!(errors.len(), 1);
    }

    #[tokio::test]
    async fn hash_verifies() {
        let h = hash("correct-tile-rack-bingo".into()).await.unwrap();
        assert!(verify("correct-tile-rack-bingo".into(), h.clone()).await);
        assert!(!verify("wrong".into(), h).await);
    }
}
