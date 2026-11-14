# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7604 |
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
|   ## Admin | 1647–1927 |
|     ### Uploads | 1661–1674 |
|     ### File formats | 1675–1790 |
|       #### Letter distribution file | 1699–1746 |
|       #### Lexicon file | 1747–1767 |
|       #### Leave values file | 1768–1790 |
|     ### Upload limits | 1791–1801 |
|     ### Immutability and deletion | 1802–1907 |
|       #### Replacing definitions and leave values | 1832–1907 |
|     ### Loading changes into running servers | 1908–1927 |
|   ## Tiles | 1928–1991 |
|   ## Filters | 1992–2274 |
|     ### Groups | 2011–2071 |
|     ### Pattern syntax | 2072–2097 |
|     ### Filter reference | 2098–2196 |
|     ### Probability and probability order | 2197–2216 |
|     ### Filter applicability by quiz type | 2217–2274 |
|   ## Architecture | 2275–2349 |
|     ### Tech Stack | 2302–2329 |
|     ### Repository layout | 2330–2349 |
|   ## Catalog Indexes | 2350–2409 |
|     ### Derived attributes | 2352–2409 |
|   ## Search Engine | 2410–2532 |
|   ## Cascades | 2533–2697 |
|     ### Questions are stored once per cascade | 2535–2557 |
|     ### Deterministic shuffles | 2558–2595 |
|     ### Rule implementation | 2596–2652 |
|     ### Working at 300,000 questions | 2653–2697 |
|   ## Offline and Sync | 2698–3895 |
|     ### Principles | 2700–2711 |
|     ### What needs a connection | 2712–2723 |
|     ### On the device | 2724–3168 |
|     ### Operations | 3169–3274 |
|     ### The sync cycle | 3275–3677 |
|       #### Telling the other devices | 3635–3677 |
|     ### Conflicts | 3678–3764 |
|     ### Authentication while offline | 3765–3895 |
|   ## Schema | 3896–4899 |
|     ### Purge task | 4841–4899 |
|   ## Authentication | 4900–5181 |
|   ## API | 5182–5405 |
|     ### Auth and account | 5209–5229 |
|     ### Catalog and search | 5230–5294 |
|     ### Cascades and sync | 5295–5386 |
|     ### Admin | 5387–5405 |
|   ## Frontend | 5406–5602 |
|   ## Configuration | 5603–5657 |
|   ## Development | 5658–5788 |
|     ### One command | 5660–5743 |
|     ### How it is put together | 5744–5764 |
|     ### Day to day | 5765–5788 |
|   ## Deployment and Operations | 5789–5966 |
|   ## Backups | 5967–6073 |
|     ### What is backed up | 5973–5996 |
|     ### Alarms | 5997–6009 |
|     ### Restoring | 6010–6043 |
|     ### The drill | 6044–6065 |
|     ### Locally | 6066–6073 |
|   ## Testing | 6074–7569 |
|     ### The fixture catalog | 6090–6106 |
|     ### Contract fixtures | 6107–6213 |
|     ### Unit tests | 6214–6587 |
|     ### Integration tests | 6588–7037 |
|     ### End-to-end tests | 7038–7384 |
|       #### What the tests reuse | 7045–7112 |
|       #### The journeys | 7113–7384 |
|     ### Scale tests | 7385–7500 |
|     ### Zyzzyva parity | 7501–7520 |
|     ### Running the tests | 7521–7569 |
|   ## Delivery Phases | 7570–7604 |

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
