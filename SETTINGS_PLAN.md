# Settings for each cascade on each device, and presets: a plan

**Date:** 2026-11-17
**Status:** implemented on 2026-11-17, on branch `settings-per-cascade-device`.
The six decisions (D1–D6, under "Decisions") were taken the same day, each as
recommended. PLAN.md § Settings is the spec again; this file records how the
design was decided.

### Implementation status

Built as planned, with these differences:

- **Presets reach the devices through a version, not the pull.** The pull
  is built around cascades: its rows are staged and rebased cascade by
  cascade, and its tombstones name a cascade or a quiz. Presets would have
  needed a tombstone entity and a path of their own through the rebase. So
  the account has a `presets_version`, bumped by every change. The sync
  request carries the version the device holds (null for none), and every
  response carries the account's version, plus the whole list when the two
  differ. The list is at most 50 presets, and it comes only when it changed.
  The `setting_presets` table therefore has no `updated_seq`, and a deleted
  preset leaves no tombstone. A device that saves, renames or deletes a
  preset changes its own list at once and forgets its version, so its next
  sync brings the account's whole list. A change another device made in the
  meantime is never missed.
- **A widened change is stamped strictly later** than every change it is
  made over (`store.svelte.ts`). Two changes made in the same millisecond
  would otherwise tie, and the narrower one would win.
- **The device's meta keys** are `cascade_device_scope`, `device_scope`,
  `account_settings`, `clock`, `presets` and `last_preset_id`. IndexedDB
  version 4 drops the old `shared_device`, `device_settings` and
  `cascade_device_settings`. It also strips `settings` from any queued
  `set_cascade_options`.

## The goal

Today a setting can be set in four places, and the first place that holds a
value wins (PLAN.md § Settings → Where a setting applies;
`frontend/src/lib/settings/layers.ts`). Each row has two switches that show
which place its value comes from, and pressing a switch moves the value.
This is hard to reason about. A value set "everywhere" can be hidden by an old
value in a narrower place, and the switches have to explain all of that.

The new design:

1. **Every (cascade, device) pair has its own settings.** A change applies to
   this cascade on this device and nowhere else.
2. **After a change, an offer to apply it more widely**: to this cascade on
   all devices, to all cascades on this device, or to all cascades on all
   devices.
3. **Presets** (D1). The user saves the settings they
   are looking at under a name, and can apply that preset to another cascade
   later.
4. **"Apply preset" replaces "Copy another cascade's settings"** in a
   cascade's Settings.
5. **Creating a cascade lets the user pick a preset.** If none is picked, the
   cascade starts with the defaults.

Since the owner is the only user, the schema is changed in place in
`0001_initial.sql`, with no second migration, and the database is reset (see
"Resetting").

## Summary

- **Users see a copy of the settings for each cascade on each device.** The
  implementation does not store N × M copies. It stores **a record of each
  change and the scope it was made in**. For each setting, a pair's value is
  the **latest** change whose scope covers that pair. That gives the same
  result as literal copies without copying anything, and it works offline
  (see "The model").
- **The four places stay, but the precedence goes.** Of the changes that
  apply, the most recent one wins, whatever its scope. Nothing can be hidden
  behind a narrower place, so the switches, "Replaced …", moving a value and
  Reset-from-a-place all go.
- **A cascade's rules (clear threshold, segment size, progression) stay one
  value per cascade**, shared by every device. The server judges a pass by
  them, so two devices cannot disagree (D2).
- **Presets** are kept per account on the server. Saving or renaming one
  needs a connection (D4). Each device keeps a copy, so a preset can be
  applied offline. A built-in **Defaults** preset resets a cascade (D6).
- **"All cascades" means the cascades that exist when the change is made**
  (D5). New cascades take their values from a preset.

## What the user sees

### A change, and the offer under it

A setting row shows its value and nothing else: no switches and no
"comes from". A change is saved at once, as today, for **this cascade on
this device**, and the offer appears under the row:

> ✓ Saved for this cascade on this device · Also apply to: **this cascade on
> all devices** · **all 12 cascades on this device** · **all 12 cascades on
> all devices**

- Each link takes one tap and stays done until the dialog closes, like the
  rules' offer today (`ApplyWider.svelte`). Taking a wider link also marks
  the narrower links it covers as done. After "all 12 cascades on all
  devices", the other two read ✓ as well.
- N counts the cascades not in the Trash, as the rules' offer does. With one
  cascade, only "this cascade on all devices" is offered.
- The controls are one setting, as today, with one offer under the Controls
  heading.
- **A rule** keeps today's offer ("✓ Saved for this cascade · Also use for:
  all N cascades"), because rules have no device dimension.

What "all cascades" means (D5): **the cascades that exist when the change
is made**, the Trash included. A cascade created later starts from its
preset or from the defaults, as goal 5 asks, and is not affected by an
earlier "all cascades" change. If the user wants new cascades to get a
value, they put it in a preset.

There is no per-row Reset. To return a cascade to the defaults, the user
applies the built-in **Defaults** preset (D6).

### Presets

In the This Cascade section, **Copy another cascade's settings** is replaced
by two controls:

- **Apply preset**: a select listing **Defaults** first, then the user's
  presets by name, and an **Apply** button. Applying gives this cascade on
  this device every setting the preset holds, and gives this cascade every
  rule the preset holds (D3). Then the same "Also apply to" offer appears
  for the settings. The rules have their own offer, "all N cascades", as
  after any rule change. The confirmation reads "✓ Applied “Phone”:
  7 settings changed." or "✓ This cascade already matches “Phone”."
- **Defaults** (D6) is built in. It holds every setting's default and the
  default rules (`CASCADE_SETTING_DEFAULTS`). It cannot be renamed, deleted
  or replaced, and "Defaults" cannot be used as a preset's name. Applying it
  records `null` (the default) for every setting, so a later change to a
  default in a new build still reaches the cascade.
- **Save as preset…**: a name field. A preset saved this way holds **every
  setting's value as this cascade shows it on this device, and the
  cascade's three rules**. If the name is already taken, the user is asked
  "Replace your preset “Phone”?", as replacing a saved search is
  (JOURNEYS C-16). Saving needs a connection (D4): offline, the message is
  "Saving a preset needs a connection.", the same pattern as renaming a
  cascade. Rename and Delete are on each preset's entry in the same list,
  and need a connection too.

### Creating a cascade

The builder gains one control above Create Cascade: **Settings: [Defaults ▾]**,
listing Defaults and then the presets. A preset's rules and settings become
the new cascade's starting values on every device. With Defaults, the
cascade starts with the defaults. The note "You can change this cascade’s
settings … once it is created" stays. The builder has no other settings
(JOURNEYS C-1).

**The select starts at the preset this device used last** to create a
cascade (D6), kept in this device's `meta` (`last_preset_id`). If that
preset has been deleted, or none was used yet, it starts at Defaults.

Duplicate cascade gives the copy **the original's settings as they are on
the duplicating device**, plus the original's rules. The original's
differences on other devices are not carried over.

## The model

### Four scopes of change, resolved by recency

Every change to a setting is recorded as `{ value, at }` in one of four
scopes:

| Scope | Key | Kept | Synced |
|---|---|---|---|
| this cascade, this device | (c, d) | device `meta` | no |
| this cascade, all devices | (c, \*) | `cascades.settings` | yes |
| all cascades, this device | (\*, d) | device `meta` | no |
| all cascades, all devices | (\*, \*) | `users.settings` | yes |

For cascade **c** on device **d**, a setting's value is the entry with the
**latest `at`** among the up to four entries that cover (c, d). Entries from
the all-cascades scopes, (\*, d) and (\*, \*), are **ignored when their `at`
is before c was created**. If no entry is left, the setting's default is
used. A value of `null` means "the default" and takes part in the recency
comparison like any other value (that is how Apply "Defaults" is recorded).

A preset applied at creation is recorded as (c, \*) entries with
`at = created_at`. A cascade created with Defaults has no entries.

The result is the same as literal copies. Each pair behaves as if it held
its own settings and every widened change had been written into each copy it
covers at the moment it was made:

| Step | (c1, phone) | (c1, laptop) | (c2, phone) |
|---|---|---|---|
| t1: on the phone, c1 font size 30, this cascade on this device | **30** | default | default |
| t2: on the laptop, c1 font size 24, this cascade on all devices | **24** (t2 > t1) | **24** | default |
| t3: on the phone, font size 40, all cascades on this device | **40** | 24 | **40** |
| t4: c3 created on the phone with Defaults | | | (c3, phone): default; t3 is before c3's creation |

### Why not store literal copies

Literal copies are the obvious alternative: a server table with one row per
(cascade, device), and "all devices" written into every row. It has three
problems that the recency model avoids:

- **A device that has never opened a cascade has no copy yet.** Something
  still has to define what that copy starts as. The natural answer, the
  cascade's starting values plus every later all-devices change, is the
  recency model.
- **Every broad change fans out** to cascades × devices rows. Offline, the
  fan-out has to wait for the server, and two devices that both widened
  changes offline have to be merged row by row, which needs per-setting
  timestamps anyway.
- **Device-only settings would have to go to the server** just so that
  another device could overwrite them.

### Clocks

The resolution compares `at` values made on different devices. The server
already caps every synced `at` at `now + 5 minutes`. In addition, **the sync
response gains `server_time`**. The device keeps the offset between that and
its own clock, and stamps every settings `at` (local ones included) with
`Date.now() + offset`. A device whose clock is wrong then still orders its
local changes correctly against changes made on other devices. Before its
first sync, it uses its own clock.

## Where it is kept

### Schema (edited in `0001_initial.sql`)

- `users.device_settings` → **`users.settings`**, the (\*, \*) scope. The
  shape is unchanged: setting name → `{ value, at }`. It is merged per
  setting, latest `at` wins, and carried whole in every sync response, as
  today. The 64-setting and 16 KB bounds stay.
- `cascades.settings` changes shape from setting name → value to setting
  name → **`{ value, at }`**, the (c, \*) scope. It is merged per setting,
  latest `at` wins. It no longer loses whole to a later
  `set_cascade_options`. Same bounds.
- New table **`setting_presets`**:

  ```sql
  CREATE TABLE setting_presets (
      id           UUID PRIMARY KEY,           -- device-generated, so a save can be retried
      user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      settings     JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
                       -- setting name -> value, every setting at the time it was saved
      clear_threshold SMALLINT NOT NULL CHECK (clear_threshold BETWEEN 1 AND 100),
      segment_size    INTEGER NOT NULL CHECK (segment_size = 0 OR segment_size BETWEEN 5 AND 300000),
      progression     quiz_progression NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, name)
  );
  ```

  Presets are capped at **50 per account, 16 KB of settings each**. Like the
  shared settings, they are **outside the storage limit**. Each change bumps
  `users.presets_version` (see "Implementation status").

### Sync

- **New op `set_cascade_settings`** `{ cascade_id, settings: { name: value | null }, at }`:
  the (c, \*) scope, merged per setting. `set_cascade_options` loses its
  `settings` field and carries only the rules, under its existing
  latest-wins rule. The server's checks (`backend/src/cascade/settings.rs`:
  names, the answer settings' ranges, the bounds) carry over. A change to a
  cascade in the Trash or already purged is handled as `set_cascade_options`
  handles it today.
- **"All cascades on all devices"** is the existing shared-settings path
  (`device_settings` in the request, the merge in `share_device_settings`),
  renamed to `settings`.
- **Presets come with a sync response** when the device's
  `presets_version` is not the account's, so each device keeps them for
  applying offline and for the builder (see "Implementation status").
- **`server_time`** is added to each sync response (see "Clocks").

### Presets API

Online only, like saved searches and renaming a cascade:

- `PUT /api/presets/:id` `{ name, settings, clear_threshold, segment_size, progression }`:
  creates or replaces. Refused if the name is held by another preset (the
  device asks first), if it is "Defaults" (case-insensitive), or if it is
  past the caps.
- `PATCH /api/presets/:id` `{ name }`: renames.
- `DELETE /api/presets/:id`.

Each one bumps the account's `presets_version` and notifies the account's
devices on the change stream, as a cascade rename does.

### Creating and duplicating

- `POST /api/cascades` drops `answer_mode`. Instead it takes **`settings`**
  (name → value, from the chosen preset; absent for Defaults) alongside the
  rules it already takes. The server stores the values as (c, \*) entries at
  the creation `at`. The device sends the values rather than the preset's
  id, so a preset changed on another device at the same moment cannot race
  the creation.
- **Duplicate** takes the same `settings`: the original's resolved values
  on the duplicating device.

### On the device (`meta`)

- `cascade_device_settings` (by cascade id) and `device_settings` hold
  `{ value, at }` entries: the (c, d) and (\*, d) scopes.
- `shared_device` (pending and values) is unchanged apart from the rename.
- `last_preset_id`: the preset the builder starts at (null for Defaults).
- The pulled presets, in their own store, for applying offline and for the
  builder. Defaults is not stored; it is built from `DEFINITIONS` and
  `CASCADE_SETTING_DEFAULTS`.
- An IndexedDB version bump drops the old shapes. After the reset there is
  nothing worth keeping.

## Code

**`frontend/src/lib/settings/`**

- `layers.ts` keeps `DEFINITIONS`, `Settings` and `sameValue`. `PLACES`,
  `resolve` and `resolveAll` are rewritten to the recency rule; they take
  the cascade's creation time. `narrowerThan`, `sidesOf`, `placeAt`,
  `PLACE_NAMES` and `Sides` are removed.
- `places.ts` reads and writes the four scopes. The (c, \*) writes go
  through `set_cascade_settings`.
- `everywhere.ts` stays (renamed fields).
- `store.svelte.ts`: `change` writes (c, d). A new `widen(key, scope)`
  writes the same value with a fresh `at` to the wider scope. `moveTo`,
  `reset`, `targets`, `replaced`, `placeOf` and `sourceOf` are removed.
- `cascade.ts`: `copySources` and `copySettings` are replaced by
  `applyPreset` and `presetFrom` (a cascade on this device → a preset's
  values).
- New `presets.ts`: the local copy, the built-in Defaults, save, rename,
  delete, and `last_preset_id`.

**Components**

- `PlaceSwitches.svelte` is removed. `LayeredSetting.svelte` becomes a plain
  row with the offer under it.
- `ApplyWider.svelte` takes the three wider scopes, plus the rules' "all N
  cascades".
- The player's Settings dialog (`routes/cascades/[id]/+page.svelte`) gets
  the Presets controls. The top line saying where a change applies is
  reworded.
- The builder (`routes/cascades/new/+page.svelte`) gets the Settings select.

**Backend**

`cascade/settings.rs` (per-setting merge with `at`), `sync/ops.rs` (the new
op; `set_cascade_options` without settings), `sync/routes.rs` (renamed
field, `presets_version`, `presets`, `server_time`), `cascade/routes.rs`
(create and duplicate take `settings`), and a new presets routes module.
`.sqlx/` is regenerated.

**Docs**

- PLAN.md § Settings: "Where a setting applies" is rewritten to describe
  the model above, "A cascade's rules: one cascade, or all of them" loses
  Copy, and a new "Presets" section is added. § Schema and § Operations are
  updated for the new columns, table and op.
- JOURNEYS.md: C-8, C-11 and C-12 are rewritten (the offer, presets), C-1
  gains the builder's preset select (and its starting at the preset used
  last), and a new journey covers save, apply, replace, rename and delete of
  presets, applying one offline, and resetting a cascade with Defaults.

## Resetting

Changing `0001_initial.sql` changes its checksum, so every existing database
has to be reset:

- **Local:** `./scripts/dev.py --reset`. dev.py already detects the checksum
  change and says so. Clear the site's data in each browser profile, or let
  the IndexedDB version bump do it.
- **Production:** `scripts/deploy.sh --reset-database`. It asks for `reset`
  to be typed. It applies twice, so no old task migrates the emptied
  database. This deletes every account; then register again.

## Order of work

1. **Backend:** the schema, `set_cascade_settings` and the per-setting
   merge, the presets table and routes, their version in the sync, create and duplicate taking
   `settings`, and `server_time`. Then regenerate `.sqlx/`.
2. **The device's model:** `layers.ts` resolution, `places.ts`,
   `store.svelte.ts`, `presets.ts`, the meta shapes and the IndexedDB bump.
3. **UI:** rows without switches, the offer, the Presets controls, the
   builder select.
4. **Docs:** PLAN.md and JOURNEYS.md, then this file's status.
5. **Reset**, locally and then in production.

## Tests

- **The resolution as vectors:** the example table above, plus clock offset,
  an all-cascades change before or after a cascade's creation, `null` as
  the default, and an unreadable value skipped (as `valueIn` does today), in
  `layers.test.ts`. The server never resolves settings, so these tests run
  on the frontend only.
- **Backend:** `set_cascade_settings` merges per setting with the latest
  `at` winning and its bounds are enforced; the presets routes (caps, name
  taken, rename, delete, the list carried when the version differs); create and duplicate store
  `settings` at the creation `at`.
- **Frontend:** `store.test.ts` (change, then each widening; marking the
  narrower offers done), `everywhere.test.ts` (rename), and the
  presets-store tests: applying Defaults records `null` for every setting
  and the default rules; "Defaults" is refused as a name; the builder starts
  at `last_preset_id`, or at Defaults once that preset is deleted.
- **Locally, run only the files touched**, one at a time. The full suites
  and the browser tests run in CI.

## Decisions

All six were taken on 2026-11-17, each as recommended.

- **D1. The name: Presets.** It is short and familiar from other apps. The
  alternatives were "Setting profiles", "Templates" and "Saved settings".
- **D2. Rules stay per cascade, the same on every device.** The threshold
  and quiz options decide how a pass is judged and how levels are made,
  which the server checks and every device has to agree on. Presets store
  them and applying a preset sets them, but they are never per device.
- **D3. Applying a preset** sends the settings to this cascade on this
  device, followed by the usual "Also apply to" offer, and sends the rules
  to this cascade, followed by the rules' "all N cascades" offer. The
  rejected alternative was to ask for the scope first. That would cost a
  step every time, where the offer costs one tap only when it is wanted.
- **D4. Presets are not saved offline**, as with saved searches. Saving,
  renaming and deleting need a connection; applying works offline.
  Making presets sync ops would allow offline saves, but then the server
  would have to settle two devices that both saved the same name offline.
- **D5. "All cascades" does not cover future cascades.** Goal 5 says a new
  cascade starts from its preset or from the defaults, and presets are how
  a value carries forward. The other reading would make the (\*, \*) scope
  a hidden default for new cascades, the kind of hidden layer this redesign
  removes.
- **D6. A built-in Defaults preset**, which cannot be renamed, replaced or
  deleted, is how a cascade is reset. It replaces the per-row Reset that
  goes away with the switches. The builder's select also starts at the
  preset this device used last (`last_preset_id`), or at Defaults.
