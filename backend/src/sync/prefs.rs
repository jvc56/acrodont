//! `set_preferences` validation (PLAN.md § Operations, § Preferences). Every
//! carried value is checked before any write, so an out-of-range value is
//! `invalid`, never a constraint violation.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::cascade::rules::Reason;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "anagram_answer_mode", rename_all = "snake_case")]
pub enum AnswerMode {
    Flashcard,
    Typed,
}

/// The preference fields a `set_preferences` may carry, typed and in range.
#[derive(Debug, Clone, Default)]
pub struct PreferenceChanges {
    pub default_clear_threshold: Option<i16>,
    pub leave_value_decimals: Option<i16>,
    pub anagram_show_definitions: Option<bool>,
    pub anagram_show_hooks: Option<bool>,
    pub anagram_answer_mode: Option<AnswerMode>,
    pub default_segment_size: Option<i32>,
    pub default_progression: Option<crate::cascade::rows::Progression>,
    pub default_require_alphabetical: Option<bool>,
    pub reveal_correct: Option<bool>,
}

pub const PREFERENCE_FIELDS: [&str; 9] = [
    "default_clear_threshold",
    "leave_value_decimals",
    "anagram_show_definitions",
    "anagram_show_hooks",
    "anagram_answer_mode",
    "default_segment_size",
    "default_progression",
    "default_require_alphabetical",
    "reveal_correct",
];

fn int_in(v: &Value, lo: i64, hi: i64) -> Result<i64, Reason> {
    v.as_i64().filter(|n| (lo..=hi).contains(n)).ok_or(Reason::Invalid)
}

fn boolean(v: &Value) -> Result<bool, Reason> {
    v.as_bool().ok_or(Reason::Invalid)
}

pub fn parse_preferences(fields: &Map<String, Value>, cap: u32) -> Result<PreferenceChanges, Reason> {
    let mut c = PreferenceChanges::default();
    for (k, v) in fields {
        match k.as_str() {
            "default_clear_threshold" => c.default_clear_threshold = Some(int_in(v, 1, 100)? as i16),
            "leave_value_decimals" => c.leave_value_decimals = Some(int_in(v, 0, 3)? as i16),
            "anagram_show_definitions" => c.anagram_show_definitions = Some(boolean(v)?),
            "anagram_show_hooks" => c.anagram_show_hooks = Some(boolean(v)?),
            "anagram_answer_mode" => {
                c.anagram_answer_mode = Some(serde_json::from_value(v.clone()).map_err(|_| Reason::Invalid)?)
            }
            "default_segment_size" => {
                let n = v.as_i64().ok_or(Reason::Invalid)?;
                c.default_segment_size = Some(crate::cascade::rules::check_segment_size(n, cap)? as i32);
            }
            "default_progression" => {
                c.default_progression = Some(serde_json::from_value(v.clone()).map_err(|_| Reason::Invalid)?)
            }
            "default_require_alphabetical" => c.default_require_alphabetical = Some(boolean(v)?),
            "reveal_correct" => c.reveal_correct = Some(boolean(v)?),
            _ => return Err(Reason::Invalid),
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn preference_ranges() {
        let m = |v: Value| v.as_object().unwrap().clone();
        assert!(parse_preferences(&m(json!({ "default_clear_threshold": 0 })), 130_000).is_err());
        assert!(parse_preferences(&m(json!({ "leave_value_decimals": 4 })), 130_000).is_err());
        assert!(parse_preferences(&m(json!({ "default_segment_size": 4 })), 130_000).is_err());
        assert!(parse_preferences(&m(json!({ "anagram_answer_mode": "typed", "default_progression": "drill" })), 130_000).is_ok());
    }
}
