# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–7736 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–625 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–452 |
|     ### Storage limit | 453–625 |
|   ## User Experience | 626–1688 |
|     ### Accounts | 628–635 |
|     ### Settings | 636–748 |
|       #### One cascade, or all of them | 688–716 |
|       #### This device, or all of them | 717–748 |
|     ### Creating a cascade | 749–859 |
|     ### Cascades page | 860–914 |
|     ### Trash | 915–959 |
|     ### Taking a quiz | 960–1520 |
|       #### Desktop layout | 972–1168 |
|       #### The three actions | 1169–1221 |
|       #### Answers | 1222–1286 |
|       #### Typed mode (Anagram quizzes only) | 1287–1384 |
|       #### Controls | 1385–1450 |
|       #### Touch zones | 1451–1514 |
|       #### Saving progress | 1515–1520 |
|     ### Finishing a quiz | 1521–1552 |
|     ### Exporting words | 1553–1688 |
|   ## Admin | 1689–1973 |
|     ### Uploads | 1703–1716 |
|     ### File formats | 1717–1832 |
|       #### Letter distribution file | 1741–1788 |
|       #### Lexicon file | 1789–1809 |
|       #### Leave values file | 1810–1832 |
|     ### Upload limits | 1833–1847 |
|     ### Immutability and deletion | 1848–1953 |
|       #### Replacing definitions and leave values | 1878–1953 |
|     ### Loading changes into running servers | 1954–1973 |
|   ## Tiles | 1974–2037 |
|   ## Filters | 2038–2320 |
|     ### Groups | 2057–2117 |
|     ### Pattern syntax | 2118–2143 |
|     ### Filter reference | 2144–2242 |
|     ### Probability and probability order | 2243–2262 |
|     ### Filter applicability by quiz type | 2263–2320 |
|   ## Architecture | 2321–2395 |
|     ### Tech Stack | 2348–2375 |
|     ### Repository layout | 2376–2395 |
|   ## Catalog Indexes | 2396–2455 |
|     ### Derived attributes | 2398–2455 |
|   ## Search Engine | 2456–2578 |
|   ## Cascades | 2579–2743 |
|     ### Questions are stored once per cascade | 2581–2603 |
|     ### Deterministic shuffles | 2604–2641 |
|     ### Rule implementation | 2642–2698 |
|     ### Working at 300,000 questions | 2699–2743 |
|   ## Offline and Sync | 2744–3959 |
|     ### Principles | 2746–2757 |
|     ### What needs a connection | 2758–2769 |
|     ### On the device | 2770–3220 |
|     ### Operations | 3221–3329 |
|     ### The sync cycle | 3330–3732 |
|       #### Telling the other devices | 3690–3732 |
|     ### Conflicts | 3733–3821 |
|     ### Authentication while offline | 3822–3959 |
|   ## Schema | 3960–4963 |
|     ### Purge task | 4905–4963 |
|   ## Authentication | 4964–5261 |
|   ## API | 5262–5485 |
|     ### Auth and account | 5289–5309 |
|     ### Catalog and search | 5310–5374 |
|     ### Cascades and sync | 5375–5466 |
|     ### Admin | 5467–5485 |
|   ## Frontend | 5486–5685 |
|   ## Configuration | 5686–5741 |
|   ## Development | 5742–5872 |
|     ### One command | 5744–5827 |
|     ### How it is put together | 5828–5848 |
|     ### Day to day | 5849–5872 |
|   ## Deployment and Operations | 5873–6062 |
|   ## Backups | 6063–6169 |
|     ### What is backed up | 6069–6092 |
|     ### Alarms | 6093–6105 |
|     ### Restoring | 6106–6139 |
|     ### The drill | 6140–6161 |
|     ### Locally | 6162–6169 |
|   ## Testing | 6170–7701 |
|     ### The fixture catalog | 6186–6202 |
|     ### Contract fixtures | 6203–6309 |
|     ### Unit tests | 6310–6703 |
|     ### Integration tests | 6704–7168 |
|     ### End-to-end tests | 7169–7516 |
|       #### What the tests reuse | 7176–7243 |
|       #### The journeys | 7244–7516 |
|     ### Scale tests | 7517–7632 |
|     ### Zyzzyva parity | 7633–7652 |
|     ### Running the tests | 7653–7701 |
|   ## Delivery Phases | 7702–7736 |

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
