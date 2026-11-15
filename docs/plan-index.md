# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–8042 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–629 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–456 |
|     ### Storage limit | 457–629 |
|   ## User Experience | 630–1711 |
|     ### Accounts | 632–639 |
|     ### Settings | 640–752 |
|       #### One cascade, or all of them | 692–720 |
|       #### This device, or all of them | 721–752 |
|     ### Creating a cascade | 753–863 |
|     ### Cascades page | 864–918 |
|     ### Trash | 919–974 |
|     ### Taking a quiz | 975–1535 |
|       #### Desktop layout | 987–1183 |
|       #### The three actions | 1184–1236 |
|       #### Answers | 1237–1301 |
|       #### Typed mode (Anagram quizzes only) | 1302–1399 |
|       #### Controls | 1400–1465 |
|       #### Touch zones | 1466–1529 |
|       #### Saving progress | 1530–1535 |
|     ### Finishing a quiz | 1536–1567 |
|     ### Exporting words | 1568–1711 |
|   ## Admin | 1712–1996 |
|     ### Uploads | 1726–1739 |
|     ### File formats | 1740–1855 |
|       #### Letter distribution file | 1764–1811 |
|       #### Lexicon file | 1812–1832 |
|       #### Leave values file | 1833–1855 |
|     ### Upload limits | 1856–1870 |
|     ### Immutability and deletion | 1871–1976 |
|       #### Replacing definitions and leave values | 1901–1976 |
|     ### Loading changes into running servers | 1977–1996 |
|   ## Tiles | 1997–2060 |
|   ## Filters | 2061–2343 |
|     ### Groups | 2080–2140 |
|     ### Pattern syntax | 2141–2166 |
|     ### Filter reference | 2167–2265 |
|     ### Probability and probability order | 2266–2285 |
|     ### Filter applicability by quiz type | 2286–2343 |
|   ## Architecture | 2344–2418 |
|     ### Tech Stack | 2371–2398 |
|     ### Repository layout | 2399–2418 |
|   ## Catalog Indexes | 2419–2478 |
|     ### Derived attributes | 2421–2478 |
|   ## Search Engine | 2479–2601 |
|   ## Cascades | 2602–2766 |
|     ### Questions are stored once per cascade | 2604–2626 |
|     ### Deterministic shuffles | 2627–2664 |
|     ### Rule implementation | 2665–2721 |
|     ### Working at 300,000 questions | 2722–2766 |
|   ## Offline and Sync | 2767–4064 |
|     ### Principles | 2769–2780 |
|     ### What needs a connection | 2781–2792 |
|     ### On the device | 2793–3252 |
|     ### Operations | 3253–3361 |
|     ### The sync cycle | 3362–3837 |
|       #### Telling the other devices | 3795–3837 |
|     ### Conflicts | 3838–3926 |
|     ### Authentication while offline | 3927–4064 |
|   ## Schema | 4065–5078 |
|     ### Purge task | 5020–5078 |
|   ## Authentication | 5079–5454 |
|   ## API | 5455–5678 |
|     ### Auth and account | 5482–5502 |
|     ### Catalog and search | 5503–5567 |
|     ### Cascades and sync | 5568–5659 |
|     ### Admin | 5660–5678 |
|   ## Frontend | 5679–5912 |
|   ## Configuration | 5913–5971 |
|   ## Development | 5972–6102 |
|     ### One command | 5974–6057 |
|     ### How it is put together | 6058–6078 |
|     ### Day to day | 6079–6102 |
|   ## Deployment and Operations | 6103–6313 |
|   ## Backups | 6314–6426 |
|     ### What is backed up | 6320–6343 |
|     ### Alarms | 6344–6359 |
|     ### Restoring | 6360–6393 |
|     ### The drill | 6394–6418 |
|     ### Locally | 6419–6426 |
|   ## Testing | 6427–8007 |
|     ### The fixture catalog | 6443–6459 |
|     ### Contract fixtures | 6460–6566 |
|     ### Unit tests | 6567–6970 |
|     ### Integration tests | 6971–7468 |
|     ### End-to-end tests | 7469–7822 |
|       #### What the tests reuse | 7476–7546 |
|       #### The journeys | 7547–7822 |
|     ### Scale tests | 7823–7938 |
|     ### Zyzzyva parity | 7939–7958 |
|     ### Running the tests | 7959–8007 |
|   ## Delivery Phases | 8008–8042 |

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
