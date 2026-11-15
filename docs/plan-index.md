# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7681 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–598 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–452 |
|     ### Storage limit | 453–598 |
|   ## User Experience | 599–1659 |
|     ### Accounts | 601–608 |
|     ### Settings | 609–721 |
|       #### One cascade, or all of them | 661–689 |
|       #### This device, or all of them | 690–721 |
|     ### Creating a cascade | 722–832 |
|     ### Cascades page | 833–885 |
|     ### Trash | 886–930 |
|     ### Taking a quiz | 931–1491 |
|       #### Desktop layout | 943–1139 |
|       #### The three actions | 1140–1192 |
|       #### Answers | 1193–1257 |
|       #### Typed mode (Anagram quizzes only) | 1258–1355 |
|       #### Controls | 1356–1421 |
|       #### Touch zones | 1422–1485 |
|       #### Saving progress | 1486–1491 |
|     ### Finishing a quiz | 1492–1523 |
|     ### Exporting words | 1524–1659 |
|   ## Admin | 1660–1944 |
|     ### Uploads | 1674–1687 |
|     ### File formats | 1688–1803 |
|       #### Letter distribution file | 1712–1759 |
|       #### Lexicon file | 1760–1780 |
|       #### Leave values file | 1781–1803 |
|     ### Upload limits | 1804–1818 |
|     ### Immutability and deletion | 1819–1924 |
|       #### Replacing definitions and leave values | 1849–1924 |
|     ### Loading changes into running servers | 1925–1944 |
|   ## Tiles | 1945–2008 |
|   ## Filters | 2009–2291 |
|     ### Groups | 2028–2088 |
|     ### Pattern syntax | 2089–2114 |
|     ### Filter reference | 2115–2213 |
|     ### Probability and probability order | 2214–2233 |
|     ### Filter applicability by quiz type | 2234–2291 |
|   ## Architecture | 2292–2366 |
|     ### Tech Stack | 2319–2346 |
|     ### Repository layout | 2347–2366 |
|   ## Catalog Indexes | 2367–2426 |
|     ### Derived attributes | 2369–2426 |
|   ## Search Engine | 2427–2549 |
|   ## Cascades | 2550–2714 |
|     ### Questions are stored once per cascade | 2552–2574 |
|     ### Deterministic shuffles | 2575–2612 |
|     ### Rule implementation | 2613–2669 |
|     ### Working at 300,000 questions | 2670–2714 |
|   ## Offline and Sync | 2715–3925 |
|     ### Principles | 2717–2728 |
|     ### What needs a connection | 2729–2740 |
|     ### On the device | 2741–3191 |
|     ### Operations | 3192–3297 |
|     ### The sync cycle | 3298–3700 |
|       #### Telling the other devices | 3658–3700 |
|     ### Conflicts | 3701–3787 |
|     ### Authentication while offline | 3788–3925 |
|   ## Schema | 3926–4929 |
|     ### Purge task | 4871–4929 |
|   ## Authentication | 4930–5227 |
|   ## API | 5228–5451 |
|     ### Auth and account | 5255–5275 |
|     ### Catalog and search | 5276–5340 |
|     ### Cascades and sync | 5341–5432 |
|     ### Admin | 5433–5451 |
|   ## Frontend | 5452–5650 |
|   ## Configuration | 5651–5706 |
|   ## Development | 5707–5837 |
|     ### One command | 5709–5792 |
|     ### How it is put together | 5793–5813 |
|     ### Day to day | 5814–5837 |
|   ## Deployment and Operations | 5838–6015 |
|   ## Backups | 6016–6122 |
|     ### What is backed up | 6022–6045 |
|     ### Alarms | 6046–6058 |
|     ### Restoring | 6059–6092 |
|     ### The drill | 6093–6114 |
|     ### Locally | 6115–6122 |
|   ## Testing | 6123–7646 |
|     ### The fixture catalog | 6139–6155 |
|     ### Contract fixtures | 6156–6262 |
|     ### Unit tests | 6263–6653 |
|     ### Integration tests | 6654–7114 |
|     ### End-to-end tests | 7115–7461 |
|       #### What the tests reuse | 7122–7189 |
|       #### The journeys | 7190–7461 |
|     ### Scale tests | 7462–7577 |
|     ### Zyzzyva parity | 7578–7597 |
|     ### Running the tests | 7598–7646 |
|   ## Delivery Phases | 7647–7681 |

Notable anchors inside long sections:

- Schema SQL begins at 3924; accounts (`users`) 4020, catalog
  (`letter_distributions`) 4071, filter specs (`search_specs`) 4160, cascades
  and quizzes (`cascades`) 4322; Purge task 4841.
- Unit tests: backend list from 6218, frontend list from 6344.

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
