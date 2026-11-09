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
