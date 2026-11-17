//! A setting's changes as the server keeps them (PLAN.md § Settings → Where a
//! setting applies): an object of setting name to `{value, at}`, `at` being
//! when the change was made and a null value meaning the setting's default.
//! A cascade's `settings` holds the changes made for it on all devices, and
//! the account's `settings` those made for all cascades on all devices; each
//! is merged per setting, the later `at` winning. Which change a cascade on a
//! device uses is the frontend's to work out, as is what a value means. The
//! server checks only the names and the size, and the range of the few
//! settings whose values it also knows. Presets hold plain values (name to
//! value), checked the same way.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};

use super::rules::Reason;

/// At most this many settings on one cascade, each name this long, and this
/// many bytes of them: the same bounds as the account's shared settings.
pub const MAX_SETTINGS: usize = 64;
pub const MAX_NAME: usize = 40;
pub const MAX_BYTES: usize = 16 * 1024;

/// Whether any text in `v` holds a NUL, which Postgres stores in neither
/// text nor jsonb: a merge would fail on it instead of refusing it.
pub fn has_nul(v: &Value) -> bool {
    match v {
        Value::String(s) => s.contains('\0'),
        Value::Array(a) => a.iter().any(has_nul),
        Value::Object(m) => m.iter().any(|(k, e)| k.contains('\0') || has_nul(e)),
        _ => false,
    }
}

/// A setting's name: lower-case letters and underscores, 1–40 of them.
pub fn valid_name(k: &str) -> bool {
    !k.is_empty() && k.len() <= MAX_NAME && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// One change to a setting: `null` takes the cascade's own value away; a
/// value for a setting the server knows must be in its range.
pub fn check(name: &str, v: &Value) -> Result<(), Reason> {
    if !valid_name(name) || has_nul(v) {
        return Err(Reason::Invalid);
    }
    if v.is_null() {
        return Ok(());
    }
    let ok = match name {
        "answer_mode" => matches!(v.as_str(), Some("flashcard" | "typed")),
        "show_definitions" | "show_hooks" | "reveal_correct" | "show_found_count" | "show_probability"
        | "definition_column" | "require_alphabetical" => v.is_boolean(),
        "leave_value_decimals" => v.as_i64().is_some_and(|n| (0..=3).contains(&n)),
        _ => true,
    };
    if ok { Ok(()) } else { Err(Reason::Invalid) }
}

/// An object of setting name to value (a preset's, or a new cascade's
/// starting values), each checked, within the bounds.
pub fn values_of(v: &Value) -> Result<Map<String, Value>, Reason> {
    let m = v.as_object().ok_or(Reason::Invalid)?;
    for (k, e) in m {
        check(k, e)?;
    }
    if m.len() > MAX_SETTINGS || v.to_string().len() > MAX_BYTES {
        return Err(Reason::Invalid);
    }
    Ok(m.clone())
}

/// A change's time as it is stored, so two can be compared as text and as times.
pub fn at_text(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `values` as changes made at `at`: name -> {value, at}.
pub fn stamped(values: &Map<String, Value>, at: DateTime<Utc>) -> Map<String, Value> {
    let at = at_text(at);
    values.iter().map(|(k, v)| (k.clone(), json!({ "value": v, "at": at }))).collect()
}

/// The changes a `set_cascade_settings` carries, its `settings` object of
/// name to value, each checked and stamped with the operation's `at`.
pub fn changes_of(body: &Value, at: DateTime<Utc>) -> Result<Map<String, Value>, Reason> {
    let s = body.get("settings").ok_or(Reason::Invalid)?;
    let m = s.as_object().ok_or(Reason::Invalid)?;
    if m.is_empty() || m.len() > MAX_SETTINGS {
        return Err(Reason::Invalid);
    }
    for (k, v) in m {
        check(k, v)?;
    }
    Ok(stamped(m, at))
}

fn time_of(e: &Value) -> Option<DateTime<Utc>> {
    e.get("at").and_then(Value::as_str).and_then(|s| s.parse().ok())
}

/// `current` (the column's text) with `changes` merged in: per setting, the
/// change with the later `at` is kept (the new one when they are equal).
/// Refused as `invalid` when the result would pass the bounds.
pub fn merge(current: &str, changes: &Map<String, Value>) -> Result<String, Reason> {
    let mut m: Map<String, Value> = serde_json::from_str(current).map_err(|_| Reason::Error)?;
    for (k, e) in changes {
        let newer = match m.get(k) {
            None => true,
            Some(old) => match (time_of(old), time_of(e)) {
                (Some(o), Some(n)) => n >= o,
                (None, _) => true,
                (_, None) => false,
            },
        };
        if newer {
            m.insert(k.clone(), e.clone());
        }
    }
    let count = m.len();
    let text = Value::Object(m).to_string();
    if count > MAX_SETTINGS || text.len() > MAX_BYTES {
        return Err(Reason::Invalid);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn known_ranges_hold() {
        assert!(check("answer_mode", &json!("typed")).is_ok());
        assert!(check("answer_mode", &json!("spoken")).is_err());
        assert!(check("show_hooks", &json!(1)).is_err());
        // Typed answers in alphabetical order: an answer setting like the others, a boolean.
        assert!(check("require_alphabetical", &json!(true)).is_ok());
        assert!(check("require_alphabetical", &json!("yes")).is_err());
        assert!(check("leave_value_decimals", &json!(4)).is_err());
        assert!(check("leave_value_decimals", &json!(null)).is_ok());
        assert!(check("question_font", &json!("serif")).is_ok());
        assert!(check("Question", &json!(1)).is_err());
        assert!(check("bindings", &json!(["\u{0}"])).is_err());
    }

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn changes_come_from_the_settings_object_stamped() {
        let c = changes_of(&json!({ "settings": { "question_size_px": 40, "show_definitions": null } }), at("2026-11-17T10:00:00Z")).unwrap();
        assert_eq!(c.get("question_size_px"), Some(&json!({ "value": 40, "at": "2026-11-17T10:00:00.000Z" })));
        // Null is a change too: the default, newer than what came before.
        assert_eq!(c.get("show_definitions"), Some(&json!({ "value": null, "at": "2026-11-17T10:00:00.000Z" })));
        assert!(changes_of(&json!({ "clear_threshold": 80 }), at("2026-11-17T10:00:00Z")).is_err());
        assert!(changes_of(&json!({ "settings": {} }), at("2026-11-17T10:00:00Z")).is_err());
        assert!(changes_of(&json!({ "settings": { "show_hooks": "no" } }), at("2026-11-17T10:00:00Z")).is_err());
        assert!(changes_of(&json!({ "settings": [1] }), at("2026-11-17T10:00:00Z")).is_err());
    }

    #[test]
    fn merge_keeps_the_later_change_of_each_setting() {
        let current = json!({
            "a": { "value": 1, "at": "2026-11-17T10:00:00.000Z" },
            "b": { "value": 2, "at": "2026-11-17T12:00:00.000Z" },
        })
        .to_string();
        let changes = stamped(&Map::from_iter([("a".into(), json!(5)), ("b".into(), json!(6)), ("c".into(), json!(null))]), at("2026-11-17T11:00:00Z"));
        let out: Value = serde_json::from_str(&merge(&current, &changes).unwrap()).unwrap();
        assert_eq!(out["a"], json!({ "value": 5, "at": "2026-11-17T11:00:00.000Z" }));
        assert_eq!(out["b"], json!({ "value": 2, "at": "2026-11-17T12:00:00.000Z" }));
        assert_eq!(out["c"], json!({ "value": null, "at": "2026-11-17T11:00:00.000Z" }));
    }

    #[test]
    fn merge_and_values_keep_the_bounds() {
        let t = at("2026-11-17T10:00:00Z");
        let big = Map::from_iter((0..65).map(|i| (format!("s{}", "x".repeat(i % 30 + 1)) + &"_".repeat(i / 30), json!(i))));
        assert!(merge("{}", &stamped(&big, t)).is_err());
        assert!(values_of(&Value::Object(big)).is_err());
        let wide = Map::from_iter([("a".to_owned(), json!("x".repeat(MAX_BYTES)))]);
        assert!(merge("{}", &stamped(&wide, t)).is_err());
        assert!(values_of(&json!({ "show_hooks": true, "question_size_px": 30 })).is_ok());
        assert!(values_of(&json!({ "show_hooks": 1 })).is_err());
    }
}
