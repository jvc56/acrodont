# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-13.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7573 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–597 |
|     ### The Source quiz | 145–193 |
|     ### Quiz options | 194–259 |
|     ### Progression: Ladder or Drill | 260–299 |
|     ### Segments | 300–383 |
|     ### Trash, restore and purge | 384–451 |
|     ### Storage limit | 452–597 |
|   ## User Experience | 598–1636 |
|     ### Accounts | 600–607 |
|     ### Settings | 608–716 |
|       #### One cascade, or all of them | 660–688 |
|       #### This device, or all of them | 689–716 |
|     ### Creating a cascade | 717–827 |
|     ### Cascades page | 828–880 |
|     ### Trash | 881–925 |
|     ### Taking a quiz | 926–1481 |
|       #### Desktop layout | 938–1131 |
|       #### The three actions | 1132–1184 |
|       #### Answers | 1185–1249 |
|       #### Typed mode (Anagram quizzes only) | 1250–1346 |
|       #### Controls | 1347–1412 |
|       #### Touch zones | 1413–1475 |
|       #### Saving progress | 1476–1481 |
|     ### Finishing a quiz | 1482–1513 |
|     ### Exporting words | 1514–1636 |
|   ## Admin | 1637–1915 |
|     ### Uploads | 1651–1664 |
|     ### File formats | 1665–1780 |
|       #### Letter distribution file | 1689–1736 |
|       #### Lexicon file | 1737–1757 |
|       #### Leave values file | 1758–1780 |
|     ### Upload limits | 1781–1791 |
|     ### Immutability and deletion | 1792–1895 |
|       #### Replacing definitions and leave values | 1822–1895 |
|     ### Loading changes into running servers | 1896–1915 |
|   ## Tiles | 1916–1979 |
|   ## Filters | 1980–2262 |
|     ### Groups | 1999–2059 |
|     ### Pattern syntax | 2060–2085 |
|     ### Filter reference | 2086–2184 |
|     ### Probability and probability order | 2185–2204 |
|     ### Filter applicability by quiz type | 2205–2262 |
|   ## Architecture | 2263–2337 |
|     ### Tech Stack | 2290–2317 |
|     ### Repository layout | 2318–2337 |
|   ## Catalog Indexes | 2338–2397 |
|     ### Derived attributes | 2340–2397 |
|   ## Search Engine | 2398–2520 |
|   ## Cascades | 2521–2685 |
|     ### Questions are stored once per cascade | 2523–2545 |
|     ### Deterministic shuffles | 2546–2583 |
|     ### Rule implementation | 2584–2640 |
|     ### Working at 300,000 questions | 2641–2685 |
|   ## Offline and Sync | 2686–3814 |
|     ### Principles | 2688–2699 |
|     ### What needs a connection | 2700–2711 |
|     ### On the device | 2712–3147 |
|     ### Operations | 3148–3253 |
|     ### The sync cycle | 3254–3615 |
|       #### Telling the other devices | 3586–3615 |
|     ### Conflicts | 3616–3702 |
|     ### Authentication while offline | 3703–3814 |
|   ## Schema | 3815–4818 |
|     ### Purge task | 4760–4818 |
|   ## Authentication | 4819–5098 |
|   ## API | 5099–5322 |
|     ### Auth and account | 5126–5146 |
|     ### Catalog and search | 5147–5211 |
|     ### Cascades and sync | 5212–5303 |
|     ### Admin | 5304–5322 |
|   ## Frontend | 5323–5519 |
|   ## Configuration | 5520–5572 |
|   ## Development | 5573–5703 |
|     ### One command | 5575–5658 |
|     ### How it is put together | 5659–5679 |
|     ### Day to day | 5680–5703 |
|   ## Deployment and Operations | 5704–5881 |
|   ## Backups | 5882–5988 |
|     ### What is backed up | 5888–5911 |
|     ### Alarms | 5912–5924 |
|     ### Restoring | 5925–5958 |
|     ### The drill | 5959–5980 |
|     ### Locally | 5981–5988 |
|   ## Testing | 5989–7538 |
|     ### The fixture catalog | 6005–6021 |
|     ### Contract fixtures | 6022–6128 |
|     ### Unit tests | 6129–6558 |
|     ### Integration tests | 6559–6996 |
|     ### End-to-end tests | 6997–7353 |
|       #### What the tests reuse | 7004–7071 |
|       #### The journeys | 7072–7353 |
|     ### Scale tests | 7354–7469 |
|     ### Zyzzyva parity | 7470–7489 |
|     ### Running the tests | 7490–7538 |
|   ## Delivery Phases | 7539–7573 |
Notable anchors inside long sections:

- Schema SQL begins at 3843; accounts (`users`) 3939, catalog
  (`letter_distributions`) 3990, filter specs (`search_specs`) 4079, cascades
  and quizzes (`cascades`) 4241; Purge task 4760.
- Unit tests: backend list from 6133, frontend list from 6259.

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
