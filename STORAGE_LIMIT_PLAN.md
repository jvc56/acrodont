# One storage limit instead of cascade limits: a plan

**Date:** 2026-11-11
**Status:** implemented on 2026-11-11. The five decisions (D1–D5, below)
were taken the same day (docs/plan-questions.md PQ-023). The default limit,
100 MB, is sized in "Sizing the default limit" from cascades the owner named.
PLAN.md § Storage limit is now the spec; this file records how it was
decided.

**Since then** the default was lowered to **10 MB** (`MAX_STORAGE_BYTES_PER_USER`
is `10000000`), once each level's questions were packed into chunks and the
same cascades came to a small fraction of the sizes below, and `MAX_ACCOUNTS`
was raised from 50 to 750. Every "100 MB" and "50" in this file is the
figure of the day it was written; PLAN.md § Storage limit has today's
sizing.

### Implementation status

- **The per-row sizes** are `contract-fixtures/storage.json`: `cascade_row`
  380, `question_row` 94 (plus the key's bytes), `quiz_row` 420,
  `quiz_question_row` 188, `attempt_row` 176, `spec_row` 380 and
  `spec_word_row` 100 (plus the entry's bytes). `backend/src/storage.rs` and
  `frontend/src/lib/cascades/storage.ts` carry them as constants, each side
  with a test keeping them equal to the file.
- **The calibration test** (`backend/tests/storage.rs`) reads the formula at
  1.012 times the measured live rows of a 20,000-question cascade made from a
  20,000-entry word list and studied through two half-missed finishes, well
  inside ±20%. The default was recomputed with the final constants: still
  100 MB (see "Sizing the default limit").
- **A single 300,000-question cascade is about 87 MB as created**, most of an
  account's 100 MB; it fits, with room for little else.
- **The In Word List figure is corrected:** an entry costs about 110 bytes, so
  a 300,000-entry list is about 33 MB, not the 6 MB PLAN.md once gave (S1,
  D2).
- **The recount** runs on every run of the purge task (hourly by default),
  not nightly: it recounts each user's total, and logs and corrects drift.
- **The per-account override** (`users.storage_limit_bytes`, S2) is included,
  set only through SQL.
- **The builder's figure is exact**, not the estimate from an average key
  length S6 describes: `POST /api/search/preview` reports `storage_bytes`,
  which is what creation then stores. The builder reads "This cascade will
  use about X. Y of Z used.", and "It won't fit: empty the Trash or delete
  cascades to make room." with Create disabled when it won't.
- **Scale at 300,000** (S5): the server's half passes every budget (creation
  5.4 s of 20 s, download 2.0 s of 60 s, push 376 s of 600 s, pull 0.9 s of
  60 s, finish 7.1 s of 20 s, exports 8.7 s and 473 MiB of 120 s and 2 GiB,
  purge 0.7 s of 30 s, capped purge runs 0.4–2.2 s of 10 s, incremental pull
  7–10 ms of 500 ms), so the ceiling is 300,000. The device's scale suites
  run at 300,000; `scale-many.scale.ts` reads 500 cascades' summaries and
  Trash groups within 10 s each, and `scale-drop.scale.ts` keeps its twenty
  large automatically kept cascades. Two integration tests (`sync_faults.rs`,
  `pull.rs`) stay at 130,000 questions.

## The goal

Today an account is held back by several separate limits on cascades: how
many it may have, how many questions each may hold, and how many saved
searches it may keep. They are blunt. Twenty cascades of 200 questions and
twenty of 130,000 are both "at the limit", although the second account uses
hundreds of times the space. The user also cannot tell how close they are to
anything that matters.

This plan replaces them with **one per-account storage limit**. Every
cascade-related count limit is either removed or raised so high it never
binds. The Cascades page shows how much storage each cascade uses and how much
of the account's allowance is left.

## Summary

| # | Change |
|---|---|
| S1 | Measure each cascade's server storage, in bytes, keep it on the cascade row, and keep a running total on the user row |
| S2 | One limit, `MAX_STORAGE_BYTES_PER_USER` (default 100 MB, D1), checked when something new is created: a cascade, a Start over, a saved search |
| S3 | Studying never fails for storage: levels made from misses may take an account over its limit, which then only blocks creating more |
| S4 | Remove `MAX_CASCADES_PER_USER` and `MAX_SAVED_SEARCHES_PER_USER` |
| S5 | Raise the question ceiling from 130,000 to 300,000 (D3), so any word search over a whole lexicon fits |
| S6 | The Cascades page shows each cascade's size, the Trash's, and the account's total against its limit; the builder shows what a new cascade will use |

## The limits there are today

Everything in the code that limits cascades, and what this plan does with it.

| Limit | Where | Today | This plan |
|---|---|---|---|
| Cascades per account, the Trash included | `MAX_CASCADES_PER_USER`, `cascade/routes.rs`, `/api/auth/me`, `session.cascadeLimit`, `lib/cascades/limits.ts` | 20 | **Removed** (S4) |
| Questions in a cascade's Source quiz | `MAX_QUIZ_QUESTIONS`, `config::QUESTION_CEILING`, and CHECKs on `cascades.question_count`, `quizzes.question_count`, `quiz_attempts.question_count`, `cascade_questions.idx`, `quiz_questions.question_idx` and `.position` | 130,000, which can be lowered but never raised | **Raised to 300,000** (S5, D3) |
| Segment size | `segment_size` CHECKs; `check_segment_size` | 5 to `MAX_QUIZ_QUESTIONS` | Follows the question ceiling |
| Saved searches per account | `MAX_SAVED_SEARCHES_PER_USER`, `search/saved.rs` | 200 | **Removed**; saved searches count toward storage (D2) |
| Cascades in one sync request's `question_rows_for` | `sync/routes.rs:104`, which compares against `MAX_CASCADES_PER_USER` | 20 | A fixed protocol bound, `MAX_QUESTION_ROWS_FOR` = 1,000 (see S4) |
| Levels in a cascade (`depth`) | none | Unbounded | Unchanged |
| A filter tree's In Word List entries | `API_MAX_BODY_BYTES` and the search's validation | 300,000 entries, 16 MB | **Unchanged.** It bounds one request's size, not what an account holds |
| Names: a cascade 1–200 characters, a saved search 1–100 | Schema CHECKs | | Unchanged. They are formats, not quotas |
| Rate limits (search, download, export, sync) | `*_RATE_PER_MINUTE` | | Unchanged. They limit speed, not holdings. `DOWNLOAD_RATE_PER_MINUTE` (120) was already sized for reopening one 300,000-question cascade per minute |
| Accounts | `MAX_ACCOUNTS` | 50 | Unchanged. Not a cascade limit, but it multiplies the storage limit into the database's worst case (D1) |
| This device's storage | `ROW_STORAGE_BUDGET` (2 GB), `ANSWER_STORAGE_SOFT_LIMIT_BYTES` (500 MB), `AUTO_KEEP_OFFLINE_ROWS` | | **Unchanged.** These decide what one device keeps downloaded, not what the account may own, and they already work by measured bytes |

## S1. Measuring a cascade's storage

### What counts

A cascade's storage is the bytes of the server rows the account owns because
of it:

- its `cascades` row
- `cascade_questions`: one row per question, the question key included
- `quizzes`: one row per level, active or in the Trash
- `quiz_questions`: one row per question per level
- `quiz_attempts`: one row per finished pass
- its private filter spec: `search_specs`, `search_groups`,
  `search_conditions` and `search_condition_words`. A 300,000-entry In Word
  List is about 33 MB (about 110 bytes an entry).

Answers, definitions and hooks are **not** counted. They are catalog data,
shared by every account and served from the lexicon tables.

Measured on Postgres 16, on copies of the real tables with their indexes, a
question costs about **102 bytes in `cascade_questions`** (about 94 bytes plus
its key). It also costs about **182 bytes in `quiz_questions` for each level
it is in**, graded; ungraded it is about 150. `quiz_questions` carries three
indexes. See "Sizing the default limit".

### How it is computed

The number is **computed from row counts with fixed per-row sizes**, not by
asking Postgres. `pg_column_size` over a cascade's rows costs a scan of
hundreds of thousands of rows, and table-level sizes cannot be split by
cascade.

```
storage_bytes = CASCADE_ROW
              + Σ cascade_questions (QUESTION_ROW + octet_length(question_key))
              + quizzes × QUIZ_ROW
              + Σ quizzes question_count × QUIZ_QUESTION_ROW
              + quiz_attempts × ATTEMPT_ROW
              + spec_bytes
```

- The question keys' total length is summed once, at creation, while the keys
  are in memory anyway.
- `spec_bytes` is computed once, when the spec is stored. A spec never changes.
- The count is of live rows. Studying updates `quiz_questions` rows, and the
  dead row versions it leaves are vacuum's to reclaim, not the user's to pay
  for. So the figure is what the account holds, not the files' momentary size.
- The per-row constants include index and tuple overhead. The measurement
  above gives `QUESTION_ROW` ≈ 94 and `QUIZ_QUESTION_ROW` ≈ 182 (the graded
  size, so a level's figure does not grow as it is studied). They are
  calibrated once against `pg_total_relation_size` on a test database, and an
  integration test keeps the formula within ±20% of measured growth, so a
  schema change that makes rows bigger fails the build instead of quietly
  under-counting. The final constants are `QUESTION_ROW` 94 and
  `QUIZ_QUESTION_ROW` 188, with the rest in "Implementation status"; the
  formula reads 1.012 times the measured live rows.

### Where it is kept

- **`cascades.storage_bytes BIGINT NOT NULL`**. The server sets it in the same
  transaction as every change to the row counts above:
  - creation and Start over set it
  - `finish` and `finish_segment` add the new level
  - `purge_quiz` subtracts the quiz
  - `purge_cascade` takes the whole cascade off the user's total

  Trashing and restoring change nothing, for a cascade or a quiz:
  `restore_quiz` reactivates the quiz's own row and adds none, and every row
  stays until it is purged.
- **`users.storage_bytes BIGINT NOT NULL DEFAULT 0`**: the account's total,
  updated in the same transactions. Creation already locks the user row, so
  the check in S2 reads the total without summing every cascade. The purge
  task recounts it from the cascades and saved searches on every run (hourly
  by default), and logs and corrects any drift.
- **The pull** carries `storage_bytes` on each cascade row, so the device
  shows sizes offline. It does not compute them: a finish made offline shows
  the old size until its sync returns the new row. The difference is at most
  one level, and nothing depends on the exact figure on the device.
- **`/api/auth/me`** reports `storage_bytes` and `max_storage_bytes` in place
  of `max_cascades_per_user`. The device keeps both in `meta`, as it keeps the
  cascade limit today.

Saved searches (D2) get a `saved_searches.storage_bytes` column, set when the
spec is stored and counted in `users.storage_bytes`.

The schema edits go into `0001_initial.sql` in place and are logged in
`docs/migration-edits.md`, as that file's process says while the migration is
undeployed.

## S2. One limit, checked where something new is made

`MAX_STORAGE_BYTES_PER_USER` is a configuration value, default **100 MB**
(D1). It is checked in three places, each inside the transaction that already
locks the user row, so two requests cannot both take the last space:

| Action | Check | Refusal |
|---|---|---|
| Create a cascade | `used + estimate(new cascade) ≤ limit` | `409 { error: "storage_limit", used, limit, needed }` |
| Start over | Same, with the original's question count and spec | Same |
| Save a search (D2) | `used + spec_bytes ≤ limit`. An overwrite counts only the difference | Same |

- **The estimate** for a new cascade is the formula with one level of
  `question_count` questions. The search has run by then, so the count and the
  key lengths are known exactly.
- **A cheap pre-check** keeps the current design's order. Before searching at
  all, a request from an account that is already at or over its limit is
  refused, so a full account never spends a `SEARCH_CONCURRENCY` permit. The
  exact check runs after the search, in the transaction, as the cascade-count
  check does today.
- **Restoring** from the Trash is always allowed: the rows never left the
  account's total.
- **An admin override** is optional and can wait: a nullable
  `users.storage_limit_bytes` that, when set, replaces the default for that
  account.

## S3. Studying never fails for storage

Under Ladder, every finish with a miss makes a new level, and every level is
new rows. Those rows are added even when they take an account over its limit.
Refusing a finish would be the one place studying fails for a reason the user
cannot act on, and it would happen offline, where the finish has already been
played. PLAN.md leaves `depth` unbounded for the same reason.

So the limit gates **creating**. Past the limit:

- the account keeps studying, syncing, restoring and exporting
- creating a cascade, Starting over and saving a search are refused, with how
  much needs freeing
- the Cascades page says the account is over, by how much, and that emptying
  the Trash or deleting cascades frees space

## S4. Removing the count limits

`MAX_CASCADES_PER_USER` and `MAX_SAVED_SEARCHES_PER_USER` are removed from
configuration, from `/api/auth/me`, and from the device's `session` and
`meta`. Everything that leaned on them changes too:

- **The sync request's `question_rows_for`** is capped by the cascade limit
  today. It gets a fixed protocol bound, `MAX_QUESTION_ROWS_FOR = 1000`. The
  device sends only cascades it holds rows for, inside its download window.
  An account with more open cascades than that splits them across requests,
  which the engine already does for operations.
- **The 409s `cascade_limit` and `saved_search_limit`** are replaced by
  `storage_limit`.
- **The builder:**
  - "17 of 20 cascades", the 90% warning and "Empty the Trash to make room" go
  - it shows "This cascade will use about 18 MB. 43 MB of 100 MB used." from
    the preview's count (S6)
- **Start over:** it is disabled at the storage limit, not the cascade count.
  Its confirmation's last sentence becomes: "You'll have both, and each counts
  toward your storage until it is deleted from the Trash."
- **Performance with many cascades.** Nothing paginated the Cascades page or
  the Trash because twenty was the most there could be. The page reads every
  cascade's summary from IndexedDB on each sync. That needs a check at, say,
  500 cascades: render the list in pages, as the Trash already renders its
  entries, if it is slow. The drop pass's scale test
  (`scale-drop.scale.ts`, written for "as many cascades as an account may
  hold, 20") moves to 500.
- **Scripts and tests:**
  - the dev `limits` scenario fills to 90% of the storage limit instead
  - `parity.py`'s `MAX_CASCADES_PER_USER=1000` override goes
  - the e2e `@limits` pass sets a small `MAX_STORAGE_BYTES_PER_USER` instead
    of `MAX_SAVED_SEARCHES_PER_USER=2`

## S5. Raising the question ceiling

**Recommendation (D3): raise it to 300,000, and stop there for now.** That is
the "effectively unlimited" point for words. The largest English lexicon,
CSW24, has about 280,000 words, so any Anagram, Definition or word-list search
over the whole lexicon fits. Much of PLAN.md was written for 300,000 already:
its sections on finishing, shuffles, card pages, downloads and the device's
stores work through a 300,000-question cascade, from when that was the limit.

What it takes:

- `QUESTION_CEILING` becomes 300,000, and the schema CHECKs become 300000 and
  299999. PLAN.md's § Schema already shows those values: it never followed
  the change to 130,000.
- **The scale tests** (`make test-scale`, and the device's `*.scale.ts`) run
  at 300,000 again. Their time and memory budgets are the real gate. If a
  budget fails, the ceiling stays where the budgets pass and the plan says so.
- **Memory on the 0.5 vCPU / 2 GiB task.** A finish reads the missed `idx`
  values into Rust, and creation holds the whole result in memory. At 300,000
  questions that is a few MB per request. `EXPORT_CONCURRENCY=1` and
  `SEARCH_CONCURRENCY` already bound how many run at once.
- **Creation time.** Inserting 300,000 `cascade_questions` rows in one
  transaction takes seconds. The builder's "Creating…" screen already reports
  progress for the device's half, so check that the server's half fits the
  request timeout.

**Beyond 300,000** is a separate step and is not recommended yet. A full
English leave value set is about a million leaves. Going there means scale
budgets at a million questions on a 2 GiB task, IndexedDB holding a million
rows per level on phones, and a download measured in tens of MB. If it is ever
wanted, it is its own plan.

## S6. What the user sees

### The Cascades page

- The header shows **"43 MB of 100 MB used"** with a thin bar, in place of
  "17 of 20 cascades".
  - Past 90% it says "Almost full: empty the Trash or delete cascades to make
    room".
  - Over the limit it says "Over your storage by 12 MB: you can keep studying,
    but can't create cascades until you make room".
- **Each cascade's row shows its size**, for example "4.2 MB", beside the
  "Available offline" badge. Hovering it, or tapping on a phone, shows the
  split between its questions, its levels and its filters, so a user can see
  that a cascade grew because of its levels.
- **The Trash** shows each trashed cascade's size, each trashed quiz's size,
  and the Trash's total ("The Trash holds 38 MB"). Its Delete forever buttons
  say how much they free.
- New cascade is disabled when the account is over its limit, with the reason
  beside it.

### This device's storage, kept apart

The Account page's "Cascades on this device" table stays. It shows what this
device has downloaded: its rows, question keys and answers, measured on the
device. The Cascades page's sizes are the **account's** storage on the server,
which is what the limit counts. The two use different words so they are not
confused: "Storage" on the Cascades page, and "On this device" on the Account
page, which has a line linking to the other.

### The builder

Under the preview count: "This cascade will use about 18 MB. You have 57 MB
free." Past the limit, Create Cascade is disabled and says how much needs
freeing. The estimate comes from the preview's count, with the average key
length of the lexicon and quiz type standing in for the exact key bytes the
server will sum. It is an estimate, labelled as one, and the server's check is
the one that decides.

## Sizing the default limit

The default must hold these three cascades, with room to spare:

- every CSW24 anagram of 7 and 8 letters
- every CSW24 definition of 7 and 8 letters
- 10,000 CSW24 leave values

### The cascades

Counted from `wolges/CSW24.txt` (280,887 words) and
`csw24_leaves/CSW24_gen_3.csv`:

| Cascade | Questions | Average key |
|---|---|---|
| Anagrams, 7–8 letters: one question per alphagram (27,660 of 7 letters and 36,693 of 8) | 64,353 | 7.6 bytes |
| Definitions, 7–8 letters: one question per word (34,506 of 7 letters and 42,341 of 8) | 76,847 | 7.6 bytes |
| Leave values: 10,000 leaves sampled from the set | 10,000 | 5.8 bytes |

### What a question costs

**Measured, before the constants were fixed.** Each cascade's real keys were
loaded into copies of `cascade_questions` and `quiz_questions` with their
indexes (`CREATE TABLE … (LIKE … INCLUDING ALL)`), on Postgres 16, and
measured with `pg_total_relation_size`:

| Cascade | `cascade_questions` | One level of `quiz_questions`, graded | As created (Source quiz only) | Studied hard (levels adding up to a second Source quiz) |
|---|---|---|---|---|
| Anagrams | 6.55 MB (102 B a question) | 11.71 MB (182 B) | **18.3 MB** | **30.0 MB** |
| Definitions | 7.81 MB (102 B) | 13.98 MB (182 B) | **21.8 MB** | **35.8 MB** |
| Leave values | 1.06 MB (106 B) | 1.89 MB (189 B) | **3.0 MB** | **4.9 MB** |
| **All three** | | | **43.0 MB** | **70.6 MB** |

**By the formula, with the final constants.** The implementation fixed the
per-row sizes in `contract-fixtures/storage.json` (`question_row` 94 plus the
key's bytes, `quiz_question_row` 188, `quiz_row` 420, `cascade_row` 380,
`spec_row` 380), and the calibration test reads the formula at 1.012 times
the measured live rows. Recomputed with those constants, the three cascades
come out slightly larger than measured, and these are the figures the default
rests on:

| Cascade | Questions | As created | Studied hard |
|---|---|---|---|
| Anagrams, 7–8 | 64,353 | **18.64 MB** | **30.74 MB** |
| Definitions, 7–8 | 76,847 | **22.25 MB** | **36.70 MB** |
| 10,000 leave values | 10,000 | **2.88 MB** | **4.76 MB** |
| **All three** | | **43.77 MB** | **72.20 MB** |

MB here is 1,000,000 bytes, as everywhere the limit is shown.

**"Studied hard"** is levels made from misses that add up to as many questions
as the Source quiz again. For example:

- missing half of each pass gives levels of 50%, 25%, 12.5% and so on of the
  questions
- cleared levels wait in the Trash for 30 days and still count (D4)

That is a generous allowance for a first pass through every 7- and 8-letter
word.

The `cascades`, `quizzes` and `quiz_attempts` rows, and these cascades'
filters (a length or a leave value range, a few hundred bytes), add well under
0.1 MB. The exception would be 10,000 leaves chosen by pasting them as an In
Word List: at about 110 bytes an entry (`spec_word_row` plus the entry), that
list adds about 1.06 MB. A 300,000-entry list is about 33 MB.

### The default: 100 MB

| | Size | 100 MB leaves |
|---|---|---|
| The three cascades as created | 43.77 MB | 56.2 MB, 2.28 times the need |
| The three, studied hard | 72.20 MB | 27.8 MB, 1.39 times the need |

That 27.8 MB of headroom is roughly:

- one more 7–8 anagram cascade as created
- a Start over of the definitions cascade
- or nine 10,000-question cascades

At 50 accounts the database's worst case is 5 GB, a quarter of RDS's starting
20 GiB, against about 35 GB for the old 20 cascades of 130,000 questions each.

The figures count a level at its graded size, which is what the formula counts
(S1). The calibration test confirmed the per-row costs, and the recomputed
figures above still fit the 100 MB default.

## Decisions

| # | Decision | Decided |
|---|---|---|
| D1 | The default limit | **100 MB**: room for the three cascades the owner named, studied hard, with 27.8 MB (1.39 times the need) to spare. See "Sizing the default limit". Configurable, so it can be raised without a deploy |
| D2 | Do saved searches count? | **Yes**, so there is one limit. A saved search with a 300,000-entry word list is about 33 MB (about 110 bytes an entry), the same as a cascade's spec |
| D3 | Question ceiling | **300,000**, gated on the scale tests passing (S5) |
| D4 | Does the Trash count? | **Yes**, as the cascade limit does today. Its rows are still stored and can be restored, and the Trash empties itself after `TRASH_RETENTION_DAYS` |
| D5 | Keep a sanity cap on the number of cascades? | **None.** Storage bounds what an account can hold, and the one place a count mattered (`question_rows_for`) gets its own protocol bound |

## Order of work

1. **Accounting, with no behaviour change.** The `storage_bytes` columns, the
   formula and its calibration test, the pull field, the `/api/auth/me`
   fields, and the per-cascade sizes on the Cascades page and in the Trash.
   The old limits still apply. This step is useful on its own, and its
   calibration test confirms the per-row costs the 100 MB default was sized
   with.
2. **The switch.** `MAX_STORAGE_BYTES_PER_USER` and the checks in S2, the
   over-limit state in S3, removing the two count limits in S4, the builder's
   estimate, and the e2e `@limits` pass and dev scenario on storage.
3. **The ceiling.** 300,000, behind the scale tests (S5).
4. **Docs**, done alongside each step, not after:
   - PLAN.md:
     - the scale assumptions under Overview
     - § Cascade limit, which becomes § Storage limit
     - § Quiz options and § Search Engine's result caps
     - § Working at 300,000 questions
     - § Schema and its invariants
     - § API (`/api/auth/me`, creation, Start over, saved searches, sync)
     - § Configuration
     - § Frontend (Cascades page, builder, Trash)
     - § Capacity
     - the test sections
   - JOURNEYS.md: C-3 and the limits journeys
   - a docs/plan-questions.md entry for D1–D5

## Tests

- **Unit:** the formula against hand-computed rows, in Rust and in the
  frontend's estimate; the estimate's labelling.
- **Integration:**
  - creation, Start over and a saved search are refused at the limit with
    `used`, `limit` and `needed`
  - two creations racing for the last space: one wins
  - a finish that takes an account over its limit still applies
  - purging frees exactly what was counted
  - `users.storage_bytes` equals the sum of its cascades and saved searches
    after every operation in the shared rule vectors
  - the calibration test (±20% of measured growth)
  - `question_rows_for` past 1,000 is a `400`
- **End to end:**
  - the Cascades page shows each cascade's size and the total
  - the Trash shows what Delete forever frees
  - on a stack with a small `MAX_STORAGE_BYTES_PER_USER`, the builder refuses
    a cascade that would not fit, Start over is disabled, studying past the
    limit still works, and emptying the Trash re-enables creation
- **Scale:** the existing budgets at 300,000 questions; the Cascades page and
  the drop pass at 500 cascades.
