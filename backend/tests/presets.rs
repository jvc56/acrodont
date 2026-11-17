//! Presets (PLAN.md § Settings → Presets): saved, replaced, renamed and
//! deleted online; every change bumps the account's version; a sync response
//! carries them all when the device's version differs, and not otherwise.

mod common;

use axum::http::StatusCode;
use common::sync::Device;
use common::TestApp;
use serde_json::{json, Value};
use uuid::Uuid;

fn preset(name: &str) -> Value {
    json!({ "name": name, "settings": { "question_size_px": 40, "mobile_buttons": "rows", "show_hooks": false },
            "clear_threshold": 95, "segment_size": 50, "progression": "drill" })
}

/// What a sync response says of the presets: its version, and the list when it carries one.
async fn synced(d: &mut Device<'_>, known: Option<&str>) -> (String, Option<Value>) {
    let body = json!({ "device_id": d.id, "app_version": 1, "cursor": d.cursor, "question_rows_for": [], "ops": [],
                       "presets_version": known });
    let r = d.raw_sync(body).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let b = r.json();
    (b["presets_version"].as_str().unwrap().to_owned(), b.get("presets").cloned())
}

#[sqlx::test]
async fn presets_are_saved_replaced_renamed_and_deleted(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut d = Device::new(app.signed_in("alice").await);
    let (v0, list) = synced(&mut d, None).await;
    assert_eq!(list, Some(json!([])), "a device that knows no version is sent the list, empty at first");
    assert_eq!(synced(&mut d, Some(&v0)).await.1, None, "a device with the account's version is sent none");

    let id = Uuid::new_v4();
    let r = d.client.put(&format!("/api/presets/{id}"), preset("Phone")).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v1 = r.json()["presets_version"].as_str().unwrap().to_owned();
    assert_ne!(v1, v0);
    let (v, list) = synced(&mut d, Some(&v0)).await;
    assert_eq!(v, v1);
    let list = list.expect("the version moved, so the list comes");
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["name"], "Phone");
    assert_eq!(list[0]["settings"]["mobile_buttons"], "rows");
    assert_eq!((list[0]["clear_threshold"].clone(), list[0]["segment_size"].clone(), list[0]["progression"].clone()), (json!(95), json!(50), json!("drill")));

    // Another preset under the same name is refused; the device asks, then replaces by id.
    let other = Uuid::new_v4();
    let r = d.client.put(&format!("/api/presets/{other}"), preset("Phone")).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "name_taken");
    let mut replaced = preset("Phone");
    replaced["clear_threshold"] = json!(80);
    let r = d.client.put(&format!("/api/presets/{id}"), replaced).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["preset"]["clear_threshold"], 80);

    // Defaults is the built-in preset's name, in any case; bad values are field errors.
    for (body, field) in [
        (preset("defaults"), "name"),
        (preset(" Defaults "), "name"),
        (preset(""), "name"),
        ({ let mut b = preset("A"); b["settings"] = json!({ "answer_mode": "spoken" }); b }, "settings"),
        ({ let mut b = preset("A"); b["clear_threshold"] = json!(0); b }, "clear_threshold"),
        ({ let mut b = preset("A"); b["segment_size"] = json!(3); b }, "segment_size"),
    ] {
        let r = d.client.put(&format!("/api/presets/{}", Uuid::new_v4()), body).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{field}: {:?}", r.json());
        assert_eq!(r.json()["errors"][0]["field"], field);
    }

    // Rename: to a free name, never to a taken one or to Defaults.
    let second = Uuid::new_v4();
    assert_eq!(d.client.put(&format!("/api/presets/{second}"), preset("Desk")).await.status, StatusCode::CREATED);
    let r = d.client.patch(&format!("/api/presets/{second}"), json!({ "name": "Phone" })).await;
    assert_eq!(r.json()["error"], "name_taken");
    let r = d.client.patch(&format!("/api/presets/{second}"), json!({ "name": "DEFAULTS" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = d.client.patch(&format!("/api/presets/{second}"), json!({ "name": "Laptop" })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["preset"]["name"], "Laptop");

    // Another account can neither see nor change them.
    let mut bob = Device::new(app.signed_in("bob").await);
    assert_eq!(synced(&mut bob, None).await.1, Some(json!([])));
    assert_eq!(bob.client.put(&format!("/api/presets/{id}"), preset("Mine")).await.status, StatusCode::CONFLICT);
    assert_eq!(bob.client.delete_empty(&format!("/api/presets/{id}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(bob.client.patch(&format!("/api/presets/{id}"), json!({ "name": "Mine" })).await.status, StatusCode::NOT_FOUND);

    // Delete: gone from the next list.
    let (v, _) = synced(&mut d, None).await;
    assert_eq!(d.client.delete_empty(&format!("/api/presets/{id}")).await.status, StatusCode::OK);
    let list = synced(&mut d, Some(&v)).await.1.unwrap();
    let names: Vec<&str> = list.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Laptop"]);
    assert_eq!(d.client.delete_empty(&format!("/api/presets/{id}")).await.status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn an_account_holds_at_most_fifty_presets(pool: sqlx::PgPool) {
    let app = TestApp::with(pool, &[("SYNC_RATE_PER_MINUTE", "100000")]).await;
    let mut c = app.signed_in("alice").await;
    let ids: Vec<Uuid> = (0..acrodont::presets::MAX_PRESETS).map(|_| Uuid::new_v4()).collect();
    for (i, id) in ids.iter().enumerate() {
        let r = c.put(&format!("/api/presets/{id}"), preset(&format!("P{i}"))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{i}");
    }
    let r = c.put(&format!("/api/presets/{}", Uuid::new_v4()), preset("One more")).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "preset_limit");
    // Replacing one is not a new one.
    assert_eq!(c.put(&format!("/api/presets/{}", ids[0]), preset("P0")).await.status, StatusCode::OK);
}
