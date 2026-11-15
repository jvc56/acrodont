# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-15.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–8235 |
|   ## Overview | 3–74 |
|   ## Glossary | 75–93 |
|   ## Cascade Rules | 94–631 |
|     ### The Source quiz | 147–196 |
|     ### Quiz options | 197–262 |
|     ### Progression: Ladder or Drill | 263–302 |
|     ### Segments | 303–386 |
|     ### Trash, restore and purge | 387–458 |
|     ### Storage limit | 459–631 |
|   ## User Experience | 632–1720 |
|     ### Accounts | 634–641 |
|     ### Settings | 642–754 |
|       #### One cascade, or all of them | 694–722 |
|       #### This device, or all of them | 723–754 |
|     ### Creating a cascade | 755–865 |
|     ### Cascades page | 866–920 |
|     ### Trash | 921–976 |
|     ### Taking a quiz | 977–1544 |
|       #### Desktop layout | 989–1192 |
|       #### The three actions | 1193–1245 |
|       #### Answers | 1246–1310 |
|       #### Typed mode (Anagram quizzes only) | 1311–1408 |
|       #### Controls | 1409–1474 |
|       #### Touch zones | 1475–1538 |
|       #### Saving progress | 1539–1544 |
|     ### Finishing a quiz | 1545–1576 |
|     ### Exporting words | 1577–1720 |
|   ## Admin | 1721–2066 |
|     ### Uploads | 1735–1748 |
|     ### File formats | 1749–1864 |
|       #### Letter distribution file | 1773–1820 |
|       #### Lexicon file | 1821–1841 |
|       #### Leave values file | 1842–1864 |
|     ### Upload limits | 1865–1879 |
|     ### Immutability and deletion | 1880–2044 |
|       #### Replacing definitions, playabilities and leave values | 1913–2044 |
|     ### Loading changes into running servers | 2045–2066 |
|   ## Tiles | 2067–2130 |
|   ## Filters | 2131–2413 |
|     ### Groups | 2150–2210 |
|     ### Pattern syntax | 2211–2236 |
|     ### Filter reference | 2237–2335 |
|     ### Probability and probability order | 2336–2355 |
|     ### Filter applicability by quiz type | 2356–2413 |
|   ## Architecture | 2414–2488 |
|     ### Tech Stack | 2441–2468 |
|     ### Repository layout | 2469–2488 |
|   ## Catalog Indexes | 2489–2554 |
|     ### Derived attributes | 2491–2554 |
|   ## Search Engine | 2555–2677 |
|   ## Cascades | 2678–2842 |
|     ### Questions are stored once per cascade | 2680–2702 |
|     ### Deterministic shuffles | 2703–2740 |
|     ### Rule implementation | 2741–2797 |
|     ### Working at 300,000 questions | 2798–2842 |
|   ## Offline and Sync | 2843–4170 |
|     ### Principles | 2845–2856 |
|     ### What needs a connection | 2857–2868 |
|     ### On the device | 2869–3331 |
|     ### Operations | 3332–3440 |
|     ### The sync cycle | 3441–3943 |
|       #### Telling the other devices | 3901–3943 |
|     ### Conflicts | 3944–4032 |
|     ### Authentication while offline | 4033–4170 |
|   ## Schema | 4171–5194 |
|     ### Purge task | 5136–5194 |
|   ## Authentication | 5195–5570 |
|   ## API | 5571–5795 |
|     ### Auth and account | 5598–5618 |
|     ### Catalog and search | 5619–5683 |
|     ### Cascades and sync | 5684–5775 |
|     ### Admin | 5776–5795 |
|   ## Frontend | 5796–6034 |
|   ## Configuration | 6035–6093 |
|   ## Development | 6094–6224 |
|     ### One command | 6096–6179 |
|     ### How it is put together | 6180–6200 |
|     ### Day to day | 6201–6224 |
|   ## Deployment and Operations | 6225–6435 |
|   ## Backups | 6436–6548 |
|     ### What is backed up | 6442–6465 |
|     ### Alarms | 6466–6481 |
|     ### Restoring | 6482–6515 |
|     ### The drill | 6516–6540 |
|     ### Locally | 6541–6548 |
|   ## Testing | 6549–8200 |
|     ### The fixture catalog | 6565–6581 |
|     ### Contract fixtures | 6582–6688 |
|     ### Unit tests | 6689–7100 |
|     ### Integration tests | 7101–7628 |
|     ### End-to-end tests | 7629–8015 |
|       #### What the tests reuse | 7636–7733 |
|       #### The journeys | 7734–8015 |
|     ### Scale tests | 8016–8131 |
|     ### Zyzzyva parity | 8132–8151 |
|     ### Running the tests | 8152–8200 |
|   ## Delivery Phases | 8201–8235 |

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
