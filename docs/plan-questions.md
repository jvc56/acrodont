# Plan questions

Ambiguities, contradictions or impossibilities found in PLAN.md, with the
provisional choice made. Code affected is marked `// PQ-nnn`.

## PQ-001 — Tailwind `darkMode: 'class'` under Tailwind v4 (open)

- **Plan:** Tech Stack (PLAN.md 1604): "shadcn-svelte, dark mode only (Tailwind
  `darkMode: 'class'` with `dark` always on the root)".
- **Issue:** `darkMode: 'class'` is Tailwind v3 config syntax. Current
  shadcn-svelte (1.x) requires Tailwind v4, which has no `darkMode` key; the v4
  equivalent is `@custom-variant dark (&:where(.dark, .dark *));` in CSS.
- **Options:** (a) Tailwind v4 + current shadcn-svelte with the class-based
  custom variant; (b) Tailwind v3 + the legacy shadcn-svelte 0.x line.
- **Provisional choice:** (a). Behaviour is identical (class-based dark mode,
  `class="dark"` always on `<html>`). Marked in `frontend/src/app.css`.

## PQ-002 — Auth wire details the plan leaves unnamed (open)

- **Plan:** Authentication (3871–4056), API → Auth and account (4084–4100).
- **Issue:** The plan names the session cookie (`acrodont_session`) and the
  endpoints but not: the CSRF cookie and header names; the shape of the
  register `400` ("every field error at once"); the success statuses and
  bodies of register, confirm, reset and the account endpoints; the request
  field names of confirm, reset-confirm, change password and delete; the
  password length bounds ("strength with zxcvbn (score ≥ 3) and length").
- **Provisional choices:** CSRF cookie `acrodont_csrf`, header
  `X-CSRF-Token`; field errors `400 { errors: [{ field, message }] }` (the
  search endpoints' `{ path, field, message }` minus `path`); register and
  reset-password `202 {}`; confirm, reset-confirm, sign-out-everywhere,
  password and delete `204`; login `200` with the `/api/auth/me` body;
  bodies `{ code }`, `{ email }`, `{ token, password }`,
  `{ current_password, new_password }`, `{ password }`; passwords 8–128
  characters. Wrong credentials `401 { error: "unauthorized" }`, unconfirmed
  `403 { error: "email_unconfirmed" }`, bad code/token
  `400 { error: "invalid_code" | "invalid_token" }`.
- Marked in `backend/src/auth/session.rs`, `backend/src/auth/password.rs`,
  `backend/src/error.rs`, `frontend/src/lib/api.ts`.
- **Since PQ-022:** there is no change-password endpoint, so its body
  `{ current_password, new_password }` and its `204` no longer apply; the
  length bounds stand, for registration and a reset alike.

## PQ-003 — Which responses slide the session TTL (open)

- **Plan:** Authentication (3946–3949): "a sync made in the last seven days of
  a cookie's life is answered with a fresh cookie of the full TTL".
- **Issue:** Only sync is named; `GET /api/auth/me` "re-sets" the CSRF cookie
  but is not said to renew the session.
- **Options:** (a) renew on sync only; (b) renew on every authenticated request.
- **Provisional choice:** (a), literal. `session::renewal` is applied by the
  sync handler (Phase 6); its integration test lands with the sync endpoint.

## PQ-004 — `governor` cannot express the login-failure buckets (open)

- **Plan:** Tech Stack names `governor`; Authentication → Login requires a
  request refused "before any Argon2 verify runs when either bucket is empty",
  with "a token taken from both only when the verify fails" and "a successful
  login spends nothing".
- **Issue:** `governor` only offers check-and-take; it cannot peek at a bucket
  without spending it, nor refund.
- **Provisional choice:** every other limit uses `governor`; the two
  login-failure limits use a small in-house bucket with the same quota
  semantics (`n` per minute, burst `n`) whose token can be given back
  (`backend/src/rate.rs`, `FailureBuckets`). A login takes its tokens before
  the verify and returns them unless the verify fails: inspecting the bucket
  first and spending it afterwards, the first form of this, let every request
  of a burst through, and PLAN.md now states the take-and-return form.

## PQ-005 — "/api/lexicons omits an item while a second instance is still completing its startup load" (open)

- **Plan:** Integration tests (5390–5393) vs. Admin → Loading changes
  (1214–1216): "An instance writes **no** rows until its startup load is
  complete ... so a task still booting during a deploy never makes an item
  look unloaded".
- **Issue:** A booting instance has no rows, so it is not "live" and cannot
  hold an item back; the test sentence reads as if it should.
- **Provisional choice:** follow the Admin section (the mechanism). The test
  is written as: an item is omitted while a **live** second instance (one with
  rows) has not yet loaded it, and listed once that instance writes its row;
  a separate assertion checks that a booting instance hides nothing
  (`backend/tests/catalog.rs`).

## PQ-006 — A distribution's tile count is capped at 256 (open)

- **Plan:** Search Engine (1737–1739) has the engine compare "small tile
  indexes (`u8`)"; File formats sets no cap on the number of tiles.
- **Provisional choice:** the upload validator refuses a distribution with
  more than 256 tiles (every MAGPIE-DATA file has under 40), so a tile index
  always fits a `u8` (`backend/src/catalog/tiles.rs`, `upload.rs`).

## PQ-007 — Upload errors that belong to no line (open)

- **Plan:** API → Admin: "`400` with `{ errors: [{ line, message }], total_errors }`".
- **Issue:** Form-level problems (name taken or malformed, unknown
  distribution or lexicon, lexicon already has leave values, missing file,
  empty file, body too large) have no line.
- **Provisional choice:** the same `400` shape with `line: null`.

## PQ-008 — The shape of an Anagram card's `answer` (open)

- **Plan:** API → Cascades and sync (card pages): cards are
  `[{ idx, key, answer }]`; a Leave Value answer is a JSON number; Answers
  (674–703) describes what is shown, not the JSON.
- **Provisional choice:** Definition → the definition string; Leave Value →
  the number (shortest round-trip text); Anagram → an array, in alphabetical
  order, of `{ word, front_hooks?, back_hooks?, definition? }`, words and hook
  lists in MAGPIE notation (hooks already in tile order, `""` when none),
  `front_hooks`/`back_hooks` present only with `hooks=1` and `definition` only
  with `definitions=1`. Creation's `sync_seq` is decimal text like every other
  sequence on the wire. (`backend/src/cascade/routes.rs`)

## PQ-009 — In Word List entry order (open)

- **Plan:** Integration tests (5582–5585): a saved tree with a 10,000-entry
  In Word List read back "equal to what was sent, child order included";
  Schema: `search_condition_words` has `PRIMARY KEY (spec_id, position,
  entry)` and no ordering column.
- **Issue:** Entry order and duplicates cannot survive the schema.
- **Provisional choice:** entries are a set: stored deduplicated and read back
  sorted by byte order (`COLLATE "C"`). The builder's WordListEditor sends
  them sorted and deduplicated, so a round trip is exact.
  (`backend/src/search/store.rs`)

## PQ-010 — What the builder knows client-side (open)

- **Plan:** Creating a cascade (step 8) has the preview keep a reserve of "all
  but two of `SEARCH_RATE_PER_MINUTE`"; Frontend → WordListEditor shows "how
  many entries are not valid in the lexicon".
- **Issue:** `SEARCH_RATE_PER_MINUTE` is server configuration the client is
  never told (`/api/auth/me` reports only the retention period and the question
  cap), and lexicon membership needs the server's word list.
- **Provisional choices:** the reserve is measured against the default, 30, a
  constant in `lib/sync/config.ts`; the editor's "not valid" count is
  structural — entries that do not parse in the distribution for the quiz
  type, have the wrong tile count, exceed the bag (leaves) or are not in
  canonical order — which is also what the plan's type-change recount test
  describes. Words that parse but are not in the lexicon are ignored by the
  server's search as the plan says.

## PQ-011 — "exactly 8 chain quizzes" from 40 questions at S = 5 (open)

- **Plan:** Contract fixtures (4822–4824): "an attempt of 40 questions with
  S = 5 and every run missing something creating exactly 8 chain quizzes, the
  `ceil(question_count / S)` bound"; Segments (292–297): only a run that is
  **not the last run** descends as a chain quiz, and "the last run always ends
  at the last question, where finishing the attempt applies the rules above".
- **Issue:** 40 / 5 has 7 boundaries strictly inside the quiz, so the rules
  create 7 segment (chain) quizzes; the 8th run's misses go to the `finish`,
  which creates one descent (or replacement) quiz, not a chain quiz. The bound
  `ceil(q / S)` is met by the attempt's created quizzes, 7 + 1 = 8.
- **Provisional choice:** the rules as written. The vector
  (`contract-fixtures/cascade/rules.json`, "the ceil(question_count / S)
  bound") and both modules' tests assert 8 quizzes created by the attempt, of
  which 7 are segment chains.

## PQ-012 — The wire form of `cursor`, `seen_seq` and `sync_seq` (open)

- **Plan:** API (4177) gives the sync body `{ device_id, app_version, cursor, … }`
  and the response's `sync_seq` without a type; § API (4186–4196) has every
  pulled row's `updated_seq`, tombstone `seq` and `min_updated_seq` "as decimal
  text".
- **Issue:** Sequences are `BIGINT`s; the plan says nothing about whether the
  request's `cursor` and each operation's `seen_seq` are JSON numbers or text,
  or how `sync_seq` is sent.
- **Provisional choice:** `sync_seq` is sent as decimal text, like the other
  sequences on the wire; `cursor`, `seen_seq` and `device_seq` are accepted
  as a JSON integer or as decimal digits (`backend/src/sync/routes.rs`,
  `// PQ-012`). The device sends numbers (sequences stay far below 2^53).

## PQ-013 — Check order for `finish` and `finish_segment` (open)

- **Plan:** Operations table (2371–2372) lists, for both, "the quiz is active,
  its cascade is not trashed, it is at the deepest level, the attempt and its
  seed match, …, no quiz already exists for this quiz, attempt and segment
  end". Conflicts (2805, 2810, 2811, 2816) and the Sync integration tests
  (5423–5428, 5480–5484): a second `finish` after one that **reset** the quiz
  is `stale_attempt`; the loser of a race on one boundary, and a device whose
  run another device already passed, get `duplicate_segment`; "a
  `finish_segment` after a `finish` is rejected because its attempt is out of
  date".
- **Issue:** Read as an order, the table's list makes those outcomes
  unreachable: a finish that descended, and a `finish_segment` that drilled,
  both add a level below the quiz, so the depth check would answer
  `not_deepest` first.
- **Provisional choice:** the table's conditions all hold, checked in the order
  the Conflicts table and the tests require: live (active, not trashed), then
  the attempt and seed, then — for `finish_segment` — the segment end's
  validity and the duplicate, then the depth, then the cursor test and the
  grading. Applied identically in `contract-fixtures/tools/reference.py`,
  `backend/src/cascade/sim.rs`, `backend/src/sync/ops.rs` and
  `frontend/src/lib/cascade/sim.ts` (each marked `PQ-013`), with a new rule
  vector ("the attempt and a duplicate run come before the depth") that pins
  it. The "Two different quizzes restored" row's `not_deepest` is unaffected,
  since that finish carries a current attempt.

## PQ-014 — "K answers from this device weren't kept." when K is 1 (open)

- **Plan:** Conflicts (after the table): 'The second sentence, "K answers
  from this device weren't kept.", appears only when K is greater than 0.'
- **Issue:** Read literally, K = 1 gives "1 answers … weren't kept."
- **Provisional choice:** "1 answer from this device wasn't kept." for one,
  the literal sentence otherwise (`frontend/src/lib/sync/notices.ts`,
  `keptSentence`).

## PQ-015 — Where the device learns the cascade limit (superseded by PQ-023)

- **Plan:** Cascade limit (405–427): "The Cascades page shows `87 of 100
  cascades`, and the cascade builder shows a warning from 90";
  API (4094): `/api/auth/me` returns `{ user_id, username, is_admin,
  trash_retention_days, max_quiz_questions }` — no limit.
- **Issue:** `MAX_CASCADES_PER_USER` is configurable on the server, but no
  endpoint reports it before a `409 { error: "cascade_limit", limit }`.
- **Provisional choice:** the device uses the documented default, 100, as a
  client constant (`frontend/src/lib/cascades/summary.ts`, `CASCADE_LIMIT`),
  with the warning from 90, as PQ-010 does for the search rate. The server's
  `409` still refuses creation at its own configured limit.
- **Since PQ-023:** there is no cascade limit. `/api/auth/me` and every sync
  response report the account's storage and its effective limit
  (`storage_bytes`, `max_storage_bytes`; `storage: { used, limit }`), which
  the device keeps in `meta.server`; `DEFAULT_STORAGE_LIMIT` in
  `lib/cascades/storage.ts` stands in only until the server has reported one.

## PQ-016 — The expired-session journey's TTL (open)

- **Plan:** End-to-end tests (5686–5688): "`SESSION_TTL_SECONDS=2` for the
  expired-session journey".
- **Issue:** The journey must create a cascade and let it download before it
  goes offline, and every request in that setup needs a live session; with a
  two-second TTL the session lapses during setup (the sliding renewal only
  comes with a sync), so the journey cannot reach its offline part.
- **Provisional choice:** the `@ttl` pass runs its stack with
  `SESSION_TTL_SECONDS=20` and waits 25 s offline before reconnecting
  (`Makefile`, `e2e/tests/env.spec.ts`). The journey's steps and assertions are
  the plan's.

## PQ-017 — The forty-cascade drop pass (open)

- **Plan:** Scale tests (6321–6336): forty 130,000-question cascades inside
  the window, all automatically kept; the pass "brings the base's rows and
  keys under `ROW_STORAGE_BUDGET` … oldest last-open first and no more than
  needed, the most recently opened still whole". Downloads (2534–2536): the
  pass drops "until the total is under the budget"; Local size (2491):
  "roughly 100–200 bytes per question per level".
- **Issue:** Whether forty cascades exceed 2 GB at all depends on the per-row
  estimate: with about 56 bytes per measured English key, they are over only
  when a row counts for more than about 123 bytes. The first estimate, 120,
  left them under budget, so the pass had nothing to do.
- **Provisional choice:** `ROW_BYTES` is 150, the middle of the plan's range
  (`frontend/src/lib/sync/downloads.ts`). The pass stops once under budget, so
  it drops only a few of the cascades. The scale test
  (`frontend/src/lib/sync/scale-drop.scale.ts`) takes "still whole" to mean
  the most recently opened cascade: it asserts that one is whole, that the
  dropped cascades are exactly the oldest-opened ones, just enough to fit
  under the budget, and that the next sync's `question_rows_for` names
  exactly the cascades still holding rows.

## PQ-018 — The answer-limit journey and the automatic keep (decided)

- **Plan:** End-to-end tests (6196–6200): "Over the answer limit with two
  automatic keeps, see the least recently opened one's answers freed while its
  questions still show in the player". Downloads (2464–2465): "An automatic
  keep by size protects a cascade's rows from the window alone, never its
  cards".
- **Issue:** An automatic keep never protects cards, so over the limit the pass
  evicts the least recently opened cascade's answers whether or not it is kept
  automatically, and nothing the user does on the Account page changes that.
- **Choice:** eviction follows the Downloads rule. The journey
  (`e2e/tests/budget.spec.ts`) opens the first cascade before the second and
  checks the first one's answers are gone while its keys stay, and that the
  Account page lists both with their answer and key sizes. Its question still
  shows in the player, it reads "Answers need a connection" offline, and it
  shows download progress again online.

## PQ-019 — Device scale cases too large to run in minutes (decided)

- **Plan:** Scale tests (5930–5985):
  - After opening ten 300,000-question cascades, the sync of about 3.75
    million graded rows "finishes in under 120 seconds on the CI runner".
  - The drop pass runs on "forty such cascades", with the heavy one also
    holding "five cleared 150,000-question levels".
- **Issue:** The device's budgets are about IndexedDB, and Chromium's
  IndexedDB wrote about 7,500 indexed rows a second on the development
  machine, however the writes were batched. At that rate:
  - 3.75 million graded rows take about eight minutes just to write once,
    against the 120 s budget, which implies about 31,000 rows a second.
  - Forty 300,000-question cascades are about 24 million writes (rows and
    keys) before the pass even starts, most of an hour.

  Each full-size run therefore takes from twenty minutes to over an hour.
  The user has asked that no test take that long.
- **Provisional choice:** Both cases run at a tenth of their rows, with
  budgets and limits scaled by the same tenth. Everything else in the device
  suites runs at the plan's size.
  - First sync (`frontend/src/lib/sync/scale-first-sync.scale.ts`): ten
    cascades, as the plan says. One of them is played as the plan describes:
    375,000 graded rows in 8 pages, against 12 s.
  - Drop pass (`frontend/src/lib/sync/scale-drop.scale.ts`): forty
    30,000-question cascades, the heavy one with five cleared 15,000-question
    levels. `ROW_STORAGE_BUDGET` and `AUTO_KEEP_OFFLINE_ROWS` are mocked to a
    tenth for that file.

  - Keys-only pass (`frontend/src/lib/sync/scale-keys.scale.ts`): three
    300,000-question cascades rather than ten. The ratios are per cascade and
    need the full size, since a smaller cascade fits its keys in one page
    against several of answers. Ten cascades cost six million writes before
    the pass finishes, about a quarter of an hour. Three give 9 requests
    against 90, the same tenth.

  Whether 120 s for 3.75 million rows is reachable on real devices is itself
  open: it implies about four times the write rate measured here.

- **Decision (2026-11-09):** The first-sync case keeps its shape, one heavily
  played cascade of ten, but its budget is the measurement rather than a tenth
  of the plan's 120 s: 162,500 graded rows (at the 130,000-question cap) took
  49–107 s in Chromium across runs (slower after other suites have filled the
  browser profile), 1,500–3,300 graded rows a second, so the budget is 150 s. Meeting 12 s would take about 13,500 a second, which a row per
  question in IndexedDB cannot reach; only storing rows differently on the
  device could. The cost is one-time, for a new device opening a cascade with
  a long history, and the user accepted it. The drop pass runs as many
  cascades as an account may hold (20) at 56,000 questions each against a
  tenth of the budget.
- **Since PQ-023:** there is no cascade count to hold. The drop pass keeps
  its twenty 56,000-question cascades as a case of many automatic keeps, and
  `scale-many.scale.ts` covers an account of 500 smaller cascades. The device
  suites' `QUESTIONS` is 300,000 again. The first-sync budget of 150 s was
  set at the 130,000-question cap for 162,500 rows. CI measured 164 s for
  375,000 rows at 300,000 (2,290 a second, inside the measured range), so it
  is now 300 s: the worst measured rate, 1,500 a second, at this size (250 s),
  with room to spare.

## PQ-020 — Two kinds of settings, no defaults for new cascades (decided)

- **Plan:** User Experience → Preferences, as it stood before this decision:
  four scopes (this cascade, every cascade, new cascades, this device), an
  account-level `user_preferences` row changed by `set_preferences` and pulled
  as `preferences`, a Preferences page at `/preferences`, a builder prefilled
  from the `Default …` preferences, and a change to a cascade's setting
  offering "new cascades" or "all N cascades and new ones".
- **Issue:** The four scopes overlapped: an answer mode or threshold lived on
  each cascade and again as a default for new ones, and definitions, hooks,
  the reveal grade and leave rounding applied to every cascade at once with no
  way to set them for one. A user changing a setting had to know which of
  four places held it, and the builder carried settings most users never
  changed at creation.
- **Decision (2026-11-11):**
  - There are two kinds of settings, which do not overlap: **a cascade's**
    (synced, on the `cascades` row) and **this device's** (display and
    controls, in `meta`, never synced). They are called **settings**
    everywhere a user sees them; "preferences" is gone.
  - No account-level settings: `user_preferences`, `set_preferences`, the
    pull's `preferences` object and the IndexedDB `preferences` store are
    removed. Definitions, hooks, the reveal grade and leave rounding move onto
    each cascade (`show_definitions`, `show_hooks`, `reveal_correct`,
    `leave_value_decimals`), carried by `set_cascade_options`. A
    `set_preferences` from an old build is `invalid`, and the device's
    version-3 migration drops any still queued.
  - No defaults for new cascades: every new cascade starts with the same
    fixed settings (`CASCADE_SETTING_DEFAULTS`), and the builder shows none,
    only a note that they are changed in the cascade's Settings.
  - All settings are edited in one place, the cascade's Settings dialog in the
    player, each saved as soon as it is changed. A change offers "all N
    cascades" (of the kind the setting applies to) when there are at least
    two; **Copy another cascade's settings** gives this cascade, in one
    `set_cascade_options`, every setting of a chosen cascade that applies to
    it. Both are ordinary `set_cascade_options`, so they work offline and
    resolve latest-wins like any options change.
  - PLAN.md § Settings, § Creating a cascade, § Desktop layout, § Operations,
    § Conflicts, § On the device and § Schema describe the result.

## PQ-021 — Explanations inline, the Trash on the Cascades page, a smaller header (decided)

- **Plan:** User Experience, as it stood before this decision: each setting's
  explanation behind an ⓘ beside its name (`InfoTip`), shown on hover or
  focus; the Trash its own page at `/trash`; the site header and the player's
  menu linking to Cascades, New cascade and Trash; and the player's Settings
  opening with a row of buttons jumping to its sections, "This cascade" and
  "This device", and Controls.
- **Issue:** An explanation behind a hover is missed on a phone and unread on
  a desktop, and the ⓘ added an extra target to every row. The Trash on a
  page of its own split the cascades from what had been trashed of them,
  though it is where a user at the cascade limit has to go. With New cascade
  and the Trash on the Cascades page, the header's links repeated what that
  page already holds. In Settings, the section names read as ordinary prose
  and the two sections ran together, and the jump row took space in a dialog
  with only two sections.
- **Decision (2026-11-11):**
  - Every setting's explanation (`INFO` in `lib/settings-info.ts`) is written
    in muted text directly under its name by `SettingRow`, followed by any
    hint. `InfoTip` is removed; nothing is hidden behind an icon. The clear
    threshold's hint "For every level, the pass in progress included" is
    dropped, since its explanation says the same.
  - The Trash is a section of the Cascades page, below the cascades
    (`TrashList`, `id="trash"`), with the same grouping, paging and actions.
    `/trash` only redirects to `/cascades#trash`. Links to the Trash at the
    cascade limit go there.
  - The site header holds Acrodont (to the Cascades page, the landing page),
    Admin for admins only, the sync status and the account link; a regular
    user's header has no Main nav. The player's menu holds Acrodont, Admin
    for admins, Account and Settings.
  - The Settings dialog's header is "Settings" and Close, with no jump row.
    Its sections are **Cascade Settings** (Synced) and **Device Settings**
    (Not synced), each opening with a full-width shaded bar and a larger
    heading; Controls stays a subheading of Device Settings, and its reset
    reads **Reset controls to defaults**.
  - PLAN.md § Settings, § Cascade limit, § Cascades page, § Trash, § Desktop
    layout, § Controls, § Exporting words, § Frontend and § End-to-end tests
    describe the result.

## PQ-022 — Password changes and resets match birdtest (decided)

- **Plan:** Authentication, as it stood before this decision: **Change
  password** on `/account` (`POST /api/account/password`, the current and the
  new password, bumping `session_generation` and re-issuing this session)
  beside a reset by email; the strength rule ("`zxcvbn` (score ≥ 3) and
  length") at registration only, scored against the username and address
  whole, on the request's own thread; a reset limited only by the shared
  per-IP auth bucket and the email caps, its mail carrying only the link, and
  no rule named for its new password.
- **Issue:** Two ways to set a password, hardened differently, where birdtest
  has one. A reset's new password was scored without the account's username
  or address, so it could be either. Asking
  for a reset could bury one address in mail from many sources, and a link
  refused a password could be replayed without bound. zxcvbn matched the
  address whole, so `jsmith` passed for `jsmith@example.com`, and a crafted
  password cost close to a second of scoring on the executor, stalling every
  request behind it.
- **Decision (2026-11-11):** Match birdtest (`PLAN.md` § Password Reset Flow).
  - No signed-in password change: the route, the Account page's card and its
    client call are gone. A reset by email is the one way to change a
    password. Sign out everywhere and delete account, each with password
    re-entry, stay on `/account`.
  - One strength rule for registration and a reset: length, then a `zxcvbn`
    score of at least 3 against the username, the address and the address's
    local part. Scoring runs on the blocking pool in turns of its own, at most
    2 at once; a request waits at most 10 seconds for a turn, else `503` with
    Retry-After 10.
  - Asking for a reset still always answers `202 {}`, with the lookup and the
    email after the response, and is now also limited to
    `RESET_RATE_PER_HOUR` (new, default 5) per caller and per address named,
    answered `429` alike for every address. The mail carries the account's
    username, since signing in asks for it. The link still lasts 30 minutes.
  - Setting the new password reads the link first, without a lock, so a wrong
    or spent link is `400 invalid_token` and costs neither a score nor a hash;
    then takes a scoring turn and charges the link's own
    `RESET_RATE_PER_HOUR` bucket, whoever sends it (a link refused a weak
    password still works); scores against the account's username and address
    and hashes, both outside any transaction; then locks the account row,
    spends the token and every other outstanding one, stores the hash and
    bumps `session_generation`. The `204` clears the caller's cookies, and the
    page goes to `/login` with no message.
  - The length bounds stay acrodont's own, 8–128 characters (PQ-002); birdtest
    is followed for the reset's hardening, not for its bounds.
  - PLAN.md § Authentication, § Auth and account, § Frontend,
    § Configuration, § Unit tests and § Integration tests, and JOURNEYS.md
    V-6, V-10 and V-11, describe the result.

## PQ-023 — One storage limit instead of cascade limits (decided)

- **Plan:** § Cascade limit and § Configuration, as they stood before this
  decision: at most 20 cascades an account, the Trash included
  (`MAX_CASCADES_PER_USER`, reported as `max_cascades_per_user`, refused with
  `409 cascade_limit`); at most 200 saved searches (`MAX_SAVED_SEARCHES_PER_USER`,
  `409 saved_search_limit`); at most 130,000 questions a cascade
  (`QUESTION_CEILING`, with the migration's CHECKs at 130000 and 129999 while
  § Schema still showed 300000 and 299999); and a sync request's
  `question_rows_for` bounded by the cascade limit.
- **Issue:** The count limits were blunt. Twenty cascades of 200 questions and
  twenty of 130,000 were both "at the limit", though the second account held
  hundreds of times the space, and nothing told a user how close they were to
  anything that mattered. The 130,000 ceiling left out any search over a whole
  lexicon. STORAGE_LIMIT_PLAN.md works it through.
- **Decision (2026-11-11):** One per-account storage limit, sized from what
  the owner named, in place of every count limit.
  - **D1, the default:** `MAX_STORAGE_BYTES_PER_USER` = 100,000,000 bytes
    (100 MB), sized from three cascades: every CSW24 anagram of 7 and 8
    letters (64,353 questions, 18.64 MB as created, 30.74 MB studied hard),
    every CSW24 definition of 7 and 8 letters (76,847 questions, 22.25 MB /
    36.70 MB) and 10,000 CSW24 leave values (2.88 MB / 4.76 MB). All three
    come to 43.77 MB as created and 72.20 MB studied hard, leaving 27.8 MB of
    headroom, 1.39 times the need. An account's own limit,
    `users.storage_limit_bytes`, can replace it, set only through SQL.
  - **D2, saved searches count:** a saved search's spec counts toward the same
    limit, so there is one limit. An In Word List entry costs about 110 bytes,
    so a 300,000-entry list is about 33 MB.
  - **D3, the question ceiling:** 300,000, so any word search over a whole
    lexicon fits. `QUESTION_CEILING`, `MAX_QUIZ_QUESTIONS`'s default and every
    schema CHECK are 300,000 / 299,999, and PLAN.md § Schema matches the
    migration again. The server's scale tests pass every budget at 300,000.
    A 300,000-question cascade is about 87 MB as created.
  - **D4, the Trash counts:** its rows are still stored and can be restored;
    only purging frees storage, after `TRASH_RETENTION_DAYS` or with Delete
    forever.
  - **D5, no count cap:** nothing bounds how many cascades or saved searches
    an account holds. `question_rows_for` gets a protocol bound of its own,
    `MAX_QUESTION_ROWS_FOR` = 1,000.
  - Storage is counted from row counts with fixed per-row sizes
    (`contract-fixtures/storage.json`), kept on `cascades`, `saved_searches`
    and `users` in the transactions that change the rows, checked only where
    something new is made (creation, Start over, saving a search, each
    refused with `409 storage_limit` and `used`, `limit`, `needed`), and never
    on studying. `MAX_CASCADES_PER_USER`, `MAX_SAVED_SEARCHES_PER_USER`,
    `cascade_limit` and `saved_search_limit` are gone.
  - PLAN.md § Overview, § Storage limit (in place of § Cascade limit),
    § Quiz options, § Creating a cascade, § Cascades page, § Trash, § Search
    Engine, § Working at 300,000 questions, § Operations, § The sync cycle,
    § Schema, § Purge task, § API, § Frontend, § Configuration, § Deployment
    and Operations (Capacity) and the test sections, and JOURNEYS.md C-2 to
    C-5 and C-14 to C-17, describe the result.
