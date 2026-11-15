# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–8049 |
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
|   ## Offline and Sync | 2774–4071 |
|     ### Principles | 2776–2787 |
|     ### What needs a connection | 2788–2799 |
|     ### On the device | 2800–3259 |
|     ### Operations | 3260–3368 |
|     ### The sync cycle | 3369–3844 |
|       #### Telling the other devices | 3802–3844 |
|     ### Conflicts | 3845–3933 |
|     ### Authentication while offline | 3934–4071 |
|   ## Schema | 4072–5085 |
|     ### Purge task | 5027–5085 |
|   ## Authentication | 5086–5461 |
|   ## API | 5462–5685 |
|     ### Auth and account | 5489–5509 |
|     ### Catalog and search | 5510–5574 |
|     ### Cascades and sync | 5575–5666 |
|     ### Admin | 5667–5685 |
|   ## Frontend | 5686–5919 |
|   ## Configuration | 5920–5978 |
|   ## Development | 5979–6109 |
|     ### One command | 5981–6064 |
|     ### How it is put together | 6065–6085 |
|     ### Day to day | 6086–6109 |
|   ## Deployment and Operations | 6110–6320 |
|   ## Backups | 6321–6433 |
|     ### What is backed up | 6327–6350 |
|     ### Alarms | 6351–6366 |
|     ### Restoring | 6367–6400 |
|     ### The drill | 6401–6425 |
|     ### Locally | 6426–6433 |
|   ## Testing | 6434–8014 |
|     ### The fixture catalog | 6450–6466 |
|     ### Contract fixtures | 6467–6573 |
|     ### Unit tests | 6574–6977 |
|     ### Integration tests | 6978–7475 |
|     ### End-to-end tests | 7476–7829 |
|       #### What the tests reuse | 7483–7553 |
|       #### The journeys | 7554–7829 |
|     ### Scale tests | 7830–7945 |
|     ### Zyzzyva parity | 7946–7965 |
|     ### Running the tests | 7966–8014 |
|   ## Delivery Phases | 8015–8049 |

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
