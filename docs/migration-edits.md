# Edits to backend/migrations/0001_initial.sql

The migration is PLAN.md § Schema's SQL block verbatim. Every edit made
to fix a real error is logged here with its reason.



## 2026-11-09: the question ceiling is 130,000

The owner expects one user at first and at most about 50 accounts, and set the
largest quiz at 130,000 questions (BIRDTEST_LESSONS_PLAN.md, "Scale
assumptions"). Every `BETWEEN 1 AND 300000` question-count and segment-size
CHECK became `130000`, and every `BETWEEN 0 AND 299999` index and position
CHECK became `129999`, matching `QUESTION_CEILING` in `backend/src/config.rs`.
Nothing was deployed, so editing in place is still allowed (PLAN.md § Schema).
After the first deploy, a change like this would be a new numbered migration.

## 2026-11-10: later migrations folded back in

Nothing is deployed, so the four numbered migrations made since were folded
into this file and deleted, leaving the single migration PLAN.md § Schema
describes:

- `0002`: `anagram_show_definitions` and `anagram_show_hooks` default to true.
- `0003`: `user_preferences.reveal_correct`, default true.
- `0004`: `user_input_bindings.slot` is `CHECK (slot >= 0)`: an action holds any
  number of bindings (PLAN.md § Controls).
- `0005`: `cascades.answer_mode`, default `'flashcard'`: flashcard or typed is the
  cascade's own (PLAN.md § Typed mode). Its backfill from the account's
  `anagram_answer_mode` had nothing to backfill on a fresh database and went.

A database made by the earlier files no longer matches: `./scripts/dev.py --reset`.

## 2026-11-11: controls are per device and no longer synced

Player controls became a setting each device keeps for itself, never sent to
the server, so the server's half went: the `user_input_bindings` table (and the
`input_action` and `input_kind` types only it used),
`user_preferences.bindings_changed_at` and `bindings_device_id`, and
`'set_bindings'` from `sync_op_type`. `user_preferences.updated_seq` is now
bumped by preference changes alone. Nothing is deployed, so the edit is in
place.

A database made by the earlier file no longer matches: `./scripts/dev.py --reset`.

## 2026-11-11: no account-level preferences; display settings are the cascade's

Settings are now either a cascade's own (synced on its `cascades` row) or a
device's own (never synced); nothing applies to the whole account. So the
`user_preferences` table went, with `'set_preferences'` from `sync_op_type`,
and with it the defaults for new cascades it held (`default_clear_threshold`,
`anagram_answer_mode`, `default_segment_size`, `default_progression`,
`default_require_alphabetical`): a new cascade takes the request's values or
the column defaults. Its four remaining settings moved onto `cascades`, set by
`set_cascade_options` and copied by Start over: `show_definitions` and
`show_hooks` (were `anagram_show_definitions` and `anagram_show_hooks`),
`reveal_correct`, and `leave_value_decimals`, with the same defaults and
range. Nothing is deployed, so the edit is in place.

A database made by the earlier file no longer matches: `./scripts/dev.py --reset`.

## 2026-11-11: one storage limit; the question ceiling is 300,000

STORAGE_LIMIT_PLAN.md replaces the cascade and saved-search counts with one
per-account storage limit, and raises the question ceiling (decisions D1–D5):

- `cascades.storage_bytes BIGINT NOT NULL CHECK (>= 0)`: the bytes the account
  holds because of the cascade, by the formula in `backend/src/storage.rs` and
  the per-row sizes in `contract-fixtures/storage.json`. Set at creation and
  Start over, changed by each finish's attempt and new level and each purged
  quiz, each with an `updated_seq` bump.
- `saved_searches.storage_bytes BIGINT NOT NULL CHECK (>= 0)`: its spec's.
- `users.storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (>= 0)`: the sum of the
  two, kept in the same transactions under the user row's lock, and recounted
  by the purge task.
- `users.storage_limit_bytes BIGINT` (NULL, `CHECK (>= 0)`): an account's own
  limit, set only via SQL, in place of `MAX_STORAGE_BYTES_PER_USER`.
- Every `BETWEEN 1 AND 130000` question-count and segment-size CHECK is
  `300000` again, and every `BETWEEN 0 AND 129999` index and position CHECK
  `299999` (undoing the 2026-11-09 edit), matching `QUESTION_CEILING`.

Nothing is deployed, so the edit is in place. A database made by the earlier
file no longer matches: `./scripts/dev.py --reset`.

## 2026-11-11: the found count is a cascade setting; shared device settings

- `cascades.show_found_count BOOLEAN NOT NULL DEFAULT false`: typed mode's
  "3 of 9 found", which was a display setting on each device, is now one of an
  anagram cascade's settings, set by `set_cascade_options` and copied by Start
  over like `show_hooks`.
- `users.device_settings JSONB NOT NULL DEFAULT '{}'` (`CHECK` an object): the
  device settings shared with all of the account's devices, setting name to
  `{value, at}`, merged by each sync request's `device_settings` (the later
  `at` wins) and returned on every sync response (PLAN.md § Settings → This
  device, or all of them).

Nothing is deployed, so the edit is in place. A database made by the earlier
file no longer matches: `./scripts/dev.py --reset`.

## 2026-11-12: packed catalog texts and packed card records

Nothing is deployed, so these are edits in place, measured first against
Postgres 16 with CSW24 (the sizes are in PLAN.md § Upload limits and
§ Storage limit):

- `lexicon_words` and `leave_values` are one row per lexicon and per leave set:
  the words (with playabilities and definitions) and the leaves as one text
  each, compressed with zstd by the server, in a `BYTEA` stored `EXTERNAL`.
  The per-row CHECKs on a word, a playability, a definition, a leave and a
  value went with the rows; upload validation makes the same checks.
- `quiz_cards` holds a chunk's questions as varint differences (`idxs BYTEA`),
  its size in `n`, and its grades and their records in one `cards BYTEA`, NULL
  while nothing is graded; `grades`, `graded_at`, `graded_seq` and `graded_by`
  are gone. A grade's time is kept to the second. `quiz_card_rows` decodes a
  chunk for the `quiz_questions` view, whose columns are unchanged.

## 2026-11-12: the probability order is a cascade setting

- `cascades.show_probability BOOLEAN NOT NULL DEFAULT false`: whether a word
  shows its probability order, which was a display setting on each device, is
  one of a cascade's settings, set by `set_cascade_options` and copied by
  Start over like `show_found_count`.

Nothing is deployed, so the edit is in place: `./scripts/dev.py --reset`.

## 2026-11-12: the definition column is a cascade setting; leaves round to 0 places

- `cascades.definition_column BOOLEAN NOT NULL DEFAULT true`: whether a
  definition sits beside its word or beneath it, which was a display setting
  on each device, is one of a cascade's settings, like `show_probability`.
- `cascades.leave_value_decimals` defaults to `0` (was `1`).

Nothing is deployed, so the edits are in place: `./scripts/dev.py --reset`.

## 2026-11-13: definitions and leave values can be replaced; unique cascade names

Nothing is deployed, so these are still edits in place, the last before the
first deploy freezes the file.

- `lexicons` gains `definitions_revision INTEGER NOT NULL DEFAULT 1 CHECK
  (definitions_revision >= 1)`, and `leave_sets` gains `values_revision` of the
  same shape. An admin upload can now replace a lexicon's definitions, or a
  leave value set's values (PLAN.md § Replacing definitions and leave values).
  Each replacement raises the revision; a cascade row carries it, and a device
  fetches again the answers it holds from an older one. Words, playabilities
  and the leaves themselves stay immutable, and a lexicon still has at most
  one leave value set.
- `cascades` gains `UNIQUE (user_id, name)`: an account's cascades each have
  their own name, the Trash included (PLAN.md § Creating a cascade). Start
  over, which used to copy the name, numbers it instead.

## 2026-11-14: a registration keeps its own username and password with its code

The adversarial review's R1-07: a second registration for an unconfirmed
address kept the first one's username and password, and a lost confirmation
mail could not be sent again. Nothing is deployed, so the edit is in place,
before the first deploy freezes the file.

- `email_confirmations` is gone. `pending_registrations` takes its place: one
  row per registration, with its `username`, `email`, `password_hash`,
  `code_hash` (unique), `created_at` and `expires_at`, indexed by `email` and
  by `username`. Neither is unique there: an address may have several
  registrations waiting, and they may share a username.
- `users.email_confirmed_at` is gone. A `users` row is made when a
  registration's code is confirmed and never before, from that registration's
  username, address and hash, so every account is confirmed and `created_at`
  is when.

`scripts/confirm-user.sh` now makes the account from the username's latest
registration, and `scripts/scrub.sql` empties the new table.

A database made by the earlier file no longer matches: `./scripts/dev.py --reset`.

## 2026-11-15: a lexicon's playabilities can be replaced

Nothing is deployed, so the edit is in place.

- `lexicons` gains `playability_revision INTEGER NOT NULL DEFAULT 1 CHECK
  (playability_revision >= 1)`, beside `definitions_revision`. An admin upload
  can now replace a lexicon's playabilities (PLAN.md § Replacing definitions,
  playabilities and leave values), which lifts the rule the 2026-11-13 entry
  above records; words and leaves stay immutable. Each replacement raises the
  revision. No cascade row carries it: an instance compares it, with
  `definitions_revision`, against the revisions its index was read at and
  builds the index again when either is newer, and a replacement of either
  part applies only while both are the ones it read, because the words are
  one stored text.
- The comment on `lexicon_words` says so.

A database made by the earlier file no longer matches: `./scripts/dev.py --reset`
(and `make sqlx-db` for the compile-check database).

## 2026-11-16: a setting can be set in four places

Production was deployed for testing only, and its owner resets its database
with this change, so the edit is in place rather than a second migration.

- `cascades` loses the eight display columns (`answer_mode`,
  `show_definitions`, `show_hooks`, `reveal_correct`, `show_found_count`,
  `show_probability`, `definition_column`, `leave_value_decimals`) and gains
  `settings JSONB NOT NULL DEFAULT '{}'`, the cascade's own settings: the
  "This cascade" place of PLAN.md § Settings → Where a setting applies. The
  `anagram_answer_mode` type went with its column.
- The comment on `users.device_settings` says it is now the "Everywhere"
  place, where a null value takes a setting out.
- `cascades` and `quizzes` lose `require_alphabetical`. Typed answers in
  alphabetical order is now an answer setting like the others, held in the
  four places, not a quiz option: the server never judged by it, and
  `set_cascade_options` and `set_quiz_options` no longer carry it.
- `quizzes` loses its copy of the quiz options (`segment_size`,
  `progression`) and the latest-wins clock that went with them
  (`options_changed_at`, `options_seq`, `options_device_id`). Every level
  now reads its cascade's options, as it already read the clear threshold,
  so a change reaches the level in progress too. `set_quiz_options` is no
  longer an operation, and `sync_op_type` loses it.

A database made by the earlier file no longer matches: `./scripts/dev.py --reset`
(and `make sqlx-db` for the compile-check database), and the production
database is reset: `scripts/deploy.sh --reset-database` (docs/runbook.md,
Deploying).
