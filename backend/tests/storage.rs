//! STORAGE_LIMIT_PLAN.md § Tests, the server's half: the per-account storage
//! limit refusing creation, Start over and saved searches with what they
//! need; two creations racing for the last space; studying past the limit;
//! purges freeing exactly what was counted; the preview's estimate; the
//! purge task's recount; and the calibration of `contract-fixtures/storage.json`
//! against what Postgres measures.

mod common;

use axum::http::StatusCode;
use common::sync::{assert_storage_consistent, play_and_finish, result, rows, Device};
use common::{Client, TestApp};
use serde_json::{json, Value};
use uuid::Uuid;
use acrodont::cascade::rules::Grade;
use acrodont::storage::{attempt_bytes, level_bytes, ROW_BYTES};

fn length(min: i64, max: i64) -> Value {
    json!({ "op": "and", "children": [{ "type": "length", "negated": false, "min": min, "max": max }] })
}

fn body(lexicon: &str, quiz_type: &str, filters: Value) -> Value {
    json!({
        "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
        "at": "2026-01-01T00:00:00Z", "name": "A cascade", "lexicon": lexicon, "quiz_type": quiz_type,
        "clear_threshold": 80, "segment_size": 0, "progression": "ladder", "require_alphabetical": false,
        "answer_mode": "flashcard", "filters": filters,
    })
}

fn start_over_body() -> Value {
    json!({ "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(), "at": "2026-01-01T00:00:00Z" })
}

/// A 64-bit figure on a cascade row: decimal text.
fn bytes_of(cascade: &Value) -> i64 {
    cascade["storage_bytes"].as_str().expect("decimal text").parse().unwrap()
}

/// What a cascade from this search would hold, by the preview.
async fn estimate(c: &mut Client<'_>, quiz_type: &str, filters: Value) -> i64 {
    let r = c.post("/api/search/preview", json!({ "lexicon": "EN-FIX", "quiz_type": quiz_type, "filters": filters })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    r.json()["storage_bytes"].as_i64().expect("a JSON number")
}

async fn used(app: &TestApp, user: Uuid) -> i64 {
    sqlx::query_scalar("SELECT storage_bytes FROM users WHERE id = $1").bind(user).fetch_one(app.db()).await.unwrap()
}

async fn set_limit(app: &TestApp, user: Uuid, limit: Option<i64>) {
    sqlx::query("UPDATE users SET storage_limit_bytes = $2 WHERE id = $1").bind(user).bind(limit).execute(app.db()).await.unwrap();
}

async fn count(app: &TestApp, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}"))).fetch_one(app.db()).await.unwrap()
}

/// The preview reports what a cascade from its search would hold as created,
/// keys' real bytes and word list included, and creation stores exactly that,
/// on the cascade row (decimal text, like every 64-bit value there), on the
/// user's total, and as the formula counts the rows.
#[sqlx::test]
async fn the_preview_reports_what_a_cascade_holds_as_created(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    let mut total = 0;
    for (quiz_type, filters) in [
        ("anagram", length(7, 7)),
        ("definition", length(7, 8)),
        ("leave_value", json!({ "op": "and", "children": [{ "type": "leave_value", "negated": false, "min": 30.0, "max": null }] })),
        ("definition", json!({ "op": "and", "children": [
            { "type": "in_word_list", "negated": false, "entries": ["RETAINS", "QI", "ZZZZZ", "QI"] }] })),
    ] {
        let want = estimate(&mut c, quiz_type, filters.clone()).await;
        let r = c.post("/api/cascades", body("EN-FIX", quiz_type, filters)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let cascade = &r.json()["cascade"];
        assert_eq!(bytes_of(cascade), want, "{quiz_type}");
        let n = cascade["question_count"].as_i64().unwrap();
        assert!(want > ROW_BYTES.cascade_row + level_bytes(n, true) + n * ROW_BYTES.question, "keys and spec on top");
        total += want;
        assert_eq!(used(&app, user).await, total);
        assert_storage_consistent(&app, user).await;
    }
    // The pull carries the same figure.
    let mut d = Device::new(c);
    let (_, pages) = d.sync_all(vec![]).await;
    let pulled: i64 = rows(&pages, "cascades").iter().map(bytes_of).sum();
    assert_eq!(pulled, total);
    assert_eq!(pages[0]["storage"], json!({ "used": total, "limit": 10_000_000 }));
}

/// Creation and Start over past the limit are `409 storage_limit` with the
/// account's figure, its limit and what the new cascade needs, writing
/// nothing; an account already at its limit is refused before any search,
/// with `needed` 0.
#[sqlx::test]
async fn creation_and_start_over_are_refused_past_the_limit(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("MAX_STORAGE_BYTES_PER_USER", "3000")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    let anagrams = estimate(&mut c, "anagram", length(7, 7)).await;
    let definitions = estimate(&mut c, "definition", length(7, 7)).await;
    assert!(anagrams < 3_000 && definitions < 3_000 && anagrams + definitions > 3_000, "{anagrams} {definitions}");
    let first = body("EN-FIX", "anagram", length(7, 7));
    assert_eq!(c.post("/api/cascades", first.clone()).await.status, StatusCode::CREATED);
    let specs = count(&app, "search_specs").await;

    let r = c.post("/api/cascades", body("EN-FIX", "definition", length(7, 7))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json(), json!({ "error": "storage_limit", "used": anagrams, "limit": 3_000, "needed": definitions }));
    let path = format!("/api/cascades/{}/start-over", first["id"].as_str().unwrap());
    let r = c.post(&path, start_over_body()).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json(), json!({ "error": "storage_limit", "used": anagrams, "limit": 3_000, "needed": anagrams }));
    assert_eq!((count(&app, "cascades").await, count(&app, "search_specs").await), (1, specs), "nothing written");
    assert_eq!(used(&app, user).await, anagrams);

    // The account's own limit replaces the configured one, both ways.
    set_limit(&app, user, Some(2 * anagrams)).await;
    let r = c.post(&path, start_over_body()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(used(&app, user).await, 2 * anagrams);
    // At the limit exactly: refused before the search.
    let r = c.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))).await;
    assert_eq!(r.json(), json!({ "error": "storage_limit", "used": 2 * anagrams, "limit": 2 * anagrams, "needed": 0 }));
    assert_eq!(c.get("/api/auth/me").await.json()["max_storage_bytes"], 2 * anagrams);
    assert_storage_consistent(&app, user).await;
}

/// "Two creations racing for the last space: one wins."
#[sqlx::test]
async fn two_creations_race_for_the_last_space(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("MAX_STORAGE_BYTES_PER_USER", "12000")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    let anagrams = estimate(&mut c, "anagram", length(7, 7)).await;
    // Trashed cascades count (D4): the room left fits one more, not two.
    let first = body("EN-FIX", "anagram", length(7, 7));
    assert_eq!(c.post("/api/cascades", first).await.status, StatusCode::CREATED);
    sqlx::query("UPDATE cascades SET trashed_at = now()").execute(app.db()).await.unwrap();
    set_limit(&app, user, Some(3 * anagrams - 1)).await;
    let mut other = Client::new(&app, "203.0.113.2");
    other.cookies = c.cookies.clone();
    other.user_id = c.user_id;
    let (a, b) = tokio::join!(
        c.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))),
        other.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7)))
    );
    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let refused = if a.status == StatusCode::CONFLICT { a } else { b };
    assert_eq!(
        refused.json(),
        json!({ "error": "storage_limit", "used": 2 * anagrams, "limit": 3 * anagrams - 1, "needed": anagrams })
    );
    assert_eq!(count(&app, "cascades").await, 2);
    assert_storage_consistent(&app, user).await;
}

/// Studying never fails for storage (§ S3): a finish whose new level takes the
/// account past its limit applies, the pull and every sync response show the
/// new figure, and only creating is refused.
#[sqlx::test]
async fn a_finish_past_the_limit_still_applies(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    let r = c.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))).await;
    let created = r.json();
    let cascade: Uuid = created["cascade"]["id"].as_str().unwrap().parse().unwrap();
    let source: Uuid = created["source_quiz"]["id"].as_str().unwrap().parse().unwrap();
    let before = bytes_of(&created["cascade"]);
    // At the limit exactly.
    set_limit(&app, user, Some(before)).await;
    let mut d = Device::new(c);
    d.qrf = vec![cascade];
    d.sync_all(vec![]).await;
    let (finish, _) = play_and_finish(&app, &mut d, source, "MMMMMMMMMCCCCCCCCC").await;
    assert_eq!(finish["status"], "applied");
    assert_eq!(finish["outcome"], "descended");
    assert_eq!(finish["new_quiz_question_count"], 9);
    let after = before + attempt_bytes() + level_bytes(9, false);
    assert_eq!(used(&app, user).await, after);
    assert_storage_consistent(&app, user).await;
    // Another device's pull carries the cascade row with its new figure, over the limit.
    let (_, pages) = d.sibling(&app).sync_all(vec![]).await;
    let pulled = rows(&pages, "cascades");
    assert_eq!(pulled.len(), 1);
    assert_eq!(bytes_of(&pulled[0]), after);
    assert_eq!(pages[0]["storage"], json!({ "used": after, "limit": before }));
    // Creating is refused; studying goes on.
    let r = d.client.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "storage_limit");
    let level2: Uuid = sqlx::query_scalar("SELECT id FROM quizzes WHERE cascade_id = $1 AND level = 2").bind(cascade).fetch_one(app.db()).await.unwrap();
    let (finish, _) = play_and_finish(&app, &mut d, level2, "MCCCCCCCC").await;
    assert_eq!(finish["status"], "applied");
    assert!(used(&app, user).await > after);
    assert_storage_consistent(&app, user).await;
}

/// "Purging frees exactly what was counted": a cleared quiz purged through
/// sync, a trashed cascade purged through sync, and both through the purge
/// task; trashing and restoring change nothing. Each change to a cascade's
/// figure reaches the pull.
#[sqlx::test]
async fn purging_frees_exactly_what_was_counted(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    let (one, source) = make(&mut c).await;
    let (two, source_two) = make(&mut c).await;
    let mut d = Device::new(c);
    d.qrf = vec![one, two];
    d.sync_all(vec![]).await;
    // A Level 2 of six questions, then cleared to the Trash with no misses.
    let (_, l2) = play_and_finish(&app, &mut d, source, "MMMMMMCCCCCCCCCCCC").await;
    let (cleared, _) = play_and_finish(&app, &mut d, l2, "CCCCCC").await;
    assert_eq!(cleared["outcome"], "cleared");
    assert_storage_consistent(&app, user).await;
    let held = used(&app, user).await;

    // purge_quiz frees its level and its one attempt, and the cascade's row changes.
    let mut other = d.sibling(&app);
    other.cursor = d.cursor;
    let op = d.op("purge_quiz", json!({ "quiz_id": l2 }));
    assert_eq!(result(&d.sync(vec![op]).await, 0)["status"], "applied");
    assert_eq!(used(&app, user).await, held - level_bytes(6, false) - attempt_bytes());
    let (_, pages) = other.sync_all(vec![]).await;
    let pulled = rows(&pages, "cascades");
    assert_eq!(pulled.len(), 1, "the purge changed the cascade's figure, so its row travels");
    assert_eq!(bytes_of(&pulled[0]), used_by(&app, one).await);
    assert_storage_consistent(&app, user).await;

    // Trashing and restoring change nothing; purge_cascade frees the whole cascade.
    let held = used(&app, user).await;
    let one_bytes = used_by(&app, one).await;
    for t in ["trash_cascade", "restore_cascade", "trash_cascade"] {
        let op = d.op(t, json!({ "cascade_id": one }));
        assert_eq!(result(&d.sync(vec![op]).await, 0)["status"], "applied", "{t}");
        assert_eq!(used(&app, user).await, held, "{t}");
    }
    let op = d.op("purge_cascade", json!({ "cascade_id": one }));
    let r = d.sync(vec![op]).await;
    assert_eq!(result(&r, 0)["status"], "applied");
    assert_eq!(used(&app, user).await, held - one_bytes);
    assert_eq!(r.json()["storage"]["used"], held - one_bytes, "the response counts the push");
    assert_storage_consistent(&app, user).await;

    // The purge task: a cleared quiz past retention, then a trashed cascade.
    let (_, l2) = play_and_finish(&app, &mut d, source_two, "MMMCCCCCCCCCCCCCCC").await;
    let (cleared, _) = play_and_finish(&app, &mut d, l2, "CCC").await;
    assert_eq!(cleared["outcome"], "cleared");
    let held = used(&app, user).await;
    sqlx::query("UPDATE quizzes SET cleared_at = now() - interval '31 days' WHERE status = 'cleared'").execute(app.db()).await.unwrap();
    acrodont::purge::purge_trash(&app.state).await.unwrap();
    assert_eq!(used(&app, user).await, held - level_bytes(3, false) - attempt_bytes());
    assert_storage_consistent(&app, user).await;
    let (_, pages) = d.sync_all(vec![]).await;
    assert_eq!(rows(&pages, "cascades").len(), 1, "the purge task's change reaches the pull");
    sqlx::query("UPDATE cascades SET trashed_at = now() - interval '31 days'").execute(app.db()).await.unwrap();
    acrodont::purge::purge_trash(&app.state).await.unwrap();
    assert_eq!(count(&app, "cascades").await, 0);
    assert_eq!(used(&app, user).await, 0);
}

async fn make(c: &mut Client<'_>) -> (Uuid, Uuid) {
    let r = c.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let j = r.json();
    (j["cascade"]["id"].as_str().unwrap().parse().unwrap(), j["source_quiz"]["id"].as_str().unwrap().parse().unwrap())
}

async fn used_by(app: &TestApp, cascade: Uuid) -> i64 {
    sqlx::query_scalar("SELECT storage_bytes FROM cascades WHERE id = $1").bind(cascade).fetch_one(app.db()).await.unwrap()
}

/// The purge task recounts each user's total and corrects drift.
#[sqlx::test]
async fn the_purge_task_recounts_drift(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let user = c.user_id.unwrap();
    assert_eq!(c.post("/api/cascades", body("EN-FIX", "anagram", length(7, 7))).await.status, StatusCode::CREATED);
    let right = used(&app, user).await;
    sqlx::query("UPDATE users SET storage_bytes = storage_bytes + 12345 WHERE id = $1").bind(user).execute(app.db()).await.unwrap();
    assert_eq!(acrodont::purge::recount_storage(&app.state).await.unwrap(), 1);
    assert_eq!(used(&app, user).await, right);
    assert_eq!(acrodont::purge::recount_storage(&app.state).await.unwrap(), 0, "nothing left to correct");
    assert!(acrodont::purge::run_once(&app.state).await.unwrap());
}

/// `question_rows_for` is a protocol bound of 1,000 cascades, not the account's
/// holdings: 1,000 is answered, 1,001 is a `400` (`tests/sync.rs`).
#[sqlx::test]
async fn question_rows_for_holds_a_thousand_cascades(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut d = Device::new(app.signed_in("alice").await);
    d.qrf = (0..acrodont::config::MAX_QUESTION_ROWS_FOR).map(|_| Uuid::new_v4()).collect();
    assert_eq!(d.sync(vec![]).await.status, StatusCode::OK);
    d.qrf.push(Uuid::new_v4());
    assert_eq!(d.sync(vec![]).await.status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/// A distribution of A–Z, nine of each.
fn distribution_csv() -> String {
    let mut s = String::from("?,?,2,0,0\n");
    for c in 'A'..='Z' {
        let vowel = u8::from("AEIOU".contains(c));
        s.push_str(&format!("{c},{},9,1,{vowel}\n", c.to_ascii_lowercase()));
    }
    s
}

/// The first `n` sets of eight distinct letters, each its own alphagram.
fn eight_letter_words(n: usize) -> Vec<String> {
    let k = 8;
    let mut idx: Vec<usize> = (0..k).collect();
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        out.push(idx.iter().map(|&i| (b'A' + i as u8) as char).collect());
        let mut i = k;
        while i > 0 && idx[i - 1] == 26 - k + i - 1 {
            i -= 1;
        }
        idx[i - 1] += 1;
        for j in i..k {
            idx[j] = idx[j - 1] + 1;
        }
    }
    out
}

/// The tables a cascade's rows live in, each with the rows of one cascade.
const TABLES: [(&str, &str); 7] = [
    ("cascades", "id = $1"),
    ("quizzes", "cascade_id = $1"),
    ("quiz_cards", "quiz_id IN (SELECT id FROM quizzes WHERE cascade_id = $1)"),
    ("quiz_attempts", "quiz_id IN (SELECT id FROM quizzes WHERE cascade_id = $1)"),
    ("search_specs", "id = (SELECT spec_id FROM cascades WHERE id = $1)"),
    ("search_groups", "spec_id = (SELECT spec_id FROM cascades WHERE id = $1)"),
    ("search_conditions", "spec_id = (SELECT spec_id FROM cascades WHERE id = $1)"),
];

async fn total_size(app: &TestApp, tables: &[String]) -> i64 {
    let mut n = 0;
    for t in tables {
        let s: i64 = sqlx::query_scalar("SELECT pg_total_relation_size($1::regclass)").bind(t).fetch_one(app.db()).await.unwrap();
        n += s;
    }
    n
}

/// Grades every question of a quiz in the database as a study session would:
/// in play order, a few seconds apart with breaks, a sync's sequence for each grade (a
/// device online syncs after every one), every other one missed.
async fn grade_half_missed(app: &TestApp, quiz: Uuid) {
    let order = common::sync::positions(app, quiz).await;
    let pos: std::collections::HashMap<u32, usize> = order.iter().enumerate().map(|(p, &i)| (i as u32, p)).collect();
    let device = Uuid::new_v4();
    let start = chrono::Utc::now();
    let mut conn = app.db().acquire().await.unwrap();
    // 1.5 to 9 seconds a question, unevenly, and a break of some hours every 400.
    let mut at_ms = Vec::with_capacity(order.len());
    let mut t = 0i64;
    for p in 0..order.len() as i64 {
        t += 1_500 + (p * 7_919) % 7_500 + if p % 400 == 399 { 3_600_000 + (p * 104_729) % 80_000_000 } else { 0 };
        at_ms.push(t);
    }
    for mut c in acrodont::cards::load(&mut conn, quiz).await.unwrap() {
        for slot in 0..c.len() {
            let p = pos[&c.idx(slot)];
            let g = if p.is_multiple_of(2) { Grade::Correct } else { Grade::Missed };
            c.set(slot, g, start + chrono::Duration::milliseconds(at_ms[p]), 1_000 + p as i64, device);
        }
        acrodont::cards::store(&mut conn, &c).await.unwrap();
    }
    sqlx::query(
        "UPDATE quizzes SET correct_count = (SELECT count(*) FROM quiz_questions WHERE quiz_id = $1 AND grade = 'correct'),
                            missed_count = (SELECT count(*) FROM quiz_questions WHERE quiz_id = $1 AND grade = 'missed')
         WHERE id = $1",
    )
    .bind(quiz)
    .execute(app.db())
    .await
    .unwrap();
}

/// PLAN.md § Storage limit: the formula stays within ±20% of what Postgres
/// measures for a realistic cascade, and never counts the packed levels as
/// less than they take, so a schema change that makes rows bigger fails here
/// instead of quietly under-counting.
///
/// A 20,000-question anagram cascade made from a 20,000-entry In Word List,
/// studied through two finishes with half missed (Levels 2 and 3, each
/// finish's attempt row), and then every level graded, since the formula
/// counts a question at its graded size. Its live rows are then copied
/// into fresh tables made `LIKE … INCLUDING ALL` (every index), and
/// `pg_total_relation_size` of the copies is the measurement: the rows the
/// account holds, without the dead row versions studying leaves for vacuum,
/// which the formula deliberately does not count.
#[sqlx::test]
async fn the_formula_is_within_20_percent_of_what_postgres_measures(pool: sqlx::PgPool) {
    const N: usize = 20_000;
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut admin = app.signed_in("root").await;
    app.make_admin("root").await;
    let r = admin.upload("/api/admin/letter-distributions", &[("name", "calib")], "calib.csv", distribution_csv().as_bytes()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let words = eight_letter_words(N);
    let tsv: String = words.iter().enumerate().map(|(i, w)| format!("{w}\t{}\tword {i}\n", 1 + i % 500)).collect();
    let r = admin
        .upload("/api/admin/lexicons", &[("name", "CALIB"), ("letter_distribution", "calib")], "CALIB.tsv", tsv.as_bytes())
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    app.reconcile().await;

    let real: Vec<String> = TABLES.iter().map(|(t, _)| (*t).to_owned()).collect();
    let before = total_size(&app, &real).await;
    let filters = json!({ "op": "and", "children": [{ "type": "in_word_list", "negated": false, "entries": words }] });
    let r = admin.post("/api/cascades", body("CALIB", "anagram", filters)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let cascade: Uuid = r.json()["cascade"]["id"].as_str().unwrap().parse().unwrap();
    let mut quiz: Uuid = r.json()["source_quiz"]["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(r.json()["cascade"]["question_count"], N);
    let user = admin.user_id.unwrap();
    let mut d = Device::new(admin);
    d.sync_all(vec![]).await;
    let mut levels = vec![quiz];
    for _ in 0..2 {
        grade_half_missed(&app, quiz).await;
        let (f, new) = common::sync::finish_op(&app, &mut d, quiz, "777").await;
        let r = d.sync(vec![f]).await;
        assert_eq!(result(&r, 0)["outcome"], "descended", "{:?}", r.json());
        quiz = new;
        levels.push(quiz);
    }
    // Every level graded: what the formula counts a level at.
    for q in levels {
        grade_half_missed(&app, q).await;
    }
    let formula = assert_storage_consistent(&app, user).await;
    let grown = total_size(&app, &real).await - before;

    // The live rows, copied into fresh tables with every index.
    let mut measured = 0;
    let mut cards_measured = 0;
    let mut lines = Vec::new();
    for (table, filter) in TABLES {
        let copy = format!("calib_{table}");
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TABLE {copy} (LIKE {table} INCLUDING ALL)"))).execute(app.db()).await.unwrap();
        let empty = total_size(&app, std::slice::from_ref(&copy)).await;
        let n = sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO {copy} SELECT * FROM {table} WHERE {filter}")))
            .bind(cascade)
            .execute(app.db())
            .await
            .unwrap()
            .rows_affected();
        let size = total_size(&app, std::slice::from_ref(&copy)).await - empty;
        if table == "quiz_cards" {
            cards_measured = size;
        }
        lines.push(format!("{table}: {n} rows, {size} bytes ({:.0} a row)", size as f64 / n.max(1) as f64));
        measured += size;
    }
    let ratio = formula as f64 / measured as f64;
    println!(
        "storage calibration: formula {formula} bytes, live rows measured {measured} bytes (formula/measured {ratio:.3}); \
         the tables grew {grown} bytes, dead row versions included\n  {}",
        lines.join("\n  ")
    );
    assert!((0.8..=1.2).contains(&ratio), "formula {formula} against measured {measured}: {ratio:.3}");
    // The levels on their own: the packed chunks compress, so the formula,
    // which counts a fixed size for each question, may count more than
    // Postgres stores, but never less, and not more than twice as much.
    let (chunks, cards, indexed): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*), coalesce(sum(n), 0)::int8, coalesce(sum(n) FILTER (WHERE idxs IS NOT NULL), 0)::int8
         FROM quiz_cards WHERE quiz_id IN (SELECT id FROM quizzes WHERE cascade_id = $1)",
    )
    .bind(cascade)
    .fetch_one(app.db())
    .await
    .unwrap();
    let b = ROW_BYTES;
    let counted = chunks * b.chunk_row + cards * b.card + indexed * b.card_idx;
    let r = counted as f64 / cards_measured as f64;
    println!("levels: formula {counted} bytes, measured {cards_measured} bytes ({r:.3})");
    assert!((1.0..=2.0).contains(&r), "levels: formula {counted} against measured {cards_measured}: {r:.3}");
}
