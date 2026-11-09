# Wordfall journeys

A tester's checklist: every journey on the site, walked by hand against a
local `./scripts/dev.py` instance. Working through it should leave you
confident Wordfall can go live. The Playwright journeys (`e2e/`) cover the
same ground automatically. This list is for what a person notices that an
assertion does not: wording, layout, feel, and the phone.

## How to use it

Each item is **Do** something, then **Expect** something. Tick it, or note the
item's ID and what you saw instead. Quoted text is what the page should say.
Do one pass on a desktop browser and one at phone width (about 390 px, with
DevTools' device toolbar or a real phone; see "Setting up").

Update this file with every feature batch.

## Setting up

```bash
./scripts/dev.py --reset --users 1 --scenario studying --scenario finished \
  --scenario segments --scenario trash --scenario saved-searches --scenario limits
```

That gives you:

| What | Where |
|---|---|
| Admin `dev`, password `correct-tile-rack-bingo`; the browser opens signed in as `dev` | dev.py's log |
| A second user, `dev2`, same password | `--login-as dev2`, or log in |
| The fixture catalog: `english`, `catalan`, `EN-FIX`, `EN-FIX-OLD`, `CA-FIX`, leave values for EN-FIX and CA-FIX | `/admin` |
| "Studying: EN-FIX 2–7": Level 1 finished with misses, Level 2 half graded | `/cascades` |
| "Finished: EN-FIX sevens" | `/cascades` |
| "Segments: EN-FIX 2–5 in fives" | `/cascades` |
| "Trashed: EN-FIX eights" | `/trash` |
| Three saved searches | the builder's Load dialog |
| Filler cascades up to the limit warning (18 of 20) | `/cascades` |

For a phone on the same network, start with `BIND_HOST=0.0.0.0` and open
`http://<this machine>:5173`.

Mail never leaves the machine: dev.py prints each confirmation or reset mail
as a link (`[mail] confirm …`).

## Part 1: visitors

- [ ] **V-1** **Do** open `/` signed out (`./scripts/dev.py --no-login`). **Expect** the landing page, with Log in and Create an account.
- [ ] **V-2** **Do** register a new account. **Expect** "check your email"; dev.py prints a `[mail] confirm` link; following it confirms the account, and you can log in.
- [ ] **V-3** **Do** register with a taken username. **Expect** "That username is taken." under the field, and no mail.
- [ ] **V-4** **Do** register with an address that already has an account. **Expect** the same "check your email" page; dev.py prints a mail saying the address already has an account.
- [ ] **V-5** **Do** log in with a wrong password ten times. **Expect** "Wrong username or password." each time, then a wait before further attempts.
- [ ] **V-6** **Do** reset a password from "Forgot password?". **Expect** a `[mail] reset` link; the new password works, and the old one no longer does.
- [ ] **V-7** **Do** start with `--env MAX_ACCOUNTS=3` and register until three accounts exist. **Expect** the next registration says "Wordfall is not taking new accounts at the moment.", for a new address and a known one alike.
- [ ] **V-8** **Do** open `/dev-login?username=dev` on the real site, once deployed. **Expect** "Dev sign-in is only available on a local stack…"; nothing signs in.

## Part 2: studying

- [ ] **S-1** **Do** open "Studying". **Expect** the player at Level 2, halfway through, the ladder showing Level 1 finished.
- [ ] **S-2** **Do** reveal, grade and advance with the mouse, then the keys (Space, X, Backspace). **Expect** each action's binding as on `/account`.
- [ ] **S-3** **Do** finish Level 2 with a miss. **Expect** a new level, with the banner saying how many questions it has.
- [ ] **S-4** **Do** open "Finished". **Expect** the completion screen: Keep studying, Start over, Move to Trash.
- [ ] **S-5** **Do** open "Segments" and finish the second run of five. **Expect** a chain quiz of its misses, and the run counter moving on.
- [ ] **S-6** **Do** `--scenario typed`, then open "Typed". **Expect** a text box; typing the anagrams grades them; a wrong word is marked.
- [ ] **S-7** **Do** go offline (DevTools Offline, or `docker compose stop backend`) and keep studying, then reload. **Expect** the app still loads and studies; SyncStatus says changes are waiting; back online, it says "Synced".
- [ ] **S-8** **Do** `./scripts/dev.py --two-devices`, grade in one profile, then switch to the other. **Expect** the grades arrive within the sync interval (about 30 s) or at once on focus.
- [ ] **S-9** **Do** the same quiz on both devices offline, then bring both online. **Expect** a notice naming what wasn't kept, never a silent loss.

## Part 3: cascades, Trash, export, account

- [ ] **C-1** **Do** build a cascade: Anagram, EN-FIX, Length 7–8, then preview. **Expect** a count and a sample; Create opens it.
- [ ] **C-2** **Do** look at the header on `/cascades`. **Expect** "18 of 20 cascades" (or your count), with the warning in the builder.
- [ ] **C-3** **Do** create two more cascades. **Expect** "20 of 20"; Create and Start over are disabled, with a link to the Trash.
- [ ] **C-4** **Do** restore "Trashed" from `/trash`. **Expect** it back on `/cascades`; restoring never counts as a new cascade.
- [ ] **C-5** **Do** Delete forever a trashed cascade. **Expect** a slot freed.
- [ ] **C-6** **Do** load each saved search in the builder. **Expect** its filters, the name, and a preview.
- [ ] **C-7** **Do** export "Studying" as text and as CSV, all and missed only. **Expect** downloads whose names say what is in them; offline, the export still works from the device.
- [ ] **C-8** **Do** change preferences and a binding on `/account`, then reload. **Expect** they persist, and reach the other device.
- [ ] **C-9** **Do** Sign out everywhere, then use the other device. **Expect** "Log in to sync"; studying still works.
- [ ] **C-10** **Do** delete an account. **Expect** the landing page; logging in again fails.

## Part 4: admins

- [ ] **A-1** **Do** open `/admin` as `dev`. **Expect** the catalog, each index's size, and the instances.
- [ ] **A-2** **Do** open `/admin` as `dev2`. **Expect** "not found", never a hint that the page exists.
- [ ] **A-3** **Do** upload a lexicon file with an error on some lines. **Expect** a list of errors with line numbers, and nothing stored.
- [ ] **A-4** **Do** `./scripts/dev.py --real-catalog DIR --stats` with the launch catalog. **Expect** the uploads succeed, and the printed index sizes and memory stay well inside `task_memory` (2 GiB).
- [ ] **A-5** **Do** try to delete a lexicon a cascade uses. **Expect** the delete is disabled, with the reason shown.

## Part 5: from the command line

- [ ] **O-1** **Do** `./scripts/dev.py --snapshot before`, change something, then `./scripts/dev.py --restore before`. **Expect** the change gone, and devices resyncing.
- [ ] **O-2** **Do** `./scripts/dev.py --fresh`. **Expect** no accounts and the first-admin steps printed; following them works.
- [ ] **O-3** **Do** edit `backend/migrations/0001_initial.sql` (add a comment) and run `./scripts/dev.py`. **Expect** dev.py says the database was made by an older edit and to run `--reset`. Revert the edit.

## What a local instance cannot show

- Real mail delivery, SES's sandbox and the bounce and complaint alarms (docs/runbook.md, One-time setup).
- Spot interruptions and the circuit breaker (`scripts/check-alerts.sh` tests the alert path).
- TLS, HSTS and Secure cookies: the local stack is plain HTTP.

## Known quirks

- `/dev-login` exists in the production build too; on the real site it only says dev sign-in is unavailable, because the endpoint answers 404.
- After `--reset`, a browser that studied before keeps its old account's data until site data is cleared: the account IDs no longer match anything on the server.
