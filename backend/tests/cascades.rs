//! PLAN.md § API → Cascades and sync (`POST /api/cascades`, start-over, card
//! pages) and § Integration tests (creation for all three types, options,
//! idempotent ids, search before the transaction, word-list totals, card
//! pages with `keys=1`, account binding). The storage limit and its races are
//! `tests/storage.rs`.

mod common;

use std::time::Duration;

use axum::http::{header, StatusCode};
use common::{Client, TestApp};
use serde_json::{json, Value};
use uuid::Uuid;
use acrodont::cascade::order::{from_i64, questions_hash, shuffle};

fn length(min: i64, max: i64) -> Value {
    json!({ "type": "length", "negated": false, "min": min, "max": max })
}

fn body(lexicon: &str, quiz_type: &str, filters: Value) -> Value {
    json!({
        "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
        "at": "2026-01-01T00:00:00Z", "name": "A cascade", "lexicon": lexicon, "quiz_type": quiz_type,
        "clear_threshold": 80, "segment_size": 0, "progression": "ladder", "require_alphabetical": false, "answer_mode": "flashcard",
        "filters": filters,
    })
}

fn sevens() -> Value {
    json!({ "op": "and", "children": [length(7, 7)] })
}

async fn count(app: &TestApp, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
        .fetch_one(app.db())
        .await
        .unwrap()
}

#[sqlx::test]
async fn creation_for_all_three_types(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    for (quiz_type, lexicon, filters, expected) in [
        ("anagram", "EN-FIX", sevens(), 18),
        ("definition", "EN-FIX", sevens(), 26),
        ("leave_value", "EN-FIX", json!({ "op": "and", "children": [
            { "type": "leave_value", "negated": false, "min": 30.0, "max": null } ] }), 4),
    ] {
        let b = body(lexicon, quiz_type, filters);
        let r = c.post("/api/cascades", b.clone()).await;
        assert_eq!(r.status, StatusCode::CREATED, "{quiz_type}: {:?}", r.json());
        let j = r.json();
        let cascade = &j["cascade"];
        let source = &j["source_quiz"];
        assert_eq!(cascade["id"], b["id"]);
        assert_eq!(cascade["quiz_type"], quiz_type);
        assert_eq!(cascade["lexicon"], "EN-FIX");
        assert_eq!(cascade["letter_distribution"], "english");
        assert_eq!(cascade["question_count"], expected);
        assert_eq!(cascade["depth"], 1);
        assert_eq!(cascade["options_device_id"], b["device_id"]);
        assert!(cascade["updated_seq"].is_string() && j["sync_seq"].is_string());
        assert_eq!(source["id"], b["source_quiz_id"]);
        assert_eq!(source["level"], 1);
        assert_eq!(source["origin"], "source");
        assert_eq!(source["attempt"], 1);
        // The seed and hash travel as unsigned decimal text.
        let seed: u64 = source["shuffle_seed"].as_str().unwrap().parse().unwrap();
        let hash: u64 = source["questions_hash"].as_str().unwrap().parse().unwrap();
        let idx: Vec<u32> = (0..expected).collect();
        assert_eq!(hash, questions_hash(&idx));
        // The Source quiz holds every idx 0…count−1, ungraded; its order comes
        // from the shared shuffle over them with the seed.
        let rows: Vec<(i32, Option<String>)> = sqlx::query_as(
            "SELECT question_idx, grade::text FROM quiz_questions WHERE quiz_id = $1 ORDER BY question_idx",
        )
        .bind(Uuid::parse_str(source["id"].as_str().unwrap()).unwrap())
        .fetch_all(app.db())
        .await
        .unwrap();
        assert_eq!(rows.iter().map(|r| r.0 as u32).collect::<Vec<_>>(), idx);
        assert!(rows.iter().all(|r| r.1.is_none()));
        assert_eq!(shuffle(&idx, seed).len(), idx.len());
        // The stored i64 reads back as the same u64.
        let stored: i64 = sqlx::query_scalar("SELECT shuffle_seed FROM quizzes WHERE id = $1")
            .bind(Uuid::parse_str(source["id"].as_str().unwrap()).unwrap())
            .fetch_one(app.db())
            .await
            .unwrap();
        assert_eq!(from_i64(stored), seed);
        // The question index is in alphabetical order of the key.
        let text: String = sqlx::query_scalar("SELECT question_keys FROM cascades WHERE id = $1")
            .bind(Uuid::parse_str(b["id"].as_str().unwrap()).unwrap())
            .fetch_one(app.db())
            .await
            .unwrap();
        let keys = acrodont::cascade::routes::split_keys(&text);
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
        // The spec is stored with the request's quiz_type.
        let q: String = sqlx::query_scalar(
            "SELECT p.quiz_type::text FROM cascades c JOIN search_specs p ON p.id = c.spec_id WHERE c.id = $1",
        )
        .bind(Uuid::parse_str(b["id"].as_str().unwrap()).unwrap())
        .fetch_one(app.db())
        .await
        .unwrap();
        assert_eq!(q, quiz_type);
    }
}

/// "creating a cascade with each combination of quiz options, and the Source
/// quiz carrying the copy".
#[sqlx::test]
async fn every_combination_of_quiz_options(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    for seg in [0, 5, 40] {
        for prog in ["ladder", "drill"] {
            for alpha in [false, true] {
                let mut b = body("EN-FIX", "anagram", sevens());
                b["segment_size"] = json!(seg);
                b["progression"] = json!(prog);
                b["require_alphabetical"] = json!(alpha);
                let r = c.post("/api/cascades", b).await;
                assert_eq!(r.status, StatusCode::CREATED);
                let j = r.json();
                for row in [&j["cascade"], &j["source_quiz"]] {
                    assert_eq!(row["segment_size"], seg);
                    assert_eq!(row["progression"], prog);
                    assert_eq!(row["require_alphabetical"], alpha);
                }
            }
        }
    }
    // Answer mode is the cascade's own, as the request gives it, and required like the options.
    for mode in ["flashcard", "typed"] {
        let mut b = body("EN-FIX", "anagram", sevens());
        b["answer_mode"] = json!(mode);
        assert_eq!(c.post("/api/cascades", b).await.json()["cascade"]["answer_mode"], mode);
    }
    let mut b = body("EN-FIX", "anagram", sevens());
    b.as_object_mut().unwrap().remove("answer_mode");
    assert_eq!(c.post("/api/cascades", b).await.status, StatusCode::BAD_REQUEST);
    // The threshold and the three options are required; a bad value is a field error.
    let mut b = body("EN-FIX", "anagram", sevens());
    b["segment_size"] = json!(4);
    assert_eq!(c.post("/api/cascades", b).await.json()["errors"][0]["field"], "segment_size");
    let mut b = body("EN-FIX", "anagram", sevens());
    b.as_object_mut().unwrap().remove("progression");
    assert_eq!(c.post("/api/cascades", b).await.status, StatusCode::BAD_REQUEST);
}

/// Puts the account exactly at its storage limit, through the per-account
/// override.
async fn fill_to_the_limit(app: &TestApp, user: &str) {
    sqlx::query("UPDATE users SET storage_limit_bytes = storage_bytes WHERE username = $1")
        .bind(user)
        .execute(app.db())
        .await
        .unwrap();
}

/// "A repeated `POST /api/cascades` or start-over with the same `id` returns
/// the existing cascade and takes no second share of storage; an `id` held by
/// another user is refused."
#[sqlx::test]
async fn creation_is_idempotent_by_device_minted_ids(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let b = body("EN-FIX", "anagram", sevens());
    let first = c.post("/api/cascades", b.clone()).await;
    assert_eq!(first.status, StatusCode::CREATED);
    fill_to_the_limit(&app, "root").await;
    let again = c.post("/api/cascades", b.clone()).await;
    assert_eq!(again.status, StatusCode::OK, "at the limit, the retry is still answered");
    assert_eq!(again.json()["cascade"], first.json()["cascade"]);
    assert_eq!(again.json()["source_quiz"], first.json()["source_quiz"]);
    assert_eq!(count(&app, "cascades").await, 1);
    let mut bob = app.signed_in("bob").await;
    let r = bob.post("/api/cascades", b.clone()).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    // A source_quiz_id held by another user's cascade is refused too.
    let mut b2 = body("EN-FIX", "anagram", sevens());
    b2["source_quiz_id"] = b["source_quiz_id"].clone();
    assert_eq!(bob.post("/api/cascades", b2).await.status, StatusCode::CONFLICT);
    // Start over, repeated with the same id, with room for it.
    sqlx::query("UPDATE users SET storage_limit_bytes = NULL").execute(app.db()).await.unwrap();
    let mut c2 = Client::new(&app, "203.0.113.1");
    c2.cookies = c.cookies.clone();
    c2.user_id = c.user_id;
    let so = json!({ "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
                     "at": "2026-01-01T00:00:00Z" });
    let path = format!("/api/cascades/{}/start-over", b["id"].as_str().unwrap());
    let r1 = c2.post(&path, so.clone()).await;
    assert_eq!(r1.status, StatusCode::CREATED, "{:?}", r1.json());
    let used: i64 = sqlx::query_scalar("SELECT storage_bytes FROM users WHERE username = 'root'").fetch_one(app.db()).await.unwrap();
    let r2 = c2.post(&path, so).await;
    assert_eq!(r2.status, StatusCode::OK);
    assert_eq!(count(&app, "cascades").await, 2);
    let after: i64 = sqlx::query_scalar("SELECT storage_bytes FROM users WHERE username = 'root'").fetch_one(app.db()).await.unwrap();
    assert_eq!(after, used, "the retry is counted once");
}

#[sqlx::test]
async fn start_over_copies_the_spec_threshold_options_and_settings(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let mut b = body("EN-FIX", "leave_value", json!({ "op": "and", "children": [
        { "type": "leave_value", "negated": false, "min": 30.0, "max": null },
        { "type": "in_word_list", "negated": false, "entries": ["?EIRS", "??"] } ] }));
    b["name"] = json!("Blank leaves");
    b["clear_threshold"] = json!(90);
    b["segment_size"] = json!(5);
    b["progression"] = json!("drill");
    let r = c.post("/api/cascades", b.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    // A new cascade's settings take their defaults.
    let o = r.json()["cascade"].clone();
    assert_eq!(
        (&o["show_definitions"], &o["show_hooks"], &o["reveal_correct"], &o["leave_value_decimals"]),
        (&json!(true), &json!(true), &json!(true), &json!(0)),
    );
    sqlx::query(
        "UPDATE cascades SET show_definitions = false, show_hooks = false, reveal_correct = false,
                             leave_value_decimals = 3, show_probability = true, definition_column = false",
    )
    .execute(app.db())
    .await
    .unwrap();
    let so = json!({ "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
                     "at": "2026-01-01T00:00:00Z" });
    let r = c.post(&format!("/api/cascades/{}/start-over", b["id"].as_str().unwrap()), so).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let n = r.json()["cascade"].clone();
    assert_eq!(
        (&n["show_definitions"], &n["show_hooks"], &n["reveal_correct"], &n["leave_value_decimals"]),
        (&json!(false), &json!(false), &json!(false), &json!(3)),
    );
    assert_eq!(
        (&n["show_probability"], &n["definition_column"]),
        (&json!(true), &json!(false)),
        "Start over copies the probability and definition column settings too"
    );
    assert_eq!(n["name"], "Blank leaves");
    assert_eq!(n["clear_threshold"], 90);
    assert_eq!(n["segment_size"], 5);
    assert_eq!(n["progression"], "drill");
    assert_eq!(n["question_count"], 2);
    // A private copy of the spec, quiz_type included.
    let specs: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT p.id, p.quiz_type::text FROM cascades c JOIN search_specs p ON p.id = c.spec_id",
    )
    .fetch_all(app.db())
    .await
    .unwrap();
    assert_eq!(specs.len(), 2);
    assert_ne!(specs[0].0, specs[1].0);
    assert!(specs.iter().all(|s| s.1 == "leave_value"));
    // And the same storage: the same rows.
    assert_eq!(n["storage_bytes"], o["storage_bytes"]);
    // At the limit, Start over is refused.
    fill_to_the_limit(&app, "root").await;
    let so = json!({ "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
                     "at": "2026-01-01T00:00:00Z" });
    let r = c.post(&format!("/api/cascades/{}/start-over", b["id"].as_str().unwrap()), so).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "storage_limit");
}

#[sqlx::test]
async fn names_are_one_to_two_hundred_scalar_values(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    for (name, ok) in [("", false), (&*"ö".repeat(201), false), (&*"ö".repeat(200), true)] {
        let mut b = body("EN-FIX", "anagram", sevens());
        b["name"] = json!(name);
        let r = c.post("/api/cascades", b).await;
        if ok {
            assert_eq!(r.status, StatusCode::CREATED);
        } else {
            assert_eq!(r.status, StatusCode::BAD_REQUEST);
            assert_eq!(r.json()["errors"][0]["field"], "name");
        }
    }
    let mut b = body("EN-FIX", "anagram", sevens());
    b.as_object_mut().unwrap().remove("name");
    assert_eq!(c.post("/api/cascades", b).await.status, StatusCode::BAD_REQUEST);
}

/// A search with no rows is the whole lexicon; one row over a filter's whole
/// range is as valid. The cap on questions still applies to both.
#[sqlx::test]
async fn a_search_with_no_rows_or_a_whole_range_is_everything(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let r = c.post("/api/cascades", body("EN-FIX", "definition", json!({ "op": "and", "children": [] }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["source_quiz"]["question_count"], 154);
    let whole = json!({ "op": "and", "children": [{ "type": "length", "negated": false, "min": 1, "max": 15 }] });
    let r = c.post("/api/cascades", body("EN-FIX", "definition", whole)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["source_quiz"]["question_count"], 154);
}

#[sqlx::test]
async fn empty_and_over_cap_searches_are_422(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("MAX_QUIZ_QUESTIONS", "10")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let r = c
        .post("/api/cascades", body("EN-FIX", "definition", json!({ "op": "and", "children": [
            { "type": "anagram_match", "negated": false, "pattern": "Z Z Z" } ] })))
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = c.post("/api/cascades", body("EN-FIX", "definition", sevens())).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.json()["count"], 26);
    assert_eq!(count(&app, "cascades").await, 0);
}

/// "a 300,000-entry In Word List accepted under `API_MAX_BODY_BYTES` while
/// eight rows of 250,000 entries are refused with a field error on the row
/// that crosses the tree's 300,000 total, on creation and on preview alike,
/// with nothing written".
#[sqlx::test]
async fn word_list_totals_on_creation_and_preview(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let mut entries: Vec<String> = vec!["RETAINS".into()];
    let letters: Vec<char> = ('A'..='Z').collect();
    let mut i = 0usize;
    while entries.len() < 300_000 {
        let mut x = i;
        let mut w = String::from("Z");
        for _ in 0..4 {
            w.push(letters[x % 26]);
            x /= 26;
        }
        entries.push(w);
        i += 1;
    }
    entries.sort();
    let big = json!({ "op": "and", "children": [{ "type": "in_word_list", "negated": false, "entries": entries }] });
    let r = c.post("/api/cascades", body("EN-FIX", "definition", big)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["cascade"]["question_count"], 1);
    let stored: i64 = sqlx::query_scalar(
        "SELECT coalesce(sum(length(entries) - length(replace(entries, E'\\n', ''))), 0)::int8 FROM search_conditions",
    )
    .fetch_one(app.db())
    .await
    .unwrap();
    assert_eq!(stored, 300_000, "every entry stored, one per line");

    let eight: Vec<Value> = (0..8)
        .map(|_| json!({ "type": "in_word_list", "negated": false, "entries": vec!["QI"; 250_000] }))
        .collect();
    let tree = json!({ "op": "and", "children": eight });
    let before = count(&app, "search_specs").await;
    for path in ["/api/cascades", "/api/search/preview"] {
        let b = if path == "/api/cascades" {
            body("EN-FIX", "definition", tree.clone())
        } else {
            json!({ "lexicon": "EN-FIX", "quiz_type": "definition", "filters": tree.clone() })
        };
        let r = c.post(path, b).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{path}");
        let e = &r.json()["errors"][0];
        assert_eq!(e["path"], json!([1]), "{path}");
        assert_eq!(e["field"], "entries");
    }
    assert_eq!(count(&app, "search_specs").await, before, "nothing written");
}

/// "A cascade creation runs its search before opening a transaction: with a
/// slow search, the purge task for the same user acquires that user's row
/// while the search is still running, and neither blocks the other; a
/// creation from an account at its storage limit is refused before the search
/// runs at all, and one that loses the race for the last space after searching
/// is refused with `409`." The limit holds either cascade, not both.
#[sqlx::test]
async fn the_search_runs_before_the_transaction(pool: sqlx::PgPool) {
    let app = TestApp::with(
        pool,
        &[("SEARCH_CONCURRENCY", "1"), ("SEARCH_TIMEOUT_MS", "20000"), ("MAX_STORAGE_BYTES_PER_USER", "3000")],
    )
    .await;
    let c = app.seed_fixture_catalog("root").await;
    let user_id = c.user_id.unwrap();
    // A slow search: the only permit is held, so both creations wait inside
    // their search, after the cheap limit check and before any transaction.
    let held = app.state.search_permits.clone().acquire_owned().await.unwrap();
    let router = app.router.clone();
    let make = |b: Value| {
        let mut cl = Client::new(&app, "203.0.113.1");
        cl.cookies = c.cookies.clone();
        cl.user_id = c.user_id;
        let req = axum::http::Request::post("/api/cascades")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cl.cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; "))
            .header("x-csrf-token", cl.csrf().unwrap().clone())
            .header("x-acrodont-user", user_id.to_string())
            .body(axum::body::Body::from(b.to_string()))
            .unwrap();
        let r = router.clone();
        tokio::spawn(async move {
            use tower::ServiceExt;
            let mut req = req;
            req.extensions_mut().insert(axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 1))));
            r.oneshot(req).await.unwrap().status()
        })
    };
    let one = make(body("EN-FIX", "anagram", sevens()));
    let two = make(body("EN-FIX", "definition", sevens()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The purge task's lock on the user's row is not blocked by the searches.
    let mut tx = app.db().begin().await.unwrap();
    let locked = tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT").bind(user_id).execute(&mut *tx),
    )
    .await;
    assert!(matches!(locked, Ok(Ok(_))), "the user's row is free while the searches run");
    tx.rollback().await.unwrap();
    drop(held);
    let mut statuses = [one.await.unwrap(), two.await.unwrap()];
    statuses.sort();
    // One wins; the other loses the limit race after searching.
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    // At the limit, a creation is refused before its search: with the permit
    // held it answers 409 at once, not 503.
    fill_to_the_limit(&app, "root").await;
    let _held = app.state.search_permits.clone().acquire_owned().await.unwrap();
    let mut cl = Client::new(&app, "203.0.113.1");
    cl.cookies = c.cookies.clone();
    cl.user_id = c.user_id;
    let r = tokio::time::timeout(Duration::from_secs(2), cl.post("/api/cascades", body("EN-FIX", "anagram", sevens())))
        .await
        .expect("answered without waiting for a permit");
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "storage_limit");
    assert_eq!(r.json()["needed"], 0, "not known before the search");
}

// ---------------------------------------------------------------------------
// Card pages
// ---------------------------------------------------------------------------

async fn create(c: &mut Client<'_>, lexicon: &str, quiz_type: &str, filters: Value) -> String {
    let r = c.post("/api/cascades", body(lexicon, quiz_type, filters)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    r.json()["cascade"]["id"].as_str().unwrap().to_owned()
}

#[sqlx::test]
async fn card_pages(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let id = create(&mut c, "EN-FIX", "anagram", sevens()).await;
    let r = c.get(&format!("/api/cascades/{id}/cards?from=0&limit=10000")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "private, no-store");
    let cards = r.json();
    assert_eq!(cards.as_array().unwrap().len(), 18);
    let aeinrst = cards.as_array().unwrap().iter().find(|c| c["key"] == "AEINRST").unwrap();
    let words: Vec<&str> = aeinrst["answer"].as_array().unwrap().iter().map(|w| w["word"].as_str().unwrap()).collect();
    assert_eq!(words, ["ANESTRI", "ANTSIER", "NASTIER", "RATINES", "RETAINS", "RETINAS", "RETSINA", "STAINER", "STEARIN"]);
    assert!(aeinrst["answer"][0].get("front_hooks").is_none() && aeinrst["answer"][0].get("definition").is_none());
    assert!(aeinrst["answer"][0].get("probability_order").is_none(), "the probability order comes with the hooks");
    // With hooks and definitions.
    let r = c.get(&format!("/api/cascades/{id}/cards?from=0&limit=18&hooks=1&definitions=1")).await;
    let card = r.json().as_array().unwrap().iter().find(|c| c["key"] == "AEINRST").unwrap().clone();
    assert!(card["answer"][0]["definition"].is_string());
    assert_eq!(card["answer"][0]["front_hooks"], "");
    assert!(card["answer"][0]["probability_order"].as_u64().is_some_and(|p| p >= 1), "{card}");
    // With hooks, each word says whether it has a front and a back inner hook.
    assert!(card["answer"][0]["front_inner"].is_boolean() && card["answer"][0]["back_inner"].is_boolean());
    // keys=1: `{ from, keys }`, the same keys in the same order as the full form.
    let r = c.get(&format!("/api/cascades/{id}/cards?from=2&limit=100000&keys=1")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "private, no-store");
    let k = r.json();
    assert_eq!(k["from"], 2);
    let full: Vec<Value> = cards.as_array().unwrap()[2..].iter().map(|c| c["key"].clone()).collect();
    assert_eq!(k["keys"], Value::Array(full));
    assert!(k["keys"][0].is_string(), "no per-row index");
    // Limits and refusals.
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=100001&keys=1")).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=10001")).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5&keys=1&hooks=1")).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5&keys=1&definitions=0")).await.status, StatusCode::BAD_REQUEST);
    // idx=: the cards named, in idx order, the same as their range form.
    let r = c.get(&format!("/api/cascades/{id}/cards?idx=7,2,15&hooks=1")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "private, no-store");
    let listed = r.json();
    let idx: Vec<i64> = listed.as_array().unwrap().iter().map(|c| c["idx"].as_i64().unwrap()).collect();
    assert_eq!(idx, [2, 7, 15]);
    for card in listed.as_array().unwrap() {
        let i = card["idx"].as_u64().unwrap() as usize;
        assert_eq!(card["key"], cards[i]["key"]);
        assert!(card["answer"][0].get("front_hooks").is_some());
    }
    let many = (0..1001).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    for bad in ["idx=", "idx=1,x", "idx=-1", "idx=1&from=0", "idx=1&limit=5", "idx=1&keys=1"] {
        assert_eq!(c.get(&format!("/api/cascades/{id}/cards?{bad}")).await.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?idx={many}")).await.status, StatusCode::BAD_REQUEST);
    // Definition and Leave Value answers.
    let def = create(&mut c, "EN-FIX", "definition", json!({ "op": "and", "children": [
        { "type": "anagram_match", "negated": false, "pattern": "Q I" } ] })).await;
    let r = c.get(&format!("/api/cascades/{def}/cards?from=0&limit=5")).await;
    assert_eq!(r.json()[0]["answer"], "the vital force in Chinese thought [n -S]");
    assert!(r.json()[0].get("word").is_none(), "no hooks asked for");
    // With hooks, a Definition card carries its word's hooks and inner hooks; the answer stays the definition.
    let r = c.get(&format!("/api/cascades/{def}/cards?from=0&limit=5&hooks=1")).await;
    let card = &r.json()[0];
    assert_eq!(card["answer"], "the vital force in Chinese thought [n -S]");
    assert_eq!(card["word"]["word"], "QI");
    assert!(card["word"]["front_hooks"].is_string() && card["word"]["back_hooks"].is_string());
    assert!(card["word"]["probability_order"].as_u64().is_some_and(|p| p >= 1), "{card}");
    assert!(card["word"]["front_inner"].is_boolean() && card["word"]["back_inner"].is_boolean());
    let lv = create(&mut c, "EN-FIX", "leave_value", json!({ "op": "and", "children": [
        { "type": "leave_value", "negated": false, "min": 0.1, "max": 0.3 } ] })).await;
    let r = c.get(&format!("/api/cascades/{lv}/cards?from=0&limit=5")).await;
    let text = String::from_utf8(r.body.to_vec()).unwrap();
    assert!(text.contains(r#""answer":0.15"#) && text.contains(r#""answer":0.25"#), "{text}");
    // Another user's cascade is 404.
    let mut bob = app.signed_in("bob").await;
    assert_eq!(bob.get(&format!("/api/cascades/{id}/cards?from=0&limit=5")).await.status, StatusCode::NOT_FOUND);
}

/// Keys of 15-tile Catalan words run to tens of bytes each; the page's bytes
/// per key are recorded on that cascade and an English anagram one.
#[sqlx::test]
async fn key_page_bytes_are_measured(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let ca = create(&mut c, "CA-FIX", "definition", json!({ "op": "and", "children": [length(15, 15)] })).await;
    let en = create(&mut c, "EN-FIX", "anagram", json!({ "op": "and", "children": [length(2, 8)] })).await;
    for (label, id) in [("Catalan 15-tile Definition", ca), ("English anagram", en)] {
        let r = c.get(&format!("/api/cascades/{id}/cards?from=0&limit=100000&keys=1")).await;
        let n = r.json()["keys"].as_array().unwrap().len();
        let per_key = r.body.len() as f64 / n as f64;
        println!("{label}: {n} keys, {:.1} bytes per key", per_key);
        if label.starts_with("Catalan") {
            assert!(per_key > 20.0, "tens of bytes a key");
        }
    }
}

// ---------------------------------------------------------------------------
// Account binding and the download bucket
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn creation_and_card_pages_need_the_account_binding(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let id = create(&mut c, "EN-FIX", "anagram", sevens()).await;
    let alice = app.signed_in("alice").await;
    let mine = c.user_id;
    for header_user in [alice.user_id, None] {
        c.user_id = header_user;
        c.send_user_header = header_user.is_some();
        let before = count(&app, "cascades").await;
        assert_eq!(c.post("/api/cascades", body("EN-FIX", "anagram", sevens())).await.status, StatusCode::UNAUTHORIZED);
        assert_eq!(count(&app, "cascades").await, before, "nothing applied");
        assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5")).await.status, StatusCode::UNAUTHORIZED);
    }
    c.user_id = mine;
    c.send_user_header = true;
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5")).await.status, StatusCode::OK);
}

#[sqlx::test]
async fn card_pages_draw_on_the_download_bucket(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("DOWNLOAD_RATE_PER_MINUTE", "1")]).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let id = create(&mut c, "EN-FIX", "anagram", sevens()).await;
    assert_eq!(c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5&keys=1")).await.status, StatusCode::OK);
    let r = c.get(&format!("/api/cascades/{id}/cards?from=0&limit=5")).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.retry_after().is_some());
    // Spending one bucket leaves the others untouched.
    let r = c.post("/api/search/preview", json!({ "lexicon": "EN-FIX", "quiz_type": "anagram", "filters": sevens() })).await;
    assert_eq!(r.status, StatusCode::OK);
}

/// A cascade's answers, sorted.
async fn leave_answers(c: &mut Client<'_>, id: &str) -> Vec<f64> {
    let r = c.get(&format!("/api/cascades/{id}/cards?from=0&limit=10000")).await;
    assert_eq!(r.status, StatusCode::OK);
    let mut v: Vec<f64> = r.json().as_array().unwrap().iter().map(|k| k["answer"].as_f64().unwrap()).collect();
    v.sort_by(f64::total_cmp);
    v
}

#[sqlx::test]
async fn a_cascade_keeps_the_leave_values_it_was_built_on(pool: sqlx::PgPool) {
    let app = TestApp::new(pool).await;
    let mut c = app.seed_fixture_catalog("root").await;
    let over_30 = json!({ "op": "and", "children": [{ "type": "leave_value", "negated": false, "min": 30.0, "max": null }] });
    // Built before a second set exists: on the lexicon's one set.
    let first = create(&mut c, "EN-FIX", "leave_value", over_30.clone()).await;
    let old_answers = leave_answers(&mut c, &first).await;
    assert_eq!(old_answers.len(), 4);

    let r = c
        .upload("/api/admin/leave-sets", &[("lexicon", "EN-FIX"), ("name", "Gen 2")], "gen2.csv", b"?,1\nA,40\nE,45.5\n")
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    app.reconcile().await;

    // A search runs on the newest set unless it names another.
    let preview = |leave_set: Option<&str>| {
        let mut b = json!({ "lexicon": "EN-FIX", "quiz_type": "leave_value", "filters": over_30.clone() });
        if let Some(s) = leave_set {
            b["leave_set"] = json!(s);
        }
        b
    };
    let r = c.post("/api/search/preview", preview(None)).await;
    assert_eq!((r.status, r.json()["count"].as_i64()), (StatusCode::OK, Some(2)));
    let r = c.post("/api/search/preview", preview(Some("Gen 2"))).await;
    assert_eq!(r.json()["count"], 2);
    let r = c.post("/api/search/preview", preview(Some("EN-FIX-leaves"))).await;
    assert_eq!(r.json()["count"], 4);
    let r = c.post("/api/search/preview", preview(Some("Gen 3"))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["errors"][0]["field"], "leave_set");
    assert_eq!(r.json()["errors"][0]["message"], "EN-FIX has no leave values named Gen 3.");
    // The choice means nothing to the other quiz types.
    let r = c
        .post("/api/search/preview", json!({ "lexicon": "EN-FIX", "quiz_type": "anagram", "filters": sevens(), "leave_set": "Gen 3" }))
        .await;
    assert_eq!(r.status, StatusCode::OK);

    // New cascades: the newest by default, or the one named.
    let r = c.post("/api/cascades", body("EN-FIX", "leave_value", over_30.clone())).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["cascade"]["leave_set"], "Gen 2");
    assert_eq!(r.json()["cascade"]["question_count"], 2);
    let newest = r.json()["cascade"]["id"].as_str().unwrap().to_owned();
    assert_eq!(leave_answers(&mut c, &newest).await, [40.0, 45.5]);
    let mut b = body("EN-FIX", "leave_value", over_30.clone());
    b["leave_set"] = json!("EN-FIX-leaves");
    let r = c.post("/api/cascades", b).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["cascade"]["leave_set"], "EN-FIX-leaves");
    assert_eq!(r.json()["cascade"]["question_count"], 4);
    let mut b = body("EN-FIX", "leave_value", over_30.clone());
    b["leave_set"] = json!("Gen 3");
    assert_eq!(c.post("/api/cascades", b).await.status, StatusCode::BAD_REQUEST);
    let r = c.post("/api/cascades", body("EN-FIX", "anagram", sevens())).await;
    assert!(r.json()["cascade"]["leave_set"].is_null());

    // The cascade built first still answers, exports and starts over from its own set.
    assert_eq!(leave_answers(&mut c, &first).await, old_answers);
    let r = c
        .post(
            &format!("/api/cascades/{first}/export-token"),
            json!({ "scope": "cascade", "which": "all", "format": "txt", "lines": "answers", "order": "alphabetical", "decimals": 3 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let file = app.get(r.json()["url"].as_str().unwrap()).await;
    let mut exported: Vec<f64> = String::from_utf8(file.body.to_vec()).unwrap().lines().map(|l| l.parse().unwrap()).collect();
    exported.sort_by(f64::total_cmp);
    assert_eq!(exported, old_answers);
    let so = json!({ "id": Uuid::new_v4(), "source_quiz_id": Uuid::new_v4(), "device_id": Uuid::new_v4(),
                     "at": "2026-01-01T00:00:00Z" });
    let r = c.post(&format!("/api/cascades/{first}/start-over"), so).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["cascade"]["leave_set"], "EN-FIX-leaves");
    assert_eq!(r.json()["cascade"]["question_count"], 4);

    // Each set is in use by its own cascades only.
    let sets: Vec<(i32, String, i64)> = sqlx::query_as(
        "SELECT s.id, s.name, (SELECT count(*) FROM cascades c WHERE c.leave_set_id = s.id)
         FROM leave_sets s JOIN lexicons l ON l.id = s.lexicon_id WHERE l.name = 'EN-FIX' ORDER BY s.id",
    )
    .fetch_all(app.db())
    .await
    .unwrap();
    assert_eq!(sets.iter().map(|s| (s.1.as_str(), s.2)).collect::<Vec<_>>(), [("EN-FIX-leaves", 3), ("Gen 2", 1)]);
    let r = c.delete_empty(&format!("/api/admin/leave-sets/{}", sets[1].0)).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    sqlx::query("DELETE FROM cascades WHERE id = $1").bind(Uuid::parse_str(&newest).unwrap()).execute(app.db()).await.unwrap();
    let r = c.delete_empty(&format!("/api/admin/leave-sets/{}", sets[1].0)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    app.reconcile().await;
    // With the newer set gone, the older one is the default again.
    let r = c.post("/api/search/preview", preview(None)).await;
    assert_eq!(r.json()["count"], 4);
}
