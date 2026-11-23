# The Search page: a plan

**Date:** 2026-11-22
**Status:** implemented on 2026-11-22, on branch `answer-hook-spacing`, with
every decision (D1–D11, under "Decisions") as recommended. PLAN.md § Search
page is the spec now; this file records how the design was decided.

### Implementation status

Built as planned, with these differences:

- **The spike's numbers** (CSW24, WebAssembly in Node on a desktop): building
  the index took 6.2 s at first, then 2.5 s once two hot spots were fixed in
  the shared crate (the server's build fell from 2.8 s to 1.4 s with them):
  - `word_combinations` worked out every binomial coefficient with 128-bit
    division for every word. Now each distribution keeps a table of them, and
    the blank-substitution sums use prefix and suffix products: O(d²) for d
    distinct tiles instead of O(d³). Checked arithmetic falls back to the
    term-by-term sum on overflow, so the integers are exactly the old ones (a
    test runs both over every count vector of a small bag).
  - Searches took 2–70 ms; the worker held 130 MB without definitions and
    145–160 MB with.
- **The device keeps the built index, not the packs.** 2.5 s is still slow on
  a phone, so after the first build the worker encodes the index
  (`lexicon::catalog::encoded`, format 1) and the device keeps it gzipped in
  `lexicon_packs`. Reading it back takes 0.46 s on the desktop. Definitions
  are added to a loaded index with `LexiconIndex::set_definitions` (1.3 s)
  instead of a rebuild; a test checks both give the index `build` makes.
- **The packs carry their revisions in a header, not the URL.** They are
  served `private, no-store` with `X-Lexicon-Revisions`, and the device
  compares that with the revisions `GET /api/lexicons` now lists. Since the
  device keeps the index, an HTTP cache of the packs would hold a second copy
  for nothing.
- **`GET /api/lexicons` lists revisions, not pack sizes.** The packs are
  compressed on the way out, so their size is known only once sent; the
  progress line counts the bytes received.
- **No `wasm-bindgen`.** The crate exports plain functions that pass JSON and
  text through linear memory, with a small hand-written glue in the worker,
  so the build needs only the `wasm32-unknown-unknown` target. `make wasm`
  builds it for `vite dev`; the frontend image builds its own in a Rust stage.
- **The `sqlx` derives on the wire enums** sit behind the crate's `sqlx`
  feature, which only the server turns on, and `tracing` comes along for the
  index's build log.
- **No macOS note for Alt+Q.** The browser does receive Alt+Q there (with
  `KeyboardEvent.code` `KeyQ`), so there is nothing to warn about.
- **A Search link in the header for every signed-in user**, beside Admin for
  admins.
- **One Search page, shown over the quiz.** The overlay first built used its
  own wrapper; then Q navigated to `/search`, which rebuilt the player on
  return. Now the player renders the `/search` route's own page component
  (with the header) in its layer, at `/search?from=<cascade>` by SvelteKit
  shallow routing, so there is one page to maintain and the switch is instant.
  The page takes the quiz as a prop (lexicon, Search keys, the way back) and
  offers **Back to the quiz**; that button, the Search keys or Back close it.
  Escape no longer does. A reload at that address shows the page on its own,
  which finds the cascade itself; the player keeps what only the screen holds
  in a SvelteKit snapshot for the way back from there.

## The goal

1. **A page called Search.** It has the New cascade page's lexicon select
   and filter rows. Instead of creating a cascade, it lists the words that
   match and lets the user download the list, as Zyzzyva's Search tab does.
2. **As much of it as possible works offline**, ideally all of it.
3. **From a quiz, Q switches to Search and back, instantly.** Q is the
   default. It can be rebound in Controls like Show / Next, Toggle and
   Previous.
4. **It starts with a single Anagram Match row.**

## Summary

- **Search runs in the browser** (D1). The server's search engine, which
  is plain Rust, moves into a crate of its own. The server keeps using that
  crate, and the browser runs the same crate compiled to WebAssembly in a
  Web Worker. Results match the server's exactly, and with them Zyzzyva's,
  with no second engine to keep in step.
- **Each lexicon is downloaded once as a pack** (D3, D9):
  - The core pack holds the words and their playability. It is about
    1.4 MB gzipped for CSW24's 280,887 words.
  - The definitions pack is about 3.3 MB gzipped and comes only when it is
    first needed.
  - Both live in a new IndexedDB store, outside the answer-card and row
    budgets.
- **After that, Search is entirely offline**: every filter, the results
  list and the download. Only these need a connection:
  - the first download of a lexicon
  - a new revision of a lexicon
  - Load Search… and Save Search…
- **Q opens Search over the player** (D6). The player stays mounted, so
  everything the quiz shows is still there on return: a revealed answer,
  typed words, a toggled grade and the scroll position. Q or Escape closes
  it. Search is also its own page, `/search`, reached from the header.
  Both places show the same remembered search.
- **Alt+Q is bound too** (D5), because a plain Q typed into typed mode's
  answer box is a letter.

## What the user sees

### The page

The layout follows the builder's, so a builder user already knows it:

- **Lexicon:** the builder's select. Opened from a quiz, it is set to the
  cascade's lexicon. On `/search` it is the lexicon used last.
- **There is no quiz type.** Search lists words. The filters that apply
  are the ones a Definition quiz allows: every type except Leave Value
  (D4).
- **Filters:** the builder's `FilterGroup`, with Not, AND/OR, groups and
  drag and drop. It starts as one AND group holding one **Anagram Match**
  row with an empty pattern, and the cursor is in that pattern. The
  builder's "Add row" still adds a Length row.
- **Results appear as the filters change.** There is no Search button.
  - A search runs 150 ms after the last change.
  - An unfinished row (an empty pattern, a range out of bounds) shows the
    builder's message under the row, and the list keeps its last results,
    dimmed.
- **The count** heads the list, for example "1,284 words", and the time
  the search took.
- **The list** has one row per word (D2), laid out like an answer row:
  - columns, all optional: probability order, front hooks, the word with
    its inner-hook dots, back hooks, definition, and playability order
  - sorted by alphagram and then word, as Zyzzyva sorts. Alphabetical,
    probability order, playability order and length are the other sorts.
  - a light band behind each set of anagrams
  - only the visible rows are drawn, so 280,000 rows scroll as smoothly
    as 20 (D7)
- **Download** gives the whole list, not just what is visible (see
  [Download](#download)).
- **Load Search… and Save Search…** are the builder's, and need a
  connection as they do there (D10).
- **New cascade from this search** opens the builder with this lexicon and
  these filters, under Definition. The builder's quiz-type switch flags
  any row that doesn't fit the type the user then picks.

**Before the lexicon is on the device** (D9):

- Online, the pack downloads at once. A progress line under the lexicon
  select reads "Downloading CSW24 for searching: 0.6 of 1.4 MB".
- Offline, it says "Search needs CSW24 on this device. Connect once to
  download it (1.4 MB)."
- The definitions pack downloads the first time any of these is needed:
  - the Definition column is shown
  - a Definition, Part of Speech or Root Word row is added
  - a download includes definitions

  Until it arrives, those rows say "Downloading definitions…", or, when
  offline, that a connection is needed once.

### From a quiz: Q

- **Q opens Search** over the quiz area, full size, with the cascade's
  lexicon. If the remembered search used another lexicon, the lexicon
  changes and the filters stay. The builder's `changeLexicon` flags any
  row the change made invalid.
- **Q, Alt+Q or Escape closes it.** The quiz is exactly as it was left.
  Inside Search:
  - a plain Q in a pattern box is a letter, so there only Alt+Q and
    Escape close it
  - the quiz's other bindings do nothing, so Space or a click in the list
    never grades a card
- **On a phone** there is no Q key:
  - Search is an item in the player's ☰ menu, and a small 🔍 button
    beside ☰
  - the phone's Back gesture closes it, because opening it adds a history
    entry (SvelteKit shallow routing, `pushState`)
- **The search is remembered** between openings and across reloads. Q
  shows the last search with its scroll position, so flicking between a
  question and its search costs nothing.

### Download

- **TXT:** one word per line, in the list's order. It is the quickest way
  into Zyzzyva or a word-list tool.
- **CSV:** RFC 4180 with CRLF line endings and a header row. Columns are
  chosen with checkboxes: word, alphagram, length, probability order,
  playability order, front hooks, back hooks, inner hooks, definition.
  - It follows `lib/export/format.ts`'s rules: CSV quoting, the leading
    apostrophe on cells starting with `= + - @`, and a filename cut to 100
    characters.
  - The filename names the lexicon and the first row, for example
    `CSW24 anagram AEINRST.csv`.
- The worker formats the file from the full result and hands back a Blob.
  The page saves it the way the export page already does, through an
  object URL and an `<a download>`. This works offline, at any size.

## Searching in the browser

### The engine, shared (D1)

The engine and the lexicon index have no server dependencies. These modules
use only `std` and `serde`:

- `catalog::{tiles, probability, pos, roots, index}`
- `search::{wire, validate, pattern, engine}`
- the `search()` function in `search/mod.rs`

Only `catalog/mod.rs` (the `Snapshot`, Postgres listening, tokio) and
`catalog/store.rs` (sqlx) are tied to the server.

**The plan:**

1. **A workspace crate, `backend/lexicon/`, holds those modules.** The
   server's `catalog` and `search` modules re-export them, so call sites
   barely change. Three seams need cutting:
   - **`std::time::Instant`** (engine, index build, `search()`) panics on
     `wasm32-unknown-unknown`. It goes behind a small `Clock` trait. The
     server passes `Instant`; the browser passes `performance.now()`.
   - **`validate`** reads In Lexicon's other lexicon from a `Snapshot`. It
     takes a lookup closure instead.
   - **`unpack_words`** (zstd) stays on the server. The browser receives
     the pack already decompressed (see [Lexicon packs](#lexicon-packs)).
2. **A wasm crate, `backend/search-wasm/`**, built with `wasm-bindgen`. Its
   interface:
   - `load(name, distribution, core_bytes, definitions_bytes?)` builds the
     `LexiconIndex`
   - `add_definitions(name, bytes)`
   - `search(name, tree_json) -> {count, ms}`, which keeps the result's
     word ids
   - `rows(from, n, sort, columns)`
   - `export(format, columns)`, which yields chunks
3. **A module worker, `frontend/src/lib/search/worker.ts`**, owns the wasm
   instance, the loaded lexicons and the latest result. The page asks only
   for the rows it draws.
   - A running wasm call can't be interrupted by a message. So each search
     keeps the server's 2,000 ms deadline (D7): a too-broad search ends
     with the builder's "too broad" message instead of freezing the
     worker.
   - A result that a newer search has superseded is dropped.
   - Most searches will take a few milliseconds: the engine first narrows
     candidates by length bucket and by a literal Anagram Match.
4. **The build.** `make` and the frontend build run
   `cargo build --target wasm32-unknown-unknown --release -p search-wasm`
   and `wasm-bindgen`, and Vite imports the result. The service worker's
   precache list includes the `.wasm` file, so the engine loads offline
   like the rest of the app shell.

### A spike comes first

The server's index for a full lexicon with definitions takes about 100 MB
(PLAN.md § Catalog Indexes). That is fine on a desktop and uncertain on a
phone. Before any UI work, build CSW24's index in wasm and measure, on a
desktop and on a mid-range Android phone:

- the time to load and build, with and without definitions
- the worker's memory, with and without definitions
- the time of typical searches: one alphagram, a length range, a
  probability range, a definition substring

**Targets:** the index builds in under 3 s on the phone, and holds under
150 MB with definitions.

- If definitions push past the memory target, the index is built without
  them. The definitions stay in the worker as one string with offsets,
  read for the Definition column and scanned only by a Definition, Part of
  Speech or Root Word row. `index.rs` already treats definitions as
  separate input to `build`.
- If the build is slow, the build is the only part a pack could store
  ready-made, and that waits until it is measured.

## Lexicon packs

### On the server

- **`GET /api/lexicons/{name}/pack?rev=…`** returns the core pack: one line
  per word, `word⇥playability`.
- **`GET /api/lexicons/{name}/pack/definitions?rev=…`** returns one
  definition per line, in the same order.
- Both are built from the `lexicon_words` blob, the same source as the
  server's index. They are cached in memory once per revision.
- Both are served gzip-compressed. The browser decompresses them with
  `DecompressionStream`, so the wasm needs no zstd.
- Because the revision is in the URL, each response is immutable:
  `Cache-Control: private, max-age=31536000, immutable`.
- **Signed-in accounts only, under the search rate limit** (D8).
- **`GET /api/lexicons` gains each lexicon's pack sizes**, so the progress
  line and the Account page can name them before a download. It already
  returns the revisions.

### On the device

- **A new IndexedDB store, `lexicon_packs`:** `{lexicon, part,
  revisions, bytes}`, where `part` is `core` or `definitions`. This is
  database version 5.
- **The lexicon list is kept in `meta`** (`lexicons`, refreshed whenever
  `/api/lexicons` is read). The select and the In Lexicon row then work
  offline.
- **Refreshing:** when a fresher lexicon list shows a newer revision, the
  new pack downloads in the background and replaces the old one once it
  has arrived. A search runs on the old pack until then.
- **Storage** (D11):
  - Packs count toward neither the 500 MB answer-card budget nor the 2 GB
    row budget, and are never evicted.
  - The Account page's "On this device" lists each lexicon's packs with
    their size and a **Remove** button.
  - CSW24 is about 1.4 MB with the core pack only, and about 4.7 MB with
    definitions.
- **In Lexicon** needs the other lexicon too: its core pack downloads when
  the row is added.
- **The letter distribution** comes from the existing `distributions`
  store, which already works offline.

### What needs a connection, afterwards

PLAN.md § What needs a connection gains these lines:

| Needs a connection | Works offline |
|---|---|
| The first download of a lexicon for Search, and of its definitions | Searching a downloaded lexicon, with every filter except Leave Value |
| A lexicon's new revision (the old one is searched until then) | The results list and downloading it as TXT or CSV |
| Load Search…, Save Search… | Switching between a quiz and Search |

## The Q key

These changes are in `lib/player/bindings.ts` unless noted:

- **A fourth action, `search`.** Its defaults are **KeyQ and Alt+KeyQ**
  (D5).
- **`normalizeBindings` merges.** Today a stored list missing any action
  falls back to the defaults entirely (line 70). Unchanged, adding
  `search` would silently reset every user's custom controls. Instead, a
  missing action gets its default bindings, minus any stroke the user has
  given to another action. The same merge serves any later action.
- **`act()` dispatches exhaustively** (`routes/cascades/[id]/+page.svelte`,
  307–309). Today any action that isn't Show / Next or Toggle runs
  Previous. It becomes a `switch` with a `never` check.
- **`ControlsEditor.svelte`** gains a "Search" row. Its rules apply as
  they are:
  - one stroke belongs to one action
  - an action keeps at least one binding
  - at most 64 bindings
  - Escape can't be bound
- **The player's `onKey`:**
  - The `search` action works whenever a quiz is on screen, including the
    completion screen.
  - While Search is open, only `search` and Escape act, and a plain
    character key belongs to whichever text box has focus.
  - In typed mode a plain Q is still the input's (`inputOwns`), so Alt+Q
    is the stroke that works there. ControlsEditor already explains
    strokes a browser may keep (`mayNotReceive`), and Alt+Q gets the same
    note on macOS.
- **The binding is part of the `bindings` setting**, so it is saved for
  this cascade on this device and offers to widen, like the other
  controls. A preset carries it.

## Keeping the quiz as it was

- **The overlay is rendered inside the player page.** A `SearchView`
  component sits in a full-area layer over the quiz area, below the status
  bar. The quiz underneath is `inert` while Search is open. Nothing
  unmounts, so the `Player`, the reveal, the typed words, the toggled
  grade, the fit and the scroll all stay as they are.

  Navigating to `/search` and back would rebuild the `Player`: `load()`
  reads every question row of the quiz, and up to 300,000 questions is not
  instant. It would also lose the reveal and the typed words, which live
  only in memory.
- **The search's state lives in `lib/search/state.svelte.ts`.** That
  module holds the lexicon, the filter form, the sort, the columns and the
  scroll position, and both the overlay and `/search` read it. It is saved
  to `meta` (`search_state`) a second after each change, so a reload keeps
  the search.
- **The worker starts when the player mounts**, and loads the cascade's
  lexicon if its pack is on the device. The first Q then waits for nothing.
- **`/search`** is a route of its own and renders the same `SearchView`.
  - It needs a "Search" link in `AppHeader`'s `links`, and a Search item
    in the player's `menuItems`.
  - The root layout's `PLAYER` regex hides the header on the player only,
    so `/search` keeps the header.

## Code

| Where | What |
|---|---|
| `backend/lexicon/` (new crate) | `catalog::{tiles, probability, pos, roots, index}` and `search::{wire, validate, pattern, engine, search()}`, moved; the `Clock` trait; In Lexicon through a lookup |
| `backend/src/catalog`, `backend/src/search` | Re-export the crate; `routes`, `saved`, `store` and `Snapshot` stay |
| `backend/src/catalog/routes.rs` | The two pack routes; pack sizes in `/api/lexicons` |
| `backend/search-wasm/` (new crate) | The `wasm-bindgen` interface; sorting, row slices and TXT/CSV chunks for the list |
| `frontend/src/lib/search/` | `worker.ts`, `client.ts` (a typed wrapper over the worker's messages), `packs.ts` (download, store, refresh), `state.svelte.ts` |
| `frontend/src/lib/components/search/` | `SearchView.svelte`, `ResultList.svelte` (virtualized), `DownloadMenu.svelte` |
| `frontend/src/routes/search/+page.svelte` | The standalone page |
| `frontend/src/routes/cascades/[id]/+page.svelte` | The overlay, `searchOpen`, key gating, the ☰ item and the 🔍 button, `act()` exhaustive |
| `frontend/src/lib/player/bindings.ts`, `ControlsEditor.svelte` | The `search` action, the merge in `normalizeBindings` |
| `frontend/src/lib/builder/form.ts` | `newRow('anagram_match', …)` as Search's start; a quiz context of "words" for `appliesTo` |
| `frontend/src/lib/local/db.ts` | Version 5: `lexicon_packs` |
| `frontend/src/routes/account/+page.svelte` | The packs under "On this device", with Remove |
| `frontend/src/service-worker.ts` | Precache the `.wasm` |
| `Makefile`, `frontend/vite.config.ts`, CI | Build the wasm before the frontend |

## Order of work

1. **The spike.** Build CSW24's index in wasm and take the measurements
   above. Its result decides whether definitions go into the index (D3).
2. **The crate.** Move the modules, cut the three seams, and change no
   behaviour. The server's tests, the contract test and `make test-parity`
   pass unchanged.
3. **The engine in the browser.** Build `search-wasm`, the worker, the
   pack routes, `lexicon_packs` and the downloads. Add a test that the
   wasm and the native engine agree.
4. **`/search`.** The page, the list, sorting and columns, Load Search…
   and Save Search…, and New cascade from this search.
5. **Download.** TXT and CSV from the worker.
6. **From a quiz.** The overlay, the `search` action, the merge in
   `normalizeBindings`, `act()` made exhaustive, ControlsEditor, the ☰
   item, the 🔍 button and the history entry.
7. **Account.** The packs, their sizes and Remove.
8. **Docs.** PLAN.md: a new § Search page, § What needs a connection,
   § Controls, § On the device and § Catalog and search (the pack
   routes). Then JOURNEYS.md, and this file's status.

Steps 2 and 3 can ship before any UI. The server is unchanged by them
apart from the two routes.

## Tests

- **Rust:**
  - The crate keeps the moved modules' tests.
  - A new test runs the search vectors through `search-wasm` built for
    the host, and checks them against the native engine on the fixture
    catalog (EN-FIX, CA-FIX).
  - The pack routes: the format, revision in the URL, signed-in only, and
    the rate limit.
- **Vitest:**
  - `bindings.test.ts`: a stored list without `search` keeps its custom
    bindings and gains Q and Alt+Q. A list where the user already gave Q
    to another action gains only Alt+Q.
  - `act()` covers every action.
  - `packs.test.ts`: download, replacing a pack on a newer revision, and
    Remove.
  - The TXT and CSV formatter for search rows, which shares
    `format.ts`'s quoting.
  - `state.svelte.ts` survives a reload through `meta`.
- **e2e, a new `search.spec.ts`** on the fixture catalog:
  1. `/search` opens with one Anagram Match row.
  2. A pattern lists the fixture's words, with the count.
  3. Sorting and columns work.
  4. The CSV download's contents are right.
  5. The context goes offline (`context.setOffline(true)`) and a new
     search still works.
  6. In a quiz: reveal an answer, press Q, search, press Q. The same card
     is still revealed.
  7. In typed mode, type two words, press Alt+Q twice. The words are
     still there.
  8. On a phone viewport, the ☰ item opens Search and Back closes it.
- **Locally, run only the files touched**, one at a time. The full suites,
  parity and the browser tests run in CI, as usual.

## Decisions

Each has a recommendation, marked **Recommended**.

- **D1. Where searching runs.**
  - **Recommended: the server's engine, compiled to WebAssembly.** One
    engine gives one set of results and keeps Zyzzyva parity, and it is
    the only option that works fully offline without rewriting 24 filter
    types.
  - *A TypeScript port* would also work offline, but it would be a second
    engine to keep in step: lax probability ranking, Limit by, hooks,
    roots and pattern semantics.
  - *A server endpoint only* would be the least work, but Search would not
    work offline at all.
- **D2. One row per word.**
  - **Recommended: rows sorted by alphagram, with bands per anagram set.**
    This is what Zyzzyva shows, and the band gives the anagram view
    without a separate mode.
  - *One row per alphagram, as in an Anagram quiz,* puts many words on a
    line and makes the download harder to use.
- **D3. Definitions.**
  - **Recommended: a separate pack, fetched when first needed.** Most
    searches never read a definition. The core pack is under a third of
    the total, and the index stays small on phones.
  - *One pack* would be simpler, but a phone pays about 3.3 MB more, and
    the memory, up front.
  - The spike may settle this.
- **D4. Leave Value is not on Search.**
  - **Recommended: leave it out.** Search lists words. Leaves would need
    the leave set (12.8 MB raw for CSW24), and leaves are a different
    kind of list. It can come later as a "Leaves" switch.
- **D5. The default keys: Q and Alt+Q.**
  - **Recommended.** A plain Q can't work while typing, because Q is a
    letter of the answer.
  - Ctrl+Q quits Firefox on Linux and Windows, and Cmd+Q quits a Mac
    browser, so neither can be the default.
  - Alt+Q is reachable everywhere the browser passes it on.
- **D6. An overlay in the player, plus `/search`.**
  - **Recommended.** Only an overlay is instant and keeps a revealed or
    typed card, and `/search` serves searching outside a quiz. The two
    share one state.
  - *Navigating to `/search` from the player* rebuilds the quiz on return
    and loses the reveal and the typed words.
- **D7. No cap on results.**
  - **Recommended.** Zyzzyva has none. The list is virtualized and the
    download streams from the worker. The 2,000 ms deadline is the only
    limit, as on the server.
  - *Capping at the 300,000 questions a cascade allows* would make no
    difference, since no lexicon is larger.
- **D8. Serving whole lexicons.**
  - Packs put a licensed word list, and its definitions, on any signed-in
    device. In practice a user can already get the same thing: create a
    cascade with Length 1–15 and export it with definitions.
  - **Recommended:** signed-in accounts only, the search rate limit, no
    public caching, and a note in PLAN.md § Catalog and search beside the
    licensing note. Check the terms the lexicons are used under before
    launch.
- **D9. The first download is automatic.**
  - **Recommended.** Opening Search asks for it, and about 1.4 MB is less
    than many pages load.
  - *Asking first* adds a step every time a lexicon is new.
- **D10. Saved searches and the builder.**
  - **Recommended:** reuse Load Search… and Save Search… as they are
    (online only, as with presets: SETTINGS_PLAN.md D4), and add "New
    cascade from this search".
- **D11. Packs stay until removed.**
  - **Recommended:** no automatic eviction. They are small, and a pack
    evicted on a train means no Search there. They are listed on Account
    with their sizes and a Remove button.
  - *Counting packs toward the 500 MB answer-card budget* would let a
    large cascade push the lexicon out.

## Found on the way

Two existing hazards that this work fixes as part of the `search` action:

- `normalizeBindings` replaces a whole custom list with the defaults when
  any action is missing (`bindings.ts:70`).
- `act()` runs Previous for any action it doesn't name
  (`+page.svelte:307–309`).
