-- Whether showing an answer marks the card correct (the default) or missed,
-- before the user toggles it (PLAN.md § Preferences).
ALTER TABLE user_preferences ADD COLUMN reveal_correct BOOLEAN NOT NULL DEFAULT true;
