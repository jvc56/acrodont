//! The browser's search against the server's: the fixture catalog loaded
//! from packs (core, then definitions) gives the words an index built the
//! server's way gives, for every kind of filter; and the list's orders and
//! the downloads are as PLAN.md § Search page says.

use super::*;
use lexicon::catalog::index::RawWord;
use lexicon::search::wire::QuizType;
use std::path::PathBuf;

fn fixture(file: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/catalog").join(file);
    std::fs::read_to_string(p).unwrap()
}

fn english() -> DistributionJson {
    let tiles = fixture("english.csv")
        .lines()
        .map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            TileJson { letter: f[0].into(), blank_letter: f[1].into(), count: f[2].parse().unwrap(), value: f[3].parse().unwrap(), is_vowel: f[4] == "1" }
        })
        .collect();
    DistributionJson { name: "english".into(), tiles }
}

/// A fixture lexicon split into the two packs the server serves.
fn packs(file: &str) -> (String, String) {
    let (mut core, mut defs) = (String::new(), String::new());
    for l in fixture(file).lines() {
        let f: Vec<&str> = l.splitn(3, '\t').collect();
        core.push_str(&format!("{}\t{}\n", f[0], f[1]));
        defs.push_str(f[2]);
        defs.push('\n');
    }
    (core, defs)
}

fn loaded(with_definitions: bool) -> Engine {
    let mut e = Engine::new();
    let (core, defs) = packs("EN-FIX.tsv");
    e.load("EN-FIX", english(), &core, with_definitions.then_some(defs.as_str())).unwrap();
    let (core, defs) = packs("EN-FIX-OLD.tsv");
    e.load("EN-FIX-OLD", english(), &core, Some(&defs)).unwrap();
    e
}

/// The server's way: the whole lexicon file into `LexiconIndex::build`, and
/// the engine run as a Definition quiz.
fn reference(filters: &Value) -> Vec<String> {
    let dist = Arc::new(Distribution::new(1, "english", english().tiles.into_iter().map(|t| TileDef { letter: t.letter, blank_letter: t.blank_letter, count: t.count, value: t.value, is_vowel: t.is_vowel }).collect()));
    let build = |id, name: &str, file: &str| {
        let raw = fixture(file)
            .lines()
            .map(|l| {
                let f: Vec<&str> = l.splitn(3, '\t').collect();
                RawWord { tiles: dist.parse_magpie(f[0], false).unwrap(), playability: f[1].parse().unwrap(), definition: f[2].into() }
            })
            .collect();
        Arc::new(LexiconIndex::build(id, name, dist.clone(), raw))
    };
    let (en, old) = (build(1, "EN-FIX", "EN-FIX.tsv"), build(2, "EN-FIX-OLD", "EN-FIX-OLD.tsv"));
    let named = |n: &str| (n == "EN-FIX-OLD").then(|| old.clone());
    let tree = parse_tree(filters).unwrap();
    let spec = validate(&tree, QuizType::Definition, Some(&TargetInfo { lexicon: &en, leaves: None, lexicon_named: &named })).unwrap().unwrap();
    lexicon::search::search(Target::Words(&en), QuizType::Definition, &spec, AtMs(f64::MAX)).unwrap().iter().map(|k| dist.to_magpie(k)).collect()
}

fn words(e: &Engine) -> Vec<String> {
    e.rows(0, usize::MAX).as_array().unwrap().iter().map(|r| r["word"].as_str().unwrap().to_owned()).collect()
}

fn and(children: Value) -> Value {
    json!({ "op": "and", "children": children })
}

fn cases() -> Vec<Value> {
    let c = |v: Value| and(json!([v]));
    vec![
        c(json!({ "type": "anagram_match", "negated": false, "pattern": "A E I N R S T" })),
        c(json!({ "type": "anagram_match", "negated": false, "pattern": "A E ." })),
        c(json!({ "type": "pattern_match", "negated": false, "pattern": "A *" })),
        c(json!({ "type": "subanagram_match", "negated": false, "pattern": "R E T A I N S" })),
        c(json!({ "type": "length", "negated": false, "min": 2, "max": 3 })),
        c(json!({ "type": "takes_suffix", "negated": false, "tiles": "S" })),
        c(json!({ "type": "takes_prefix", "negated": true, "tiles": "A" })),
        c(json!({ "type": "front_inner_hook", "negated": false })),
        c(json!({ "type": "num_anagrams", "negated": false, "min": 2, "max": 3 })),
        c(json!({ "type": "probability_order", "negated": false, "min": 1, "max": 3, "lax": false })),
        c(json!({ "type": "limit_by_playability_order", "negated": false, "min": 1, "max": 5, "lax": true })),
        c(json!({ "type": "definition", "negated": false, "text": "lava" })),
        c(json!({ "type": "part_of_speech", "negated": false, "part_of_speech": "noun" })),
        c(json!({ "type": "root_word", "negated": false })),
        c(json!({ "type": "in_lexicon", "negated": true, "lexicon": "EN-FIX-OLD" })),
        json!({ "op": "or", "children": [
            { "type": "length", "negated": false, "min": 2, "max": 2 },
            { "op": "and", "children": [{ "type": "includes_letters", "negated": false, "tiles": "Z" }] }
        ] }),
    ]
}

#[test]
fn every_kind_of_filter_finds_what_the_server_finds() {
    let mut e = loaded(true);
    for filters in cases() {
        e.search("EN-FIX", &filters, Sort::Alphabetical, 2000.0).unwrap_or_else(|f| panic!("{filters}: {f:?}"));
        let found = words(&e);
        // An empty result would agree with anything.
        assert!(!found.is_empty(), "{filters} finds nothing in EN-FIX");
        assert_eq!(found, reference(&filters), "{filters}");
    }
}

#[test]
fn definitions_added_later_are_the_same_as_loaded_at_once() {
    let mut e = loaded(false);
    let pos = and(json!([{ "type": "part_of_speech", "negated": false, "part_of_speech": "noun" }]));
    // Without definitions nothing has a part of speech.
    assert_eq!(e.search("EN-FIX", &pos, Sort::Alphabetical, 2000.0), Ok(0));
    e.add_definitions("EN-FIX", &packs("EN-FIX.tsv").1).unwrap();
    for filters in cases() {
        e.search("EN-FIX", &filters, Sort::Alphabetical, 2000.0).unwrap_or_else(|f| panic!("{filters}: {f:?}"));
        assert_eq!(words(&e), reference(&filters), "{filters}");
    }
}

#[test]
fn an_index_saved_and_read_back_searches_the_same() {
    let mut e = loaded(false);
    let bytes = e.encode("EN-FIX").unwrap();
    let mut back = Engine::new();
    back.load_encoded("EN-FIX", english(), &bytes, false).unwrap();
    let (core, defs) = packs("EN-FIX-OLD.tsv");
    back.load("EN-FIX-OLD", english(), &core, Some(&defs)).unwrap();
    back.add_definitions("EN-FIX", &packs("EN-FIX.tsv").1).unwrap();
    e.add_definitions("EN-FIX", &packs("EN-FIX.tsv").1).unwrap();
    for filters in cases() {
        e.search("EN-FIX", &filters, Sort::Alphagram, 2000.0).unwrap();
        back.search("EN-FIX", &filters, Sort::Alphagram, 2000.0).unwrap();
        assert_eq!(words(&back), words(&e), "{filters}");
        assert_eq!(back.rows(0, 1000), e.rows(0, 1000), "{filters}");
    }
    assert!(matches!(back.add_definitions("EN-FIX", "one\n"), Err(Failure::Message(_))));
    assert!(back.search("EN-FIX", &cases()[0], Sort::Alphagram, 2000.0).is_ok(), "a refused change keeps the lexicon");
}

#[test]
fn errors_are_the_builders() {
    let mut e = loaded(true);
    let empty = and(json!([{ "type": "anagram_match", "negated": false, "pattern": "" }]));
    match e.search("EN-FIX", &empty, Sort::Alphagram, 2000.0) {
        Err(Failure::Rows(errs)) => assert_eq!((errs[0].path.clone(), errs[0].field.as_str()), (vec![0], "pattern")),
        other => panic!("{other:?}"),
    }
    let leave = and(json!([{ "type": "leave_value", "negated": false, "min": 0, "max": 1 }]));
    assert!(matches!(e.search("EN-FIX", &leave, Sort::Alphagram, 2000.0), Err(Failure::Rows(_))));
    assert!(matches!(e.search("CSW24", &empty, Sort::Alphagram, 2000.0), Err(Failure::Message(_))));
    let unknown = and(json!([{ "type": "in_lexicon", "negated": false, "lexicon": "NOPE" }]));
    assert!(matches!(e.search("EN-FIX", &unknown, Sort::Alphagram, 2000.0), Err(Failure::Rows(_))));
}

#[test]
fn the_orders() {
    let mut e = loaded(true);
    let f = and(json!([{ "type": "length", "negated": false, "min": 1, "max": 15 }]));
    e.search("EN-FIX", &f, Sort::Alphagram, 2000.0).unwrap();
    let rows = e.rows(0, usize::MAX);
    let rows = rows.as_array().unwrap();
    let alpha: Vec<u64> = rows.iter().map(|r| r["alphagram"].as_u64().unwrap()).collect();
    assert!(alpha.windows(2).all(|p| p[0] <= p[1]), "anagrams together, alphagrams in order");
    // The band turns over exactly where the alphagram changes.
    for p in rows.windows(2) {
        let changed = p[0]["alphagram"] != p[1]["alphagram"];
        assert_eq!(p[0]["band"] != p[1]["band"], changed, "{} {}", p[0]["word"], p[1]["word"]);
    }
    assert_eq!(rows[0]["band"], false);
    e.sort(Sort::Probability);
    let rows = e.rows(0, usize::MAX);
    let key: Vec<(u64, u64)> = rows.as_array().unwrap().iter().map(|r| (r["length"].as_u64().unwrap(), r["probability_order"].as_u64().unwrap())).collect();
    assert!(key.windows(2).all(|p| p[0] < p[1]), "by length, then a unique probability order");
    e.sort(Sort::Alphabetical);
    let w = words(&e);
    assert!(w.windows(2).all(|p| p[0] < p[1]));
    // A slice past the end is empty, not an error.
    assert_eq!(e.rows(w.len() + 5, 10), json!([]));
}

#[test]
fn downloads() {
    let mut e = loaded(true);
    let f = and(json!([{ "type": "anagram_match", "negated": false, "pattern": "A A" }]));
    e.search("EN-FIX", &f, Sort::Alphagram, 2000.0).unwrap();
    assert_eq!(e.export(false, &[]), "AA\n");
    let all: Vec<String> = CSV_COLUMNS.iter().rev().map(|c| c.to_string()).collect();
    let csv = e.export(true, &all);
    let mut lines = csv.split("\r\n");
    assert_eq!(lines.next().unwrap(), CSV_COLUMNS.join(","), "the columns in their own order");
    // AA's definition holds a comma, so it is quoted.
    assert!(lines.next().unwrap().ends_with(",\"a rough, cindery lava [n -S]\""), "{csv}");
    assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    assert_eq!(text_cell("=SUM(A1)"), "'=SUM(A1)");
    assert_eq!(text_cell("a sum"), "a sum");
}

