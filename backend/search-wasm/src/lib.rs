//! The browser's search (PLAN.md § Search page). [`Engine`] holds the
//! lexicons this device has loaded and the latest search's words; the
//! `ffi` module exposes it as plain WebAssembly exports that pass JSON and
//! text through linear memory, so the build needs no binding generator.
//!
//! Searching is the server's own code (the `lexicon` crate), so a search here
//! returns the words a cascade made from the same filters would hold.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use lexicon::catalog::index::{LexiconIndex, RawWord, WordEntry};
use lexicon::catalog::tiles::{Distribution, TileDef};
use lexicon::clock::{now_ms, AtMs};
use lexicon::search::validate::{validate, TargetInfo};
use lexicon::search::wire::{parse_tree, PathError, QuizType};
use lexicon::search::{engine, SearchError, Target};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct TileJson {
    pub letter: String,
    pub blank_letter: String,
    pub count: u16,
    pub value: u16,
    pub is_vowel: bool,
}

#[derive(Deserialize)]
pub struct DistributionJson {
    pub name: String,
    pub tiles: Vec<TileJson>,
}

/// The orders the list can take (PLAN.md § Search page → The page).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sort {
    /// By alphagram, then word: Zyzzyva's order, with each set of anagrams together.
    Alphagram,
    Alphabetical,
    /// By length, then probability order (ranked within a length).
    Probability,
    /// By length, then playability order.
    Playability,
    Length,
}

/// The columns a CSV download can hold, in this order whatever order they are asked in.
pub const CSV_COLUMNS: [&str; 9] = [
    "word",
    "alphagram",
    "length",
    "probability_order",
    "playability_order",
    "front_hooks",
    "back_hooks",
    "inner_hooks",
    "definition",
];

/// The latest search: its lexicon and its words' ids, in the chosen order.
struct Result {
    lexicon: Arc<LexiconIndex>,
    ids: Vec<u32>,
    /// Per row: whether it sits in an odd-numbered run of one alphagram's
    /// words, so the list can band each set of anagrams.
    bands: Vec<bool>,
}

fn bands_of(lex: &LexiconIndex, ids: &[u32]) -> Vec<bool> {
    let mut band = false;
    let mut prev = None;
    ids.iter()
        .map(|&id| {
            let a = lex.words[id as usize].alphagram;
            if prev.is_some_and(|p| p != a) {
                band = !band;
            }
            prev = Some(a);
            band
        })
        .collect()
}

#[derive(Default)]
pub struct Engine {
    lexicons: HashMap<String, Arc<LexiconIndex>>,
    /// Whether each loaded lexicon has its definitions.
    with_definitions: HashMap<String, bool>,
    distribution_ids: HashMap<String, i16>,
    next_lexicon_id: i16,
    result: Option<Result>,
}

/// An error for the page: a message, or the builder's row errors.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Message(String),
    Rows(Vec<PathError>),
    TooBroad,
}

impl Failure {
    pub fn to_json(&self) -> Value {
        match self {
            Failure::Message(m) => json!({ "ok": false, "message": m }),
            Failure::Rows(errors) => json!({ "ok": false, "errors": errors }),
            Failure::TooBroad => json!({ "ok": false, "too_broad": true, "message": "search too broad" }),
        }
    }
}

fn parse_core(text: &str) -> std::result::Result<Vec<(String, f64)>, Failure> {
    let mut out = Vec::new();
    for line in text.split_terminator('\n') {
        let (word, p) = line
            .split_once('\t')
            .ok_or_else(|| Failure::Message(format!("The lexicon line {line:?} does not have two fields.")))?;
        let p: f64 = p.parse().map_err(|_| Failure::Message(format!("The playability {p:?} is not a number.")))?;
        out.push((word.to_owned(), p));
    }
    Ok(out)
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    fn distribution(&mut self, d: DistributionJson) -> Arc<Distribution> {
        let next = self.distribution_ids.len() as i16 + 1;
        let id = *self.distribution_ids.entry(d.name.clone()).or_insert(next);
        let tiles = d
            .tiles
            .into_iter()
            .map(|t| TileDef { letter: t.letter, blank_letter: t.blank_letter, count: t.count, value: t.value, is_vowel: t.is_vowel })
            .collect();
        Arc::new(Distribution::new(id, d.name, tiles))
    }

    /// Builds `name`'s index from its core pack (`word⇥playability` lines)
    /// and, when given, its definitions pack (one line per word, in the same
    /// order). The server writes both in its index's word order, so a
    /// definitions pack added later lines up. Returns the build time in
    /// milliseconds.
    pub fn load(&mut self, name: &str, distribution: DistributionJson, core: &str, definitions: Option<&str>) -> std::result::Result<u64, Failure> {
        let dist = self.distribution(distribution);
        let rows = parse_core(core)?;
        let mut raw = Vec::with_capacity(rows.len());
        for (word, playability) in rows {
            let tiles = dist
                .parse_magpie(&word, false)
                .map_err(|e| Failure::Message(format!("The word {word:?} does not parse: {e}.")))?;
            raw.push(RawWord { tiles, playability, definition: String::new() });
        }
        if let Some(defs) = definitions {
            let mut lines = defs.split_terminator('\n');
            for w in &mut raw {
                w.definition = lines.next().ok_or_else(|| Failure::Message("The definitions are fewer than the words.".into()))?.to_owned();
            }
        }
        self.next_lexicon_id += 1;
        let index = LexiconIndex::build(self.next_lexicon_id, name, dist, raw);
        let ms = index.build_ms;
        self.put(name, index, definitions.is_some());
        Ok(ms)
    }

    /// Reads back an index [`Engine::encode`] saved. Returns the time taken.
    pub fn load_encoded(&mut self, name: &str, distribution: DistributionJson, bytes: &[u8], definitions: bool) -> std::result::Result<u64, Failure> {
        let dist = self.distribution(distribution);
        let index = LexiconIndex::decode(bytes, dist).map_err(Failure::Message)?;
        let ms = index.build_ms;
        self.put(name, index, definitions);
        Ok(ms)
    }

    /// `name`'s index as bytes, for the device to keep.
    pub fn encode(&self, name: &str) -> Option<Vec<u8>> {
        self.lexicons.get(name).map(|l| l.encode())
    }

    /// Gives `name` its definitions (one line per word, in the core pack's
    /// order): Definition, Part of Speech and Root Word read them, and the
    /// list shows them.
    pub fn add_definitions(&mut self, name: &str, definitions: &str) -> std::result::Result<u64, Failure> {
        let start = now_ms();
        // The latest result holds the index too; it is dropped as any change
        // to its lexicon drops it, so the index can change in place.
        if self.result.as_ref().is_some_and(|r| r.lexicon.name == name) {
            self.result = None;
        }
        let Some(lex) = self.lexicons.remove(name) else {
            return Err(Failure::Message(format!("{name} is not loaded.")));
        };
        let mut index = match Arc::try_unwrap(lex) {
            Ok(index) => index,
            Err(lex) => {
                self.lexicons.insert(name.to_owned(), lex);
                return Err(Failure::Message(format!("{name} is in use.")));
            }
        };
        let had = self.with_definitions.get(name).copied().unwrap_or(false);
        let r = index.set_definitions(definitions.split_terminator('\n').map(str::to_owned).collect());
        let ok = r.is_ok();
        self.put(name, index, ok || had);
        r.map_err(Failure::Message)?;
        Ok((now_ms() - start) as u64)
    }

    fn put(&mut self, name: &str, index: LexiconIndex, definitions: bool) {
        self.lexicons.insert(name.to_owned(), Arc::new(index));
        self.with_definitions.insert(name.to_owned(), definitions);
        // A result over the old index would name words by stale ids.
        if self.result.as_ref().is_some_and(|r| r.lexicon.name == name) {
            self.result = None;
        }
    }

    pub fn unload(&mut self, name: &str) {
        self.lexicons.remove(name);
        self.with_definitions.remove(name);
        if self.result.as_ref().is_some_and(|r| r.lexicon.name == name) {
            self.result = None;
        }
    }

    pub fn loaded(&self) -> Value {
        json!(self.lexicons.keys().map(|n| json!({ "name": n, "definitions": self.with_definitions[n] })).collect::<Vec<_>>())
    }

    /// Runs `filters` (the builder's wire tree) over `lexicon`'s words, as a
    /// Definition quiz would: one entry per word. Keeps the words, sorted.
    pub fn search(&mut self, lexicon: &str, filters: &Value, sort: Sort, deadline_ms: f64) -> std::result::Result<usize, Failure> {
        let Some(lex) = self.lexicons.get(lexicon).cloned() else {
            return Err(Failure::Message(format!("{lexicon} is not on this device.")));
        };
        let tree = parse_tree(filters).map_err(Failure::Rows)?;
        let lexicons = &self.lexicons;
        let lexicon_named = |n: &str| lexicons.get(n).cloned();
        let info = TargetInfo { lexicon: &lex, leaves: None, lexicon_named: &lexicon_named };
        let spec = validate(&tree, QuizType::Definition, Some(&info)).map_err(Failure::Rows)?.expect("a target gives a spec");
        let mut ids = engine::run_ids(Target::Words(&lex), &spec, AtMs(now_ms() + deadline_ms), true).map_err(|SearchError::TooBroad| Failure::TooBroad)?;
        sort_ids(&lex, &mut ids, sort);
        let n = ids.len();
        let bands = bands_of(&lex, &ids);
        self.result = Some(Result { lexicon: lex, ids, bands });
        Ok(n)
    }

    pub fn sort(&mut self, sort: Sort) {
        if let Some(r) = self.result.as_mut() {
            sort_ids(&r.lexicon, &mut r.ids, sort);
            r.bands = bands_of(&r.lexicon, &r.ids);
        }
    }

    /// Rows `from..from + n` of the latest result, for the list to draw.
    pub fn rows(&self, from: usize, n: usize) -> Value {
        let Some(r) = &self.result else { return json!([]) };
        let d = &r.lexicon.distribution;
        let end = (from + n).min(r.ids.len());
        let from = from.min(end);
        let rows: Vec<Value> = r.ids[from..end]
            .iter()
            .zip(&r.bands[from..end])
            .map(|(&id, &band)| {
                let w = &r.lexicon.words[id as usize];
                json!({
                    "band": band,
                    "word": d.to_magpie(&w.tiles),
                    "alphagram": w.alphagram,
                    "length": w.length,
                    "probability_order": w.probability_order,
                    "playability_order": w.playability_order,
                    "front_hooks": d.to_magpie(&w.front_hooks),
                    "back_hooks": d.to_magpie(&w.back_hooks),
                    "front_inner": w.has_front_inner_hook,
                    "back_inner": w.has_back_inner_hook,
                    "definition": &*w.definition,
                })
            })
            .collect();
        json!(rows)
    }

    /// The whole result as a file: TXT is one word a line; CSV is RFC 4180
    /// with a header, holding `columns` in [`CSV_COLUMNS`] order, with the
    /// export's rules for a definition that a spreadsheet would read as a
    /// formula (`lib/export/format.ts`).
    pub fn export(&self, csv: bool, columns: &[String]) -> String {
        let mut out = String::new();
        let Some(r) = &self.result else { return out };
        let d = &r.lexicon.distribution;
        if !csv {
            for &id in &r.ids {
                out.push_str(&d.to_magpie(&r.lexicon.words[id as usize].tiles));
                out.push('\n');
            }
            return out;
        }
        let cols: Vec<&str> = CSV_COLUMNS.iter().copied().filter(|c| columns.iter().any(|x| x == c)).collect();
        out.push_str(&cols.join(","));
        out.push_str("\r\n");
        for &id in &r.ids {
            let w = &r.lexicon.words[id as usize];
            let cells: Vec<String> = cols.iter().map(|c| csv_field(&cell(&r.lexicon, w, c))).collect();
            out.push_str(&cells.join(","));
            out.push_str("\r\n");
        }
        out
    }
}

fn cell(lex: &LexiconIndex, w: &WordEntry, col: &str) -> String {
    let d = &lex.distribution;
    match col {
        "word" => d.to_magpie(&w.tiles),
        "alphagram" => d.to_magpie(&lex.alphagrams[w.alphagram as usize]),
        "length" => w.length.to_string(),
        "probability_order" => w.probability_order.to_string(),
        "playability_order" => w.playability_order.to_string(),
        "front_hooks" => d.to_magpie(&w.front_hooks),
        "back_hooks" => d.to_magpie(&w.back_hooks),
        "inner_hooks" => match (w.has_front_inner_hook, w.has_back_inner_hook) {
            (true, true) => "both".into(),
            (true, false) => "front".into(),
            (false, true) => "back".into(),
            (false, false) => String::new(),
        },
        "definition" => text_cell(&w.definition),
        _ => String::new(),
    }
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) {
        let mut q = String::with_capacity(s.len() + 2);
        let _ = write!(q, "\"{}\"", s.replace('"', "\"\""));
        q
    } else {
        s.to_owned()
    }
}

/// A cell a spreadsheet would read as a formula is written after an apostrophe.
fn text_cell(s: &str) -> String {
    if s.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{s}") } else { s.to_owned() }
}

fn sort_ids(lex: &LexiconIndex, ids: &mut [u32], sort: Sort) {
    let w = |id: u32| &lex.words[id as usize];
    match sort {
        // Word ids are in alphabetical order already.
        Sort::Alphabetical => ids.sort_unstable(),
        Sort::Alphagram => ids.sort_unstable_by_key(|&id| (w(id).alphagram, id)),
        Sort::Probability => ids.sort_unstable_by_key(|&id| (w(id).length, w(id).probability_order, id)),
        Sort::Playability => ids.sort_unstable_by_key(|&id| (w(id).length, w(id).playability_order, id)),
        Sort::Length => ids.sort_unstable_by_key(|&id| (w(id).length, id)),
    }
}

/// The WebAssembly interface. Every call that takes text takes a pointer and
/// a length into memory from `alloc`; every call that returns text leaves it
/// in the output buffer (`output_ptr`, `output_len`) and returns 0 for
/// success or 1 for a failure whose JSON is in the buffer.
pub mod ffi {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        static ENGINE: RefCell<Engine> = RefCell::new(Engine::new());
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    fn set_output(s: String) {
        OUTPUT.with(|o| *o.borrow_mut() = s.into_bytes());
    }

    fn reply(r: std::result::Result<Value, Failure>) -> u32 {
        match r {
            Ok(v) => {
                set_output(v.to_string());
                0
            }
            Err(f) => {
                set_output(f.to_json().to_string());
                1
            }
        }
    }

    /// # Safety
    /// `ptr..ptr + len` must be memory `alloc` returned and not yet freed.
    unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
        if len == 0 {
            return "";
        }
        // SAFETY: as the caller promises; the page writes UTF-8 (TextEncoder).
        unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len.max(1));
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr` and `len` must be exactly as `alloc` returned and was given.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        // SAFETY: as the caller promises.
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
    }

    /// The saved index's layout (`lexicon::catalog::encoded::FORMAT`): a
    /// device rebuilds an index saved in another.
    #[unsafe(no_mangle)]
    pub extern "C" fn index_format() -> u32 {
        lexicon::catalog::encoded::FORMAT
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn output_ptr() -> *const u8 {
        OUTPUT.with(|o| o.borrow().as_ptr())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn output_len() -> usize {
        OUTPUT.with(|o| o.borrow().len())
    }

    #[derive(Deserialize)]
    struct LoadRequest {
        name: String,
        distribution: DistributionJson,
    }

    /// `request` is `{name, distribution}`; `core` the core pack; `defs` the
    /// definitions pack, or empty for none. Replies `{ok, ms}`.
    ///
    /// # Safety
    /// Each pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn load(req: *const u8, req_len: usize, core: *const u8, core_len: usize, defs: *const u8, defs_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let (req, core, defs) = unsafe { (text(req, req_len), text(core, core_len), text(defs, defs_len)) };
        let r = serde_json::from_str::<LoadRequest>(req)
            .map_err(|e| Failure::Message(e.to_string()))
            .and_then(|q| ENGINE.with(|e| e.borrow_mut().load(&q.name, q.distribution, core, (defs_len > 0).then_some(defs))))
            .map(|ms| json!({ "ok": true, "ms": ms }));
        reply(r)
    }

    /// `request` is `{name, distribution, definitions}`; `bytes` an index
    /// `encode` saved. Replies `{ok, ms}`.
    ///
    /// # Safety
    /// Each pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn load_encoded(req: *const u8, req_len: usize, bytes: *const u8, bytes_len: usize) -> u32 {
        #[derive(Deserialize)]
        struct Request {
            name: String,
            distribution: DistributionJson,
            definitions: bool,
        }
        // SAFETY: as the caller promises.
        let (req, bytes) = unsafe { (text(req, req_len), std::slice::from_raw_parts(bytes, bytes_len)) };
        let r = serde_json::from_str::<Request>(req)
            .map_err(|e| Failure::Message(e.to_string()))
            .and_then(|q| ENGINE.with(|e| e.borrow_mut().load_encoded(&q.name, q.distribution, bytes, q.definitions)))
            .map(|ms| json!({ "ok": true, "ms": ms }));
        reply(r)
    }

    /// Leaves `name`'s index, as bytes, in the output buffer.
    ///
    /// # Safety
    /// The pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn encode(name: *const u8, name_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let name = unsafe { text(name, name_len) };
        match ENGINE.with(|e| e.borrow().encode(name)) {
            Some(bytes) => {
                OUTPUT.with(|o| *o.borrow_mut() = bytes);
                0
            }
            None => reply(Err(Failure::Message(format!("{name} is not loaded.")))),
        }
    }

    /// # Safety
    /// Each pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn add_definitions(name: *const u8, name_len: usize, defs: *const u8, defs_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let (name, defs) = unsafe { (text(name, name_len), text(defs, defs_len)) };
        reply(ENGINE.with(|e| e.borrow_mut().add_definitions(name, defs)).map(|ms| json!({ "ok": true, "ms": ms })))
    }

    /// # Safety
    /// The pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn unload(name: *const u8, name_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let name = unsafe { text(name, name_len) };
        ENGINE.with(|e| e.borrow_mut().unload(name));
        reply(Ok(json!({ "ok": true })))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn loaded() -> u32 {
        reply(Ok(ENGINE.with(|e| e.borrow().loaded())))
    }

    #[derive(Deserialize)]
    struct SearchRequest {
        lexicon: String,
        filters: Value,
        sort: Sort,
        deadline_ms: f64,
    }

    /// `request` is `{lexicon, filters, sort, deadline_ms}`. Replies
    /// `{ok, count, ms}`, or `{ok: false}` with `errors` (the builder's row
    /// errors), `too_broad`, or a `message`.
    ///
    /// # Safety
    /// The pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn search(req: *const u8, req_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let req = unsafe { text(req, req_len) };
        let start = now_ms();
        let r = serde_json::from_str::<SearchRequest>(req)
            .map_err(|e| Failure::Message(e.to_string()))
            .and_then(|q| ENGINE.with(|e| e.borrow_mut().search(&q.lexicon, &q.filters, q.sort, q.deadline_ms)))
            .map(|count| json!({ "ok": true, "count": count, "ms": (now_ms() - start).round() }));
        reply(r)
    }

    /// # Safety
    /// The pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn sort(req: *const u8, req_len: usize) -> u32 {
        // SAFETY: as the caller promises.
        let req = unsafe { text(req, req_len) };
        let r = serde_json::from_str::<Sort>(req).map_err(|e| Failure::Message(e.to_string())).map(|s| {
            ENGINE.with(|e| e.borrow_mut().sort(s));
            json!({ "ok": true })
        });
        reply(r)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rows(from: usize, n: usize) -> u32 {
        reply(Ok(ENGINE.with(|e| e.borrow().rows(from, n))))
    }

    /// `request` is `{format: "txt" | "csv", columns}`; the reply is the file's text.
    ///
    /// # Safety
    /// The pointer and length must be memory from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn export(req: *const u8, req_len: usize) -> u32 {
        #[derive(Deserialize)]
        struct ExportRequest {
            format: String,
            #[serde(default)]
            columns: Vec<String>,
        }
        // SAFETY: as the caller promises.
        let req = unsafe { text(req, req_len) };
        match serde_json::from_str::<ExportRequest>(req) {
            Ok(q) => {
                set_output(ENGINE.with(|e| e.borrow().export(q.format == "csv", &q.columns)));
                0
            }
            Err(e) => reply(Err(Failure::Message(e.to_string()))),
        }
    }
}

#[cfg(test)]
mod tests;
