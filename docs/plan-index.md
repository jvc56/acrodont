# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7664 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–598 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–452 |
|     ### Storage limit | 453–598 |
|   ## User Experience | 599–1646 |
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
|     ### Exporting words | 1524–1646 |
|   ## Admin | 1647–1931 |
|     ### Uploads | 1661–1674 |
|     ### File formats | 1675–1790 |
|       #### Letter distribution file | 1699–1746 |
|       #### Lexicon file | 1747–1767 |
|       #### Leave values file | 1768–1790 |
|     ### Upload limits | 1791–1805 |
|     ### Immutability and deletion | 1806–1911 |
|       #### Replacing definitions and leave values | 1836–1911 |
|     ### Loading changes into running servers | 1912–1931 |
|   ## Tiles | 1932–1995 |
|   ## Filters | 1996–2278 |
|     ### Groups | 2015–2075 |
|     ### Pattern syntax | 2076–2101 |
|     ### Filter reference | 2102–2200 |
|     ### Probability and probability order | 2201–2220 |
|     ### Filter applicability by quiz type | 2221–2278 |
|   ## Architecture | 2279–2353 |
|     ### Tech Stack | 2306–2333 |
|     ### Repository layout | 2334–2353 |
|   ## Catalog Indexes | 2354–2413 |
|     ### Derived attributes | 2356–2413 |
|   ## Search Engine | 2414–2536 |
|   ## Cascades | 2537–2701 |
|     ### Questions are stored once per cascade | 2539–2561 |
|     ### Deterministic shuffles | 2562–2599 |
|     ### Rule implementation | 2600–2656 |
|     ### Working at 300,000 questions | 2657–2701 |
|   ## Offline and Sync | 2702–3912 |
|     ### Principles | 2704–2715 |
|     ### What needs a connection | 2716–2727 |
|     ### On the device | 2728–3178 |
|     ### Operations | 3179–3284 |
|     ### The sync cycle | 3285–3687 |
|       #### Telling the other devices | 3645–3687 |
|     ### Conflicts | 3688–3774 |
|     ### Authentication while offline | 3775–3912 |
|   ## Schema | 3913–4916 |
|     ### Purge task | 4858–4916 |
|   ## Authentication | 4917–5214 |
|   ## API | 5215–5438 |
|     ### Auth and account | 5242–5262 |
|     ### Catalog and search | 5263–5327 |
|     ### Cascades and sync | 5328–5419 |
|     ### Admin | 5420–5438 |
|   ## Frontend | 5439–5637 |
|   ## Configuration | 5638–5693 |
|   ## Development | 5694–5824 |
|     ### One command | 5696–5779 |
|     ### How it is put together | 5780–5800 |
|     ### Day to day | 5801–5824 |
|   ## Deployment and Operations | 5825–6002 |
|   ## Backups | 6003–6109 |
|     ### What is backed up | 6009–6032 |
|     ### Alarms | 6033–6045 |
|     ### Restoring | 6046–6079 |
|     ### The drill | 6080–6101 |
|     ### Locally | 6102–6109 |
|   ## Testing | 6110–7629 |
|     ### The fixture catalog | 6126–6142 |
|     ### Contract fixtures | 6143–6249 |
|     ### Unit tests | 6250–6636 |
|     ### Integration tests | 6637–7097 |
|     ### End-to-end tests | 7098–7444 |
|       #### What the tests reuse | 7105–7172 |
|       #### The journeys | 7173–7444 |
|     ### Scale tests | 7445–7560 |
|     ### Zyzzyva parity | 7561–7580 |
|     ### Running the tests | 7581–7629 |
|   ## Delivery Phases | 7630–7664 |

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
