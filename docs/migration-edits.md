# Edits to backend/migrations/0001_initial.sql

The migration is PLAN.md § Schema (lines 3008–3700) verbatim. Every edit made
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
