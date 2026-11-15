# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-15.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–8102 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–629 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–456 |
|     ### Storage limit | 457–629 |
|   ## User Experience | 630–1718 |
|     ### Accounts | 632–639 |
|     ### Settings | 640–752 |
|       #### One cascade, or all of them | 692–720 |
|       #### This device, or all of them | 721–752 |
|     ### Creating a cascade | 753–863 |
|     ### Cascades page | 864–918 |
|     ### Trash | 919–974 |
|     ### Taking a quiz | 975–1542 |
|       #### Desktop layout | 987–1190 |
|       #### The three actions | 1191–1243 |
|       #### Answers | 1244–1308 |
|       #### Typed mode (Anagram quizzes only) | 1309–1406 |
|       #### Controls | 1407–1472 |
|       #### Touch zones | 1473–1536 |
|       #### Saving progress | 1537–1542 |
|     ### Finishing a quiz | 1543–1574 |
|     ### Exporting words | 1575–1718 |
|   ## Admin | 1719–2003 |
|     ### Uploads | 1733–1746 |
|     ### File formats | 1747–1862 |
|       #### Letter distribution file | 1771–1818 |
|       #### Lexicon file | 1819–1839 |
|       #### Leave values file | 1840–1862 |
|     ### Upload limits | 1863–1877 |
|     ### Immutability and deletion | 1878–1983 |
|       #### Replacing definitions and leave values | 1908–1983 |
|     ### Loading changes into running servers | 1984–2003 |
|   ## Tiles | 2004–2067 |
|   ## Filters | 2068–2350 |
|     ### Groups | 2087–2147 |
|     ### Pattern syntax | 2148–2173 |
|     ### Filter reference | 2174–2272 |
|     ### Probability and probability order | 2273–2292 |
|     ### Filter applicability by quiz type | 2293–2350 |
|   ## Architecture | 2351–2425 |
|     ### Tech Stack | 2378–2405 |
|     ### Repository layout | 2406–2425 |
|   ## Catalog Indexes | 2426–2485 |
|     ### Derived attributes | 2428–2485 |
|   ## Search Engine | 2486–2608 |
|   ## Cascades | 2609–2773 |
|     ### Questions are stored once per cascade | 2611–2633 |
|     ### Deterministic shuffles | 2634–2671 |
|     ### Rule implementation | 2672–2728 |
|     ### Working at 300,000 questions | 2729–2773 |
|   ## Offline and Sync | 2774–4098 |
|     ### Principles | 2776–2787 |
|     ### What needs a connection | 2788–2799 |
|     ### On the device | 2800–3259 |
|     ### Operations | 3260–3368 |
|     ### The sync cycle | 3369–3871 |
|       #### Telling the other devices | 3829–3871 |
|     ### Conflicts | 3872–3960 |
|     ### Authentication while offline | 3961–4098 |
|   ## Schema | 4099–5112 |
|     ### Purge task | 5054–5112 |
|   ## Authentication | 5113–5488 |
|   ## API | 5489–5712 |
|     ### Auth and account | 5516–5536 |
|     ### Catalog and search | 5537–5601 |
|     ### Cascades and sync | 5602–5693 |
|     ### Admin | 5694–5712 |
|   ## Frontend | 5713–5950 |
|   ## Configuration | 5951–6009 |
|   ## Development | 6010–6140 |
|     ### One command | 6012–6095 |
|     ### How it is put together | 6096–6116 |
|     ### Day to day | 6117–6140 |
|   ## Deployment and Operations | 6141–6351 |
|   ## Backups | 6352–6464 |
|     ### What is backed up | 6358–6381 |
|     ### Alarms | 6382–6397 |
|     ### Restoring | 6398–6431 |
|     ### The drill | 6432–6456 |
|     ### Locally | 6457–6464 |
|   ## Testing | 6465–8067 |
|     ### The fixture catalog | 6481–6497 |
|     ### Contract fixtures | 6498–6604 |
|     ### Unit tests | 6605–7007 |
|     ### Integration tests | 7008–7512 |
|     ### End-to-end tests | 7513–7882 |
|       #### What the tests reuse | 7520–7605 |
|       #### The journeys | 7606–7882 |
|     ### Scale tests | 7883–7998 |
|     ### Zyzzyva parity | 7999–8018 |
|     ### Running the tests | 8019–8067 |
|   ## Delivery Phases | 8068–8102 |

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
