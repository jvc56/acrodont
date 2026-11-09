-- Turns a COPY of production's database into a local one (./scripts/dev.py
-- --restore DUMP runs it on the staging database before swapping it in).
--   * every address becomes user-<id>@wordfall.invalid, so nothing local can
--     mail a real person;
--   * every password becomes the dev password, correct-tile-rack-bingo;
--   * every session is revoked, and pending codes and tokens are dropped.
-- Usernames, cascades and progress stay, which is the point of the copy.
--
-- Refuses unless run with -v dev_copy=1. The guard sits inside the
-- transaction with ON_ERROR_ROLLBACK off, so pasting this into a psql
-- connected to production cannot commit after the refusal (birdtest).
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
BEGIN;
\if :{?dev_copy}
\else
SELECT 'scrub.sql refuses to run without -v dev_copy=1: it rewrites every account' AS refused;
SELECT 1 / 0;
\endif
UPDATE users
   SET email = 'user-' || id || '@wordfall.invalid',
       password_hash = '$argon2id$v=19$m=19456,t=2,p=1$SXwQPhaGhngrdmsQrPUR8w$X2hmEeToIazw6+GFF7qYpMecAJAxxUP+EGtEwM5XHo0',
       session_generation = session_generation + 1;
DELETE FROM email_confirmations;
DELETE FROM password_reset_tokens;
DELETE FROM export_tokens_spent;
COMMIT;
