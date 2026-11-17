//! PLAN.md § Integration tests → Sync integration tests: database errors
//! inside a savepoint, a forced serialization failure, purge against a
//! concurrent sync, the sync and catalog rate limits, the sliding session
//! (PQ-003), and the 130,000-question finish and reset.

mod common;

use std::time::Instant;

use axum::http::StatusCode;
use chrono::Duration;
use acrodont::cascade::rules::Grade;
use common::sync::{finish_op, grades, insert_cascade, play_and_finish, result, rows, write_grades, Device, Setup};
use common::TestApp;
use serde_json::json;

/// The budget for one 130,000-question finish, and for its reset, in a debug
/// build on the CI runner ("The budgets are constants in the test").
const FINISH_FULL_BUDGET_SECS: u64 = 20;

async fn setup<'a>(app: &'a TestApp, s: &Setup) -> Device<'a> {
    let c = app.signed_in("alice").await;
    insert_cascade(app, c.user_id.unwrap(), s).await;
    let mut d = Device::new(c);
    d.qrf = vec![s.cascade_id];
    d.sync(vec![]).await;
    d
}

/// "A restore_quiz whose application raises a database error inside its
/// savepoint is recorded rejected with reason error, leaving the rest of the
/// batch applied" — a CHECK violation injected by a trigger.
#[sqlx::test]
async fn a_database_error_in_one_savepoint(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(5);
    let mut d = setup(&app, &s).await;
    let (_, l2) = play_and_finish(&app, &mut d, s.source_id, "CCCCM").await;
    play_and_finish(&app, &mut d, l2, "C").await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE FUNCTION wf_fault() RETURNS trigger AS $$
         BEGIN
           IF NEW.id = '{l2}' AND OLD.status = 'cleared' AND NEW.status = 'active' THEN
             RAISE EXCEPTION 'injected' USING ERRCODE = 'check_violation';
           END IF;
           RETURN NEW;
         END $$ LANGUAGE plpgsql;
         CREATE TRIGGER wf_fault BEFORE UPDATE ON quizzes FOR EACH ROW EXECUTE FUNCTION wf_fault();"
    )))
    .execute(app.db())
    .await
    .unwrap();
    let mut ops = grades(&app, &mut d, s.source_id, 0, "C").await;
    ops.push(d.op("restore_quiz", json!({ "quiz_id": l2, "shuffle_seed": "9" })));
    ops.extend(grades(&app, &mut d, s.source_id, 1, "C").await);
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(result(&r, 0)["status"], "applied");
    assert_eq!((result(&r, 1)["status"].clone(), result(&r, 1)["reason"].clone()), (json!("rejected"), json!("error")));
    assert_eq!(result(&r, 2)["status"], "applied");
    let recorded: String = sqlx::query_scalar("SELECT reason::text FROM sync_operations WHERE op_type = 'restore_quiz'")
        .fetch_one(app.db())
        .await
        .unwrap();
    assert_eq!(recorded, "error");
}

/// One question's grade as stored, by idx.
async fn stored(app: &TestApp, quiz: uuid::Uuid) -> std::collections::HashMap<u32, Option<Grade>> {
    let mut conn = app.db().acquire().await.unwrap();
    acrodont::cards::cards(&mut conn, quiz).await.unwrap().into_iter().map(|c| (c.idx, c.grade)).collect()
}

/// Grades and cursor moves share a savepoint, so a database error in one of
/// them cannot be rolled back alone: the batch is undone and applied again
/// with one savepoint an operation, and the outcome is what that always gave.
/// Here the second grade's chunk cannot be written (a CHECK violation
/// injected by a trigger): it alone is rejected `error`, and the grades and
/// the cursor move on either side of it are applied, once.
#[sqlx::test]
async fn a_database_error_in_one_grade_of_a_run_rejects_that_grade_alone(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(600);
    let mut d = setup(&app, &s).await;
    sqlx::raw_sql(
        "CREATE TABLE wf_cascade_writes (n int);
         CREATE FUNCTION wf_count() RETURNS trigger AS $$
         BEGIN INSERT INTO wf_cascade_writes VALUES (1); RETURN NEW; END $$ LANGUAGE plpgsql;
         CREATE TRIGGER wf_count AFTER UPDATE ON cascades FOR EACH ROW EXECUTE FUNCTION wf_count();
         CREATE FUNCTION wf_fault() RETURNS trigger AS $$
         BEGIN
           IF NEW.first_idx = 256 THEN
             RAISE EXCEPTION 'injected' USING ERRCODE = 'check_violation';
           END IF;
           RETURN NEW;
         END $$ LANGUAGE plpgsql;
         CREATE TRIGGER wf_fault BEFORE UPDATE ON quiz_cards FOR EACH ROW EXECUTE FUNCTION wf_fault();",
    )
    .execute(app.db())
    .await
    .unwrap();
    let q = common::sync::quiz_now(&app, s.source_id).await;
    let grade = |d: &mut Device<'_>, idx: u32, g: &str| {
        d.op("grade", json!({ "quiz_id": s.source_id, "attempt": q.attempt, "attempt_seed": q.seed, "question_idx": idx, "grade": g }))
    };
    let ops = vec![
        grade(&mut d, 3, "correct"),
        grade(&mut d, 300, "correct"), // the chunk that cannot be written
        d.op("move_cursor", json!({ "quiz_id": s.source_id, "attempt": q.attempt, "attempt_seed": q.seed, "position": 2 })),
        grade(&mut d, 5, "missed"),
        grade(&mut d, 599, "correct"),
    ];
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK);
    let got: Vec<(String, Option<String>)> = (0..5)
        .map(|i| (result(&r, i)["status"].as_str().unwrap().to_owned(), result(&r, i)["reason"].as_str().map(str::to_owned)))
        .collect();
    let applied = || ("applied".to_owned(), None);
    assert_eq!(got, vec![applied(), ("rejected".to_owned(), Some("error".to_owned())), applied(), applied(), applied()]);

    let cards = stored(&app, s.source_id).await;
    assert_eq!((cards[&3], cards[&300], cards[&5], cards[&599]), (Some(Grade::Correct), None, Some(Grade::Missed), Some(Grade::Correct)));
    let (correct, missed, cursor, quiz_seq): (i32, i32, i32, i64) =
        sqlx::query_as("SELECT correct_count, missed_count, cursor, updated_seq FROM quizzes WHERE id = $1").bind(s.source_id).fetch_one(app.db()).await.unwrap();
    let seq: i64 = r.json()["sync_seq"].as_str().unwrap().parse().unwrap();
    assert_eq!((correct, missed, cursor, quiz_seq), (2, 1, 2, seq), "each applied grade counted once, though the batch was applied twice over");
    let cascade_seq: i64 = sqlx::query_scalar("SELECT updated_seq FROM cascades WHERE id = $1").bind(s.cascade_id).fetch_one(app.db()).await.unwrap();
    assert_eq!(cascade_seq, seq);
    // The second pass is the plain one: each applied grade wrote the cascade's row.
    let writes: i64 = sqlx::query_scalar("SELECT count(*) FROM wf_cascade_writes").fetch_one(app.db()).await.unwrap();
    assert_eq!(writes, 3);
    let recorded: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT status::text, reason FROM sync_operations ORDER BY device_seq").fetch_all(app.db()).await.unwrap();
    assert_eq!(recorded, got, "recorded once each, as answered");
}

/// The cascade's row is written once for a run of grades, outside any one
/// grade's savepoint. If that write fails in the database, the batch is
/// applied again the plain way, where each grade writes the row itself and is
/// rejected `error` alone, as it always was; the cursor move writes no
/// cascade row and is applied.
#[sqlx::test]
async fn a_database_error_writing_the_cascade_row_rejects_the_grades_and_nothing_else(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(8);
    let mut d = setup(&app, &s).await;
    sqlx::raw_sql(
        "CREATE FUNCTION wf_fault() RETURNS trigger AS $$
         BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
         CREATE TRIGGER wf_fault BEFORE UPDATE ON cascades FOR EACH ROW EXECUTE FUNCTION wf_fault();",
    )
    .execute(app.db())
    .await
    .unwrap();
    let q = common::sync::quiz_now(&app, s.source_id).await;
    let mut ops = grades(&app, &mut d, s.source_id, 0, "CM").await;
    ops.push(d.op("move_cursor", json!({ "quiz_id": s.source_id, "attempt": q.attempt, "attempt_seed": q.seed, "position": 1 })));
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK, "a write the batch makes for its grades must not fail the request");
    for i in 0..2 {
        assert_eq!((result(&r, i)["status"].clone(), result(&r, i)["reason"].clone()), (json!("rejected"), json!("error")));
    }
    assert_eq!(result(&r, 2)["status"], "applied");
    assert!(stored(&app, s.source_id).await.values().all(Option::is_none), "a rejected grade leaves no grade");
    let (correct, missed, cursor): (i32, i32, i32) =
        sqlx::query_as("SELECT correct_count, missed_count, cursor FROM quizzes WHERE id = $1").bind(s.source_id).fetch_one(app.db()).await.unwrap();
    assert_eq!((correct, missed, cursor), (0, 0, 1));
}

/// "a forced serialization failure answers 503 with Retry-After and records
/// nothing, and the same batch sent again is applied in full".
#[sqlx::test]
async fn a_serialization_failure_is_503_and_the_resend_applies(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(5);
    let mut d = setup(&app, &s).await;
    // Fails the first grade only: a sequence is not rolled back with the transaction.
    sqlx::raw_sql(
        "CREATE SEQUENCE wf_fault_seq;
         CREATE FUNCTION wf_fault() RETURNS trigger AS $$
         BEGIN
           IF nextval('wf_fault_seq') = 1 THEN
             RAISE EXCEPTION 'injected' USING ERRCODE = 'serialization_failure';
           END IF;
           RETURN NEW;
         END $$ LANGUAGE plpgsql;
         CREATE TRIGGER wf_fault BEFORE UPDATE ON quiz_cards FOR EACH ROW EXECUTE FUNCTION wf_fault();",
    )
    .execute(app.db())
    .await
    .unwrap();
    let ops = grades(&app, &mut d, s.source_id, 0, "CCM").await;
    let r = d.sync(ops.clone()).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(r.retry_after().is_some());
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_operations").fetch_one(app.db()).await.unwrap();
    let graded: i64 = sqlx::query_scalar("SELECT count(*) FROM quiz_questions WHERE grade IS NOT NULL").fetch_one(app.db()).await.unwrap();
    assert_eq!((recorded, graded), (0, 0), "nothing recorded or written");
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["results"].as_array().unwrap().iter().all(|x| x["status"] == "applied"));
}

/// A pool like the test's own, with its size and its wait for a connection chosen.
async fn pool_of(pool: &sqlx::PgPool, connections: u32, options: &[(&str, &str)]) -> sqlx::PgPool {
    let mut connect = (*pool.connect_options()).clone();
    if !options.is_empty() {
        connect = connect.options(options.iter().copied());
    }
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(connections)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect_with(connect)
        .await
        .unwrap()
}

/// A sync holds one connection of the pool at a time: over a pool of one,
/// every kind of answer is given. A request that kept its connection while it
/// waited for a second would wait out the pool's timeout and fail; with every
/// connection of a larger pool held that way, so would every request.
#[sqlx::test]
async fn a_sync_never_waits_for_a_second_connection(pool: sqlx::PgPool) {
    let app = TestApp::with(pool_of(&pool, 1, &[]).await, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(5);
    let mut d = setup(&app, &s).await;
    let user = d.client.user_id.unwrap();
    // A push with its pull, and shared device settings.
    let ops = grades(&app, &mut d, s.source_id, 0, "C").await;
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let cursor = d.cursor.unwrap();
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let r = d
        .raw_sync(json!({ "device_id": d.id, "app_version": 1, "cursor": cursor, "question_rows_for": [], "ops": [],
                          "settings": { "border_px": { "value": 2, "at": at } } }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // A later page of a pull.
    let token = acrodont::sync::pull::PageToken { u: user, cur: None, ceil: cursor, qrf: vec![], table: 0, after: vec![] };
    let r = d
        .raw_sync(json!({ "device_id": d.id, "app_version": 1, "cursor": null, "page_token": token.encode(), "question_rows_for": [] }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["changes"]["cascades"].as_array().unwrap().len(), 1);
    // A cursor ahead of the server, and one below the floor.
    let r = d.raw_sync(json!({ "device_id": d.id, "app_version": 1, "cursor": cursor + 1000, "question_rows_for": [], "ops": [] })).await;
    assert_eq!((r.status, r.json()["resync_required"].clone()), (StatusCode::OK, json!(true)));
    sqlx::query("UPDATE users SET sync_floor_seq = sync_seq WHERE id = $1").bind(user).execute(app.db()).await.unwrap();
    let r = d.raw_sync(json!({ "device_id": d.id, "app_version": 1, "cursor": 1, "question_rows_for": [], "ops": [] })).await;
    assert_eq!((r.status, r.json()["resync_required"].clone()), (StatusCode::OK, json!(true)));
    // Several accounts at once: each waits its turn for the one connection.
    let mut b = Device::new(app.signed_in("bob").await);
    let mut c = Device::new(app.signed_in("carol").await);
    d.cursor = None;
    for _ in 0..5 {
        let (x, y, z) = tokio::join!(d.sync(vec![]), b.sync(vec![]), c.sync(vec![]));
        assert_eq!((x.status, y.status, z.status), (StatusCode::OK, StatusCode::OK, StatusCode::OK));
    }
}

/// A transient failure in the pull, after the push is committed, is `503`
/// with `Retry-After` like one in the push: the same batch sent again is
/// answered from the server's records, with its pull. Here the pull's read of
/// `quiz_attempts` meets a lock it does not wait out.
#[sqlx::test]
async fn a_transient_failure_in_the_pull_is_503_and_the_resend_is_answered(pool: sqlx::PgPool) {
    let app = TestApp::with(pool_of(&pool, 5, &[("lock_timeout", "300ms")]).await, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(5);
    let mut d = setup(&app, &s).await;
    let ops = grades(&app, &mut d, s.source_id, 0, "CM").await;
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE quiz_attempts IN ACCESS EXCLUSIVE MODE").execute(&mut *lock).await.unwrap();
    let r = d.sync(ops.clone()).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.json());
    assert!(r.retry_after().is_some());
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_operations").fetch_one(app.db()).await.unwrap();
    assert_eq!(recorded, 2, "the push was committed before the pull");
    lock.rollback().await.unwrap();
    let r = d.sync(ops).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["results"].as_array().unwrap().iter().all(|x| x["status"] == "applied"));
    let graded: usize = r.json()["changes"]["quiz_questions"].as_array().unwrap().iter().map(|g| g["question_idx"].as_array().unwrap().len()).sum();
    assert_eq!(graded, 2, "and its pull carries what it wrote");
}

/// "the purge task running against a concurrent sync for the same user
/// completes without a deadlock".
#[sqlx::test]
async fn purge_against_a_concurrent_sync(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000"), ("PURGE_MAX_QUIZZES_PER_USER_PER_RUN", "50")]).await;
    let s = Setup::new(40);
    let mut d = setup(&app, &s).await;
    let user = d.client.user_id.unwrap();
    common::sync::insert_cleared_chains(&app, user, &s, 400, 40).await;
    let old = Setup::new(5);
    insert_cascade(&app, user, &old).await;
    sqlx::query("UPDATE cascades SET trashed_at = now() - interval '40 days' WHERE id = $1").bind(old.cascade_id).execute(app.db()).await.unwrap();
    for round in 0..8 {
        let marks: String = (0..5).map(|i| if (i + round) % 2 == 0 { 'C' } else { 'M' }).collect();
        let mut ops = grades(&app, &mut d, s.source_id, round * 5, &marks).await;
        ops.push(d.op("set_cascade_options", json!({ "cascade_id": s.cascade_id, "segment_size": 5 + round })));
        let state = app.state.clone();
        let (purged, r) = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            tokio::join!(acrodont::purge::run_once(&state), d.sync(ops))
        })
        .await
        .expect("no hang");
        purged.expect("the purge completes");
        assert_eq!(r.status, StatusCode::OK, "round {round}: {:?}", r.json());
    }
}

/// The sync limit: with the rate at 1, a second sync in the minute is 429
/// with Retry-After and the card-page bucket is untouched; and the catalog's
/// per-IP bucket does not touch a signed-in user's sync.
#[sqlx::test]
async fn the_sync_and_catalog_limits_are_separate(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "1"), ("CATALOG_RATE_PER_MINUTE", "1")]).await;
    let s = Setup::new(5);
    let c = app.signed_in("alice").await;
    insert_cascade(&app, c.user_id.unwrap(), &s).await;
    let mut d = Device::new(c);
    // The catalog bucket spent from this address first.
    assert_eq!(d.client.get("/api/lexicons").await.status, StatusCode::OK);
    assert_eq!(d.client.get("/api/lexicons").await.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(d.sync(vec![]).await.status, StatusCode::OK);
    let r = d.sync(vec![]).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.retry_after().is_some());
    let cards = d.client.get(&format!("/api/cascades/{}/cards?from=0&limit=5&keys=1", s.cascade_id)).await;
    assert_eq!(cards.status, StatusCode::OK, "the card-page bucket is its own");
}

/// PQ-003: a sync in the last seven days of a cookie's life gets a fresh
/// cookie of the full TTL; earlier, and on /api/auth/me, it does not.
#[sqlx::test]
async fn a_sync_slides_the_session(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut d = Device::new(app.signed_in("alice").await);
    let r = d.sync(vec![]).await;
    assert!(r.set_cookie("acrodont_session").is_none());
    app.state.clock.advance(Duration::days(24));
    assert!(d.client.get("/api/auth/me").await.set_cookie("acrodont_session").is_none());
    let r = d.sync(vec![]).await;
    let cookie = r.set_cookie("acrodont_session").expect("renewed");
    assert!(cookie.contains("Max-Age=2592000"), "{cookie}");
    d.client.absorb(&r);
    // Still signed in past the original expiry.
    app.state.clock.advance(Duration::days(10));
    assert_eq!(d.sync(vec![]).await.status, StatusCode::OK);
}

/// "A 130,000-question finish and reset complete within budget, and the reset
/// is pulled by another device as one quiz row."
#[sqlx::test]
async fn a_130000_question_finish_and_reset(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let s = Setup::new(130_000);
    let mut d = setup(&app, &s).await;
    let mut b = d.sibling(&app);
    b.qrf = d.qrf.clone();
    b.sync(vec![]).await;
    // Every question graded, half missed, straight in the database (the
    // 260-request push is the scale test's).
    write_grades(&app, s.source_id, d.id, chrono::Utc::now(), None, |i| {
        Some(if i % 2 == 0 { Grade::Correct } else { Grade::Missed })
    })
    .await;
    sqlx::query("UPDATE quizzes SET correct_count = 65000, missed_count = 65000 WHERE id = $1").bind(s.source_id).execute(app.db()).await.unwrap();
    // The finish: the Source quiz descends, which resets it, and creates a 65,000-question Level 2.
    let (f, l2) = finish_op(&app, &mut d, s.source_id, "123").await;
    let t = Instant::now();
    let r = d.sync(vec![f]).await;
    assert!(t.elapsed().as_secs() < FINISH_FULL_BUDGET_SECS, "finish took {:?}", t.elapsed());
    assert_eq!(result(&r, 0)["outcome"], "descended");
    assert_eq!(result(&r, 0)["new_quiz_question_count"], 65_000);
    // A reset on its own: a reshuffle of the Source quiz.
    write_grades(&app, s.source_id, d.id, chrono::Utc::now(), None, |_| Some(Grade::Missed)).await;
    sqlx::query("UPDATE quizzes SET correct_count = 0, missed_count = 130000 WHERE id = $1").bind(s.source_id).execute(app.db()).await.unwrap();
    // Level 2 is the deepest; clear it out of the way first.
    sqlx::query("UPDATE quizzes SET status = 'cleared', cleared_at = now() WHERE id = $1").bind(l2).execute(app.db()).await.unwrap();
    sqlx::query("UPDATE cascades SET depth = 1").execute(app.db()).await.unwrap();
    let (f, _) = finish_op(&app, &mut d, s.source_id, "456").await;
    let t = Instant::now();
    let r = d.sync(vec![f]).await;
    assert!(t.elapsed().as_secs() < FINISH_FULL_BUDGET_SECS, "reset took {:?}", t.elapsed());
    assert_eq!(result(&r, 0)["outcome"], "reshuffled");
    // The other device pulls the reset as one quiz row and no question rows.
    let (_, pages) = b.sync_all(vec![]).await;
    let source_rows: Vec<_> = rows(&pages, "quizzes").into_iter().filter(|q| q["id"] == json!(s.source_id)).collect();
    assert_eq!(source_rows.len(), 1);
    assert!(rows(&pages, "quiz_questions").iter().all(|g| g["quiz_id"] != json!(s.source_id)));
}
