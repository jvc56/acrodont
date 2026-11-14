# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-13.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7566 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–598 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–452 |
|     ### Storage limit | 453–598 |
|   ## User Experience | 599–1643 |
|     ### Accounts | 601–608 |
|     ### Settings | 609–721 |
|       #### One cascade, or all of them | 661–689 |
|       #### This device, or all of them | 690–721 |
|     ### Creating a cascade | 722–832 |
|     ### Cascades page | 833–885 |
|     ### Trash | 886–930 |
|     ### Taking a quiz | 931–1488 |
|       #### Desktop layout | 943–1136 |
|       #### The three actions | 1137–1189 |
|       #### Answers | 1190–1254 |
|       #### Typed mode (Anagram quizzes only) | 1255–1352 |
|       #### Controls | 1353–1418 |
|       #### Touch zones | 1419–1482 |
|       #### Saving progress | 1483–1488 |
|     ### Finishing a quiz | 1489–1520 |
|     ### Exporting words | 1521–1643 |
|   ## Admin | 1644–1924 |
|     ### Uploads | 1658–1671 |
|     ### File formats | 1672–1787 |
|       #### Letter distribution file | 1696–1743 |
|       #### Lexicon file | 1744–1764 |
|       #### Leave values file | 1765–1787 |
|     ### Upload limits | 1788–1798 |
|     ### Immutability and deletion | 1799–1904 |
|       #### Replacing definitions and leave values | 1829–1904 |
|     ### Loading changes into running servers | 1905–1924 |
|   ## Tiles | 1925–1988 |
|   ## Filters | 1989–2271 |
|     ### Groups | 2008–2068 |
|     ### Pattern syntax | 2069–2094 |
|     ### Filter reference | 2095–2193 |
|     ### Probability and probability order | 2194–2213 |
|     ### Filter applicability by quiz type | 2214–2271 |
|   ## Architecture | 2272–2346 |
|     ### Tech Stack | 2299–2326 |
|     ### Repository layout | 2327–2346 |
|   ## Catalog Indexes | 2347–2406 |
|     ### Derived attributes | 2349–2406 |
|   ## Search Engine | 2407–2529 |
|   ## Cascades | 2530–2694 |
|     ### Questions are stored once per cascade | 2532–2554 |
|     ### Deterministic shuffles | 2555–2592 |
|     ### Rule implementation | 2593–2649 |
|     ### Working at 300,000 questions | 2650–2694 |
|   ## Offline and Sync | 2695–3861 |
|     ### Principles | 2697–2708 |
|     ### What needs a connection | 2709–2720 |
|     ### On the device | 2721–3159 |
|     ### Operations | 3160–3265 |
|     ### The sync cycle | 3266–3662 |
|       #### Telling the other devices | 3620–3662 |
|     ### Conflicts | 3663–3749 |
|     ### Authentication while offline | 3750–3861 |
|   ## Schema | 3862–4865 |
|     ### Purge task | 4807–4865 |
|   ## Authentication | 4866–5147 |
|   ## API | 5148–5371 |
|     ### Auth and account | 5175–5195 |
|     ### Catalog and search | 5196–5260 |
|     ### Cascades and sync | 5261–5352 |
|     ### Admin | 5353–5371 |
|   ## Frontend | 5372–5568 |
|   ## Configuration | 5569–5623 |
|   ## Development | 5624–5754 |
|     ### One command | 5626–5709 |
|     ### How it is put together | 5710–5730 |
|     ### Day to day | 5731–5754 |
|   ## Deployment and Operations | 5755–5932 |
|   ## Backups | 5933–6039 |
|     ### What is backed up | 5939–5962 |
|     ### Alarms | 5963–5975 |
|     ### Restoring | 5976–6009 |
|     ### The drill | 6010–6031 |
|     ### Locally | 6032–6039 |
|   ## Testing | 6040–7531 |
|     ### The fixture catalog | 6056–6072 |
|     ### Contract fixtures | 6073–6179 |
|     ### Unit tests | 6180–6551 |
|     ### Integration tests | 6552–7001 |
|     ### End-to-end tests | 7002–7346 |
|       #### What the tests reuse | 7009–7076 |
|       #### The journeys | 7077–7346 |
|     ### Scale tests | 7347–7462 |
|     ### Zyzzyva parity | 7463–7482 |
|     ### Running the tests | 7483–7531 |
|   ## Delivery Phases | 7532–7566 |
Notable anchors inside long sections:

- Schema SQL begins at 3890; accounts (`users`) 3986, catalog
  (`letter_distributions`) 4037, filter specs (`search_specs`) 4126, cascades
  and quizzes (`cascades`) 4288; Purge task 4807.
- Unit tests: backend list from 6184, frontend list from 6310.

## Sections each delivery phase depends on

Always re-read the phase's own bullet in Delivery Phases and the relevant
part of Testing before starting. The sections are named as the table above
names them; take their lines from it.

### Phase 1 — Skeleton
- Architecture, Tech Stack, Repository layout
- Schema → `backend/migrations/0001_initial.sql`
- API preamble for `/health` and error shape
- Frontend: shell, CSP, nginx, build-time CSP check
- Configuration
- Development: `scripts/stack.py`, `scripts/dev.py`, compose
- Deployment and Operations: Terraform baseline
- Testing: Running the tests

### Phase 2 — Accounts
- UX → Accounts, Settings
- Authentication incl. security bullets, rate limits, CSRF
- Offline and Sync → Authentication while offline: `X-Acrodont-User`
- API preamble, API → Auth and account
- Schema accounts tables
- Configuration
- Testing → Integration tests, auth parts

### Phase 3 — Catalog
- Admin: uploads, file formats, limits, immutability, NOTIFY reload
- Tiles
- Filters → Probability and probability order
- Catalog Indexes
- Schema catalog tables, `catalog_instance_status`
- API → Catalog and search, API → Admin
- Testing → fixture catalog, backend unit tests,
  integration tests admin parts

### Phase 4 — Search engine
- Filters: Groups, Pattern syntax, Filter reference, applicability
- Search Engine
- Catalog Indexes
- Schema filter specs
- API → Catalog and search
- Configuration (`SEARCH_CONCURRENCY`, timeouts)
- Testing → backend unit tests, Zyzzyva parity

### Phase 5 — Cascade builder
- UX → Creating a cascade; Quiz options; Storage limit
- Filters → applicability
- Cascades → Questions stored once, Working at 300,000
- API → Catalog and search, Cascades and sync
- Frontend
- Schema filter specs + cascades
- Testing → Contract fixtures (the filter contract test)

### Phase 6 — Cascade rules and sync
- Cascade Rules, all subsections
- Cascades: shuffles, rule implementation
- Offline and Sync → Operations, The sync cycle,
  Conflicts
- Schema cascades, quizzes, sync, Purge task
- API → Cascades and sync
- Testing → Contract fixtures, unit, integration

### Phase 7 — Local-first player
- User Experience in full
- Offline and Sync in full, especially On the device
- Cascades
- Frontend
- API → Cascades and sync
- Testing → frontend unit, E2E, Scale

### Phase 8 — Production
- Deployment and Operations
- Backups
- Configuration, Development
- Authentication (email/SES parts)
