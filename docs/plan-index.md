# PLAN.md index

Every heading in `PLAN.md` with its line range (inclusive; a range runs to the
line before the next heading of the same or higher level), as of 2026-11-14.
PLAN.md changes often and this table is made by hand: when a range looks
wrong, `grep -n '^#' PLAN.md` has today's lines (headings inside code fences
are not headings).

| Heading | Lines |
|---|---|
| # Acrodont — Project Plan | 1–8026 |
|   ## Overview | 3–72 |
|   ## Glossary | 73–91 |
|   ## Cascade Rules | 92–629 |
|     ### The Source quiz | 145–194 |
|     ### Quiz options | 195–260 |
|     ### Progression: Ladder or Drill | 261–300 |
|     ### Segments | 301–384 |
|     ### Trash, restore and purge | 385–456 |
|     ### Storage limit | 457–629 |
|   ## User Experience | 630–1700 |
|     ### Accounts | 632–639 |
|     ### Settings | 640–752 |
|       #### One cascade, or all of them | 692–720 |
|       #### This device, or all of them | 721–752 |
|     ### Creating a cascade | 753–863 |
|     ### Cascades page | 864–918 |
|     ### Trash | 919–963 |
|     ### Taking a quiz | 964–1524 |
|       #### Desktop layout | 976–1172 |
|       #### The three actions | 1173–1225 |
|       #### Answers | 1226–1290 |
|       #### Typed mode (Anagram quizzes only) | 1291–1388 |
|       #### Controls | 1389–1454 |
|       #### Touch zones | 1455–1518 |
|       #### Saving progress | 1519–1524 |
|     ### Finishing a quiz | 1525–1556 |
|     ### Exporting words | 1557–1700 |
|   ## Admin | 1701–1985 |
|     ### Uploads | 1715–1728 |
|     ### File formats | 1729–1844 |
|       #### Letter distribution file | 1753–1800 |
|       #### Lexicon file | 1801–1821 |
|       #### Leave values file | 1822–1844 |
|     ### Upload limits | 1845–1859 |
|     ### Immutability and deletion | 1860–1965 |
|       #### Replacing definitions and leave values | 1890–1965 |
|     ### Loading changes into running servers | 1966–1985 |
|   ## Tiles | 1986–2049 |
|   ## Filters | 2050–2332 |
|     ### Groups | 2069–2129 |
|     ### Pattern syntax | 2130–2155 |
|     ### Filter reference | 2156–2254 |
|     ### Probability and probability order | 2255–2274 |
|     ### Filter applicability by quiz type | 2275–2332 |
|   ## Architecture | 2333–2407 |
|     ### Tech Stack | 2360–2387 |
|     ### Repository layout | 2388–2407 |
|   ## Catalog Indexes | 2408–2467 |
|     ### Derived attributes | 2410–2467 |
|   ## Search Engine | 2468–2590 |
|   ## Cascades | 2591–2755 |
|     ### Questions are stored once per cascade | 2593–2615 |
|     ### Deterministic shuffles | 2616–2653 |
|     ### Rule implementation | 2654–2710 |
|     ### Working at 300,000 questions | 2711–2755 |
|   ## Offline and Sync | 2756–4053 |
|     ### Principles | 2758–2769 |
|     ### What needs a connection | 2770–2781 |
|     ### On the device | 2782–3241 |
|     ### Operations | 3242–3350 |
|     ### The sync cycle | 3351–3826 |
|       #### Telling the other devices | 3784–3826 |
|     ### Conflicts | 3827–3915 |
|     ### Authentication while offline | 3916–4053 |
|   ## Schema | 4054–5067 |
|     ### Purge task | 5009–5067 |
|   ## Authentication | 5068–5443 |
|   ## API | 5444–5667 |
|     ### Auth and account | 5471–5491 |
|     ### Catalog and search | 5492–5556 |
|     ### Cascades and sync | 5557–5648 |
|     ### Admin | 5649–5667 |
|   ## Frontend | 5668–5896 |
|   ## Configuration | 5897–5955 |
|   ## Development | 5956–6086 |
|     ### One command | 5958–6041 |
|     ### How it is put together | 6042–6062 |
|     ### Day to day | 6063–6086 |
|   ## Deployment and Operations | 6087–6297 |
|   ## Backups | 6298–6410 |
|     ### What is backed up | 6304–6327 |
|     ### Alarms | 6328–6343 |
|     ### Restoring | 6344–6377 |
|     ### The drill | 6378–6402 |
|     ### Locally | 6403–6410 |
|   ## Testing | 6411–7991 |
|     ### The fixture catalog | 6427–6443 |
|     ### Contract fixtures | 6444–6550 |
|     ### Unit tests | 6551–6954 |
|     ### Integration tests | 6955–7452 |
|     ### End-to-end tests | 7453–7806 |
|       #### What the tests reuse | 7460–7530 |
|       #### The journeys | 7531–7806 |
|     ### Scale tests | 7807–7922 |
|     ### Zyzzyva parity | 7923–7942 |
|     ### Running the tests | 7943–7991 |
|   ## Delivery Phases | 7992–8026 |

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
