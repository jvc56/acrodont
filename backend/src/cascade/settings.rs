//! A cascade's own settings (PLAN.md § Settings → Where a setting applies):
//! the "This cascade" place, one object of setting name to value held on the
//! cascade row. A setting it does not name falls through to the device's
//! places and the account's, which the server never resolves: what a value
//! means is the frontend's to check, as it does a shared device setting's.
//! The server checks only the names and the size, and the range of the few
//! settings whose values it also knows.

use serde_json::{Map, Value};

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

/// The changes a `set_cascade_options` carries to the cascade's settings, its
/// `settings` object, each checked; none at all is `None`.
pub fn changes_of(body: &Value) -> Result<Option<Map<String, Value>>, Reason> {
    let Some(s) = body.get("settings") else { return Ok(None) };
    let m = s.as_object().ok_or(Reason::Invalid)?;
    for (k, v) in m {
        check(k, v)?;
    }
    Ok(if m.is_empty() { None } else { Some(m.clone()) })
}

/// `current` (the column's text) with `changes` made: a value replaces, null
/// removes. Refused as `invalid` when the result would pass the bounds.
pub fn merge(current: &str, changes: &Map<String, Value>) -> Result<String, Reason> {
    let mut m: Map<String, Value> = serde_json::from_str(current).map_err(|_| Reason::Error)?;
    for (k, v) in changes {
        if v.is_null() {
            m.remove(k);
        } else {
            m.insert(k.clone(), v.clone());
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

    #[test]
    fn changes_come_from_the_settings_object() {
        let c = changes_of(&json!({ "settings": { "question_size_px": 40, "show_definitions": null } })).unwrap().unwrap();
        assert_eq!(c.get("question_size_px"), Some(&json!(40)));
        assert_eq!(c.get("show_definitions"), Some(&json!(null)));
        assert!(changes_of(&json!({ "clear_threshold": 80 })).unwrap().is_none());
        assert!(changes_of(&json!({ "settings": { "show_hooks": "no" } })).is_err());
        assert!(changes_of(&json!({ "settings": [1] })).is_err());
    }

    #[test]
    fn merge_sets_clears_and_bounds() {
        let changes = changes_of(&json!({ "settings": { "a": 1, "b": null } })).unwrap().unwrap();
        let out: Value = serde_json::from_str(&merge(r#"{"b":2,"c":3}"#, &changes).unwrap()).unwrap();
        assert_eq!(out, json!({ "a": 1, "c": 3 }));
        let big = Map::from_iter((0..65).map(|i| (format!("s{}", "x".repeat(i % 30 + 1)) + &"_".repeat(i / 30), json!(i))));
        assert!(merge("{}", &big).is_err());
        let wide = Map::from_iter([("a".to_owned(), json!("x".repeat(MAX_BYTES)))]);
        assert!(merge("{}", &wide).is_err());
    }
}
