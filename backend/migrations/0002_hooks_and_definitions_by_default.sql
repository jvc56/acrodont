-- Anagram answers show hooks and definitions by default (PLAN.md § Preferences).
-- Only the defaults change: an account's saved choice stays as it is.
ALTER TABLE user_preferences ALTER COLUMN anagram_show_definitions SET DEFAULT true;
ALTER TABLE user_preferences ALTER COLUMN anagram_show_hooks SET DEFAULT true;
