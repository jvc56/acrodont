//! The hourly purge task (PLAN.md § Purge task).
//!
//! Each instance runs it; `pg_try_advisory_lock` lets only one purge at a time.
//! It works one user per transaction, locking the user row first (the
//! `sync_seq` bump) and only then touching that user's cascades and quizzes,
//! the same order a sync takes, so a purge and a sync never deadlock.

use std::time::Duration;

use uuid::Uuid;

use crate::app::AppState;

/// Advisory lock key for the purge task.
pub const PURGE_LOCK_KEY: i64 = 0x0057_4650_5552_4745; // "WFPURGE"

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(state.config.purge_interval_seconds.max(1)));
        loop {
            tick.tick().await;
            // This instance's own in-memory limits, whoever holds the lock.
            state.limits.prune();
            state.email_caps.prune();
            if let Err(e) = run_once(&state).await {
                tracing::error!(error = %e, "purge run failed");
            }
        }
    });
}

/// One run. Returns false when another instance holds the lock.
pub async fn run_once(state: &AppState) -> anyhow::Result<bool> {
    let mut conn = state.db.acquire().await?;
    let locked: bool = sqlx::query_scalar!("SELECT pg_try_advisory_lock($1) AS \"locked!\"", PURGE_LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?;
    if !locked {
        return Ok(false);
    }
    let result = run_locked(state).await;
    sqlx::query_scalar!("SELECT pg_advisory_unlock($1)", PURGE_LOCK_KEY).fetch_one(&mut *conn).await?;
    result.map(|_| true)
}

/// Every step runs whatever the others did: a step that fails is logged and
/// the run goes on, so one account's bad row cannot also stop every other
/// account's purge, the pruning and the recount, hour after hour.
async fn run_locked(state: &AppState) -> anyhow::Result<()> {
    let mut failed = Vec::new();
    let mut step = |name: &'static str, result: anyhow::Result<()>| {
        if let Err(e) = result {
            tracing::error!(step = name, error = %e, "purge step failed");
            failed.push(name);
        }
    };
    step("purge_trash", purge_trash(state).await);
    step("prune_sync_records", prune_sync_records(state).await);
    step("delete_stale_unconfirmed", delete_stale_unconfirmed(state).await.map(drop));
    step("prune_export_tokens", prune_export_tokens(state).await.map(drop));
    step("prune_catalog_status", prune_catalog_status(state).await.map(drop));
    step("recount_storage", recount_storage(state).await.map(drop));
    if failed.is_empty() {
        Ok(())
    } else {
        Err(anyhow::anyhow!("these steps failed: {}", failed.join(", ")))
    }
}

/// Counts the accounts a per-account step failed for, logging each, so the
/// step can go on to the next account and still report that it failed.
struct Failures(u64);

impl Failures {
    fn note(&mut self, what: &'static str, user: Uuid, result: anyhow::Result<()>) {
        if let Err(e) = result {
            tracing::error!(%user, error = %e, "{what} failed for an account; going on to the next");
            self.0 += 1;
        }
    }

    fn done(self, what: &'static str) -> anyhow::Result<()> {
        if self.0 == 0 {
            Ok(())
        } else {
            Err(anyhow::anyhow!("{what} failed for {} accounts", self.0))
        }
    }
}

/// Each user's storage total recounted from their cascades and saved
/// searches; any drift is logged and corrected (STORAGE_LIMIT_PLAN.md § S1).
pub async fn recount_storage(state: &AppState) -> anyhow::Result<u64> {
    Ok(crate::storage::recount_users(&state.db).await?)
}

/// Users with anything past the retention period.
async fn users_with_trash(state: &AppState, days: i32) -> anyhow::Result<Vec<Uuid>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT q.user_id AS "user_id!" FROM quizzes q JOIN cascades c ON c.id = q.cascade_id
           WHERE q.status = 'cleared' AND c.trashed_at IS NULL
             AND q.cleared_at < now() - make_interval(days => $1)
           UNION
           SELECT user_id FROM cascades WHERE trashed_at < now() - make_interval(days => $1)"#,
        days
    )
    .fetch_all(&state.db)
    .await?)
}

/// Cleared quizzes past the retention period whose cascade is not trashed,
/// oldest first and at most `PURGE_MAX_QUIZZES_PER_USER_PER_RUN` per user per
/// run, then trashed cascades past it, each whole; a run that has reached its
/// cap starts no further cascade.
pub async fn purge_trash(state: &AppState) -> anyhow::Result<()> {
    let days = state.config.trash_retention_days as i32;
    let cap = i64::from(state.config.purge_max_quizzes_per_user_per_run);
    let mut failures = Failures(0);
    for user in users_with_trash(state, days).await? {
        failures.note("purging the trash", user, purge_user_trash(state, user, days, cap).await);
    }
    failures.done("purging the trash")
}

/// One account's turn, in one transaction.
async fn purge_user_trash(state: &AppState, user: Uuid, days: i32, cap: i64) -> anyhow::Result<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user).fetch_one(&mut *tx).await?;
    let seq = sqlx::query_scalar!("UPDATE users SET sync_seq = sync_seq + 1 WHERE id = $1 RETURNING sync_seq", user)
        .fetch_one(&mut *tx)
        .await?;
    // The account's devices drop what was purged at once (sync::notify).
    crate::sync::notify::changed(&mut tx, user, None).await?;
    let quizzes: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT q.id FROM quizzes q JOIN cascades c ON c.id = q.cascade_id
         WHERE q.user_id = $1 AND q.status = 'cleared' AND c.trashed_at IS NULL
           AND q.cleared_at < now() - make_interval(days => $2)
         ORDER BY q.cleared_at, q.id LIMIT $3",
        user,
        days,
        cap
    )
    .fetch_all(&mut *tx)
    .await?;
    if !quizzes.is_empty() {
        // What they free, per cascade, read before they go.
        let freed = crate::storage::quizzes_bytes(&mut tx, &quizzes).await?;
        sqlx::query!("DELETE FROM quizzes WHERE id = ANY($1)", &quizzes).execute(&mut *tx).await?;
        for (cascade, bytes) in freed {
            crate::storage::add_to_cascade(&mut tx, user, cascade, -bytes, seq).await?;
        }
        sqlx::query!(
            "INSERT INTO sync_tombstones (user_id, entity, entity_id, seq)
             SELECT $1, 'quiz', q, $3 FROM UNNEST($2::uuid[]) AS q
             ON CONFLICT (user_id, entity, entity_id) DO UPDATE SET seq = EXCLUDED.seq, deleted_at = now()",
            user,
            &quizzes,
            seq
        )
        .execute(&mut *tx)
        .await?;
    }
    if (quizzes.len() as i64) < cap {
        let cascades: Vec<Uuid> = sqlx::query_scalar!(
            "SELECT id FROM cascades WHERE user_id = $1 AND trashed_at < now() - make_interval(days => $2)
             ORDER BY trashed_at, id",
            user,
            days
        )
        .fetch_all(&mut *tx)
        .await?;
        for c in cascades {
            crate::sync::ops::purge_cascade_rows(&mut tx, user, c, seq).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Result-bearing sync records and tombstones past `SYNC_RETENTION_DAYS`,
/// raising each affected user's `sync_floor_seq` to the highest tombstone
/// sequence removed.
pub async fn prune_sync_records(state: &AppState) -> anyhow::Result<()> {
    let days = state.config.sync_retention_days as i32;
    sqlx::query!("DELETE FROM sync_operations WHERE received_at < now() - make_interval(days => $1)", days)
        .execute(&state.db)
        .await?;
    let users: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT DISTINCT user_id FROM sync_tombstones WHERE deleted_at < now() - make_interval(days => $1)",
        days
    )
    .fetch_all(&state.db)
    .await?;
    let mut failures = Failures(0);
    for user in users {
        failures.note("pruning tombstones", user, prune_user_tombstones(state, user, days).await);
    }
    failures.done("pruning tombstones")
}

async fn prune_user_tombstones(state: &AppState, user: Uuid, days: i32) -> anyhow::Result<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user).fetch_one(&mut *tx).await?;
    let highest = sqlx::query_scalar!(
        "WITH gone AS (DELETE FROM sync_tombstones WHERE user_id = $1 AND deleted_at < now() - make_interval(days => $2)
                       RETURNING seq)
         SELECT max(seq) FROM gone",
        user,
        days
    )
    .fetch_one(&mut *tx)
    .await?;
    if let Some(h) = highest {
        sqlx::query!("UPDATE users SET sync_floor_seq = greatest(sync_floor_seq, $2) WHERE id = $1", user, h)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Accounts never confirmed whose last confirmation code expired more than
/// 7 days ago, so an abandoned registration does not hold an address forever.
pub async fn delete_stale_unconfirmed(state: &AppState) -> anyhow::Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM users u
         WHERE u.email_confirmed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM email_confirmations c
                           WHERE c.user_id = u.id
                             AND c.expires_at > now() - interval '7 days')"
    )
    .execute(&state.db)
    .await?;
    Ok(r.rows_affected())
}

pub async fn prune_export_tokens(state: &AppState) -> anyhow::Result<u64> {
    let r = sqlx::query!("DELETE FROM export_tokens_spent WHERE expires_at < now()").execute(&state.db).await?;
    Ok(r.rows_affected())
}

/// `catalog_instance_status` rows whose heartbeat is older than 3 minutes,
/// left by instances that have stopped.
pub async fn prune_catalog_status(state: &AppState) -> anyhow::Result<u64> {
    let r = sqlx::query!("DELETE FROM catalog_instance_status WHERE heartbeat_at < now() - interval '3 minutes'")
        .execute(&state.db)
        .await?;
    Ok(r.rows_affected())
}
