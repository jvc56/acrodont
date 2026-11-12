# Acrodont journeys

A tester's checklist: every journey on the site, walked by hand against a
local `./scripts/dev.py` instance. Working through it should leave you
confident Acrodont can go live. The Playwright journeys (`e2e/`) cover the
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
| CSW24 with definitions and leave values, from `fixtures/licensed/` (dev.py downloads it on the first run with `scripts/build-licensed-catalog.py`; if that fails, the test catalog's EN-FIX stands in, and the names below say EN-FIX) | `/admin`, the builder |
| "Studying: CSW24 2–7" (the 20 most probable of each length): Level 1 finished with misses, Level 2 half graded | `/` |
| "Finished: CSW24 sevens" (the 25 most probable) | `/` |
| "Segments: CSW24 2–5 in fives" | `/` |
| "Trashed: CSW24 eights" | the Trash, under the cascades on `/` |
| Three saved searches | the builder's Load dialog |
| Filler cascades until the account holds 90–100% of its 100 MB storage limit, so the Cascades page warns it is almost full (on EN-FIX, whose cascades are tens of KB, add `--env MAX_STORAGE_BYTES_PER_USER=1000000` to the command above) | `/` |

For a phone on the same network, start with `BIND_HOST=0.0.0.0` and open
`http://<this machine>:5173`.

Mail never leaves the machine: dev.py prints each confirmation or reset mail
as a link (`[mail] confirm …`).

## Part 1: visitors

- [ ] **V-1** **Do** open `/` signed out (`./scripts/dev.py --no-login`). **Expect** the log-in page, with Create an account; there is no public landing page.
- [ ] **V-9** **Do** log in. **Expect** the Cascades page, the landing page, with New cascade at the top and the Trash below the cascades. The header shows Acrodont, Admin (admins only), the sync status and your name, and nothing else; Acrodont leads back to the Cascades page. An old link to `/trash` lands on the Cascades page, scrolled to the Trash.
- [ ] **V-2** **Do** register a new account. **Expect** "check your email"; dev.py prints a `[mail] confirm` link; following it confirms the account, and you can log in.
- [ ] **V-3** **Do** register with a taken username. **Expect** "That username is taken." under the field, and no mail.
- [ ] **V-4** **Do** register with an address that already has an account. **Expect** the same "check your email" page; dev.py prints a mail saying the address already has an account.
- [ ] **V-5** **Do** log in with a wrong password ten times. **Expect** "Wrong username or password." each time, then a wait before further attempts.
- [ ] **V-6** **Do** while signed in as `dev` in another tab, reset its password from "Forgot password?" on the log-in page: ask for `dev@acrodont.local`, follow the `[mail] reset` link, try `dev@acrodont.local` as the new password, then a strong one. **Expect** "If that address has a confirmed account, a reset link is on its way, with the account's username. The link expires in 30 minutes."; the mail says "Your Acrodont username is dev."; the link opens "Choose a new password"; the weak password is refused under the field and the same link still works; **Set new password** lands on the log-in page with no message, and the other tab shows "Log in to sync" on its next sync. The new password works, and the old one no longer does. The Account page has no Change password: a reset is the one way to change a password.
- [ ] **V-10** **Do** ask for a reset for one address six times within the hour; then open a reset link and submit a weak password six times. **Expect** the sixth request says "Too many attempts. Try again in N seconds.", for an address with an account or without alike; the link's sixth try says "Too many tries, with this link or from this address. Try again in N minutes, or ask for a new link."
- [ ] **V-11** **Do** open `/reset-password/confirm` with no token. **Expect** it says the link is missing its reset token, with a link to ask for a new one, and no form.
- [ ] **V-7** **Do** start with `--env DEV_LOGIN=false` (a stack with dev log-in never closes registration), fill it to 100 accounts (`docker compose exec postgres psql -U acrodont -c "INSERT INTO users (username, email, password_hash, email_confirmed_at) SELECT 'filler' || g, 'filler' || g || '@example.com', 'x', now() FROM generate_series(1, 100 - (SELECT count(*) FROM users)) g"`), and register. **Expect** the registration says "Acrodont isn't taking new accounts right now.", for a new address and a known one alike.
- [ ] **V-8** **Do** open `/dev-login?username=dev` on the real site, once deployed. **Expect** "Dev sign-in is only available on a local stack…"; nothing signs in.

## Part 2: studying

- [ ] **S-1** **Do** open "Studying". **Expect** the player at Level 2, halfway through, the ladder showing Level 1 finished.
- [ ] **S-2** **Do** reveal, grade and advance with the mouse, then the keys (Space, X, Backspace). **Expect** each action's binding as listed in the player's Settings (Device Settings → Controls).
- [ ] **S-3** **Do** finish Level 2 with a miss. **Expect** a new level, with the banner saying how many questions it has.
- [ ] **S-4** **Do** open "Finished". **Expect** the completion screen: Keep studying, Start over, Move to Trash.
- [ ] **S-5** **Do** open "Segments" and finish the second run of five. **Expect** a chain quiz of its misses, and the run counter moving on.
- [ ] **S-6** **Do** `--scenario typed`, then open "Typed". **Expect** a text box; typing the anagrams grades them; a word that isn't an anagram of the question stays in the box with "Not an anagram of the question"; an anagram that isn't a word turns the box red until the next keystroke and shows in red under the box as the last entry; a found word shows there in green, and is the green one among the found words in the answer space; the last entry clears on the next card.
- [ ] **S-7** **Do** go offline (DevTools Offline, or `docker compose stop backend`) and keep studying, then reload. **Expect** the app still loads and studies; SyncStatus says changes are waiting; back online, it says "Synced".
- [ ] **S-8** **Do** `./scripts/dev.py --two-devices`, grade in one profile, then switch to the other. **Expect** the grades arrive within the sync interval (about 30 s) or at once on focus.
- [ ] **S-9** **Do** the same quiz on both devices offline, then bring both online. **Expect** a notice naming what wasn't kept, never a silent loss.
- [ ] **S-10** **Do** in Chrome or Edge on a desktop, open `localhost:5173`, wait for the header's drive icon to turn green, and press **Install** (or the icon, then Install Acrodont). Then go offline, close the app and the browser, and open Acrodont from its own icon. **Expect** the browser's install dialog; the installed app opens with no connection on the Cascades page, with no Install button and the cascades available offline playable. Hovering the icon says Acrodont opens on this device with no connection.

## Part 3: cascades, Trash, export, account

- [ ] **C-1** **Do** build a cascade: Anagram, CSW24, Length 7–8, then preview. **Expect** a count and a sample, no settings on the page (no threshold, answer mode or segments), and a note that the cascade's settings can be changed in its Settings once it is created; Create opens it, clearing at 90%, with flashcards.
- [ ] **C-2** **Do** look at the header on `/`, hover a cascade's size, then open the builder and preview a search. **Expect** "X MB of 100 MB used" with an amber meter and "Almost full: empty the Trash or delete cascades to make room", and no count of cascades. Each cascade's row shows its size (such as "4.2 MB"); hovering it splits it into questions and filters, and levels. The builder says "This cascade will use about X. Y of 100 MB used." under the count. Sizes are in decimal units (1 MB is 1,000,000 bytes).
- [ ] **C-3** **Do** in the builder, preview a search too big for the room left (Anagram, CSW24, Length 2–15), then a small one, and create it. **Expect** the big one says "It won’t fit: empty the Trash or delete cascades to make room." in red, with Create Cascade disabled; the small one is created. If the device's figure was behind, Create answers "This cascade needs about X, and Y of your 100 MB is free. Empty the Trash or delete cascades to make room."
- [ ] **C-14** **Do** with storage full or nearly so, finish a level with misses, then go back to `/`. **Expect** the finish works (studying is never refused); once storage is past the limit the header says "Over your storage by X: you can keep studying, but can’t create cascades until you make room", the meter is red, and New cascade is disabled. In the player's Settings, Start over is disabled ("Start over: your storage is full").
- [ ] **C-15** **Do** look at the Trash on `/`, then Move to Trash a cascade. **Expect** "The Trash holds X of your storage.", each group showing its size, and each Delete forever button saying what it frees ("Delete forever (X)"). Move to Trash's confirmation says the storage is freed only once the cascade is deleted forever; the header's figure does not drop.
- [ ] **C-4** **Do** restore "Trashed" from the Trash on `/`. **Expect** it back among the cascades above at once; the storage figure does not change, and restoring is allowed even when storage is full. Moving a cascade to the Trash there shows it in the Trash below at once.
- [ ] **C-5** **Do** Delete forever a trashed cascade. **Expect** a confirmation ending "This frees X of your storage."; afterwards the header's figure drops by that much (at the next sync), and if that makes room, the over-limit message goes and New cascade and the builder's Create work again.
- [ ] **C-16** **Do** with storage full, save a search with a pasted word list in the builder. **Expect** "This search needs about X of storage, and Y is free. Make room by emptying the Trash or deleting cascades or saved searches."; overwriting a saved search with a smaller one is accepted.
- [ ] **C-6** **Do** load each saved search in the builder. **Expect** its filters, the name, and a preview.
- [ ] **C-17** **Do** open the Account page, then the Catalog (as an admin) and the Cascades page with something in the Trash, at phone width. **Expect** no storage card on the Account page; the Catalog's three cards each with its own Upload button and its items listed with their figures under their names, nothing scrolling sideways; each Cascades row showing just the name, its details in its tooltip on a desktop; every Trash button on the screen.
- [ ] **C-7** **Do** export "Studying" as text and as CSV, all and missed only. **Expect** downloads whose names say what is in them; offline, the export still works from the device.
- [ ] **C-8** **Do** in a cascade's Settings (Settings in the player's menu, ☰ on a phone, beside Acrodont, Admin for admins, and Account), hover or tap a setting's ⓘ to see its explanation, then change a setting under Cascade Settings and a binding under Device Settings, then reload. **Expect** both persist, each saved as soon as it changed, with no Save button; the cascade's setting reaches the other device, the binding does not (controls are per device) until you tap **all your devices** under it, after which it does at the other device's next sync. The header and the Account page have no settings or links to them.
- [ ] **C-16** **Do** at phone width, study a few cards with the default tap zones, then switch **Tap zones on a phone** to Rows in Device Settings. **Expect** three columns, Previous, Toggle and Show / Next, each acting anywhere in its third of the quiz area with its label along the bottom; the desktop's status bar under the quiz (wrapping to two lines) with the sync status; ☰ opening a menu with Settings in it and no other settings button; nothing vibrating; no lines between the columns; the status bar's second line starting under "Level", not under its hide icon; with Rows, the question, then Previous, Toggle and Show / Next as rows under it, as tall as **Row height on a phone**; a long answer shrinking to fit the screen's width.
- [ ] **C-9** **Do** Sign out everywhere, then use the other device. **Expect** "Log in to sync"; studying still works.
- [ ] **C-10** **Do** delete an account. **Expect** the log-in page; logging in again fails.
- [ ] **C-11** **Do** change a cascade's clear threshold in its Settings, then press "all N cascades". **Expect** "✓ Saved for this cascade · Also use for: all N cascades" before, "✓ Used for all N cascades" after, and every cascade on the Cascades page clears at the new value. Turning off Show hooks offers "all N anagram cascades" instead; with only one cascade of the kind, no offer appears.
- [ ] **C-12** **Do** in one cascade's Settings, choose another cascade under "Copy another cascade's settings" and press Copy settings, then press it again. **Expect** "✓ Copied N settings from “…”." and the settings above changing to match, then "✓ “…” already has the same settings."; the level being studied keeps its own options.
- [ ] **C-13** **Do** in a cascade's Settings, change the level being studied's segment size (leave the field or press Enter), and turn on Study in segments for levels made from now on without typing a size. **Expect** "✓ Saved for this level" after the first; nothing saved by the second until a size is entered; on a cascade large enough, a size that would make more than 2,000 levels is warned about once typed, before it is saved.

## Part 4: admins

- [ ] **A-1** **Do** open `/admin` as `dev`. **Expect** the catalog, each index's size, and the instances.
- [ ] **A-2** **Do** open `/admin` as `dev2`. **Expect** "not found", never a hint that the page exists.
- [ ] **A-3** **Do** upload a lexicon file with an error on some lines. **Expect** a list of errors with line numbers, and nothing stored.
- [ ] **A-4** **Do** `./scripts/dev.py --stats` with the launch catalog in `fixtures/licensed/`. **Expect** the uploads succeed, and the printed index sizes and memory stay well inside `task_memory` (2 GiB).
- [ ] **A-5** **Do** try to delete a lexicon a cascade uses. **Expect** the delete is disabled, with the reason shown.

## Part 5: from the command line

- [ ] **O-1** **Do** `./scripts/dev.py --snapshot before`, change something, then `./scripts/dev.py --restore before`. **Expect** the change gone, and devices resyncing.
- [ ] **O-2** **Do** `./scripts/dev.py --fresh`. **Expect** no accounts and the first-admin steps printed; following them works.
- [ ] **O-3** **Do** edit `backend/migrations/0001_initial.sql` (add a comment) and run `./scripts/dev.py`. **Expect** dev.py says the database was made by an older edit and to run `--reset`. Revert the edit.

## What a local instance cannot show

- Real mail delivery, SES's sandbox and the bounce and complaint alarms (docs/runbook.md, One-time setup).
- Spot interruptions and the circuit breaker (`scripts/check-alerts.sh` tests the alert path).
- TLS, HSTS and Secure cookies: the local stack is plain HTTP.
- Installing on a phone: a phone reaches the local stack over plain HTTP, where browsers register no service worker and offer no install. The iPhone tip and Add to Home Screen need the deployed site (or a phone emulator on `localhost`).

## Known quirks

- `/dev-login` exists in the production build too; on the real site it only says dev sign-in is unavailable, because the endpoint answers 404.
- After `--reset`, a browser that studied before keeps its old account's data until site data is cleared: the account IDs no longer match anything on the server.
