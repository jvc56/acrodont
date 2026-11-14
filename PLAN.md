# Acrodont — Project Plan

## Overview

Acrodont is a word study website for crossword game players. A logged-in user
describes the words they want with filters, and Acrodont turns the matches into
a **cascade** of flashcard quizzes. Getting a quiz at least X% right **clears**
it and removes it from the cascade. Missing too many sends the missed questions
one **level** down. The **Source quiz** at Level 1 is the exception: it is never
cleared and stays until the user trashes the cascade. The user works down the
cascade and back up until the Source quiz is finished with no misses, which
makes the cascade **complete**.

There are three quiz types:

| Quiz type | Question | Answer |
|---|---|---|
| **Anagram** | An alphagram (the tiles of a word in alphabetical order), e.g. `AEINRST` | Every valid word in the lexicon made from exactly those tiles, e.g. `ANESTRI, ANTSIER, NASTIER, RATINES, RETAINS, RETINAS, RETSINA, STAINER, STEARIN` |
| **Definition** | A word, e.g. `QAT` | That word's definition, e.g. `an evergreen shrub [n -S]` |
| **Leave Value** | An alphabetized set of 1–6 tiles, e.g. `?EIRS` | The leave's value, e.g. `34.1` |

Twenty of the filters match search conditions in Zyzzyva
(<https://github.com/scrabblewords/collins-zyzzyva>), so experienced players can
describe a word list the way they already know how. Three are Acrodont-only:
**Front Inner Hook** and **Back Inner Hook**, which Zyzzyva shows in its word
display but has no search condition for, and **Leave Value**, for Leave Value
quizzes. Filters combine with AND and OR in nested groups whose precedence the
user chooses. [Filters](#filters) below explains what each filter means and how
Zyzzyva implements it.

Word study data comes in three kinds, all uploaded by admins:

- **Letter distributions** (English, Catalan, Polish, …) define the tiles: how
  each is written, how many of each are in the bag, their point values, and which
  are vowels. They use MAGPIE's letter distribution format.
- **Lexicons** (CSW24, NWL23, …) are word lists. Every word has a definition and
  a playability value. Each lexicon refers to one letter distribution.
- **Leave values** are sets of leave → value pairs. Each set belongs to one
  lexicon and uses that lexicon's letter distribution. A lexicon has at most one
  set of leave values, and may have none. The set's values can be replaced
  later, as a lexicon's definitions can; its leaves cannot.

Each cascade also carries a few **quiz options**: how long a study run is
(**segment size**), what happens to a quiz that isn't cleared (**progression**),
and whether typed answers have to be given in alphabetical order. Every quiz the
cascade creates starts with a copy of them. See [Quiz options](#quiz-options).

Any cascade or quiz can be downloaded as a word list of everything in it, or of
just what was answered correctly or missed. See
[Exporting words](#exporting-words).

A cascade's Source quiz can hold up to **300,000 questions**: any word search
over a whole lexicon fits.

**Scale assumptions (2026-11).** Acrodont is sized for its owner alone at
first, perhaps ten more people within months, and **at most 750
accounts** (`MAX_ACCOUNTS`, after which registration closes), each holding at
most **10 MB** of cascades and saved searches on the server (the [storage
limit](#storage-limit)), in cascades of at most **300,000 questions**. There is
no limit on how many cascades an account has. The production stack is sized
and costed for that (see [Deployment and Operations](#deployment-and-operations)).
Many passages below work through a 300,000-question cascade, which is the
ceiling again, or a hundred cascades. The budgets in [Scale tests](#scale-tests)
run at 300,000 questions. The In Word List filter's 300,000-entry allowance
limits a search's input, not a quiz.

Once a cascade has been downloaded, studying works **offline**: a user can log
in and start a cascade, board a plane, keep studying, and have everything sync
when they land. See [Offline and Sync](#offline-and-sync).

---

## Glossary

| Term | Meaning |
|---|---|
| **Cascade** | Everything built from one set of filters: the Source quiz and every level quiz that comes from it. |
| **Source quiz** | The quiz created from the filter search. It is always the active quiz at Level 1. A finish never clears, replaces or removes it; only trashing the cascade does. |
| **Level** | A position in the cascade, numbered from 1. Each level has at most one active quiz. The **deepest level** is the only one that can be played. |
| **Attempt** | One pass through a quiz's questions, identified by its number and the shuffle seed that produced its order. A quiz that is reset or restored starts a new attempt with a new shuffle. |
| **Segment** (or **run**) | A fixed-size run of questions inside an attempt, the length of one sitting. Finishing a run drills its misses before the attempt goes on. Off by default. |
| **Finish** | Move on from the last question of an attempt. Finishing always either sends the quiz to the Trash, sends the user down a level, or resets the quiz in place. |
| **Clear threshold** | The score (X%) needed to clear a quiz. It is a setting of each cascade, 90% when the cascade is created, and can be changed in the cascade's Settings in the player, under Cascade Settings; a change applies to every level, the pass in progress included. |
| **Quiz options** | Segment size, progression and alphabetical order. They are held by the cascade, copied to each new quiz, and editable on either. |
| **Progression** | What finishing a quiz below the clear threshold does: **Ladder** (keep the quiz and go down a level) or **Drill** (replace the quiz with its misses). |
| **Clear** | Finish an attempt with a score of at least the clear threshold. The quiz goes to the Trash. The Source quiz is never cleared; see **Complete**. |
| **Complete** | A cascade whose Source quiz has been finished with no misses. It is a milestone, not an end state: the Source quiz resets like any other finish, nothing is created because nothing was missed, and the cascade stays active and playable until the user trashes it. |
| **Trash** | Cleared quizzes and trashed cascades. They can be restored until they are **purged** (deleted permanently) after the trash retention period (Y days, a server setting that defaults to 30). |

---

## Cascade Rules

A cascade is a **stack of levels**, and the user always plays the **deepest
level**. Level 1 is always the **Source quiz**, which has its own rules (see
[The Source quiz](#the-source-quiz)); the table below is for quizzes at Level 2
and deeper. The rules in this first table are the defaults: **Ladder**
progression and no segments. [Progression](#progression-ladder-or-drill) and
[Segments](#segments) below give the two ways the cascade's
[quiz options](#quiz-options) change them.

When the user finishes an attempt at the deepest level N ≥ 2, with score
= correct ÷ questions:

| Result | What happens | Where the user goes next |
|---|---|---|
| **Score ≥ threshold, some misses** | Level N's quiz is **cleared** (to the Trash). A new quiz of the missed questions takes its place at Level N. | The new Level N quiz |
| **Score ≥ threshold, no misses** | Level N's quiz is **cleared** (to the Trash). Level N is removed. | Back up to Level N − 1's quiz. |
| **Score < threshold, some correct** | Level N's quiz stays, **reset** to a new attempt with a new shuffle. A new quiz of the missed questions is created at **Level N + 1**. | Down to Level N + 1 |
| **Score < threshold, nothing correct** | Level N's quiz is **reset** to a new attempt with a new shuffle. No new level is created, because it would be an identical copy of Level N. | The reset Level N quiz |

Why these rules hold together:

- **The quiz being played is always the deepest level.** Clearing a quiz with
  misses keeps the same depth, clearing one with no misses pops a level, and
  failing pushes a level. So when the user finishes the quiz at Level N, no
  Level N + 1 exists yet. Missed questions never have to be merged into an
  existing quiz.
- **Upper levels wait.** A quiz above the deepest level keeps whatever state it
  had when the level below it appeared, and nothing touches it until the user
  climbs back to it. That is a rule of play, not of sync: the server accepts a
  `grade` or `move_cursor` on any active quiz, deepest or not, so a device that
  finished a level before learning that another device had restored a quiz on
  top of it keeps every grade it made and loses only its `finish` (see
  [Conflicts](#conflicts)). A quiz that a finish pushed down from is in its reset,
  reshuffled state and starts from its first question. A quiz that is waiting
  because a [segment](#segments) went down, or because a quiz was
  [restored](#trash-restore-and-purge) on top of it, keeps its attempt, its
  grades and its cursor, and resumes at the card it was on.
- **The same question can be on several levels.** A question missed at Level 2
  is still in Level 2's reset quiz and also in the new Level 3 quiz. That is
  intended: the user has to get it right in both places.
- **Score is compared exactly**, as `correct × 100 ≥ threshold × question_count`
  in integer arithmetic, so there is no rounding at the boundary.
- **A threshold of 100** means only a perfect attempt clears. The threshold is
  **1–100**; 0 is not allowed, because every attempt would clear. With a
  threshold of at least 1 an attempt with nothing correct is always below it,
  so the rows above never overlap.

The "nothing correct" rule is the one departure from a literal reading of "go
down with the misses". Without it, a Level N quiz where every question was missed
would be followed by an identical Level N + 1 quiz, doubling the work for no
benefit. It can be removed without changing anything else.

### The Source quiz

The Source quiz is permanent. It is always the active quiz at Level 1, a finish
never clears, replaces or removes it, and it leaves the cascade only when the
user moves the cascade to the Trash. Every other quiz is at Level 2 or deeper.
When the user finishes an attempt of the Source quiz:

| Result | What happens | Where the user goes next |
|---|---|---|
| **Some correct, some missed** (any score) | The Source quiz is **reset** to a new attempt with a new shuffle. A new quiz of the missed questions is created at **Level 2**. | Down to Level 2 |
| **No misses** | The Source quiz is **reset**, exactly as in the other rows; nothing is created because nothing was missed. The cascade is **complete**: its `completed_at` is recorded and the completion screen shows how many levels and attempts it took since the previous completion (or since creation). | The completion screen, then the reset Source quiz if the user keeps studying |
| **Nothing correct** | The Source quiz is **reset**. Nothing is created. | The reset Source quiz |

- The threshold still decides whether the attempt was a pass, and that is
  derivable from the attempt's counts and the cascade's threshold, so no
  column records it (the threshold [can be changed](#quiz-options), and an
  earlier attempt's pass is then read against the new one); it does not decide where the user goes:
  the Source quiz's misses always go down, because there is nothing for them
  to replace.
- Progression does not apply to the Source quiz, for the same reason. The
  Level 2 quiz it creates takes the cascade's progression like any other quiz,
  so a Drill cascade is the Source quiz plus a drill chain at Level 2.
- A cascade can be completed more than once; each finish with no misses
  records a new `completed_at`. The Cascades page marks complete cascades, and
  the completion screen offers **Start over** and **Move to Trash**. While it
  is in front, the reset Source quiz under it takes no action: a key bound to
  Show / Next neither shows nor grades its cards, and Space or Enter presses
  the screen's focused button.
- **What the completion screen counts.** *Levels* is the deepest level the
  cascade reached since the previous completion (`cascades.peak_depth`, reset
  to 1 at each completion), and *attempts* is the number of attempts finished
  since then, on any level, including the attempt that completed it
  (`cascades.attempts_since_completion`; the screen takes both numbers, then
  both reset). Both are stored on the cascade and both sides maintain them with
  the same rule, so a device that has pulled everything shows the figures the
  server records. A device holding finishes another device made and it has not
  pulled shows its **own**, lower count: the `finish` result carries neither
  number, since the server's `Completed` has already reset them, so nothing
  corrects the screen afterwards. The screen is a milestone, not an audited
  total, and that is the reason it is drawn only from a completion this device
  computed (see [Conflicts](#conflicts)).
- **Segments do not make completion easier.** A question missed in a run and
  drilled one level down is still missed in the Source quiz's attempt (see
  [Segments](#segments)), so a completion needs an attempt in which no run
  descended.
- Segments work on the Source quiz exactly as on any other quiz: a run's
  misses go to Level 2 as a drill quiz.
- Restoring a quiz from the Trash always pushes it to Level 2 or deeper, since
  Level 1 is taken.

### Quiz options

Three options change how a quiz is studied:

| Option | Default | Effect |
|---|---|---|
| **Segment size** | `0` (off) | Study the quiz in runs of this many questions, drilling each run's misses before going on. See [Segments](#segments). |
| **Progression** | **Ladder** | What finishing a quiz below the clear threshold does. See [Progression](#progression-ladder-or-drill). |
| **Answers in alphabetical order** | off | In typed anagram mode, answers have to be entered in tile order. See [Typed mode](#typed-mode-anagram-quizzes-only). |

The options belong to the **cascade** and to each **quiz**:

- **The cascade holds the options a new quiz starts with.** Every new cascade
  starts with the defaults above, and they can be changed at any time
  afterwards in the cascade's [Settings](#settings) (Cascade Settings → levels made
  from now on). Changing them affects quizzes created from then on, never
  quizzes that already exist.
- **Every quiz is created with a copy of its cascade's options**, and that copy
  can be changed at any time after the quiz exists, in the cascade's Settings
  (Cascade Settings → the level you are studying), for the level being studied. A
  change takes effect on the current card.
- **A quiz created from another quiz's misses** — a replacement, a descent or a
  segment — copies the **cascade's** options, not the finishing quiz's, so a
  change made to one quiz never propagates down the cascade. The one exception is
  a quiz in a **segment chain** (see [Segments](#segments)): a run's drill quiz
  and every replacement of it carry `segment_chain`, their progression is
  **Drill for their whole life**, they are never segmented themselves, a
  `set_quiz_options` that names `progression` or `segment_size` for one is
  rejected, and a [restore](#trash-restore-and-purge) copies only alphabetical
  order onto it.
- The **clear threshold** is not one of these options: it stays a single
  cascade-wide setting, because a cascade whose levels cleared at different
  scores would be hard to reason about. It can still be **changed**: a
  `set_cascade_options` may carry `clear_threshold` (a whole number from 1 to
  100, otherwise `invalid`), under the same latest-wins rule as the options.
  Nothing copies it into a quiz — every finish reads the cascade's — so the new
  value judges the pass in progress as well as later ones, at every level.
  Quizzes already cleared stay cleared. `set_quiz_options` never carries it.

Every option is validated on both sides: segment size is 0, meaning off, or an
integer from **5** to
`MAX_QUIZ_QUESTIONS` (the device uses the value `/api/auth/me` reported into
its `meta` store, and 300,000 before its first login), progression is Ladder
or Drill, and alphabetical order is a flag. The cap bounds **new** values only:
it can be lowered on the server, and a cascade or quiz that already
holds a larger segment size keeps it and keeps working, since nothing
re-validates options after they are stored. So the player's Settings
**clamp what they prefill** to the cap in `meta`,
rather than sending a value the server would refuse as a field the user never
typed. The minimum of 5 rules out an
attempt made of one-question runs. It does not rule out a single short run after
a [mid-attempt size change](#segments), since boundaries follow the current size
while `run_start` keeps the one an earlier size set: a quiz at `run_start` 119,
reached with S = 7, whose size becomes 120 has a run of one question, which costs
one card and one Trash entry and breaks nothing. Nor does the minimum bound the
work on its own. **An
attempt creates at most `ceil(question_count / S)` chain quizzes**, one per run
that missed something, each of which becomes a Trash entry, so the segment size
is the user's choice of how much that will be: 5 on a 300,000-question quiz can
leave 60,000 of them. The player's Settings therefore warn
when `question_count / segment_size` is above 2,000, saying how many levels the
attempt could create, for the size typed in the field before it is saved; the
count is the quiz's own for the level being studied, and the cascade's for
levels made from now on. A segment size at or above a quiz's question count means the same as 0 for
that quiz.

### Progression: Ladder or Drill

Progression decides what a finish below the clear threshold does, for quizzes
at Level 2 and deeper (the [Source quiz](#the-source-quiz) is exempt). A finish
reads the finishing **quiz's** progression, which starts as a copy of the
cascade's and can be changed on the quiz alone; the cascade's setting only
decides what new quizzes start with:

| Progression | Finishing below the clear threshold |
|---|---|
| **Ladder** (default) | The table above: Level N's quiz stays, reset and reshuffled, and its misses become a new quiz at Level N + 1. The user has to come back and clear Level N before the cascade is done. |
| **Drill** | Level N's quiz is finished and goes to the Trash whatever the score, and a new quiz of its missed questions takes its place at Level N. The cascade never grows a level from a finish. |

So with Drill, the score decides nothing about where the user goes; only the
misses do:

| Result | What happens | Where the user goes next |
|---|---|---|
| **Some correct, some missed** (any score) | Level N's quiz is finished (to the Trash). A new quiz of the missed questions takes its place at Level N. | The new Level N quiz |
| **No misses** | Level N's quiz is finished (to the Trash). Level N is removed. | Back up to Level N − 1's quiz. |
| **Nothing correct** | Level N's quiz is **reset** to a new attempt with a new shuffle. Nothing is created, because the replacement would be an identical copy. | The reset Level N quiz |

- The attempt's outcome still records whether the score met the clear
  threshold, `cleared` when it did and `replaced` when it did not, so
  the Trash and the cascade's history still show which attempts were passes.
- The "nothing correct" rule is kept for the same reason as in Ladder: replacing
  a quiz with a copy of itself is work for no benefit.
- A Drill cascade that has never had a segment descent or a restore is at most
  two levels deep for its whole life: the Source quiz, and the drill chain its
  misses feed at Level 2. That is what makes it a straight drill: keep going
  until nothing is missed.

**Naming.** *Progression: Ladder / Drill* is the name used throughout this plan
for the option described as "go back up the ladder". Other candidates, if a
better one is wanted later: **Repeat style** (*Climb back* / *Straight through*),
**Keep failed quizzes** (a plain boolean), **Second chances**, **Review mode**
(*Ladder* / *Chain*), or **On a fail** (*Go down a level* / *Retry the misses*).
Renaming it touches the enum `quiz_progression`, two columns, the two option
fields on the wire and the UI strings, and nothing else.

### Segments

A **segment size** of 0 means no segments: an attempt is one run from the first
question to the last. A segment size S greater than 0 splits the attempt into
runs of S questions in the attempt's shuffled order — positions 0…S−1, S…2S−1,
and so on — so the user studies a sitting's worth at a time and drills what they
missed in it before going on.

Run boundaries are the positions S, 2S, … that fall **strictly inside** the
quiz. The last run always ends at the last question, where finishing the attempt
applies the rules above. So a quiz of 250 questions with S = 100 has runs of 100,
100 and 50, and a quiz of 80 questions with S = 100 behaves exactly as if
segments were off.

Moving on from the last question of a run that is not the last run:

| Result | What happens | Where the user goes next |
|---|---|---|
| **Some of the run missed** | A new quiz of that run's missed questions is created at **Level N + 1**, marked `segment_chain`, with Drill progression and no segments. Level N's quiz keeps its attempt, its grades and its counters, with its cursor at the start of the next run. | Down to the new Level N + 1 |
| **None of the run missed** | Nothing is created, and nothing is finished. | The first question of the next run |

- **A segment chain always drills and is never segmented.** However the
  cascade's options are set, the quiz made from a run's misses is marked
  `segment_chain`, and so is every quiz that replaces it: each has Drill
  progression and a segment size of 0, so finishing one always replaces it with
  its own misses, in a single run, until an attempt has no misses at all. Then
  its level is removed and the user comes back up to the parent quiz's next run.
  A run is a sitting to be finished, not a level to come back to, and a chain
  sits one level below the run it serves until it is cleared, however many
  misses the run had. A chain quiz restored from the Trash simply returns to
  whatever level is above it when it clears.
- **Coming back up** puts the user on the parent quiz's cursor, which is the
  first question of the next run, in the same attempt and the same shuffled
  order.
- **A run starts where the last one ended.** Each quiz records `run_start`, the
  position of the last boundary it passed in the current attempt, whether or not
  that run descended. The current run is the positions from `run_start` up to,
  but not including, the next boundary, and passing a boundary sets both
  `run_start` and the cursor to it. `run_start` is 0 in a new attempt.
- **Previous never crosses a run boundary.** Going back stops at `run_start`,
  so on the device a run that has been passed is never re-entered, regraded or
  descended again in the same attempt. Like **Upper levels wait** above, that
  is a rule of play and not of sync: the server accepts a `grade` on any
  question of an active quiz whatever that quiz's `run_start`, so a device that
  had not yet learned of a boundary another device passed keeps every grade it
  made (see [Conflicts](#conflicts)). What no device can do is descend a run
  twice, because `origin_segment_end` is unique per parent attempt, so **a run
  descends at most once per attempt** whatever arrives afterwards.
- **The finish still sees every miss.** A question missed in run 1 and then
  drilled at Level N + 1 is still missed in Level N's attempt: it counts against
  the attempt's score, and it is in the quiz that the finish creates, whether
  that is a descent (Ladder) or a replacement (Drill). Segments change **when**
  misses are drilled, not what the attempt was.
- **Resetting** a quiz starts its runs again from position 0 in the new attempt.
- **Changing the segment size mid-attempt** is allowed. Boundaries are always
  computed from the current size, so the next boundary is the smallest multiple
  of the current S that is greater than the cursor and less than the question
  count, and the run that ends there still begins at `run_start`. So a quiz of
  250 with S = 100 whose first run descended at 100, then switched to S = 30,
  has its next run at positions 100–119, not 90–119. Runs that have already
  been passed stay passed, because `run_start` and a descent's
  `origin_segment_end` are **positions**, not run numbers. **`run_start`
  survives every size change**, a change to 0 and one to a value at or above the
  question count included, which mean the same thing: a passed run stays passed
  whether or not the quiz is segmented any more, so `set_quiz_options` never
  rewrites attempt state and the two rule modules never disagree about where
  Previous stops. Because no run indicator is shown for an unsegmented quiz, the
  player says "you have already finished this part of the attempt" when Previous
  stops at `run_start`, so a blocked Previous always has a visible cause.
- **How a run is numbered.** Everything the rail, the top bar and the banners
  show is computed from the **current** segment size: the run number is the
  count of boundaries at or below `run_start` plus one, the total is the count
  of boundaries strictly inside the quiz plus one, and the position within the
  run is `cursor − run_start + 1` of `next_boundary − run_start`, or of
  `question_count − run_start` on the last run, where `next_boundary` is None.
  A size change
  mid-attempt therefore renumbers them, which is expected: the 250-question
  quiz above, at `run_start` 100 after switching to S = 30, reads
  `run 4 of 9 · 1 of 20` (the run indicator the two rule modules agree on;
  the status bar shows it as its
  [Segment row](#desktop-layout), `Segment 4 of 9` and `1 / 20`).
- **Segments never clear a quiz**, never change its attempt number and never
  touch the clear threshold. Only a finish does those.

### Trash, restore and purge

- **Finished quizzes** at Level 2 and deeper go to the Trash automatically,
  labelled with their cascade, level and final score, and with whether the
  score cleared the quiz or it was replaced under
  [Drill progression](#progression-ladder-or-drill). The Source quiz never
  does.
  On the server a quiz in the Trash keeps each question's grade, which an
  [export](#exporting-words) of it reads, and drops the grades' times,
  sequences and devices: nothing pulls a cleared quiz's questions, and a
  restore starts a new attempt. Its grades, when a device asks for them, are
  each dated the finish that cleared it.
- **A complete cascade** (Source quiz finished with no misses) stays active.
  The user sees a completion screen showing how many levels and attempts it
  took, with **Start over** and **Move to Trash**. **Start over** closes the
  screen and the user studies the same cascade again from Level 1, whose
  Source quiz the finish has already reset and reshuffled: nothing is created
  and no storage is used. A cascade reaches the Trash only when the user
  moves it there.
- **Trashing a cascade manually** (e.g. "I'm done with this word list") moves the
  whole cascade to the Trash with its levels as they are.
- **Restoring a finished quiz** pushes it back onto its cascade as the **new
  deepest level**, so it is the next thing the user studies. Its attempt number
  goes up by one, its cursor, counters and `run_start` return to 0, its
  questions are reshuffled with the operation's seed, and it gets a fresh copy
  of the cascade's current [quiz options](#quiz-options) (a segment-chain quiz
  takes only alphabetical order and stays Drill with no segments). The quiz that
  was the deepest level is not
  touched: if that quiz was mid-attempt, it keeps its attempt, grades and cursor
  and resumes there when the user climbs back. If the cascade had been trashed,
  it comes back too. Level 1 is always the Source quiz, so a restored quiz is at
  Level 2 or deeper. Restoring never merges quizzes and never leaves a gap in the
  levels.
- **Restoring a manually trashed cascade** brings it back exactly as it was,
  except that the retention clocks of its cleared quizzes restart (see
  **Purging** below).
- **Purging** happens after the trash retention period: a cleared quiz is purged
  that long after it was cleared, and a trashed cascade that long after it was
  trashed. Trashing a cascade freezes the clocks of the cleared quizzes under
  it: they are purged with the cascade, never before it, so a trashed cascade is
  one unit in the Trash until it is gone. Restoring the cascade, by **Restore**
  or by restoring one of its quizzes, sets `cleared_at` to now on the cleared
  quizzes still under it, so each gets a full retention period again instead of
  being purged at once for time that passed while the cascade was trashed.
  Purging a cascade purges every quiz in it. Users can also purge from the
  Trash immediately with **Delete forever**.
- **Duplicate cascade**, in any cascade's **Settings**, creates a new cascade
  from the same filters: a private copy of them, the same threshold and
  [quiz options](#quiz-options) and every other setting, starting at Level 1
  with nothing graded. The search is run again, so the new cascade holds what
  matches now. It is how a ladder is abandoned for a clean start without
  losing it, and how a cascade's questions are chosen again after the
  catalog's definitions or leave values were replaced. It is not on the
  completion screen, where **Start over** means another pass of the same
  cascade. An account's cascades each have their own name (see
  [Creating a cascade](#creating-a-cascade)), so the new one takes the
  original's name with the next free number after it: "Sevens" gives
  "Sevens (2)", then "Sevens (3)"; duplicating "Sevens (2)" replaces its
  number rather than adding one, and a name at the 200-character limit is cut
  to make room. It asks first, saying: "This makes a new cascade from the same
  filters, with the same threshold and options, starting at Level 1. It takes
  this cascade's name with the next free number after it. This cascade isn't
  changed. You'll have both, and each counts toward your storage until it is
  deleted from the Trash." (see [Storage limit](#storage-limit)).
- **Exporting** works on anything in the Trash that has not been purged, so a
  cleared quiz can still be downloaded as a word list (see
  [Exporting words](#exporting-words)).

### Storage limit

An account may hold at most **10 MB** on the server
(`MAX_STORAGE_BYTES_PER_USER`, default 10,000,000 bytes). That is the one
limit on what an account owns: there is no limit on how many cascades or saved
searches it has, only on how much they hold. Storage figures are in decimal
units wherever they are shown, on the Cascades page and in the builder alike: 1 MB is 1,000,000 bytes. The default was sized from four CSW24 cascades the
owner named, which one account should be able to hold all at once, by the
formula below:

| Cascade | Questions | As created | Studied hard |
|---|---|---|---|
| Anagrams of 2 to 8 letters | 94,684 | 1.58 MB | 2.52 MB |
| Definitions of 2 to 8 letters | 120,145 | 1.99 MB | 3.17 MB |
| 10,000 leave values | 10,000 | 0.16 MB | 0.27 MB |
| Anagrams of 2 to 15 letters with four or more anagrams | 1,952 | 0.03 MB | 0.06 MB |
| **All four** | | **3.76 MB** | **6.02 MB** |

Studied hard is levels made from misses adding up to a second Source quiz
each (half missed on every pass), with their quiz and attempt rows. 10 MB is
1.66 times that, leaving room for a Duplicate of both large cascades at
once. (The first sizing, PQ-023, was 100 MB for three cascades that came to
72.20 MB studied hard when every question of every level was a row of its
own; packed, those three are 4.09 MB.) An
account's own limit can replace the default: `users.storage_limit_bytes`, NULL
unless set, is set only through SQL.

**What counts.** A cascade's storage is what the account holds on the server
because of it: its `cascades` row with its question keys (one line each in
`question_keys`), one `quizzes` row per level (active or in the Trash), each
level's questions and grades packed in `quiz_cards` chunks of up to 256
questions, one `quiz_attempts` row per finished pass, and its private filter
spec with any In Word List entries. A
saved search's is its spec. Answers, definitions and hooks are catalog data,
shared by every account, and count for no one.

**How it is counted.** From counts with fixed sizes, never by asking
Postgres, which would mean reading every chunk or table sizes that cannot be
split by cascade. The sizes are
`contract-fixtures/storage.json`, which `backend/src/storage.rs` and the
device's `lib/cascades/storage.ts` each carry as constants, a test on each side
keeping them equal to the fixture:

| Size | Bytes |
|---|---|
| `cascade_row` | 380 |
| `question` | 1 (its line break), plus the question key's bytes |
| `quiz_row` | 430 |
| `chunk_row` | 200 (a `quiz_cards` row, up to 256 questions) |
| `card` | 8 (a question's grade, and its record: device, sequence and time) |
| `card_idx` | 1 (a question's index as its difference from the one before, in every level but the Source quiz) |
| `attempt_row` | 210 |
| `spec_row` | 380 (the spec with its groups and conditions) |
| `spec_word` | 1 (its line break), plus the entry's bytes |

```
cascade = cascade_row
        + Σ questions (question + octet_length(question_key))
        + Σ levels (quiz_row + ⌈question_count / 256⌉ × chunk_row
                    + question_count × (card + card_idx unless the Source quiz))
        + attempts × attempt_row
        + spec
spec    = spec_row + Σ In Word List entries (spec_word + octet_length(entry))
```

The sizes include index and tuple overhead, and `card` is the graded size, so
a level's figure does not grow as it is studied, nor shrink when the level is
cleared and its chunks drop all but the grades. What Postgres stores varies
with the grades: an unstudied chunk is its row alone (under half a byte a
question for the Source quiz), and a chunk graded the usual way, a sync after
each grade a few seconds apart, measures about 8 bytes a question with its
indexes and its row. The sizes are set a little above that (about 9 and 10
bytes a question for the Source quiz and for any other level), so the count
never falls short of the disk used. The
count is of live rows: the dead row versions grading leaves are vacuum's to
reclaim, not the account's to pay for. An integration test calibrates the sizes
against `pg_total_relation_size`: the whole cascade within ±20% of what Postgres
measures with every level graded, and its levels counted at no less than they
take and no more than twice, so a schema change that makes rows bigger fails
the build instead of quietly under-counting. A 300,000-question cascade is about 5 MB as created; an
In Word List entry costs its bytes plus one, so a 300,000-entry list of 8-letter words is about 2.7 MB.

**Where it is kept.** `cascades.storage_bytes`, `saved_searches.storage_bytes`
and the account's total, `users.storage_bytes`, each changed in the
transaction that changes the rows:

- creation and Duplicate set a cascade's figure and add it to the total
- `finish` adds its attempt row and any new level; `finish_segment` adds any
  new level
- `purge_quiz` subtracts the quiz's level and its attempt rows, and bumps the
  cascade's `updated_seq` so the new figure reaches every device's pull
- `purge_cascade` (Delete forever, or the [purge task](#purge-task)) takes the
  cascade's figure off the total
- saving a search adds its spec's figure, an overwrite only the difference, and
  deleting it, which locks the user's row first as a save does, takes it off
- trashing and restoring change nothing, for a cascade or a quiz: every row
  stays until it is purged

The purge task recounts every user's total from their cascades and saved
searches on each run, and logs and corrects any drift. The device never counts
a cascade itself: it shows the server's figures, which the pull carries on
each cascade row and every sync response carries for the account (see
[On the device](#on-the-device)).

**Where it is checked.** Only where something new is made, inside the
transaction that locks the user's row, so two requests cannot both take the
last space:

| Action | Needs | Refusal |
|---|---|---|
| Create a cascade | The formula with one level of the search's questions, their keys' real bytes and the spec | `409 { error: "storage_limit", used, limit, needed }` |
| Duplicate | The same, for the original's questions and a copy of its spec | Same |
| Save a search | Its spec; an overwrite needs only the difference | Same |

A change that adds nothing is never refused. **The search runs before the
transaction opens**, so the row lock never covers CPU-bound work or a wait for
a [`SEARCH_CONCURRENCY`](#search-engine) permit. A cheap pre-check refuses an
account already at or over its limit before searching at all, with `needed`
0, and a creation that loses the race after its search is refused with the
same `409`. The builder's preview reports exactly what creation will then
store (`storage_bytes`).

**Studying never fails for storage.** Under Ladder every finish with a miss
makes a new level, and its rows are added even when they take the account over
its limit. Refusing a finish would be the one place studying fails for a reason
the user cannot act on, and offline the finish has already been played. Past
the limit the account keeps studying, syncing, restoring and exporting; only
creating a cascade, Duplicate and saving a search are refused.

- **Restores.** Restoring a quiz or a cascade adds no rows, so it is always
  allowed.
- **The Trash counts**, because its rows are still stored and can be restored.
  Only purging frees storage, either automatically after the retention period
  or with **Delete forever**, whose buttons and confirmation say how much.
- **Visibility.** The [Cascades page](#cascades-page) shows `4.3 MB of 10 MB
  used` with a meter, each cascade's size, and the Trash's; the
  [builder](#creating-a-cascade) shows what a new cascade will use against what
  is free.
- **Almost full and over.** From 90% the Cascades page says "Almost full:
  empty the Trash or delete cascades to make room". Over the limit it says
  "Over your storage by 12 MB: you can keep studying, but can't create cascades
  until you make room", New cascade is disabled, and Duplicate is disabled
  once storage is full.

---

## User Experience

### Accounts

Every page except the login, registration, email confirmation and password
reset pages requires a logged-in user (`/` is the [Cascades page](#cascades-page); signed out, it goes to the log-in page). An account is a username, an
email address and a password. Some accounts are **admins**, who can also upload
and delete catalog data (see [Admin](#admin)). See
[Authentication](#authentication).

### Settings

There are two kinds of settings, and they do not overlap:

- **A cascade's settings**: everything about how one cascade is studied. They
  are stored on the `cascades` row, sync like everything else (see
  [Offline and Sync](#offline-and-sync)) and apply to that cascade alone. Each
  cascade has its own; there are no account-wide settings and no defaults for
  new cascades.
- **This device's settings**: the [display settings](#desktop-layout) and the
  [controls](#controls), kept in the `meta` store, since what suits a laptop
  is wrong on a phone. They apply to every cascade studied on that device, and
  reach other devices only when the user asks (see
  [This device, or all of them](#this-device-or-all-of-them)).

Both are edited in one place only: a cascade's **Settings** dialog in the
player (the menu's **Settings**, on the desktop and on a phone alike; see
[Desktop layout](#desktop-layout)), where a change takes effect on the current
card straight away. There is no settings page and nothing in the site header
or on the Account page. The dialog has two sections, each with a
heading and an ⓘ saying what it reaches and whether it syncs: **Cascade
Settings** and **Device Settings**. Neither heading carries a badge.

**Every setting is saved as soon as it is changed**: a choice or a checkbox
when it changes, a number when its field is left or Enter is pressed. There is
no Save button.

Every new cascade starts with the same settings, the defaults below
(`CASCADE_SETTING_DEFAULTS` in `lib/local/rows.ts`, matching the column
defaults in the [schema](#schema)). They are changed afterwards in the
cascade's Settings.

| Setting of a cascade | Applies to | Default | Options |
|---|---|---|---|
| **Clear threshold** (`clear_threshold`) | Every level of the cascade, the pass in progress included | `90`% | 1–100 |
| **Answer mode** (`answer_mode`) | Anagram cascades (see [Typed mode](#typed-mode-anagram-quizzes-only)) | **Flashcard** | Flashcard / Typed |
| **When an answer is revealed, mark it** (`reveal_correct`) | Flashcard cards (a typed card is graded by what was typed) | **Correct** | Correct / Missed: the grade a card starts with when its answer is shown, before any toggle |
| **Show definitions** (`show_definitions`) | Anagram answers | **on** | on / off |
| **Show hooks** (`show_hooks`) | Anagram answers (with inner hooks) | **on** | on / off |
| **Show each word's probability order** (`show_probability`) | Anagram answers and a Definition card's word | off | on / off |
| **Definitions in their own column** (`definition_column`) | Anagram answers and a Definition card's definition | **on** | on / off: beside the word, or centred beneath it |
| **Round leave values to (decimal places)** (`leave_value_decimals`) | Leave Value answers, rounded half away from zero | `0` | `0`, `1`, `2`, `3` |
| **Segment size** (`segment_size`) | Levels made from now on (see [Quiz options](#quiz-options)) | `0` (off) | 0 (off), or 5 – `MAX_QUIZ_QUESTIONS` |
| **Progression** (`progression`) | Levels made from now on | **Ladder** | Ladder / Drill |
| **Answers in alphabetical order** (`require_alphabetical`) | Levels made from now on, Anagram cascades | off | on / off |

Each is changed with `set_cascade_options`, under the cascade options'
latest-wins rule (see [Conflicts](#conflicts)). The level being studied also has
its own copy of the three quiz options, changed with `set_quiz_options` (see
[Quiz options](#quiz-options)); that belongs to the one quiz. Duplicate gives
the new cascade every one of the original's settings.

#### One cascade, or all of them

A change to one of a cascade's settings applies to that cascade alone, at once.
The row then says so and **offers to use the same value for every cascade**,
one tap: "✓ Saved for this cascade · Also use for: all N cascades". A setting
that only one kind of cascade has reaches only that kind, and says so: "all N
anagram cascades" for the answer mode, definitions, hooks and alphabetical
order, "all N leave value cascades" for leave rounding. N counts the cascades
of that kind not in the Trash, this one included, and the offer appears only
when N is at least 2. The offer is made for each setting in the table and for
the options of levels made from now on; the options of the level being studied
belong to that one quiz and offer nothing wider (the row says "✓ Saved for this
level"). The offer stays until the dialog closes, so it is never gone before it
is read, and a second change to the same setting starts a fresh one.

**Copy another cascade's settings** gives this cascade, in one change, every
setting of a chosen cascade that applies to this cascade's kind and differs
from its own. The choice lists the user's other cascades not in the Trash, most
recently studied first. It says "✓ Copied N settings from “X”." or, when
nothing differs, "✓ “X” already has the same settings." The level being
studied keeps its own options: copying sends no `set_quiz_options`.

Neither is a new kind of change: "all N cascades" is the ordinary
`set_cascade_options` for each cascade whose value differs, and a copy is one
`set_cascade_options` for this cascade, so both work offline, sync, and are
judged on the server like any other (a change to a threshold applies to every
level of each cascade, the pass in progress included). The functions are in
`lib/settings/cascade.ts`.

#### This device, or all of them

A change to one of this device's settings applies to this device alone, at
once, and the row then **offers to use it for every device** of the account:
"✓ Saved on this device · Also use for: all your devices". The controls make
the same offer after any change, and after **Reset controls to defaults**
("✓ Reset on this device"), sharing the whole list of bindings as one setting.

The account keeps the shared values on the server, in `users.device_settings`:
an object of setting name to `{ value, at }`, `at` being when it was shared.
Sharing writes the value to this device's `meta` store (`shared_device`) as
pending, and the next sync carries the pending values in the request's
`device_settings`; the server merges them in, the later `at` winning per
setting, so two devices sharing the same setting agree on the last one. The
server keeps `at` as `least(at, now + 5 minutes)`, as it clamps every device
time it compares (see [Operations](#operations)), so a device whose clock is
months ahead wins a merge by five minutes at most and the next real share
takes the setting back.
**Every sync response carries the account's `device_settings`**, and a device
takes each value whose `at` is later than the last it took for that setting
(also kept in `shared_device`), made valid as a stored value from another
build is, and an open player shows it at once. A new device therefore starts
with every shared value once it has synced. A device's own later change stays
on that device until it, or another, shares again. Sharing works offline: the
value waits as pending until a sync carries it. The functions are in
`lib/settings/device.ts`; the server holds at most 64 shared settings per
account, 16 KB of them in all (a share that would pass either changes
nothing: every sync response carries them, and they are outside the
[storage limit](#storage-limit)), and reads no meaning into a value.

Question order is **not** a setting: questions are always shuffled.

### Creating a cascade

`/cascades/new` is laid out like Zyzzyva's Search tab. It needs a connection,
because searching runs on the server.

1. **Quiz type**: Anagram, Definition or Leave Value, a segmented control
   like the filters' AND / OR (radio inputs underneath, so the arrow keys
   move between them).
2. **Lexicon**: e.g. `CSW24`, a select under it. Each label sits in a column
   of its own on a wide screen and above its control on a phone, where both
   controls take the full width. When the type is Leave Value, lexicons without
   leave values are disabled, with a tooltip saying why.
3. **Filters**: a tree of condition rows in AND / OR [groups](#groups). Each
   row has a `+` menu (add a row or a group below), a `−` button (remove this
   row), a **Not** checkbox, a filter type dropdown, and inputs that change with
   the type. The dropdown only lists filters that apply to the chosen quiz type
   (see the [applicability table](#filter-applicability-by-quiz-type)). The Not
   checkbox is disabled for filters that do not support negation. The top-level
   group is AND, so a plain list of rows means all of them must match, as in
   Zyzzyva. For distributions whose tiles are not all plain A–Z, a **tile
   palette** under each tile input inserts tiles by clicking.
4. **Load Search… / Save Search…**: save the current filter rows under a name,
   or load a saved set. Load lists the saved searches by name, with how many
   word-list entries each holds, and fetches only the tree of the one picked
   (see [the endpoints](#catalog-and-search)), since a user can keep many lists
   of up to 300,000 entries. That fetch shares the search bucket, so a `429`
   on it waits for `Retry-After` like the preview. Save Search… is refused while any row is invalid or
   flagged, naming the row, and the server validates the tree again (see
   [the endpoint](#catalog-and-search)). A saved search stores only the filters, never the
   results, so it can be reused with any lexicon and any quiz type. It does
   record the quiz type it was saved under, because an In Word List row's entries
   are canonical for that type and the load flags the row when the two sides of
   Leave Value differ (see
   [Filter applicability](#filter-applicability-by-quiz-type)).
5. **Settings**: none here. Every new cascade starts with the same
   [settings](#settings) (a 90% clear threshold, flashcards, no segments,
   Ladder, and the rest at their defaults), and a note under the form says so:
   the cascade's settings, such as its clear threshold, answer mode and
   segments, can be changed in its Settings once it is created. The create
   request still carries the threshold, the three [quiz options](#quiz-options)
   and the answer mode, which the builder fills from
   `CASCADE_SETTING_DEFAULTS`.
6. **Cascade name**: prefilled with a summary of the filters, such as
   `CSW24 · Length 7–7 · Probability Order 1–1000`, which the user can edit.
   The summary is built on the device only, from the same `lib/filters.ts`
   table that labels each row, and the device always sends the field's text,
   so the server never generates a name. When the summary is longer than 200
   Unicode scalar values it is cut to its first 199 followed by `…`.
   **An account's cascades each have their own name, the Trash included**
   (`UNIQUE (user_id, name)`; names differing in case are different names, and
   a purged cascade's name is free again). The device knows every cascade
   the account has, so the builder keeps to the rule itself: a suggested name
   the account already uses is given the next free number ("… (2)"), and an
   edited name already in use shows "You already have a cascade named “…”.
   Each cascade needs its own name, the Trash included." under the field,
   with Create Cascade disabled. The server refuses one all the same, with a
   `400` on the field `name`, before the search runs.
7. **Preview**: runs the search as filters change, debounced by
   `PREVIEW_DEBOUNCE_MS` (400 ms) and then throttled to at most one request
   every `PREVIEW_MIN_INTERVAL_MS` (2 s), both beside the other client
   constants, with the latest edit always sent when the interval expires so the
   count on screen is never left behind the filters. The debounce is what makes
   the first count after a pause feel immediate; **the interval is what keeps a
   user editing a pattern under `SEARCH_RATE_PER_MINUTE`**, which the debounce
   alone does not: someone who types two or three characters and pauses to think
   crosses 400 ms on every pause, which would be 120 requests a minute against a
   limit of 30, making the `429` path below the ordinary case rather than the
   exception. At one request every 2 s the ceiling is exactly the limit — which
   is why the preview also **keeps a reserve**: it stops firing once it has spent
   all but two of `SEARCH_RATE_PER_MINUTE` in the rolling minute, showing the
   last count with "the server is busy" as a `429` would, because preview,
   Create Cascade, Duplicate and Save Search… all draw on that one bucket and a
   preview sized to the whole of it would refuse the very action the page leads
   to. The reserve counts **this tab's own** requests, since the bucket is the
   user's and nothing tells one tab what another spent, so two builders open at
   once can still empty it between them; that is what the `429` retry below is
   for, and the reserve is what keeps the ordinary single-tab case from needing
   it. It shows
   how many
   questions it matches plus the first few, so the user can adjust before
   committing. While an In Word List row holds more than 10,000 entries the
   preview runs only on an explicit **Preview** button, so a list of up to
   300,000 entries is not resent on every keystroke. The form shows inline errors for invalid rows, such as a
   malformed pattern, a tile not in the distribution, or min > max. Searches
   with more than 300,000 results say so and show the count. A `503` from the
   [search semaphore](#search-engine) is not a row error: the last count stays
   on screen with "the server is busy" beside it, and the preview retries once
   after `Retry-After`, so a loaded server never looks like a bad filter. **A
   `429` takes the same path**, since the user cannot act on the difference
   between a busy instance and a spent bucket and neither is a fault of their
   filters; only a `400` ever marks a row.
   Create Cascade retries a `5xx` with the same body, as it already does, **and
   a `429` the same way**, after `Retry-After`, with the button reading "the
   server is busy" until it goes through: the device-minted ids make the repeat
   safe, and without it a minute of previewing could refuse the create that
   follows it. **Duplicate** and **Save Search…** do the same.
8. **Create Cascade**: runs the search, shuffles the questions into the Source
   quiz, saves the cascade, starts downloading it for offline use, and goes
   straight to the first card. Under the preview count the builder shows what
   the cascade will use against the account's [storage](#storage-limit):
   "This cascade will use about 1.8 MB. 4.3 MB of 10 MB used." The figure is
   the preview's `storage_bytes`, which is exactly what creation will store.
   When it will not fit, or the account is already full, the line says "It
   won't fit: empty the Trash or delete cascades to make room." (linking to
   `/#trash`) and the button is disabled. The device's figure can be a
   sync behind, so the server's check decides: a `409 storage_limit` says what
   the cascade needs and how much is free ("This cascade needs about 2.1 MB,
   and 1.4 MB of your 10 MB is free. Empty the Trash or delete cascades to
   make room."). Save Search… past the limit says the same for the search,
   adding saved searches to what can be deleted.

### Cascades page

`/` is the landing page (`/cascades` redirects to it): it lists the user's cascades, newest activity
first, one compact row each, for a glance, with **New cascade** at the top and
the [Trash](#trash) below the list. Each cascade shows:

- its name on the left, then its quiz type (Anagram, Definition or Leave
  Value) in muted text; on a phone the name wraps rather than being cut
  short. Hovering the name shows the rest, as a
  tooltip of three lines: the name; quiz type, lexicon and clear threshold,
  its [quiz options](#quiz-options) in short form (e.g. `segments of 40 ·
  drill`, nothing when all are at their defaults), and "complete" with the
  date once the Source quiz has been finished with no misses; and a compact
  ladder of its levels, the current one with its progress and that progress
  as a percentage to two places, e.g. `L1 · 250 (waiting, segment 3 of 7) → L2 ·
  38 (waiting) → L3 · 9 (4/9 done, 44.44%)`
- how much [storage](#storage-limit) it holds on the server, e.g. `4.2 MB`,
  the server's figure for it; hovering it shows the split between its
  questions and filters and its levels (`Storage: 4.2 MB — questions and
  filters 2.6 MB, levels 1.6 MB`), the levels' share counted on the device
  from the same per-row costs
- an **Available offline** badge, download progress, or "not downloaded on
  this device, open to download" for a cascade whose question rows this
  device does not hold (outside its window and not kept for its size, or
  dropped for the storage [budget](#on-the-device); nothing pending)
- **Move to Trash**, whose confirmation adds that its storage is freed only
  when it is deleted forever, after the retention period or from the Trash

**The list is drawn as soon as the device has read it**; each row's download
badge counts the cascade's rows on the device, which for a cascade of 100,000
questions takes a phone's IndexedDB a second or more, so the badges follow,
one by one, rather than hold the list back. Until the device's first sync the
page says "Getting your cascades…" (offline, that they will appear once the
device is online), never an empty list. With no cascades the list says "No
cascades yet. Make one." (or, with no lexicon on the server, says so), and
the Trash follows as usual. Selecting a cascade opens the player at its deepest
level, whose **Settings** dialog holds the rest: the ladder with **Export…** per
level, the cascade's [settings](#settings), **Duplicate** and
**Move to Trash**. The header shows the account's
[storage](#storage-limit) against its limit, `4.3 MB of 10 MB used`, with a
meter (`data-storage` is `ok`, `almost` from 90%, or `over`). From 90% it adds
"Almost full: empty the Trash or delete cascades to make room"; over the limit
it says "Over your storage by 12 MB: you can keep studying, but can't create
cascades until you make room", and **New cascade** is disabled. Both link to
the Trash below. The figures are the ones `/api/auth/me` and every sync
response last reported, so they show offline too. The header also has
**New cascade** and
the sync status, which is [`SyncStatus`](#frontend) in every one of its states —
**Synced**, **Waiting to sync**, **Syncing…**, **Offline**, **Log in to sync**,
**not enough room on this device**, **signed out in another tab** and **reload to
keep syncing** — since this is the page a user studies from and the last four
are the ones that need acting on.

### Trash

The Trash is a section of the [Cascades page](#cascades-page), headed
**Trash** (`id="trash"`), below the cascades list, so the cascades and what is
in the Trash are seen together (`TrashList`). Moving a cascade to the Trash on
that page shows it in the Trash at once, and a restore or a deletion there
refreshes the cascades above. `/trash` has no page of its own: it redirects to
`/#trash`, so an old link lands on the Cascades page scrolled to the
Trash. With nothing in it, the section says "The Trash is empty."

The Trash lists finished quizzes and trashed cascades, grouped by cascade. Each
entry shows its final score, whether it cleared or was replaced, and when it will
be **deleted forever** (`cleared_at` or `trashed_at` plus the retention period
from the `meta` store). The Trash never says "purge", which is only the
operations' and the purge task's name. A quiz this device cleared offline has no server `cleared_at`
yet, and a cascade it trashed offline has no `trashed_at`, which is what puts a
cascade in this list at all, so `applyLocally` writes the operation's `at` into
the overlay row as a provisional one in both cases, which satisfies the row's
own shape and keeps a cascade trashed on a plane from vanishing from the
Cascades page and the Trash alike. Such an entry reads
"deleted forever 30 days after this syncs" until the acknowledged row replaces it.
Each entry has **Restore**, **Export…** and **Delete forever** actions;
Delete forever asks for confirmation first.
**What the Trash holds still counts** toward the account's
[storage](#storage-limit), so the section's header says "The Trash holds
12 MB of your storage.", each group shows its size, each Delete forever button
says what it frees ("Delete forever (4.2 MB)"), and its confirmation ends
"This frees 4.2 MB of your storage." A trashed cascade's figure is the
server's for the whole cascade; a cleared quiz's is its level's share, counted
on the device from the same per-row costs (its attempt rows, 210 bytes each,
are left out of the label but freed with it).
**Entries are grouped and not all rendered.** A cascade's group shows its name,
how many entries it holds, its size and the earliest date among them that one is deleted
forever ("deleted forever on …"), collapsed;
expanding it renders its entries a page of 100 at a time behind a **Show more**
control. A group holding one entry is rendered expanded, since collapsing a
single row hides nothing. One segmented attempt can leave tens of thousands of cleared quizzes
(see [Quiz options](#quiz-options)), and a flat list of them would lock the tab.
Restore is offered offline for a cascade that is not on this device too, with
the note "downloads when online", since the restored level cannot be played
until its rows are fetched. A
trashed cascade is one unit: the cleared quizzes listed under it can still be
restored (which brings the cascade back) and exported, but Delete forever is
shown only on the cascade itself, never on its quizzes.

### Taking a quiz

`/cascades/:id` plays the deepest level's quiz one card at a time. Upper levels
are shown as waiting and cannot be opened. The player chooses its layout from the
device's **primary pointer**:

- **Desktop layout** for a mouse or trackpad (`pointer: fine`) in a window at
  least 900 px wide.
- **Touch layout** otherwise (see [Touch zones](#touch-zones)).
- A tablet with a keyboard and mouse gets the layout for its primary pointer.
  Key bindings work in both layouts.

#### Desktop layout

```
┌────────────┬──────────────────────────────────────────────────────────────┐
│ Acrodont « │┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓│
│            │┃                         AEINRST                            ┃│
│ Cascades   │┃                         ANESTRI                            ┃│
│ New cascade│┃                         ANTSIER                            ┃│
│ Trash      │┃                         NASTIER …                          ┃│
│ Admin      │┃                                                            ┃│
│ Account    │┃          quiz area: its border is the grade                ┃│
│ Settings   │┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛│
│            ├──────────────────────────────────────────────────────────────┤
│            │ Level 2 of 3  Pass 3  37 / 250 (14.40%)  31 ✓ 5 ✗ (86.11%)   ● Synced │
└────────────┴──────────────────────────────────────────────────────────────┘
```

Users see an *attempt* (a pass through a level's quiz, reshuffled each time) as
a **pass**: "Pass 3", "after 4 levels and 9 passes". The plan keeps "attempt"
as the term of the data model and the API.

- **The quiz area** takes the rest of the window. The question sits at the top
  (half a rem below the area's edge by default; a setting moves it lower, up
  to 800 px in all), with the answer beneath it, so
  revealing the answer never moves the question. Banners appear at its foot.
  It is the only place where mouse controls act.
- **The grade is the quiz area's border**: once the answer is shown, red for
  Missed and, if the user turns it on, green for Correct (off by default, so
  only a miss stands out); none before the reveal. It changes at once (no
  fade) as the grade is toggled. Each colour is its own setting, as is the
  width (10 px by default). A visually hidden status line says the grade for screen readers;
  the area carries it as `data-grade` (`correct`, `missed`).
- **The menu** on the left holds Acrodont (to the Cascades page, so no
  separate Cascades link), Admin (for admins), Account and **Settings**; on a phone the same menu opens
  as a sheet over the quiz from **☰**, so there is no separate settings button.
  Settings is the one settings dialog there is: every
  [setting](#settings), in its two sections, under a header that holds only
  "Settings" and Close. Each section opens with a full-width shaded bar — a
  larger heading and an ⓘ saying what it reaches and whether it syncs
  (`SCOPE` in `settings-info.ts`) — so the two read as separate. Every
  setting is saved as soon as it is changed:
  - **Cascade Settings** (synced; other cascades keep their settings, and a
    change can be applied to every cascade), in order: the ladder as a
    table whose columns line up — level, questions, pass, last pass's score,
    status — with each level's Export…; the clear threshold (a number, taking
    effect when the field is left, for the pass in progress too); the answer
    mode (anagram cascades); "When an answer is revealed, mark it"; Show
    definitions, Show hooks and Show how many anagrams are found in typed
    mode (anagram cascades); Show each word's probability order and Definitions
    in their own column (anagram and definition cascades); Round leave values (leave
    value cascades); the [options](#quiz-options) of **Level N, the level you
    are studying** (that quiz only, from the current card; "✓ Saved for this
    level" after a change); the options **levels made from now on** start
    with (the cascade's); **Copy another cascade's settings** (a choice of the
    user's other cascades and **Copy settings**); then Duplicate and Move to
    Trash. Duplicate is disabled when the account's
    [storage](#storage-limit) is full (`Duplicate cascade: your storage is full`); a
    `409 storage_limit` says what duplicating needs and how much is free. The two sets of level options are subgroups of the section, each
    under its own heading. Each of the cascade's settings, and the options
    for levels made from now on, says "✓ Saved for this cascade" once changed
    and offers **all N cascades** (see
    [One cascade, or all of them](#one-cascade-or-all-of-them)).
  - **Device Settings** (saved on this device; other devices keep their
    settings, and a change can be applied to all of them): the display settings, then
    the [controls](#controls) under their own **Controls** subheading. Each
    display setting says "✓ Saved on this device" once changed and offers
    **all your devices**, as do the controls after a change or after **Reset
    controls to defaults** ("✓ Reset on this device"); see
    [This device, or all of them](#this-device-or-all-of-them). Every control
    is the same width and followed by the same unit column, so the fields,
    choices and checkboxes line up.

  **A cascade always opens with the menu
  hidden**, whatever happened last time: **☰** in the quiz area's corner
  shows it for this visit and **«** hides it again.
- **The status bar** along the bottom, outside the quiz area, shows the level,
  the pass, the card shown out of the level with the share of the level graded
  in this pass in parentheses (with a thin progress line above it), the score
  with the share of graded questions correct in parentheses — green when it is
  at or above the clear threshold, so the pass is on track to clear the level,
  red when it is below. Percentages show two decimal places, rounded.
  - **A level studied in [segments](#segments) has a second row, the Segment
    row,** under that Level row:

    ```
    Level 2 of 3     Pass 1   9 / 27 (29.63%)   5 ✓ 3 ✗ (62.50%)
    Segment 2 of 6   Pass 1   4 / 5 (60.00%)    2 ✓ 1 ✗ (66.67%)
    ```

    It gives the same four figures for the segment the user is in (a
    **run**, in the rules' word; the interface says *segment* throughout): the
    segment's number as [Segments](#segments) numbers runs, the card shown out
    of the segment's questions with the share of them graded, and the grades
    within the segment with the share correct. The figures of the two rows
    sit in the same columns, so they read against each other. On a phone each
    row's name takes a line of its own with its figures in columns under it.
    The segment's percentage has no colour: a segment has no threshold, and
    whatever it misses is drilled.
  - **A drill is its segment's next pass, not a level the bar speaks of.**
    The drill of a segment's misses is a quiz one level down (see
    [Segments](#segments)), but to the user it belongs to the segment. While
    one is played the Level row stays on the segmented level above, which
    waits at the next segment's first card, and the Segment row shows the
    drill: the same `Segment 2 of 6`, with `Pass 2` (then 3, 4, … for each
    further pass of what is still missed), the card shown out of the drill's
    questions, and the drill's grades. The level list in Settings still lists
    the drill as the level it is. If the level above stops being studied in
    segments while a drill is under way, the drill is shown as a level of its
    own, as any other.
  - Both rows are worked out on the device, from the question rows and quiz
    rows it already holds (`lib/player/segment.ts`); nothing is stored for
    them.
  The clear threshold, which rarely changes, is not on the bar: it is in
  Settings (where it is changed) and in the score's tooltip. An icon at the bar's left end hides it,
  and the same icon brings it back: hidden, the bar keeps its place with only
  that icon, so the quiz area and its grade border look
  the same either way. Hiding the bar quiets the sync status too.
- **The sync status** sits at the very bottom right: the right end of the
  status bar, shown or hidden.
- **The sync status shows what is happening**: "Waiting to sync" after an
  answer, "Syncing…" while the device talks to the server (a sync starts
  within about a second of a write), then "Synced"; offline, log in, reload
  and no room as they arise. It has a fixed width with its label flush right,
  so a changing label never shifts what is beside it.
- **The sync status can be hidden**, with the status bar or by its own
  setting on the device (shown by default). Hidden, it is quiet rather than
  gone: "Synced", "Syncing…" and "Waiting to sync" are not shown, and what
  needs the user's attention still is — offline, log in, reload, no room on
  this device, signed out in another tab.
- **On this device.** The question's and the answers' typeface is a choice of
  the few every device can show offline (Inter, bundled and the default; the
  system font; serif; monospace). **Definitions** — a Definition quiz's
  answer and the line under each anagram — have their own typeface, size (20
  px by default) and letter spacing, beside the question's and the answers'.
  Every other setting here is a value the user
  types, not a choice from a list: size
  in px (36 by default, 8 to 200) and letter spacing in em (0, the browser's
  normal, by default); the question's position in px from the top (8 by
  default); whether a correct answer shows its green border (off) and a missed
  one its red border (on); the grade border's width in px (10 by default, 0 to
  40); and the
  repeat guard in ms (0, off, by default). A number takes effect when its
  field is left, out-of-range values are clamped, and values saved by builds
  that offered presets are converted. Answers match the question by default. A
  definition answer is prose, so it takes the answer typeface at a reading
  size; hooks, and the probability order, have a size of their own (27 px by
  default, three quarters of the answers' default), and anagram definitions
  have their own. These, the question's
  position, the borders, whether the status bar and the sync status are
  shown, how wide a definition's own column may be (0 px by default: all the room there is; see
  [Answers](#answers)), a phone's
  [tap zones](#touch-zones) and the repeat guard are per device (the `meta`
  store's `display` value), since what suits a laptop is wrong on a phone;
  they are in the player's Settings, under Device Settings, and reach other
  devices only when shared (see
  [This device, or all of them](#this-device-or-all-of-them)).
- **Every setting is a row with its control at the right end**: a checkbox,
  a choice or a number, in the player's Settings and in the quiz options
  alike (`SettingRow`), so the place to click is
  always the same. On a phone (narrower than 640 px) a number or a choice
  goes under its name, which then has the row's whole width and is not
  squeezed into a few words a line; a checkbox stays at the right end of its
  name's line. Progression is a choice (Ladder or Drill), not a pair of
  radio buttons; its ⓘ explains both.
- **Every setting explains itself**: an ⓘ beside its name (`InfoTip`) shows
  what it does — on hover with a mouse, and on a tap or click, which keeps it
  open until a tap elsewhere, so a phone has it too — in a cascade's
  settings, the quiz options and this device's display settings. Written out
  under every name, the explanations crowded the dialog on a phone and a
  desktop alike, so nothing is written under a setting: an example (a
  segment of 40) or a default (0 counts every press) is in the same ⓘ. The
  section headings work the same way: Cascade Settings and Device Settings
  say where they apply (`SCOPE`), and the level being studied, levels made
  from now on, copying another cascade's settings and Controls say what they
  hold (`SECTION`), each behind an ⓘ ("About these settings") beside the
  heading. The texts live in one module (`lib/settings-info`).
- **Sensitive actions ask first** (`ConfirmDialog`, one per app, in the root
  layout): Move to Trash, Delete forever, Duplicate, removing an account's
  data from the device, deleting the account, resetting the controls,
  replacing a saved search and the admin's deletes. The dialog says what is
  about to happen and whether it can be undone; its confirming button names
  the action (never "OK"), drawn in the destructive colour when data goes for
  good, and Cancel, Escape or a click outside declines. While it is open, the
  player takes no keys.
- **The logout warning** ("2 changes haven't synced yet. They will sync the
  next time you log in on this device.") shows on the Account page only when
  changes cannot sync now (offline, or the session needs a login). Online,
  every change syncs within a second and the sync status in the header shows
  it; a line that came and went with each setting changed would only shift
  the page.
- **Inside the quiz area**, text selection is off and the browser's context menu
  is suppressed. Middle-click autoscroll and (on Linux) middle-click paste are
  prevented, so all three mouse buttons are free for quiz actions.

#### The three actions

Every quiz is driven by three actions, whatever the device:

| Action | Before the answer is shown | After the answer is shown |
|---|---|---|
| **Show / Next** | Show the answer | Save the grade and go to the next card |
| **Toggle grade** | Nothing: there is no grade until the answer is shown | Flip the grade between Correct and Missed |
| **Previous** | Go back to the previous card | Go back to the previous card |

- **The grade** appears with the answer, as the colour of the quiz area's
  border (green Correct, red Missed; see the layout above). It starts as
  Correct, so a user who knows the answer only ever uses Show / Next, and one
  who does not shows it, then toggles.
- **Saving.** A grade is saved only when Show / Next moves on. Going back from a
  card discards that card's unsaved reveal and toggle.
- **Going back.** Previous shows the earlier card with its answer and saved
  grade. Toggle changes that grade, and Show / Next saves it and moves forward
  again. Previous does nothing on the first card of the attempt or of the
  current [run](#segments).
- **The last card.** Moving on from it finishes the attempt (see
  [Finishing a quiz](#finishing-a-quiz)).
- **Repeats.** The same action fired twice within the **repeat guard** counts
  once, so a bouncing mouse button or an accidental double tap does not skip a
  card. The guard is a setting on each device, typed in ms, and **0 (off) by
  default**, so every press counts; a user whose mouse bounces raises it. It
  is beside the display settings in the player's Settings, under This
  device, since how much a button bounces belongs to the hardware.
  Settings saved before the default changed with the old default, 50, read as
  0. The wheel's own 150 ms guard against one flick firing many
  steps is separate. A key held down is one press whatever the guard: the
  keyboard's own repeats are ignored, since they would show and grade cards
  nobody saw.
- **Instant at any size.** Show / Next and Previous never wait for IndexedDB,
  however large the quiz and however slow the browser's storage (Firefox
  commits each read-write transaction more carefully than Chromium):
  - the next card is drawn from memory: the player holds the keys and answers
    of the cards from one behind to fifty ahead, read in the background in one
    small transaction as it moves;
  - the grade and cursor writes go to a queue that applies them in order behind
    the screen; the score and cursor shown are what those writes will leave;
  - actions are never dropped: they run one at a time, each up to the point its
    card is shown, and only the end of a run or an attempt waits for the
    queue, since finishing needs every grade saved;
  - a reload (after a sync, a setting) takes its turn with the actions and
    waits for the queue, so it reads what the screen shows;
  - a write that fails halts the queue: for want of space the player returns
    to the card it came from with the storage message, holding that write and
    those after it until Try again; a rejection reloads what the device holds.
  Measured in the first minute after creating a 103,925-question CSW24
  cascade, with its download running: Next 2 ms median, 17 ms at worst (from
  about a second before these changes); reveal the same.

#### Answers

This is how Definition and Leave Value quizzes always work, and how Anagram
quizzes work by default (**flashcard mode**). The answer that Show / Next reveals:

- **Anagram**: each valid anagram, one per line, in alphabetical order. The
  card carries the words already in that order, and the device never re-sorts
  them. The words sit in **one straight column**: each line is a row of five
  columns — the word's probability order, right-aligned; front hooks,
  right-aligned; the word, with its inner-hook dots; back hooks, left-aligned;
  the definition, left-aligned. Each hook column is as wide as its own widest
  hooks and no wider, the same for every row. What is left of the word and
  what is right of it share the page's width equally, so every word starts at
  the same place and the column is in the middle of the page whatever the
  others hold; the answer is as wide as the quiz area.
  - **The probability order** is the word's rank by
    [probability](#probability-and-probability-order) among the lexicon's
    words of its length (1 is the likeliest). The column is empty unless the
    cascade's *Show each word's probability order* is on (off by default). The
    card carries it with the hooks (`probability_order`), so a cascade that
    shows it fetches its cards with hooks even with *show hooks* off (the
    hooks are then not drawn).
  - With *show hooks* on (the default), each word is written Zyzzyva-style with its front
    hooks to the left and back hooks to the right, e.g. `bcfm ·AA· hls`, and
    its **inner hooks** as a dot before the word (the word less its first tile
    is a word) and after it (less its last tile); an absent dot still takes its
    space, so the column stays straight. The
    hooks are drawn by `TileText` like any other tiles, in
    [tile order](#tiles), and **lower-cased only where a tile is a single ASCII
    letter**: that is what makes the English display the one Zyzzyva users know,
    while a multi-character or non-ASCII tile keeps its own form, since its
    lower-case form is its `blank_letter` — `ny`, `l·l` — which means "a blank
    playing that tile" everywhere else in Acrodont and is an error in an upload
    file. So a Catalan front hook reads `NY`, never `ny`.
  - With *show definitions* on (the default), each word's definition appears
    in the definitions' own typeface and size, **one line for each part of
    speech** (a lexicon's definition separates them with ` / ` after the
    bracketed part of speech: `a way out [n -S] / to go out [v -ED, -ING, -S]`
    is two lines; a line too long for its column wraps). It is in its own
    column after the back hooks (the cascade's *Definitions in their own
    column*, on by default), or, with that off, centred beneath the word. The
    column runs to the right edge of the page, or to the device's *Definition
    column width* when that is not 0. The probability order and the hooks, which are
    smaller than the word, are centred on it vertically, not sat on its
    baseline, and the word and the definition are **centred on each
    other**, however many lines the definition takes or wraps to: a
    definition of three lines has its second beside the word. A short part of speech (`[n -S]`, up to 16 characters)
    is never split across lines, nor an inflection from its hyphen (`-S`). A window narrower than 640 px has no room for the column and always
    puts the definition beneath the word.
- **Definition**: the word, written like an anagram's with its probability
  order, hooks and inner hooks, and the full definition text in its column
  or beneath it, as above. A Definition cascade's cards
  are always fetched with hooks; the card carries its word's (`word`) beside the
  definition, which stays the answer.
- **Leave Value**: the value rounded to the cascade's decimal places (half away
  from zero), e.g. `34.1` or `-8.4`: a negative value has its `-`, and a
  positive one no `+`. A value that rounds to zero is
  shown as `0.0`, never `-0.0`. Both sides round the same way, on the `f64`
  value: with `d` decimal places, `n = trunc(|v| × 10^d + 0.5)` computed in
  `f64`; the text is `n` written as an integer, with a `.` inserted `d` digits
  from the right (zero-padded, so `d = 1` and `n = 3` give `0.3`); the sign is
  an ASCII `-` when `v < 0` and `n > 0`, and otherwise there is none — never a
  `+`, on screen or in exports. Neither side uses `toFixed`, `format!("{:.d}")` or any other
  library rounding, which round half to even on the binary value.

#### Typed mode (Anagram quizzes only)

- Only Anagram quizzes can be typed: a Definition or Leave Value card is
  always a flashcard.
- **The answer mode is the cascade's own** (`cascades.answer_mode`), like its
  clear threshold: one of the cascade's [settings](#settings), Flashcard when
  the cascade is created, changed in its Settings with `set_cascade_options`
  (for it alone, or for every anagram cascade), copied by Duplicate, and
  never a quiz's.
- **The tiles typed mode needs** are the cascade's letter distribution. A
  cascade played card by card (a new one, or one not downloaded here) may not
  have it yet, so the player fetches it as the card is shown, and a card shown
  as a flashcard for want of it becomes typed when it arrives.
- The text input sits **at the bottom of the page**, in a bar under the quiz
  area (above the on-screen keyboard on a phone), with a line under it for the
  notes below ("already entered", "not an anagram of the question").
- **The found count** (`3 of 9 found`) is **off by default**: knowing how many
  anagrams are left is a hint. A cascade setting (`show_found_count`, synced
  like the cascade's others) turns it on, and it then shows in the status bar
  until the reveal.
- The user types a word and presses **Enter**. Input is upper-cased, trimmed,
  and converted to tiles (see [Tiles](#tiles)).
  - A word that is **one of the answers and not yet entered** joins the found
    list, and the counter goes up. Found words show **in the answer space**,
    in the answer font and size and in the answer's order — the word alone,
    with **no hooks, inner hooks or definitions** until the reveal, since those
    would hint at the words still to find.
  - A word **already entered** is ignored, with a brief "already entered" note.
  - An entry that is **not an anagram of the question** — other tiles, or
    another number of them — is rejected: it cannot be an answer. For `ABC`,
    `AB` and `ABD` are rejected; so is `RETAINS NASTIER`, two words typed
    together, which the space-separates-tiles rule reads as one 14-tile entry,
    and text that is not tiles of the distribution at all. A blank in the
    question stands for any one tile, so for `AB?` the entry must hold an `A`
    and a `B` and one more tile. It is left in the input with "not an anagram
    of the question", and does not affect the grade.
  - Any other entry — an anagram of the question that is not an answer, such
    as `BCA` for `ABC` — is **wrong**: the question will be graded missed. The
    input clears and **turns red** until the next keystroke.
  - **The last entry.** An entry that is an anagram of the question is
    *taken*: found, already entered or wrong. The most recently taken entry
    shows on a line under the input box, **green** if it is an answer (found
    now or already entered) and **red** if it is wrong, until the next entry
    replaces it; it clears when the next card comes up. An entry that is not an
    anagram of the question is not taken and never shows there. A wrong word
    shows nowhere else, before the reveal or after it.
  - **The latest word.** While the user is typing, the found words in the
    answer space show the most recently entered one in green.
- **The card ends only when the user says so**: on **Enter on an empty input**,
  or on **Show / Next**, which before every anagram is found means giving up.
  Finding every anagram does not reveal the answer by itself, because the user
  may still mean to try a word that is not one — and that word should count
  against them. Showing the answer displays the full list, formatted by the
  cascade's hook and definition settings, with the words the user did not find
  highlighted.
- The grade is set automatically: **correct** only if every anagram was found
  with no wrong entries, otherwise **missed**. Toggle grade flips it, and Show /
  Next (or Enter) saves it and moves on.
- **A card whose answer the device does not hold falls back to flashcard mode**,
  with the "answer needs a connection" line the reveal shows there. Typed mode
  grades from the answer list, so without one every entry would be wrong and
  the card would grade missed by itself; the fallback starts the grade at
  Correct and leaves it to Toggle, as flashcard mode does, and the
  alphabetical-order option is inert on such a card. This is the same fallback
  a missing distribution forces (see [On the device](#on-the-device)).
- **Alphabetical order.** With the quiz's **Answers in alphabetical order**
  [option](#quiz-options) on, the answers have to be entered one after another
  in tile order (see [Tiles](#tiles)): each entry must be the first answer not
  yet given. An entry that is a valid, not-yet-entered answer but skips an
  earlier one (`NASTIER` when `ANTSIER` is still to find) is **out of order**,
  and the card is **missed at once**: the answer is revealed with the grade
  Missed and "Out of order: `NASTIER`" under it, with no Enter needed, since
  nothing typed after it could save the card. The
  input shows a hint of what is expected next ("after `RETSINA`"). The option does nothing in flashcard mode, and nothing at
  all in Definition and Leave Value cascades, but it is stored for every cascade
  so that switching answer modes later keeps it.
- **Protecting typing.** While the input has focus, every stroke that **types,
  edits or submits** goes to the input and is never dispatched as a binding:
  any key that produces a character, **with or without Shift**, Space,
  Backspace, Delete and **Enter**. Enter keeps its two typed-mode meanings —
  submit the word, and Show / Next on an empty input — even when it is also
  bound, so one keystroke never both submits and acts. Shift alone is not a
  modifier here, so a `Shift+T` binding types a `T` while the input has focus.
  Strokes with Ctrl, Alt or Meta still act, and so do Escape, the arrow keys
  and function keys. Every binding acts as usual in flashcard mode and whenever
  the input does not have focus.
- **Focus.** The input takes the focus as each card comes up to be typed, and
  again when Settings or a confirmation closes over it, so answer after
  answer can be typed with no click in the box. It is focused once per card,
  never taken back on a later change to the same card.
- **Protecting against accidental give-ups.** Before the answer is shown, a
  stroke bound to **Show / Next** inside the quiz area focuses the input instead
  of acting. A stroke bound to Previous, such as the default middle click,
  still acts, so a card can be left with the keyboard covered. One bound to
  Toggle grade does nothing, as on any card before its answer is shown: there
  is no grade to flip yet (see [The three actions](#the-three-actions)).
- Switching modes in the middle of a card resets that card's typed entries.

#### Controls

The default desktop bindings are:

| Action | Mouse (in the quiz area) | Keyboard |
|---|---|---|
| **Show / Next** | Left click | Space, `,`, Enter |
| **Toggle grade** | Right click | `X`, `M` |
| **Previous** | Middle click | Backspace, `J` |

An action can hold any number of bindings, up to 64 on a device in all, but always at least one. A device
whose bindings were saved before `,`, `M`, `J` and Enter were added gets them
with **Reset controls to defaults**.

- **What can be bound.** Each action can have any number of bindings. A binding
  can be:
  - a mouse button: left, middle, right, back or forward
  - a wheel direction: up or down
  - any key

  Each can be combined with any mix of Ctrl, Shift, Alt and Meta.
- **Where bindings act.** Mouse and wheel bindings act only inside the quiz
  area. Key bindings act anywhere on the player page except text fields outside
  the quiz area, such as the Settings dialog. **A wheel binding takes the
  wheel** inside the quiz area: a bound direction acts and does not scroll, and
  an unbound direction scrolls as usual. **An answer is fitted to the panel**:
  when the answer — an anagram list with definitions, a long definition —
  would make the quiz area scroll, its words and definitions are scaled down
  together until it fits, before the browser paints it, and back up when there
  is room again (a resize, a hidden menu). The question keeps its size. The
  scale stops at 30%; an answer too long even then overflows the panel, shows a
  scrollbar, and scrolls with it or with any arrow or Page key that is not
  itself bound, so a user who
  binds the wheel can still read the end of it; the capture box says so when a
  wheel direction is bound.
- **Editing.** Bindings are changed in **Controls**, under **Device Settings** in
  the player's Settings (`ControlsEditor`). The user chooses
  **Add binding** and then presses the key, or clicks or scrolls, inside a
  capture box. Escape cancels capture, cannot itself be bound, and does not
  close Settings.
- **Rules.**
  - A stroke can belong to only one action; binding it to another action moves
    it there, with a notice.
  - Every action must keep at least one binding.
  - **Reset controls to defaults** restores the table above, after a
    confirmation.
- **Keyboard layouts.** Keys are recorded by physical position
  (`KeyboardEvent.code`) and displayed using the user's keyboard layout where
  the browser supports it (`navigator.keyboard.getLayoutMap()`).
- **Strokes the page may not receive.** Some belong to the browser or operating
  system: Ctrl+W, Cmd+Q, and on some systems the back and forward mouse
  buttons. The capture box warns when a stroke is one of these.
- **Wheel bindings** act at most once every 150 ms, so one flick of the wheel is
  one action.
- **Per device, shared only when asked.** Bindings are kept in the user's
  `meta` store on the device, beside the display settings, exactly as those
  are: a laptop's trackpad and a desktop's five-button mouse want different
  bindings, so one device's choice changes another's only when the user uses
  it for all their devices (see
  [This device, or all of them](#this-device-or-all-of-them)), which shares
  the whole list as one setting. A new device starts with the defaults, or
  with the account's shared controls once it has synced; a stored or shared
  list that is unreadable, or leaves an action with none, is read as the
  defaults. There is no `set_bindings` operation and no bindings table on the
  server.

#### Touch zones

In the touch layout the quiz area fills the screen above typed mode's input
and the [status bar](#desktop-layout), which is the desktop's: the level, the
pass, the card out of the level, the score, the run and the found count,
wrapping to a second line rather than leave anything out (the second line
starts under the first item, so nothing sits under the hide icon), with the
sync status at its right end and the same icon to hide it. **☰** in the quiz
area's top-left corner opens the player's menu as a sheet (Acrodont, Admin,
Account, Settings). The quiz area is divided into three tap zones, one per
action, laid out by a device setting, **Tap zones on a phone**:

**Columns** (the default): three columns side by side, Previous, Toggle and
Show / Next, each a third of the screen's width and the quiz area's full
height. A tap anywhere in a column is that column's action, the question and
answer included, and each column's label sits along the bottom, in a row of
three buttons. Nothing marks the columns' edges: the labels are enough.

```
┌─────────────────────────────┐
│☰                            │
│         AEINRST             │
│   ANESTRI ANTSIER NASTIER … │
│                             │
│                             │
│ ↶Previous ✓⇄✗Toggle  Show ▸ │
├─────────────────────────────┤
│ ▣ Level 2 of 3  Pass 1  37 / 250 (14.80%)
│   30 ✓ 7 ✗ (81.08%)       ● Synced │  status bar
└─────────────────────────────┘
```

**Rows**: the question and answer fill the top, and under them three rows of
buttons, top to bottom Previous, Toggle and Show / Next, each the full width
and as tall as a device setting, **Row height on a phone** (64 px by default,
32–200; shown once Rows is chosen). The question itself does not act. In
landscape the question takes the left and the three rows stand at the bottom
of a column on the right, two fifths of the width.

Why these layouts:

- **Columns** put every action within reach of a thumb along the bottom edge,
  each a large target, and keep the whole screen tappable.
- **Rows** put **Show / Next**, used twice per card, at the bottom, nearest
  the thumb holding the phone, Toggle above it and Previous, the rarest, the
  furthest up; the row height lets a large hand or a small screen make them
  easier to hit.

Details:

- **Taps and drags.** A tap acts, and a drag scrolls. Answers are fitted to the
  quiz area as on a desktop; one too long even at the smallest scale scrolls
  without acting.
- **Responsiveness.** `touch-action: manipulation` removes the double-tap-zoom
  delay. Nothing vibrates.
- **Typed mode.** The input bar is at the bottom of the page, and the page
  shrinks to the space above the on-screen keyboard (`interactive-widget=resizes-content`),
  so the bar sits just above the keyboard. The keyboard covers the zones, so while
  it is open the bar also holds a row of three buttons: Previous, Show / Next,
  Toggle. The bar is there only until the answer is shown, so its Toggle, like
  every Toggle before the reveal, does nothing.
- **Customization.** Columns or rows is the one choice; only mouse and
  keyboard controls can be rebound.

#### Saving progress

Every grade is saved locally at once and synced when there is a connection, so
closing the tab, losing the connection, or switching devices resumes at the
current card.

### Finishing a quiz

Moving on from the last card applies the [cascade rules](#cascade-rules) and
goes straight on, with no summary screen. A small, non-blocking banner says what
happened:

- `Level 2 cleared with 87%. Its 5 missed questions are now Level 2.`
- `Level 2 cleared with 100%. Back to Level 1.`
- `Level 2: 64%, and 80% is needed to clear. Level 2 is reshuffled and waiting.
  Down to Level 3 with 18 missed questions.` (Ladder progression)
- `Level 2: 64%. Replaced with its 18 missed questions.` (Drill progression)
- `Level 2: 0%. Reshuffled. Try again.`
- `Level 1: 87%. Reshuffled, and its 5 missed questions are now Level 2.` (the
  Source quiz, whatever the progression)
- `Level 1: 100%. Cascade complete after 4 levels and 9 attempts.` This one
  leads to the completion screen, which offers **Start over** and **Move to
  Trash**.

Moving on from the last card of a **run** that is not the last run does not
finish anything; it drills that run's misses (see [Segments](#segments)) and
says so:

- `Segment 2 of 3 done, 9 missed. Now drilling them.`
- `Segment 2 of 3 done, nothing missed. On to segment 3.`
- `Drill done. Back to Level 2, segment 3 of 3.`

A drill's own passes speak of the drill, never of its level, as the status
bar does: `Drill: 50%. Now drilling its 3 missed questions.` when some are
still missed, and `Drill: 0%. Reshuffled. Try again.`

All of this works offline.

### Exporting words

Any cascade or quiz can be downloaded as a word list. **Export…** appears on
each level in the player's **Settings** (the ladder under Cascade Settings) and on each entry in the [Trash](#trash), and opens a small dialog:

| Choice | Options | Default |
|---|---|---|
| **What** | The whole cascade, or one of its quizzes | whatever the menu was opened from |
| **Which questions** | All · Correct · Missed · Not yet answered | All |
| **Format** | **Word list** (`.txt`, one entry per line) or **Spreadsheet** (`.csv`, one row per question) | Word list |
| **Lines** (word list) | The answers, or the questions | the answers for Anagram cascades, the questions otherwise |
| **Columns** (spreadsheet) | question, answer, definition, hooks, grade | question, answer, grade |

What "correct" and "missed" mean:

- **For a quiz**: the grades of its current attempt. For a quiz in the Trash, the
  attempt it finished on.
- **For a cascade**: the union over its **active** quizzes' current attempts. A
  question is *missed* if it is graded missed in at least one of them, *correct*
  if it is graded correct in at least one and missed in none, and *not yet
  answered* if it is in no active quiz or ungraded everywhere. This is what
  "everything I'm still getting wrong in this list" means, which is what the
  export is for. The dialog spells it out in a line of help text.

What ends up in the file, per quiz type:

| Quiz type | Questions | Answers |
|---|---|---|
| **Anagram** | one alphagram per line | every word of each selected alphagram, one per line, in alphabetical order |
| **Definition** | the word | the definition |
| **Leave Value** | the leave | the value, at the cascade's decimal places |

- Entries are written in the quiz's shuffled order for a quiz export, and in
  search order for a cascade export. For a quiz export the dialog offers
  **alphabetical instead**, which sorts by question key in
  [tile order](#tiles); it is not offered for a cascade export, whose search
  order already is that order (see [Search Engine](#search-engine)), so the two
  would produce the same bytes.
- [Tiles](#tiles) are written in MAGPIE notation, so a multi-character tile
  round-trips (`A[NY]S`). Files are UTF-8 without a byte-order mark. A word
  list uses LF line endings; a CSV is RFC 4180, so CRLF line endings, a header
  row, and a field quoted with `"` only when it contains `,`, `"`, CR or LF,
  with `"` doubled inside. Both end with a line ending, except that a word
  list with no entries is a zero-byte file; a CSV with no entries is its
  header row alone.
- **CSV cells.** `question` and `answer` are as in the table above; an Anagram
  `answer` cell holds the alphagram's words separated by single spaces, in
  alphabetical order. `definition` is the word's definition, or for an Anagram
  row the definitions of its words separated by ` | ` in the same order
  (definitions themselves contain ` / `, so that cannot be the separator; a
  definition may hold ` | ` too, so an Anagram row's `definition` and `hooks`
  cells are for reading, not for splitting back into words).
  `hooks` is `front hooks|back hooks`, each a space-separated list of upper-case
  tiles in MAGPIE notation (empty when none), and for an Anagram row one such
  pair per word separated by ` / `. `grade` is `correct`, `missed` or empty. A
  Leave Value `answer` is the value as the [Answers](#answers) rule writes it
  for exports (no `+`), and a Leave Value row's `definition` and `hooks` are
  empty; the dialog does not offer those columns for a Leave Value cascade. The header row is the column names in the order chosen.
- The file is named after the source, e.g. `CSW24 7s - L2 missed.txt`: the
  cascade name, then ` - L<level>` for a quiz export, then, after a single
  space, the selection's API value when it is not `all` (`correct`, `missed`
  or `ungraded`), then the extension. Every Unicode scalar value (a code point,
  never a UTF-16 code unit) outside `A–Z`, `a–z`, `0–9`, space, `.`, `_` and
  `-` is replaced with one `_`, and the name is cut to 100 characters before
  the extension. The server sends the same name in
  `Content-Disposition`.

**How it is produced.** The export is built on the device from its view of the
local rows (overlay over base, see [On the device](#on-the-device)), after
materialising the cascade if it is not yet (which needs a connection when its
index lists have never been fetched or its rows were dropped on leaving the
window, and the dialog says so), so it
works offline for a downloaded cascade, in a worker and in chunks so a
300,000-question list doesn't block the page, and handed over as a Blob. The
questions come from the `questions` store, which eviction never touches, so a
questions-only export works offline for a cascade whose keys are complete; when
they number fewer than the cascade's `question_count`, because a download never
finished, it falls back to the server like any other missing piece. The dialog's
live count comes from that same store, which is why it counts the **questions**
the selection holds rather than the lines an answers export would write: those
lines are words, they live in the `cards` store, and eviction can empty it, so a
count of lines would be the one figure the dialog could not produce offline. With
the cards complete locally it shows the entry count beside the question count.
Answers,
definitions and hooks come from the cascade's answer cards, and definitions and
hooks are only in the local cards if the cascade's settings asked for them, so an
export that needs something the device doesn't have falls back to
the server, in two steps. A page cannot see the status of a navigation, and a
navigation that lands on an error body can replace the app, so the dialog first
`fetch`es `POST /api/cascades/:id/export-token` with the export's choices and
`X-Acrodont-User`: that request is the one that sees `401`, `404` and `429`, and
the dialog reacts to them as below and as every client of a limited endpoint
does. Its answer is a short-lived, single-use URL for
`GET /api/cascades/:id/export`, bound to the user and the choices, and the dialog
navigates a **hidden `<iframe>`** to it — never the tab — so the file streams to
disk as an attachment without ever being held in the tab's memory, and any
response that is not an attachment (a `204`, a `404` for a cascade purged in the
intervening second, a `500`, or the ALB's own `502`/`503` page while a task is
replaced during a deploy) renders invisibly in the frame and is discarded
instead of replacing the app. The token is the proof of account, so the
download carries no header. It is a PASETO v4.local under an **export key
derived from `SESSION_SIGNING_KEY` with HKDF** (label `acrodont export token`),
never the session key itself, so an export token can never decrypt as a session
cookie or a session token as an export token, whatever claims either parser
checks. It carries the user id, a hash of the choices, an expiry 60 seconds out
and a random `jti`, so any task can check it; its **one use** is recorded by inserting
the `jti` into `export_tokens_spent`, where a conflict means it was already used,
so a token issued by one task and redeemed on the other works, and a second
redemption on either is refused. An expired, reused or mismatched token answers
`204 No Content`, the tidiest answer for a frame that nothing reads, so a double
click or a tab throttled past the minute produces no file and no error; the dialog, having seen the token request succeed, re-enables its
button, and a retry mints a fresh token. The choices carry every choice that
shapes the bytes, including the cascade's leave value decimal places as the
device sees them, so the server never reads a setting the device may have
changed offline. When that is needed and there is no connection, the dialog says
so and offers to export the questions alone, which never needs anything but
local data. A `404` from the token request means the quiz or cascade was purged on
another device or by the retention period while the dialog was open; the dialog
says it has been deleted and, two seconds later, goes to the Cascades page, rather than offering
the offline fallback, which would fail for the same reason.

---

## Admin

Admins manage the catalog from `/admin`. It lists every letter distribution,
lexicon and leave value set, with its size, uploader, upload time, how many
cascades reference it, and its **Storage**: everything the server keeps for it,
which is its rows in Postgres (the item's own row and its tiles, or its one
packed row of words with definitions or of leave values: each row as stored,
a packed text at its compressed size, plus its share of the tables' indexes) and, for a lexicon or
leave value set, its in-memory index on the instance answering. Hovering the
figure splits it into the database's part and the in-memory part with the
index's build time. Nothing about an item is kept on disk outside Postgres. Admin status is the `users.is_admin`
flag. **No endpoint can set it**; it is granted with SQL (`scripts/dev.py` does
this for the local dev user), so no bug in the web API can create an admin.

### Uploads

Each upload is a form plus one file:

| Upload | Form fields | File |
|---|---|---|
| **Letter distribution** | name (defaults to the file name without `.csv`, e.g. `english`) | [Letter distribution CSV](#letter-distribution-file) |
| **Lexicon** | name (e.g. `CSW24`), letter distribution | [Lexicon TSV](#lexicon-file) |
| **Leave values** | lexicon | [Leave values CSV](#leave-values-file) |

Every upload is validated in full before anything is written. If there are
problems, nothing is stored and the page lists them with line numbers: the first
1,000, plus a total count. A valid upload is written in one transaction.

### File formats

These rules apply to all three files:

- **Encoding:** UTF-8. A leading byte-order mark is ignored.
- **Lines:** one record per line, with LF or CRLF line endings. Blank or
  whitespace-only lines are ignored. There is no header row and no comment
  syntax.
- **Fields:** each record has exactly the number of fields listed for its file,
  separated by that file's delimiter (tab or comma). There is no quoting or
  escaping, so a field can never contain its file's delimiter. Whitespace around
  each field is trimmed.
- **Tiles** (lexicon and leave value files): written in
  [MAGPIE notation](#tiles). Single-character tiles are written as they are,
  and multi-character tiles in square brackets (`A[NY]S`). In that notation,
  lower-case tiles mean a blank standing for a tile, so they are errors in these
  files.
- **Numbers:** plain decimals: an optional `+` or `-`, digits, and an optional
  `.` followed by digits. For example `542388`, `28.292000`, `-0.378`. No
  exponents, thousands separators, `NaN` or `Infinity`.
- **Size:** at most 100 MB.

In the examples below, `⇥` stands for a tab character.

#### Letter distribution file

The format is MAGPIE's, the same as the files in
[MAGPIE-DATA](https://github.com/jvc56/MAGPIE-DATA/tree/main/data/letterdistributions)
(`english.csv`, `english_super.csv`, `catalan.csv`, `dutch.csv`, `french.csv`,
`german.csv`, `polish.csv`). Those files upload unchanged. It is a
comma-separated file with one line per tile and **5 or 7 fields** per line:

`letter,blank_letter,count,value,is_vowel[,fullwidth_letter,fullwidth_blank_letter]`

| Field | Rules |
|---|---|
| `letter` | How the tile is written: one or more characters, e.g. `A`, `Ą`, `Ç`, `NY`, `L·L`. Unique within the file. Apart from the blank's `?`, it cannot contain `[`, `]`, `,`, `?`, `*`, `.` or whitespace. At most **8 bytes** of UTF-8, which is below MAGPIE's `MAX_LETTER_BYTE_LENGTH` and covers every real distribution (`L·L` is 4); the cap is what lets every text column that holds tiles have a fixed size. |
| `blank_letter` | How the tile is written when a blank stands for it, conventionally the lower-case form (`a`, `ą`, `ny`, `l·l`). Unique within the file, never equal to any tile's `letter`, and with the same character rules. |
| `count` | Non-negative integer: how many of this tile are in the bag. |
| `value` | Non-negative integer: points. |
| `is_vowel` | `1` or `0`. |
| `fullwidth_letter`, `fullwidth_blank_letter` | Optional; give both or neither. These are the fullwidth forms MAGPIE uses to align text output. They are stored for fidelity but not used by the Acrodont UI. |

- **The first line is the blank** and must be `?,?,<count>,0,0`. MAGPIE treats
  the first tile as the blank. A count of `0` means a bag with no blanks.
- **Line order is tile order.** Alphagrams and leaves are sorted in this order,
  so the blank always sorts first.
- **A line with other than 5 or 7 fields is an error**, as in MAGPIE. The file
  may end with or without a newline.
- **The name** entered in the form defaults to the file name without `.csv`
  (`english`, `english_super`) and must be unused.

An excerpt of MAGPIE-DATA's `catalan.csv`:

```
?,?,2,0,0
A,a,12,1,1
B,b,2,3,0
C,c,3,2,0
Ç,ç,1,10,0
…
L,l,4,1,0
L·L,l·l,1,10,0
M,m,3,2,0
N,n,6,1,0
NY,ny,1,10,0
O,o,5,1,1
P,p,2,3,0
QU,qu,1,8,0
…
```

#### Lexicon file

A tab-separated file (`.tsv`) with three fields per line:
`word⇥playability⇥definition`. There is one line per word, in any order, and at
least one word.

| Field | Rules |
|---|---|
| `word` | 1–15 tiles of the chosen letter distribution, in MAGPIE notation, with no blanks. No duplicates. In a Catalan lexicon, `ANYS` is written `A[NY]S`. |
| `playability` | Decimal number. Higher means more playable. Words with equal values tie, as described under [Lax](#filter-reference). |
| `definition` | Required, 1–10,000 characters, no tabs. Part-of-speech tags in square brackets (`[n -S]`, `[v]`) are what the Part of Speech filter reads. |

A line with fewer or more than three fields is an error. The name entered in the
form must be unused.

```
AA⇥3811⇥(Hawaiian) a volcanic rock consisting of angular blocks of lava with a very rough surface [n -S]
AAH⇥2104⇥an interjection expressing surprise [interj] / to exclaim in surprise [v -ED, -ING, -S]
QI⇥542388⇥the vital force that in Chinese thought is inherent in all things [n -S]
```

#### Leave values file

A comma-separated file with two fields per line: `leave,value`. There is one
line per leave, in any order, and at least one leave.

| Field | Rules |
|---|---|
| `leave` | 1–6 tiles of the **lexicon's** letter distribution, in MAGPIE notation, with `?` for a blank. The tiles may be in any order within the field (`SIER?` and `?EIRS` are the same leave) and are stored in canonical order: the distribution's tile order, blank first. No tile may appear more times than the bag holds. No duplicates after canonical ordering. |
| `value` | Decimal number, with an absolute value of at most **1,000,000**. The bound is what keeps the rounding in [Answers](#answers) identical on both sides: at three decimal places the rounded integer still fits in 64 bits, so "written as an integer" has one meaning in Rust and in TypeScript. A larger value is a line error. |

The file does not have to list every possible leave; a leave missing from it
simply cannot be quizzed. The chosen lexicon must not already have leave
values. To change the values of the leaves it already has, use
[Replace values](#replacing-definitions-and-leave-values); to change which
leaves it holds, delete the existing set (allowed only while no cascade uses
it) and upload again.

```
?,28.292000
A,-0.378000
EIRS?,34.117000
```

### Upload limits

Uploads are synchronous. The largest realistic file, around a million leaves, is
expected to validate and insert in well under a minute. Most of that is
compressing it: a lexicon's words and a leave set's leaves are each stored as
one text compressed with zstd at level 19 (see [Schema](#schema)), about ten
seconds for CSW24's 280,887 words and twenty-five for its 914,624 leaves,
which then take 3.8 MB and 3.9 MB where a row for each took 40 MB and 91 MB. Admin upload endpoints
accept request bodies up to 100 MB and have a 120-second timeout, and the ALB
idle timeout is raised to match.

### Immutability and deletion

Catalog data is **immutable once uploaded**. There are no edit endpoints; a
corrected word list is a new lexicon with a new name (`CSW24` → `CSW24-fixed` or
`CSW27`). Immutability is what lets a cascade store only question keys, lets
downloaded answers be cached forever, and makes re-running a stored search always
give the same questions. There are two exceptions, made deliberately:
[a lexicon's definitions and a leave value set's values can be replaced](#replacing-definitions-and-leave-values).

An admin can delete an item only when nothing references it. The foreign keys
enforce this, and the admin page disables the delete button and explains what is
still using the item:

- **A letter distribution** is in use while any lexicon refers to it.
- **A lexicon** is in use while it has leave values, or while any cascade refers
  to it, either as its own lexicon or through an In Lexicon row in the
  cascade's spec. A **saved search's** In Lexicon row does not pin it: a saved
  search records its In Lexicon target by **name**, and when that lexicon is
  deleted the row is flagged on load and refused at creation, exactly as one
  naming a lexicon on another distribution is. A cascade leaves the catalog
  alone within a retention period of being trashed; a saved search can sit for
  years under an owner who never logs in again, and letting it block deletion
  would leave the admin nothing to do but edit user data by hand. If a later
  upload takes the deleted lexicon's name, the saved search resolves to it
  without comment: a name is what the user chose, a re-uploaded name is almost
  always a corrected list, and a corrected list is meant to get a new name in
  any case (see above). The distribution check still flags a mismatch.
- **A lexicon's leave values** are in use while any Leave Value cascade refers
  to them.

#### Replacing definitions and leave values

Two things an answer shows keep being improved after upload, and each
improvement is wanted by the cascades already studying it: a word's
**definition**, and a leave's **value**. Both can be replaced in place, by
the same mechanism. What a question *is* never changes: a lexicon's words and
playabilities, and a set's leaves.

**Definitions.** An admin uploads, at `/admin/lexicons/definitions`, the
lexicon's own file with new definitions:

- **Only definitions may differ.** The file is a [lexicon file](#lexicon-file)
  and is validated as one. It must hold exactly the lexicon's words, in any
  order, each with its stored playability; a word the lexicon lacks, a word
  left out and a changed playability are each reported (by line where the file
  has one) and nothing is stored. A file whose definitions are all the stored
  ones is refused too, as there is nothing to replace. The stored order of the
  words is kept.
- **The lexicon's `definitions_revision` rises by one**, in the transaction
  that stores the new text. Two replacements at once cannot both apply: the
  second finds the revision moved and is asked to upload again.
- **Every instance rebuilds the lexicon's index** on `catalog_changed` (see
  [Loading changes into running servers](#loading-changes-into-running-servers)),
  serving the old one until the new one takes its place. Part of Speech and
  the Definition filter read the new text from then on.
- **Every cascade on the lexicon reaches its devices again.** The same
  transaction gives each such cascade a new `updated_seq` in its account's
  sequence and tells the account's devices, so their next pull brings the
  cascade row with the new `definitions_revision`.
- **A device fetches the answers again.** Each card records the revision it
  was fetched at. A cascade whose cards carry definitions (a Definition
  cascade, and an Anagram cascade showing definitions) and are from an older
  revision has those pages fetched again by the download manager, as it does
  for cards lacking something a setting asks for (see
  [Downloads](#on-the-device)). Until they arrive, and offline, the device
  shows the definitions it has.
- **No old text is ever stored as new.** While an instance still holds the
  older index, it answers `503` with `Retry-After` to a request for cards that
  carry definitions for a cascade whose row names the newer revision; keys,
  and cards without definitions, are served as usual.
- **A cascade keeps its questions.** They are stored as keys, so a cascade
  created with a Definition or Part of Speech filter holds the questions that
  matched when it was created. Duplicate runs the search again and takes
  what matches now.

**Leave values.** An admin uploads, at `/admin/leave-sets/values`, the
lexicon's leave values file with new values. Everything above holds with the
names changed:

- **Only values may differ.** The file is a
  [leave values file](#leave-values-file), validated as one, holding exactly
  the set's leaves in any order (and with a leave's tiles in any order). A
  leave the set lacks or a leave left out is reported and nothing is stored;
  so is a file whose values are all the stored ones.
- **The set's `values_revision` rises by one**, every instance rebuilds the
  set's index, and every Leave Value cascade on the set is given a new
  `updated_seq`, so its row reaches its devices with the new
  `leave_values_revision`.
- **A device fetches a Leave Value cascade's cards again** when they are from
  an older revision, and an instance still holding the older index answers
  `503` to a request for them meanwhile.
- **A cascade keeps its questions**, and this matters more here than for
  definitions: the Leave Value filter is the usual way to build a Leave Value
  cascade, so after a replacement a cascade of "leaves worth 5 or more" may
  hold a leave now worth less and lack one now worth more. Its answers are
  the new values; its questions are the ones chosen at creation: **Duplicate
  cascade** runs the search again and so chooses them again, in a new cascade
  (Start over is another pass of the same questions). The values upload page
  says so.
- **A lexicon still has at most one set.** A different list of leaves is a
  different catalog item: the old set is deleted once no cascade uses it, or
  the lexicon is uploaded again under a new name.

Words, playabilities and the leaves stay immutable: changing any changes what searches
return, which is what a new lexicon name is for.

### Loading changes into running servers

After an upload or deletion commits, the backend runs
`NOTIFY catalog_changed`. Every backend instance `LISTEN`s on that channel and
reconciles its in-memory indexes with the database: it builds indexes for new
items and drops deleted ones. It also reconciles every 60 seconds in case a
notification is missed. Each instance records what it has loaded in
`catalog_instance_status` (one row per instance and item, with a heartbeat
the instance refreshes every 60 seconds), so a new item appears in the
cascade builder once every instance with a heartbeat in the last 3 minutes
has loaded it; until then, the item is marked **loading** in `/admin`, which
lists each instance's rows. An instance writes **no** rows until its startup
load is complete, the moment `/health` turns ready, so a task still booting
during a deploy never makes an item look unloaded, and it deletes an item's
row when it drops that item's index, so a deleted item leaves `/admin` at
once. Rows whose heartbeat is older than 3 minutes are
ignored and pruned by the purge task.

---

## Tiles

Words, alphagrams, leaves, patterns and question keys are all **sequences of
tiles**, not strings of English letters. Tiles follow MAGPIE's letter
distributions.

- **Tile.** Each tile is written as its distribution's `letter`. Usually that
  is one character (`A`, `Ą`, `Ç`), but it can be several (Catalan `NY`, `QU`,
  `L·L`). Length always means number of tiles, so Catalan `ANYS` is 3 tiles.
- **Tile order** is the line order of the distribution file. Alphagrams and
  leaves are sorted in that order, so a blank comes first (`?EIRS`).
- **Alphabetical order** of words, wherever this plan says it (answer lists,
  exports, typed-mode order, rank tie-breaks), means comparing two words tile by
  tile in tile order, with a word that is a prefix of another sorting first. For
  plain A–Z distributions this is ordinary string order; with multi-character
  tiles it differs from Zyzzyva's string order (`L·L` sorts after `L`, not
  between `LA` and `LZ`). Hook lists, on screen and in exports, are in tile
  order, and the answer cards carry them already in that order, so the device
  never sorts them. On screen a hook list is lower-cased only where the tile is
  a single ASCII letter (see [Answers](#answers)); in exports it is always
  upper-case MAGPIE notation.
- **MAGPIE notation** is how tile sequences are written in upload files, stored
  keys and the API. Single-character tiles are written as they are, and
  multi-character tiles in square brackets: `A[NY]S`, `?A[L·L]`. The notation is
  unambiguous. In MAGPIE, lower-case tiles (a tile's `blank_letter`) mean a blank
  standing for that tile. Acrodont never stores them.
- **Display** shows each tile's `letter` without brackets. A multi-character
  tile is drawn as one joined tile, so `ANYS` visibly reads as three tiles.
- **Typed text** in filter inputs, In Word List entries and typed-mode answers
  is converted to tiles in three steps:
  1. Upper-case it.
  2. Treat any bracketed group as a multi-character tile (`A[NY]S`), except in
     pattern inputs.
  3. Split the remaining text at spaces, and match each piece greedily, longest
     tile first, so `ANYS` becomes `A`, `NY`, `S` and `AN YS` becomes `A`,
     `N`, `Y`, `S`. There is no backtracking: a piece that greedy matching
     cannot consume in full is an error ("not a tile of this distribution"),
     even if another split would have worked.

  In pattern inputs, square brackets already mean a set of tiles (see
  [Pattern syntax](#pattern-syntax)). There, multi-character tiles are typed
  plainly or inserted from the tile palette. A **space separates tiles**
  everywhere, and the palette inserts a tile with a space on each side, so a
  palette `N` followed by a typed `Y` stays two tiles. That is how to enter a
  sequence that greedy matching would otherwise join.
- **The canonical form.** The client does the conversion and sends tiles in
  their canonical text form, which is also what is stored and what the server
  parses: MAGPIE notation for tile lists (Includes Letters, prefixes, suffixes,
  word list entries, answers), and for patterns the tokens separated by single
  spaces (`. W * M . S`, `[A NY] L`). The server rejects anything that is not in
  canonical form, so both sides always tokenise the same text the same way. The
  rule covers tile and pattern parameters only: Definition's text is matched as
  typed, and In Lexicon names a lexicon.
- **Blank.** Written, typed and displayed as `?` everywhere: in upload files,
  In Word List entries, Includes Letters and patterns. The single-tile wildcard
  in patterns is `.`, never `?`, so the two never collide.
- **Vowels and point values** come from the distribution, so Number of Vowels,
  Consists of `AEIOU`-style sets, Point Value and probability all work for any
  language.

Words and leaves both use the **lexicon's** letter distribution.

---

## Filters

There are 23 filters: 20 of Zyzzyva's condition types, in the order of its
search dropdown, plus three Acrodont-only filters at the end: **Front Inner
Hook**, **Back Inner Hook** and **Leave Value**. Zyzzyva's Belongs to Group
condition is deliberately left out; the other filters are enough to build any
study list, and its "Inner Hooks" group is what the two inner hook filters
replace. A filter has a type, a Not flag, and parameters, and it is either a
**predicate** or a **limit**:

- A **predicate** tests one candidate on its own. Zyzzyva checks predicates in
  three phases for speed: a word graph walk, then SQL, then post-processing. That
  split is an optimization, not part of their meaning. Acrodont evaluates every
  predicate in memory (see [Search Engine](#search-engine)).
- A **limit** (Limit by Probability Order, Limit by Playability Order) ranks
  the candidates that passed every predicate and keeps a range of that ranking.
  Limits are **always applied last within their group, after that group's
  predicates**, however the rows are ordered (see [Groups](#groups)).

### Groups

Filter rows live in **groups**. A group has an operator, **AND** or **OR**, and
holds rows and other groups in order. The top of the form is a group, AND by
default, so a plain list of rows means what it does in Zyzzyva: every row must
match. For anything else the user wraps rows in a group and picks its operator,
so the precedence is whatever the user builds:

- `Length 7 AND (Includes Q OR Includes Z)`: an AND group at the top holding a
  Length row and an OR group of two Includes Letters rows.
- `(Length 7 AND Probability Order 1–500) OR (Length 8 AND Probability Order
  1–300)`: an OR group at the top holding two AND groups.

The rules:

- **Every group is evaluated over a candidate set.** The top group's
  candidates are the whole target. A child group of an **AND** group gets its
  parent's candidates narrowed by the parent's **predicate rows** (not by its
  sibling groups or by the parent's limits), and a child group of an **OR**
  group gets its parent's candidates unchanged. So a nested group only ever
  sees words its enclosing AND rows already accept.
- **A group's result is a set of candidates.** A predicate row's result is the
  candidates it matches. An AND group intersects its children's results and an
  OR group unions them, once every child has been evaluated.
- **Limits belong to the group they are in.** A group's limit rows rank the
  group's combined result, and the kept slice is what the group passes to its
  parent. A limit at the top ranks the final result, which is Zyzzyva's
  behaviour when there are no groups. Several limit rows of the same kind in
  one group combine as under [Lax](#filter-reference). An OR group's limits
  rank the union of its other children. A group whose children are all limit
  rows ranks every one of its candidates: at the top that is every word of the
  target, which is what `Limit by Probability Order 1–50` on its own means in
  Zyzzyva, and under an AND group it is that group's predicate survivors, so
  `Length 7 AND (Limit 1–50)` means the same as `Length 7, Limit 1–50`.
  Because candidates come from the parent, `Length 7 AND (Includes V AND Limit
  by Probability Order 1–50)` is the 50 most probable 7s with a V, not the 50
  most probable V-words of any length cut down to the 7s.
- **Not** applies to a row, never to a group. A negated group can always be
  written by negating its rows and flipping its operator.
- **Validation.** A search with no rows at all is valid: it is the whole
  lexicon (or, for a Leave Value cascade, the whole leave set), within the cap
  on questions like any other search. A nested group must hold at least one row
  or group. An empty nested group,
  a group nested more than 4 deep, a form with more than 100 rows in total, or
  one with more than **100 groups** counting the top one is an error. The group
  cap matches the column that holds a group's id (see [Schema](#schema)) and is
  a real limit, not a restatement of the row cap: 100 rows each wrapped in their
  own group is 101 groups, legal by every other rule here, and without this check
  it would be refused by a constraint violation on insert rather than by a field
  error on the row that crossed it. Applicability is checked per row, wherever the row sits, and
  errors are keyed by the row's **path**: its child indexes from the top group,
  such as `[1, 0]`.

On the form, each row's `+` adds a row below it at once (another row is what
is wanted nearly every time), every group ends with **Add row** and **Add
group**, which add to its end, a group
is drawn as an indented box with an AND / OR switch in its header, and rows and
groups can be dragged between groups. A saved search stores the whole tree. The
cascade's default name writes groups with parentheses, such as
`CSW24 · Length 7 · (Includes Q or Includes Z)`.

### Pattern syntax

Anagram Match, Pattern Match and Subanagram Match take a pattern made of tiles
plus:

| Token | Meaning |
|---|---|
| `.` | Any single tile. In a Leave Value pattern that includes the blank. |
| `*` | Any number of tiles, including none. More than one `*` in an anagram or subanagram pattern means the same as one. |
| `[ABC]` | Exactly one tile from the set |
| `?` | The blank tile itself (Leave Value quizzes only), exactly as it is written in leave files and leaves |

`.` is the only single-tile wildcard. Zyzzyva uses `?` for it; Acrodont does
not, because `?` is how the blank is written everywhere else, and a leave
pattern needs both.

Input is upper-cased as it is typed and converted to tiles, with multi-character
tiles matched greedily, separated by spaces, or inserted from the tile palette
(see [Tiles](#tiles)). Brackets in a pattern always mean a tile set, never
MAGPIE's multi-character notation, so `[A NY]` and `[ANY]` both mean "`A` or
`NY`" in a Catalan lexicon. A tile that is not in the distribution, an
unbalanced bracket, or an empty bracket fails validation, and so does `?` in
any pattern or tile input (Includes Letters, Consists of, Takes Prefix or
Suffix, In Word List) of an Anagram or Definition cascade, with the message
"use `.` for any single tile", since that is what Zyzzyva users will type.

### Filter reference

Unless a row says otherwise, "word" means the candidate: a word in Anagram and
Definition quizzes, or a leave in Leave Value quizzes. Lengths and counts are in
tiles.

| # | Filter | Parameters | Not | Meaning (as implemented in Zyzzyva) |
|---|---|---|---|---|
| 1 | **Anagram Match** | pattern | ✓ | The word uses exactly the pattern's tiles, in any order. `.` and `[..]` each stand for one tile; `*` allows any number of extra tiles. `ETX.` → EXIT, NEXT, SEXT, TEXT, VEXT. |
| 2 | **Pattern Match** | pattern | ✓ | The word matches the pattern in order, left to right. `T.P` → TAP, TIP, TOP, TUP. `.W*M.S` → SWAMIS, SWAMPS, TWASOMES, … |
| 3 | **Subanagram Match** | pattern | ✓ | Every tile of the word can be taken from the pattern; not every pattern tile has to be used. `LX.` → AL, AX, EL, … LAX, LEX, LOX, LUX. A `*` matches everything. |
| 4 | **Length** | min, max (1–15) | — | The word has min–max tiles. Setting min = max gives an exact length. |
| 5 | **In Lexicon** | lexicon | ✓ | The word is also valid in a second lexicon that uses the **same letter distribution** as the cascade's lexicon; the dropdown lists only those, and any other is a validation error, so tiles are always compared within one distribution. Negated, it finds words that are new or unique compared with that lexicon, e.g. CSW24 words not in CSW21. |
| 6 | **In Word List** | list of words | ✓ | The word appears in a list the user pastes or uploads (one word per line, up to 300,000 entries). **300,000 is the limit for a whole filter tree, not for one row**: several In Word List rows share it, and the row that takes the total past it is a field error naming the total, checked on preview, on save and on creation. That is the figure `API_MAX_BODY_BYTES` and the storage estimate under [Capacity](#deployment-and-operations) are both sized against, and without it eight rows of 250,000 entries would fit in one 16 MB body and cost about 18 MB, nearly seven times the 2.7 MB one list does. The list is saved with the filter, packed into its condition's `entries` (one entry per line, lz4-compressed), and counts toward the account's [storage](#storage-limit) at its bytes plus one an entry (`spec_word`, its line break). Entries that are not valid in the cascade's lexicon are ignored. |
| 7 | **Number of Vowels** | min, max | — | Count of the distribution's vowel tiles is within min–max. |
| 8 | **Includes Letters** | tiles | ✓ | Each tile appears in the word at least as many times as it appears in the parameter (`EE` means two or more Es). Negated, as in Zyzzyva, the word does **not** contain all of them: `Not Includes U` matches words without a U, so `Includes Q` plus `Not Includes U` finds Q-without-U words, while `Not Includes AB` matches words that lack an A or lack a B. To exclude every tile of a set, add one Not row per tile; the row's help text says so. |
| 9 | **Probability Order** | min, max, lax | — | The word's precomputed probability rank among **all words of the same length** in the lexicon is within min–max. Probability always assumes two blanks; there is no blanks parameter. See [Probability](#probability-and-probability-order). |
| 10 | **Limit by Probability Order** | min, max, lax | — | *Limit.* Rank the words that survived every predicate by probability, then keep ranks min–max of that list. Example: `Length 7`, `Includes V`, `Limit 1–50` gives the 50 most probable 7s with a V. |
| 11 | **Playability Order** | min, max, lax | — | The word's precomputed playability rank among all words of the same length is within min–max. |
| 12 | **Limit by Playability Order** | min, max, lax | — | *Limit.* Like Limit by Probability Order, but ranks by playability value. |
| 13 | **Number of Unique Letters** | min, max | — | Count of distinct tiles is within min–max. |
| 14 | **Point Value** | min, max | — | Sum of tile values is within min–max. Tiles count at face value even when a word needs a blank (ZYZZYVA = 43 in English). The maximum allowed is 15 × the distribution's highest tile value, or 6 × for a Leave Value cascade. |
| 15 | **Takes Prefix** | tiles | ✓ | Prefix + word is also a valid word. `PRE` with `VAL*` keeps VALENCE but not VALID. |
| 16 | **Takes Suffix** | tiles | ✓ | Word + suffix is also a valid word. |
| 17 | **Part of Speech** | one of: Adjective, Adverb, Conjunction, Definite Article, Indefinite Article, Interjection, Noun, Preposition, Pronoun, Verb | ✓ | The definition contains that part-of-speech tag in brackets: `[adj`, `[adv`, `[conj`, `[definite_article`, `[indefinite_article`, `[interj`, `[n`, `[prep`, `[pron`, `[v`. Zyzzyva matches `[tag ` (tag, then a space) or `[tag]`, so `[n -S]` and `[n]` are nouns and `[interj]` is not. |
| 18 | **Definition** | text | ✓ | The definition contains the text as a literal, case-insensitive substring. No wildcards. |
| 19 | **Consists of** | tiles, min %, max % | — | `floor(100 × (tiles of the word that are in the set) / length)` is within min–max. Example: `AEIOU`, 70–100 finds words that are at least 70% vowels. |
| 20 | **Number of Anagrams** | min, max | — | The number of valid words with this word's alphagram (including itself) is within min–max. |
| 21 | **Front Inner Hook** *(Acrodont only)* | — | ✓ | The word with its first tile removed is also a valid word: SPORT, because PORT is a word. A one-tile word never has one. Zyzzyva has no condition for this; it is the front half of its "Inner Hooks" group. |
| 22 | **Back Inner Hook** *(Acrodont only)* | — | ✓ | The word with its last tile removed is also a valid word: SPORTS, because SPORT is a word. |
| 23 | **Leave Value** *(Acrodont only)* | min, max (decimals; either may be blank) | — | *Leave Value quizzes only.* The leave's stored value is between min and max, inclusive. A blank bound is open, so `min 10, max blank` means "worth at least 10". At least one bound is required, and min ≤ max when both are given. The comparison uses the full stored value, not the rounded display value. |

Details that are easy to get wrong:

- **Range defaults.** A new integer range row starts at the smallest allowed
  value (0, or 1 for Length and the four order filters, whose ranks are
  1-based) and the maximum allowed value, its **ceiling**:
  15 for Length, Number of Vowels and Number of Unique Letters, 15 × the
  highest tile value for Point Value, 100 for Consists of, and, for Number of
  Anagrams, the **largest `num_anagrams` in the target**, which the
  [index](#derived-attributes) already computes for every word and leave and
  which `GET /api/lexicons` reports as `max_num_anagrams` and
  `max_leave_num_anagrams`, since nothing else would tell the builder where this
  one tops out. For the **four order filters** the ceiling is the largest rank
  a candidate can actually hold: the size of the **largest length bucket**, which
  the same endpoint reports as `max_order_rank` and `max_leave_order_rank`, for
  Probability Order and Playability Order, whose ranks run within a length (or,
  on leaves, within a size), and the whole target's size (`word_count` or
  `leave_count`) for the two **limit**
  filters, which rank the survivors of a group together whatever their length.
  Reading the target's size for all four would put the two predicates' default
  max past any rank that exists, and a row stopping at the largest bucket would
  then never reach the end of the range. On a Leave Value cascade the 15s
  become 6 and
  the Point Value ceiling 6 ×, and the anagram ceiling is the leave set's own
  largest count. **A range that includes everything is valid** — `Length 1–15`,
  a Leave Value cascade's `Length 1–6`, `Probability Order 1–N`: it matches
  every candidate, and a user who wants to study everything may say so. A row
  needs min ≤ max within **that filter's own smallest allowed value** (1 for
  Length and the four order filters) and the ceiling, and a bound above the
  ceiling is a
  field error naming the ceiling, so a saved `Length 4–15` loaded into a Leave
  Value cascade is flagged rather than silently clamped. Leave Value rows start with both
  bounds blank and are invalid until one is filled in. Inner hook rows have no
  parameters.
- **Lax** (the order filters). Every word has a unique rank, plus the lowest and
  highest rank shared by words with the *same* value (`min_order`, `max_order`).
  Ties are broken by alphagram, then by the word. Strict mode compares the
  unique rank. Lax mode matches any word whose tie range overlaps min–max,
  meaning `max_order ≥ min && min_order ≤ max`, so a whole group of tied words
  is taken or left together. Lax is on by default, as in Zyzzyva.
- **Lax for the limit filters**, exactly as Zyzzyva's `WordEngine` does it. The
  survivors are ranked by (value descending, alphagram, word), where the value
  is the word's combinations or playability itself, never its per-length rank,
  so a limit over `Length 7–8` ranks the 7s and 8s together by raw value; the
  [parity list](#zyzzyva-parity) holds that case. Within one group
  the limit rows of one kind are reduced to a strict range and a lax range,
  each the intersection of its rows (highest min, lowest max), a missing one
  being 1…∞. The kept slice starts at the higher of the two mins and ends at
  the lower of the two maxes, and is then widened to include neighbours with an
  equal value, but never past the **strict** min or max. So a lax row alone
  widens freely, a strict row alone never widens, and a strict row caps a lax
  one. If the min is past the last survivor the result is empty.
- **Both limit kinds in one group** each rank the group's predicate result
  **independently**, and the kept set is the **intersection** of the two slices.
  Nothing applies one kind to the other's output, so the answer cannot depend on
  which kind goes first — the same property the same-kind rule above has, where
  row order never decides. `Length 7` with `Limit by Probability Order 1–50` and
  `Limit by Playability Order 1–10` is therefore the 7s that are both among the
  50 most probable and among the 10 most playable, which may be fewer than ten
  and may be none, and not "the 10 most playable of the 50 most probable" or the
  reverse — two readings that give different word lists from the same rows, and
  a cascade keeps only its question index, so the difference would never be
  visible again. Zyzzyva is not the authority here, since it has no comparable
  case, which is why the [parity list](#zyzzyva-parity) holds none.
- **Several rows of one type** in an AND group are simply ANDed. Two Length
  rows intersect; two Includes Letters rows both have to hold. In an OR group
  either may hold.

### Probability and probability order

Following Zyzzyva's `LetterBag::getNumCombinations`, a word's **combinations**
is the number of distinct draws from the bag that spell the word, allowing up to
two of the bag's blanks to stand in. Zyzzyva lets the user choose 0, 1 or 2
blanks; Acrodont always uses 2, Zyzzyva's default, since that is what players
mean by probability. It is the sum of three terms:

- **no blank**: the product over each distinct tile of `C(count in bag, count
  in word)`
- **one blank**: for each distinct tile, `C(blanks in bag, 1)` times the
  product with that tile's count in the word reduced by one
- **two blanks**: for each unordered pair of tile slots (the same tile twice
  when the word holds it at least twice), `C(blanks in bag, 2)` times the
  product with both counts reduced

With no blanks in the distribution, the blank terms are zero. Probability order
ranks all words of a length by combinations, highest first, with ties broken by
alphagram and then word.

### Filter applicability by quiz type

**Anagram quizzes** search over words, then turn the matches into questions:
each distinct alphagram among them is one question. The answer is every valid
word with that alphagram, **including words that did not match the filters**.
The question is "what can these tiles make", not "which of these tiles'
anagrams passed my filters". Limit filters rank words, not alphagrams, the way
Zyzzyva does, and the limited words are then collapsed to alphagrams.

**Definition quizzes** search over words, and each matching word is one
question.

**Leave Value quizzes** search over the **lexicon's leave values**. A leave has
no word-only attributes (validity, definition, playability, hooks), so filters
that depend on those do not apply. Leave probability uses the lexicon's letter
distribution, with the blank treated as an ordinary tile.

| Filter | Anagram | Definition | Leave Value |
|---|---|---|---|
| Anagram / Pattern / Subanagram Match | ✓ | ✓ | ✓ (Pattern Match matches against the alphabetized leave) |
| Length | ✓ | ✓ | ✓ (1–6) |
| In Lexicon | ✓ (same distribution) | ✓ (same distribution) | — |
| In Word List | ✓ | ✓ | ✓ (the list holds leaves; each entry is put in canonical order on input, which is why a type change flags the row) |
| Number of Vowels | ✓ | ✓ | ✓ (the blank is not a vowel) |
| Includes Letters | ✓ | ✓ | ✓ |
| Probability Order / Limit by Probability Order | ✓ | ✓ | ✓ (ranked among leaves of the same size, with the blank as an ordinary tile and no blank substitution) |
| Playability Order / Limit by Playability Order | ✓ | ✓ | — |
| Number of Unique Letters | ✓ | ✓ | ✓ (the blank is one distinct tile) |
| Point Value | ✓ | ✓ | ✓ (a blank is worth 0) |
| Takes Prefix / Takes Suffix | ✓ | ✓ | — |
| Front Inner Hook / Back Inner Hook | ✓ | ✓ | — |
| Part of Speech / Definition | ✓ | ✓ | — |
| Consists of | ✓ | ✓ | ✓ (the blank is an ordinary tile: `?` may be in the set and matches only itself) |
| Number of Anagrams | ✓ | ✓ | ✓ (valid words in the lexicon using exactly the leave's tiles; 0 if the leave contains a blank) |
| Leave Value | — | — | ✓ |

Changing the quiz type on the creation form keeps the filter rows that still
apply and flags the ones that don't, rather than deleting them silently.
Changing the lexicon, or loading a saved search, flags In Lexicon rows whose
target is on another distribution the same way, and loading a saved search also
flags one whose target lexicon has since been deleted, since a saved search
names its target rather than pinning it (see
[Immutability and deletion](#immutability-and-deletion)). **An In Word List row is flagged
on a change to or from Leave Value**, although the filter applies to every type,
because its entries are stored in the canonical form of the type they were
entered under: a leave is sorted into tile order and a word is not, so a list of
leaves read as words, or of words read as leaves, would silently match almost
nothing rather than fail. That holds on **both** paths, which is why
`search_specs` records a `quiz_type`: a change inside the form compares against
the type the form had a moment ago, and **loading a saved search** compares
against the type stored on its spec, since nothing else on the load path could
tell leave-canonical entries from word-canonical ones. The row's editor recounts
on every type or lexicon
change and says how many entries are now invalid, so a list that has become
empty is visible before Create Cascade rather than after.

---

## Architecture

```
Browser
├── Service worker        (caches the app so it loads offline)
├── IndexedDB             (cascades, quizzes, grades, question keys, answers, outbox of operations)
└── Sync engine ──HTTPS──▶ ALB ──▶ ECS Fargate task
                                   ├── nginx      (SvelteKit static build; proxies /api)
                                   └── acrodont   (Axum; in-memory catalog indexes;
                                         │  ▲      cascade rules; sync; purge task)
                                         ▼  │ LISTEN catalog_changed
                                    RDS Postgres  (users, catalog, saved searches,
                                                   cascades, quizzes, grades, sync bookkeeping)
```

- **Postgres is the source of truth** for everything.
- **The backend holds a read-only in-memory index** for each lexicon and each
  leave value set, built from Postgres at startup and kept current through
  `LISTEN/NOTIFY`. Search and answer lookups use these indexes, so no search query
  ever hits the database.
- **The browser is local-first for studying.** The player only ever reads and
  writes IndexedDB. A sync engine sends the user's operations to the server and
  pulls back changes, whether the connection comes and goes or never drops. See
  [Offline and Sync](#offline-and-sync).
- **Cascade rules exist twice**, in Rust on the server and in TypeScript in the
  browser. Both must pass the same shared test vectors (see [Testing](#testing)).

### Tech Stack

| Concern | Decision |
|---|---|
| Language (backend) | Rust (stable toolchain, pinned via `rust-toolchain.toml`) |
| Web framework | Axum |
| DB access | SQLx (compile-checked queries, migrations run at startup) |
| Database | Postgres 16 (RDS in production) |
| Frontend framework | SvelteKit, built as a static SPA with `adapter-static` |
| Styling | Tailwind CSS |
| Component library | shadcn-svelte, dark mode only (Tailwind `darkMode: 'class'` with `dark` always on the root) |
| Offline app shell | SvelteKit service worker (`src/service-worker.ts`) |
| Local storage | IndexedDB via the `idb` wrapper |
| Frontend serving | Nginx container serving the static build and proxying `/api` to the backend |
| Compute | AWS ECS on Fargate Spot: one task of two containers (backend and Nginx), 0.5 vCPU and 2 GiB, in public subnets with no NAT gateway; deployed by Terraform from `scripts/deploy.sh` |
| Load balancer | ALB, HTTPS only (port 80 redirects) |
| Auth | Built in-house: Argon2 password hashes and PASETO v4.local session cookies |
| Email | AWS SES (a `console` backend locally) |
| Rate limiting | `governor` middleware (in-memory token buckets, per backend instance; see [Security](#authentication)) |
| Compression | `tower-http` gzip and brotli for API responses (answer card pages in particular) |
| Secrets | AWS SSM Parameter Store, injected into the task as environment variables; Terraform references them by ARN and never reads their values |
| Infrastructure as code | Terraform (VPC, ALB, ECS, RDS, SES, SSM, backups) |
| Logging | `tracing` with `tracing-subscriber` JSON output to CloudWatch |
| Local development | Docker Compose: Postgres, backend and Nginx frontend, plus an optional Vite dev server profile for hot reload |

Object storage is not needed in v1. Uploaded files are parsed and written
straight into Postgres; the original files are not kept.

### Repository layout

| Path | Contents |
|---|---|
| `backend/` | Axum and SQLx server: auth, admin uploads, catalog indexes, search engine, cascade rules, sync, exports, purge task. `migrations/0001_initial.sql`. |
| `frontend/` | SvelteKit SPA, including `lib/cascade/` (rules), `lib/local/` (IndexedDB), `lib/sync/` (sync engine and downloads) and `lib/export/` (word lists). |
| `contract-fixtures/` | Shared JSON test data: filter types and parameters, cascade rule vectors, shuffle vectors, export fixtures (see [Testing](#testing)). |
| `fixtures/catalog/` | The committed [fixture catalog](#the-fixture-catalog): unlicensed distributions, lexicons and leave values, used by the unit tests, the end-to-end tests and `./scripts/dev.py` alike. |
| `e2e/` | Playwright configuration, `globalSetup` and the [journeys](#the-journeys). |
| `docker/` | Backend Dockerfile (a Rust build, then two targets: `backend`, the server alone, and `ops`, the tools for the backup, drill and ops tasks), the frontend's, and the Nginx configuration. Base images pinned by digest. |
| `infra/` | Terraform. |
| `scripts/` | `stack.py` (the one way to bring a Acrodont up: compose, health, seed, reset, down), `dev.py` (its command line), `scenarios.py` (study states through the API), `scrub.sql` (a production copy made safe locally), `backup.py`, `restore.py` and `drill.py`; the operator scripts (`deploy.sh`, `rollback.sh`, `set-setting.sh`, `prod-sql.sh`, `prod-shell.sh`, `confirm-user.sh`, `init-db-roles.sh`, `rotate-db-password.sh`, `cutover-db.sh`, `onboard-deployer.sh`, `check-alerts.sh`) over `lib/ops.sh`, and their checks (`ops-scripts-check.sh` against stand-ins in `lib/ops_fakes.py`, `runbook-check.sh`, and `backup-check.py`, the backup's S3 paths against a stand-in). |
| `Makefile` | The [test targets](#running-the-tests), each runnable with no arguments. |
| `docker-compose.yml` | Local stack. |

Lexicon data files are licensed (e.g. Collins Scrabble Words © HarperCollins)
and are **never committed**. Admins upload them from files they supply.

---

## Catalog Indexes

### Derived attributes

Postgres stores uploaded data as given. The backend builds each lexicon's
in-memory `LexiconIndex`, computing for every word:

- the word as a tile sequence, `alphagram`, `length`, `num_vowels`,
  `num_unique_letters`, `point_value`, and a letter count vector sized to the
  distribution
- `num_anagrams` (from an alphagram → words map, which also serves Anagram
  answers)
- `front_hooks` and `back_hooks` (for a cascade's Show hooks setting)
- `has_front_inner_hook` and `has_back_inner_hook`: whether the word minus its
  first, or last, tile is in the lexicon
- `combinations` (with two blanks), `probability_order`,
  `min_probability_order` and `max_probability_order`
- `playability_order`, `min_playability_order`, `max_playability_order`
- parsed parts of speech from the definition tags

Each leave value set gets a `LeaveSetIndex` with the same tile-based attributes
for every leave (length, vowels, unique letters, point value, combinations and
probability order within size, anagram count against its lexicon), plus the
value. It also holds the two structures the search's candidate shortcuts need:
per-size buckets, and a lookup from a canonical leave to its entry, which is
what a literal Anagram Match narrows by on leaves where a word search uses the
alphagram map (see [Search Engine](#search-engine)).
Each index also keeps the two figures a filter row's [ceiling](#filter-reference)
needs and nothing else on the device could work out: the **largest
`num_anagrams`** it holds, and the size of its **largest length bucket** (its
largest size bucket for leaves), which is the highest per-length rank a
candidate can have. `GET /api/lexicons` reports both.

Computing these when an index is built, instead of storing them, means there is
only one implementation of each attribute and no derived column can drift from
the inputs. It is also cheap: roughly 280,000 words and about 1 million leaves
take a few seconds of single-core work, which startup and a reload can afford.
If that is measured and turns out to be too slow, the fix is to cache the built
index, not to add columns.

Memory use is on the order of 100 MB per full lexicon including definitions,
plus about 50 MB per full leave value set. The Fargate task is sized for the
catalog offered, and each index's size is logged when it is built and shown in
`/admin`.

**Where those two figures are checked.** Neither the few seconds nor the 100 MB
means anything on [the fixture catalog](#the-fixture-catalog), and licensed data
never reaches CI, so no unit or scale test holds them to a budget. Every index's
build time and resident size are logged when it is built and shown in `/admin`
(on hovering its Storage),
the [parity run](#zyzzyva-parity) records both for a real CSW24 upload and its
leave value set, and the runbook compares the recorded total against the task's
memory reservation before a catalog is offered in production.

`/health` reports ready only once every catalog item in the database has been
indexed at startup. Items that arrive later are built in the background and
never block requests.

---

## Search Engine

`backend/src/search/` is a pure Rust module with no I/O:

```rust
pub struct SearchSpec { pub root: Group }

pub enum GroupOp { And, Or }
pub struct Group { pub op: GroupOp, pub children: Vec<Node> }
pub enum Node { Condition(Condition), Group(Group) }

pub enum ConditionKind {
    AnagramMatch(Pattern), PatternMatch(Pattern), SubanagramMatch(Pattern),
    Length(Range), InLexicon(LexiconId), InWordList(HashSet<TileString>),
    NumVowels(Range), IncludesLetters(TileCounts),
    ProbabilityOrder { range: Range, lax: bool },
    LimitByProbabilityOrder { range: Range, lax: bool },
    PlayabilityOrder { range: Range, lax: bool },
    LimitByPlayabilityOrder { range: Range, lax: bool },
    NumUniqueLetters(Range), PointValue(Range),
    TakesPrefix(TileString), TakesSuffix(TileString),
    PartOfSpeech(Pos), Definition(String),
    ConsistsOf { tiles: TileSet, min_pct: u8, max_pct: u8 },
    NumAnagrams(Range),
    FrontInnerHook, BackInnerHook,
    LeaveValue { min: Option<f64>, max: Option<f64> },
}

pub struct Condition { pub kind: ConditionKind, pub negated: bool }

pub enum Target<'a> { Words(&'a LexiconIndex), Leaves(&'a LeaveSetIndex) }

pub fn search(target: Target, catalog: &Catalog, quiz_type: QuizType,
              spec: &SearchSpec) -> Result<Vec<QuestionKey>, SearchError>;
```

Filter inputs arrive in their [canonical text form](#tiles) and are parsed into
tiles against the target's distribution during validation, so the engine itself
only compares small tile indexes (`u8`).

How a search runs:

1. **Validate** the spec against the quiz type and target: applicability,
   negation allowed, ranges, pattern syntax, tiles present in the distribution,
   and the [group](#groups) rules. It returns every error, keyed by row path,
   so the form can mark each bad row.
2. **Pick candidates.** Words or leaves of the target. If the top group is AND
   and has a Length row, iterate only the per-length buckets inside its range,
   and if it has an Anagram Match that is not negated and holds only literal
   tiles, start from the alphagram map for a word target or the canonical-leave
   lookup for a leave target. These are shortcuts only; the results
   must match a full scan. They are safe whatever the tree holds, because a
   nested group's candidates are already narrowed by the top group's predicate
   rows (see [Groups](#groups)), which is exactly what the shortcut narrows by.
3. **Evaluate the tree.** Each group receives its candidate set as
   [Groups](#groups) defines it and produces a bitset over it. In an AND group
   the predicates are applied to each candidate cheapest first (integer and
   leave value ranges, then tile counts, then patterns, then definition
   substring scans) and stop at the first failure; the survivors are the
   candidates handed to its child groups, whose bitsets are then intersected
   in. In an OR group every child is evaluated over the group's own candidates
   and the bitsets are unioned.
4. **Apply limits** inside each group to that group's result, grouped by kind,
   with lax widening as described in [Filters](#filters), before the result is
   handed to the parent group. Each kind ranks that same result, never the other
   kind's output, and the two slices are intersected, so the order the kinds run
   in is not a decision the engine has to make. The top group's result is the
   search result.
5. **Make questions.** Anagram: dedupe alphagrams. Definition: words.
   Leave Value: canonical leaves. The result is sorted in
   [alphabetical order](#tiles) of the question key. That
   order becomes the cascade's question index (see [Cascades](#cascades)).

Pattern matching:

- **Anagram and Subanagram** compare tile count vectors. `.` and bracket sets
  are matched by a bipartite matching between the word's distinct remaining
  tiles and the pattern's distinct sets, each with its count, grown along
  augmenting paths. A candidate costs at most its length times the number of
  (tile, set) pairs, whatever the pattern holds: a pattern of one set sixty
  times over is answered as fast as one of three.
- **Pattern Match** compiles to an anchored matcher over tile indexes (`.` → any
  one tile, `*` → any run, `[..]` → a tile set, `?` → the blank tile). Compiled patterns are cached
  per request.

The search runs on `tokio::task::spawn_blocking`. A search over a full lexicon
is expected to take tens of milliseconds. That figure stands like the index
sizes in [Catalog Indexes](#derived-attributes): the fixture catalog is too
small to measure it, so the [parity run](#zyzzyva-parity) records the
wall-clock time of every search on its list against a real CSW24 upload, and a
regression shows up there rather than in CI. A `SEARCH_TIMEOUT_MS` budget (default
2 seconds) is checked cooperatively inside the scan, every 4,096 candidates and
before each limit ranking; when it is exceeded the search stops and the request
returns `422` with "search too broad". A blocking task cannot be cancelled from
outside, so the check inside the loop is what stops one broad search.

It does not bound how many searches run at once, and the blocking pool holds far
more threads than the task has cores, so **`SEARCH_CONCURRENCY` (default 2, the
task's vCPU count) is a semaphore taken before `spawn_blocking`**. Without it,
four users at the default `SEARCH_RATE_PER_MINUTE` would each get a fraction of
a core, every search would reach its deadline having done little work, and a
perfectly narrow search would be answered "search too broad" — which sends the
user to narrow a filter that was fine, and which the builder's debounced preview
would then repeat. A request that waits longer than `SEARCH_TIMEOUT_MS` for a
permit is answered `503` with `Retry-After` instead, so a loaded server never
blames the user's filters. The queue stays short, because an admitted search
takes tens of milliseconds.

**Result caps.** A cascade's Source quiz holds at most `MAX_QUIZ_QUESTIONS`
questions, default and ceiling **300,000**. The database enforces the same
ceiling (see [Schema](#schema)), so configuration can lower the cap but not
raise it. A search over the cap is refused with the count, so the user knows
how much to narrow it; results are never silently truncated. For a sense of
scale, the whole of CSW24 (280,887 words) fits, so any Anagram, Definition or
word-list search over a whole lexicon does, but a full English leave value set
(around a million leaves) does not. What fits under the cap is still bounded
by the account's [storage](#storage-limit): the preview reports what the
cascade would hold (`storage_bytes`), and a 300,000-question cascade is about
5 MB as created. Preview returns the count and the first
20 questions.

---

## Cascades

### Questions are stored once per cascade

When a cascade is created, its search results are stored once, in search order,
as the cascade's **question index**: `cascades.question_keys`, one key per line,
a question's `idx` being its line. Every quiz in the cascade refers to questions
by `idx` rather than repeating the key. Every level's questions come from the
Source quiz's questions, so:

- a level costs a few bytes per question: its questions and grades are packed
  in `quiz_cards` chunks of up to 256: a chunk's questions as the differences
  between their idx values (nothing at all in the Source quiz, whose chunks
  hold `0 … n−1` in turn), its grades two bits a question, and one short
  record per graded question for its device, sync sequence and time to the
  second. A chunk with nothing graded stores no grades, and a cleared quiz's
  chunks keep the grades and drop the records
  ([Trash](#trash-restore-and-purge)). A position
  in the attempt is never stored; it comes from the seed
  ([Deterministic shuffles](#deterministic-shuffles)). A view, `quiz_questions`,
  reads the chunks back as one row per question, for tests, scripts and
  support queries
- the answer cards downloaded for the Source quiz cover every level that can ever
  exist in the cascade, including levels created offline

### Deterministic shuffles

Shuffles must come out the same on the device and on the server. A device can
create a level or reset a quiz while offline, and the server has to end up with
the same order the user actually studied. Rather than sending whole orderings,
an operation carries a 64-bit **shuffle seed**, and both sides compute the order
with the same algorithm:

1. Sort the questions being shuffled by `idx`, ascending.
2. Seed **SplitMix64** with the seed: Vigna's reference `splitmix64.c`, where
   each call adds `0x9E3779B97F4A7C15` to the state, then mixes the result
   with `z ^= z >> 30; z *= 0xBF58476D1CE4E5B9; z ^= z >> 27;
   z *= 0x94D049BB133111EB; z ^= z >> 31`, all in 64-bit wrapping arithmetic,
   so the first output follows the first increment.
3. Run **Fisher–Yates** from the last position down to position 1, swapping
   position `i` with `j = next_u64() mod (i + 1)`.

The Rust and TypeScript versions are checked against the same test vectors. The
TypeScript version uses `BigInt` for the 64-bit arithmetic. The Source quiz is
shuffled the same way, with a seed the server generates and returns from
`POST /api/cascades`, so the creating device derives the order without
downloading it. **Every attempt is identified by its seed**: `quizzes` stores
the `shuffle_seed` of the current attempt, positions never travel over the wire
(a pull carries the seed and the device derives the order), and every operation
on an attempt names the seed it was played under, so a grade or cursor from a
different shuffle can be recognised (see [Operations](#operations)).

**Every quiz also carries `questions_hash`**: the FNV-1a 64-bit hash (offset
basis `14695981039346656037`, prime `1099511628211`) of its question indexes
in ascending order, each fed as a little-endian 32-bit integer, computed identically in Rust and TypeScript and fixed by a contract
vector like the shuffles. A quiz's question set never changes, so the server
computes it once at creation and stores it on the row, and every pulled quiz
row and every `finish`, `finish_segment` or `restore_quiz` result carries it.
The device compares its own rows against it whenever a quiz's rows reach the
base by any path (a pull plus index-list fetch, promotion of rows the device
built, or materialisation over retained rows), so a divergent question set is
detected and repaired rather than discovered later as rejected grades.

### Rule implementation

The rules in [Cascade Rules](#cascade-rules) are pure functions, implemented in
`backend/src/cascade/` and `frontend/src/lib/cascade/`:

```
finish(cascade, quiz, grades, shuffle_seed, new_quiz_id) → Outcome
    Finished { cleared: bool, replacement: Option<NewQuiz> }
                                                     // level ≥ 2 only: quiz to the Trash; replacement
                                                     // at the same level, or none (level removed).
                                                     // `cleared` says whether the score met the threshold.
    Descended { reset_seed, new_level: NewQuiz }     // Ladder, or the Source quiz under any progression:
                                                     // quiz reset; new quiz at level + 1
    Completed { reset_seed }                         // Source quiz, no misses: reset in place; the
                                                     // cascade records completed_at
    Reshuffled { reset_seed }                        // nothing correct; reset in place

next_boundary(quiz) → Option<position>               // smallest multiple of the quiz's segment size
                                                     // above its cursor and below its question count.
                                                     // None when the segment size is 0, when it is at or
                                                     // above the question count, or for a segment_chain
                                                     // quiz — so nothing ever divides by the size

finish_segment(cascade, quiz, grades, segment_end, shuffle_seed, new_quiz_id) → SegmentOutcome
    Drilled { new_level: NewQuiz }                   // the run's misses, one level down, segment_chain
    Continued                                        // nothing missed in the run
                                                     // both set cursor and run_start to segment_end

restore_quiz(cascade, quiz, shuffle_seed) → Restored  // pushed as the new deepest level: attempt + 1,
                                                     // cursor, counters and run_start 0, shuffled with seed;
                                                     // options copied afresh from the cascade row, only
                                                     // alphabetical order for a segment_chain quiz
```

- `finish` reads the finishing **quiz's** `progression` to choose between
  `Finished` and `Descended`: the quiz's copy is what Settings edits for the
  level being studied,
  and the cascade's copy only seeds new quizzes. Every quiz these functions
  create takes its
  [options](#quiz-options) from the **cascade** row, except a quiz in a segment
  chain, which is always Drill with no segments. Both sides read the same cascade
  row, so both build the same quiz. A quiz these functions create or restore
  takes `options_device_id` from the operation's device, and `options_seq`
  and `options_changed_at` from the operation, never from the cascade row.
- One `shuffle_seed` in an operation derives every shuffle that operation needs.
  The replacement, new level or restored quiz uses `seed` unchanged, and a reset
  uses `seed ^ 0x9E3779B97F4A7C15`, so a single number keeps both sides in
  agreement. Whichever it is becomes the new attempt's `shuffle_seed`.
- **The completion counters are part of these functions.** Every outcome that
  increases `depth` (`Descended`, `Drilled`, `restore_quiz`) sets
  `cascades.peak_depth = max(peak_depth, depth)` in the same step, so the
  schema's `peak_depth >= depth` holds after a restore into a completed
  cascade as much as after a descent. Every `finish` increments
  `attempts_since_completion`, and `Completed` records `completed_at`, reports
  both counters and then resets them to 1 and 0. Both sides do this inside
  the rule functions, never in the code that calls them.

### Working at 300,000 questions

300,000 is the question ceiling, and every step involving a quiz's full
question set is written for it; the [scale tests](#scale-tests) run there:

- **Creation** stores the question index and the Source quiz in two statements,
  each passing all values as array parameters through `UNNEST`. No per-row round
  trips.
- **Finishing** reads the missed `idx` values (up to 300,000 integers) into Rust,
  shuffles them, and inserts the new quiz through `UNNEST`.
- **Resetting** rewrites positions and clears grades in one `UPDATE … FROM
  UNNEST`. The `(quiz_id, position)` uniqueness constraint is `DEFERRABLE
  INITIALLY DEFERRED`, so rearranging positions mid-statement doesn't collide.
  The statement does not bump the question rows' `updated_seq`; only the quiz
  row is stamped, because other devices rebuild the order from the new seed.
- **Replacing** clears the old quiz before inserting the replacement at the
  same level, in that order within the transaction, because
  `quizzes_one_active_per_level` is a partial unique index, which Postgres
  checks per statement and cannot defer.
- **Answer cards** are downloaded in pages of 10,000, compressed. Anagram cards
  without definitions come to roughly 10–15 MB uncompressed for 300,000
  questions, with definitions considerably more. Definitions and hooks are only
  included when the cascade's settings ask for them, and a later change to
  those settings refetches them (see [Downloads](#on-the-device)).
- **Sync pulls** are paged, so a first sync on a new device never builds one
  enormous response, and they carry neither positions nor index lists: a quiz
  new to the device arrives as one row plus, when its cascade is in the
  request's `question_rows_for`, its graded questions, its index
  list is fetched on demand when the device materialises it (a Source quiz's is
  implied), and a reset arrives as a new seed on the quiz row. A
  300,000-question reset therefore costs other devices one row, not 300,000.
- **Exports** are written in chunks, in a worker on the device and as a stream on
  the server, so a 300,000-question word list never needs the whole file in
  memory at once. With every anagram's words included, such a file is on the
  order of tens of megabytes.
- **Storage**: by the [storage formula](#storage-limit), a question costs
  about 8.8 bytes in the Source quiz and 9.8 in any other level, and its key
  plus one byte in the question index, so a full 300,000-question level is
  about 2.9 MB, and a cascade as created (its Source quiz plus question index)
  about 5 MB.
  This is watched on the database dashboard. The Trash's automatic purge keeps
  cleared quizzes from piling up.

---

## Offline and Sync

### Principles

- **One code path.** The player never talks to the server. It reads and writes
  IndexedDB, and every change it makes is also appended to an **outbox** as an
  operation. Being online just means the outbox empties within a second, so the
  offline case gets exercised every time anyone studies.
- **The server is authoritative.** It validates every operation against the same
  cascade rules. If it rejects one, or other devices have made changes, the
  device's local state is rebuilt from the server's.
- **Operations are safe to repeat.** Each has a device-generated UUID. Sending
  it twice, for example after a timeout, has no further effect.

### What needs a connection

| Needs a connection | Works offline |
|---|---|
| Logging in, registering, password reset | Opening the app, including after a reload or browser restart |
| — | Logging out: the signed-in pointer is cleared at once and the server call is retried later |
| Creating a cascade (search runs on the server) | Studying any downloaded cascade in both answer modes |
| Duplicate (creates a new cascade) | Finishing quizzes: clearing, going down, going back up |
| Saved searches, admin, account changes | Trash: restoring quizzes and cascades (a restored quiz whose rows were dropped is playable once they are fetched), Delete forever |
| Downloading a cascade's answer cards | Changing a cascade's settings (quiz options included), the display settings and controls |
| Exporting answers or definitions the device has not downloaded | Exporting anything the device already has |

### On the device

**App shell.** The service worker precaches the built app (SvelteKit's
`$service-worker` `build` and `files` lists) and answers every navigation **to an
app route** with the cached `index.html`, so `/cascades/:id` loads with no
connection. A navigation whose path begins with `/api/` goes to the network
untouched, as does any request the worker does not recognise as part of the
built app: the server export is a navigation of a hidden frame to
`/api/cascades/:id/export`, and answering it with the shell would download
nothing and boot a second copy of the app inside the frame. It never caches
`/api` responses either; downloaded data lives in IndexedDB instead. **A new
app version installs and waits**, and a plain reload does not activate it: the
browser keeps the old worker while any page it controls is open, a reload does
not release the page it reloads, and the old worker answers that navigation from
its cached `index.html`, so Nginx's `no-cache` never comes into it. The worker
does **not** call `skipWaiting()` on install either, because taking over a running
page would remove the old build's lazily loaded chunks from under a card in
progress. Instead the app watches `registration.waiting`, offers "a new version
is ready", and when the user accepts it — or presses reload in the `426` state —
posts `SKIP_WAITING` to the waiting worker, which calls `skipWaiting()`. The
tab that posted it sets a flag first and reloads on `controllerchange` only when
that flag is set, which is the one reload the user asked for: the event fires in
**every** tab the new worker takes over, and the usual handler that reloads on
it would reload the others on their own initiative, losing a revealed card. Each
other tab shows "Acrodont was updated in another tab — reload to continue" and
keeps running. So that it can, the new worker's `activate` deletes the previous
build's cache only once `clients.matchAll()` finds no page still on that build,
checking again whenever an old tab reports that it is closing, so a tab left on
the old build can still load the chunks the card it is on needs: a request for
a hashed file this build does not have is answered from whichever build's cache
holds it. Each tab says which build it runs (`HELLO`), again to a worker that
takes it over, and nothing is deleted while some open tab has not said: a
worker stopped while idle forgets what it was told. A worker deletes **older**
builds' caches only (a build's version is the time it was made), never a newer
one's, which is the cache of a worker installed and waiting: deleted, that
worker would take over with nothing, answer with the old build's shell, and
show a blank page when the shell asked for a chunk the server no longer has. A
worker that does find its cache gone fetches it again on `activate`, and until
then answers from the network, falling back to another build's copy only with
no connection. The
app never reloads on its own initiative, so a card in progress is never
interrupted by an update, and a user who never accepts keeps the old version
until the `426` line. IndexedDB schema upgrades run from versioned migrations,
and every tab listens for `versionchange` on its connections: the tab still
running the old build closes them and shows "Acrodont was updated in another tab
— reload to continue", so the new build's upgrade is never **blocked** by an
old tab holding the previous version open.

**Installing the app.** The worker lets a closed tab come back with no
connection, but only for someone who can find the site again and whose browser
has kept its data, so the app is installable and asks to keep that data:

- **A web app manifest** (`static/manifest.webmanifest`, linked from `app.html`
  with a theme colour and an `apple-touch-icon`): name, `start_url` `/`,
  `display: standalone`, and icons at 192 and 512 px, a maskable one and an SVG,
  drawn in `static/icons/*.svg` and rendered by `frontend/scripts/icons.mjs`: a
  cream letter tile with a dark A. The browser tab's icon is a cream A on the
  dark ground (`favicon.svg`, with a 32 px `/favicon.ico` for a browser that
  shows no SVG icon).
  Chrome, Edge and Android then offer to install it; on an iPhone or iPad it is
  Share → Add to Home Screen. Installed, it opens from its own icon, with or
  without a connection, straight from the worker's cache. The manifest and icons
  are among the worker's precached `files`. Nginx serves the manifest as
  `application/manifest+json` (the image's `mime.types` has no `.webmanifest`).
- **Keeping the data**: once an account is signed in, the app calls
  `navigator.storage.persist()` (once per page load, after
  `persisted()` says it is not already kept), and again after an accepted
  install. Unasked, a browser may clear a site's IndexedDB and caches when the
  device runs low on space, and Safari clears a site's script-written data after
  seven days of use without a visit to it, unless it is on the Home Screen. Synced
  work comes back with the next download; anything still in the outbox would be
  lost.
- **The header's offline status** (`OfflineStatus`, beside SyncStatus): an icon,
  green when an active worker has the app stored and the browser keeps the data,
  amber when the data is not kept or the browser has no service worker, pulsing
  while the worker installs. Hovering, tapping or clicking it says which, in
  words (`lib/sw/install.ts`), and offers Install where the browser can.
  **On a phone the header is one line**: beside the offline icon the sync
  status is its dot alone while it is Synced, Syncing… or Waiting to sync (a
  tap on the dot shows or hides the word, which floats under the dot so the
  header keeps its one line), and has its words whenever
  something needs attention.
- **Install**: Chrome's and Edge's `beforeinstallprompt` is held back from the
  browser's own mini-infobar and shown as an **Install** button in the header
  (not on a phone, where the header has no room for it) and in the offline status; pressing it opens the
  browser's install dialog. It goes once used or installed (`appinstalled`), and
  is never shown inside the installed app.
- **On an iPhone or iPad**, which never offers to install, a one-time tip under
  the header (`InstallTip`) says "To study with no connection, add Acrodont to
  your Home Screen: tap Share, then Add to Home Screen." Dismiss hides it for
  good on that browser (a `localStorage` flag; with no storage, it shows again
  next visit). It does not show inside the installed app or in the player.

**IndexedDB stores**: one database per user id, so two accounts on one device
never mix, plus one **unscoped** database holding two things: an `accounts`
table with one row per account that has data here, and a single `signed_in`
pointer naming the account signed in now. A row carries that account's id and
username, when it last signed in, **its rows, keys and answer bytes** as its own
drop pass and eviction last measured them, and a flag set while a
`POST /api/auth/logout` for it is still unacknowledged. The pointer is what lets a
reload with no connection open the right data: the user id is needed to find the
per-user database, so it cannot live inside it, and `GET /api/auth/me` needs a
connection. Login inserts or updates that account's row, sets the pointer and
clears the unacknowledged-logout flag on **every** row, its own included,
because the response that signed this account in has already replaced the
session cookie those queued logouts existed to clear;
**every** logout clears the pointer, before
the app navigates away, so the next startup finds no signed-in user and shows the
login page rather than the last account's cascades; and removing an account's
data deletes its per-user database and empties its row, which is then deleted
too unless it still holds an unacknowledged logout (see
[Authentication while offline](#authentication-while-offline)). Everything the
app needs about an account other than the signed-in one is in its row,
so **no per-user database but the signed-in one is ever opened**: opening another
at this app's schema version would run that account's migrations behind its back,
and `indexedDB.databases()` is missing in Safari and Firefox in any case. This
database has its own versioned migrations, like the per-user stores. The per-user
stores are:

| Store | Contents |
|---|---|
| `meta` | user id, username, `device_id` (a UUID made once per device **and user**: it lives in this user-scoped store, so each account on a device syncs as its own device, and its `device_seq` counts from 1 for that account), sync cursor, last sync time, the trash retention period and `max_quiz_questions` as `/api/auth/me` last reported them, the account's [storage](#storage-limit) (`storage_bytes` and `max_storage_bytes`) as `/api/auth/me` or the latest sync response reported it, when this device last opened each cascade (see [Downloads](#on-the-device) for what counts as an open), and the ids the [budget](#on-the-device) pass dropped while they were still inside the window, which are treated as outside it until the user opens them; and this device's own settings: the display settings (`display`) and the [controls](#controls) (`bindings`), which stay on this device unless the user shares one with all their devices, and `shared_device`, the shared values waiting for a sync and when each shared value was last taken (see [This device, or all of them](#this-device-or-all-of-them)). The distribution tiles live in their own store below, not here |
| `distributions` | the tiles (letter, blank letter, value, vowel) of every distribution the user's cascades use, keyed by name. A pulled cascade row carries its `lexicon` and `letter_distribution` names, and the download manager fetches a distribution the store lacks from `GET /api/letter-distributions/:name` before any cascade on it shows **Available offline**; typed mode on a cascade whose distribution is missing shows "needs a connection" like a missing card, since it cannot split typed text into tiles |
| `cascades`, `quizzes`, `quiz_questions`, `quiz_attempts` | the **base**: the server's rows as of the last pull, written only by the sync engine. A base question row also holds its `position`, which the device computes from the quiz's seed in a worker when it builds or rebuilds the quiz, once per attempt; the player keeps the inverse map in memory for the quiz being played. A base quiz row also carries a `pending` flag, set by the staging move and the drop pass on an **active** quiz when its question rows are yet to be fetched and its counters show any grade (an unplayed quiz needs only its index list; a cleared quiz is never flagged, since its rows are fetched only for a restore or an export), and cleared only by the full fetch sequence |
| `overlay_cascades`, `overlay_quizzes`, `overlay_quiz_questions`, `overlay_quiz_attempts` | the **overlay**: only the rows the outbox has changed or created, keyed like the base. The player's view of any row is the overlay's version if there is one, else the base's. It holds a few hundred rows in normal use, never a second copy of a cascade, except for a level created by a `finish` that is still in the outbox, which lives there until the finish is acknowledged, and except during a long offline session, when it holds one row per pending grade until the outbox drains |
| `questions` | the **question keys** of every cascade the device holds rows for, keyed by `(cascade_id, idx)`: the alphagram, word or canonical leave the card shows. Written from the same card pages the answers come from, and **never evicted**, because the key is the question itself; a cascade's keys are dropped only with its question rows, by the drop pass. About 10 bytes per question for an English alphagram, so a 300,000-question cascade costs about 3 MB; a Definition cascade on a distribution with multi-character tiles runs four or five times that, since a 15-tile key in MAGPIE notation is tens of bytes, which is why `ROW_STORAGE_BUDGET` counts this store by measurement rather than trusting the estimate. Bounded by the same window that bounds its rows |
| `cards` | the **answers** per cascade, keyed by `(cascade_id, idx)`, with the definitions and hooks when the cascade's settings asked for them. This is the only store eviction ever touches |
| `staging_cascades`, `staging_quizzes`, `staging_quiz_questions`, `staging_quiz_attempts` | the **staging** stores, mirroring the four base stores: where a pull's rows land when the rebase cannot write them straight to the base (see [The sync cycle](#the-sync-cycle)). Written by the pull, read only by the rebase, and cleared at the start of every pull, so an interrupted one leaves nothing behind |
| `outbox` | operations not yet accepted by the server, in `device_seq` order |

**Schema versions.** The per-user database is at **version 3**. Each migration
upgrades from one version to the next inside the upgrade transaction, and they
run one after another (`upgradeFrom` in `lib/local/db.ts`): a migration that
rewrites rows finishes its rewrites before the next one starts, so two never
walk the same store at once. Version 1 creates the stores; version 2 indexes
what each outbox entry touches, for the rebase's fast path, and gives the
entries already queued theirs; version 3 removes the account preferences that
earlier builds kept: it deletes the `preferences` store, drops any
`set_preferences` entries still in the outbox, and gives each cascade row in
the base, overlay and staging stores the per-cascade [settings](#settings) at
their defaults, keeping any value the row already has, until its next pull
brings the server's.

**Downloads.**
- A cascade starts downloading the moment it is created. That covers the user
  who creates one just before boarding.
- **Creating shows what it is doing.** The builder (and Duplicate) shows a
  screen over the page — finding the questions, then saving them on this device
  with a progress bar — until the player opens. The Source quiz's rows are
  written in chunks in position order, so the row at the last position, which
  witnesses a quiz's whole set, lands last and the quiz never reads as complete
  before it is. A 103,925-question CSW24 cascade: about 4 s on the server and 6 s
  on the device.
- **Downloading never slows the player.** A page is written in chunks of 250
  rows, each its own transaction, and a background chunk waits (up to a
  second) while the player is acting, so an action queues behind one chunk at
  most. While a new cascade's pages are still arriving, the player reads ahead:
  the next 200 cards in its own order, fetched by `idx` in one small request
  whenever fewer than 100 are covered, since a shuffled quiz's consecutive cards
  fall in different 10,000-card pages. Measured in the first minute after
  creating that cascade: Next 20 ms median, 61 ms at worst; a card being
  fetched shows a spinner, never the card before.
- Every cascade **opened or created on this device in the last 14 days** is
  kept downloaded. The window is judged entirely locally: the `meta` store
  records, per device and user, when this device last opened each cascade,
  where an **open** is: navigating to its player, creating it, exporting it,
  or an `applyLocally` of a `grade`, `move_cursor`, `finish`,
  `finish_segment` or `restore_quiz` on it. Trash, purge and options
  operations never extend the window, so trashing a cascade does
  not hold its rows for a fortnight. The
  server-wide `last_activity_at` only orders the Cascades page. So a cascade
  studied daily on the phone takes no question rows and no cards on a tablet
  until the user opens it there, and one created here but studied elsewhere
  leaves this device's window 14 days after its last open here; the Cascades
  page marks every cascade whose question rows this device does not hold
  "not downloaded on this device, open to download", so it can be pulled
  ahead of a flight. A cascade whose active
  quizzes hold more than `AUTO_KEEP_OFFLINE_ROWS` question rows (a constant
  beside the window in `lib/sync/config.ts`, 50,000 by default) is **kept
  automatically** from the moment this device has opened it and learned its
  size, so reopening it never means refetching hundreds of thousands of rows.
  This keep holds against the **14-day window** only. It never holds against
  `ROW_STORAGE_BUDGET` below, which drops automatically kept cascades once
  nothing else is left to drop, and never against the answer limit. Nothing
  shows it and nothing turns it off. The automatic keep is re-evaluated
  from the pulled quiz rows after every pull, so a cascade whose large level
  clears and whose active rows fall below the threshold becomes subject to
  the window again at the next drop pass; its rows come back on open. Cleared
  quizzes do not count toward the threshold, and **a cleared quiz's question
  rows never travel in a pull**, whatever cascade they belong to: the server
  sends question rows only for active quizzes. A cleared quiz keeps whatever
  rows the base already holds, as a quiz cleared on this device does, so its
  Trash export works offline. A restore or an export fetches them from the
  questions and grades endpoints when the base holds none, holds fewer than
  the quiz's `question_count`, holds them without positions, or holds a set
  that fails the `questions_hash` check, so a partial set left by an
  interrupted download can never become a silently incomplete file. Either
  way they are dropped with the cascade like any other rows, and a cleared
  quiz is never flagged pending: a quiz a pull reports cleared has its flag
  cleared, and the fetch above is what makes its rows whole.
- **Question rows follow the same rule.** A pull writes cascade and quiz rows
  for everything and grade rows for every graded question of an active quiz,
  but never a quiz's
  full index list: that comes from
  `GET /api/cascades/:id/quizzes/:quiz_id/questions` (paged, immutable for the
  quiz's life) when the device materialises the quiz. After every pull the
  download manager, judging the window from the `meta` store's last-open times,
  the automatic keep from the pulled quiz rows and the **budget-dropped** ids
  from `meta` too, which count as outside the window however recently they were
  opened (see [the budget](#on-the-device)), fetches the missing index
  lists, then the graded rows of every
  **pending** quiz (always an active one) from the grades endpoint, then the
  missing **question keys** from the card pages with `keys=1`, then the missing
  answers from the same pages in full, for
  cascades inside the window or kept automatically, in a worker, materialising each
  quiz's positions once its list and grades are present, behind the same
  download progress the cards show. Keys come before answers, and before any
  other cascade's answers, because they cost far less and are what makes
  a level playable: a user who creates several cascades and boards a plane gets
  every question and its grading, then the answers as the budget allows. **How
  much less they cost is two different ratios**, and both are worth stating
  exactly: a keys page holds ten times as many rows as a card page, so the
  pass is a **tenth of the requests**, which is what the shared rate bucket
  counts; in bytes it is about a **quarter** of anagram cards without
  definitions, since an alphagram is most of a card whose answer is one word,
  and far less once definitions are included. The request ratio is what makes
  several cascades playable quickly; the byte ratio is why it is worth doing at
  all. A
  quiz's pending mark is cleared only by
  that full sequence (index list, graded rows, positions, hash check),
  whichever of the download manager or a first open runs it; an index list
  alone never clears it. **The grades fetch is checked for completeness too**:
  the hash covers the question set, not the grades, so the device compares the
  graded rows it wrote against the quiz row's `correct_count + missed_count`
  before clearing the flag and fetches again when they differ, since a fetch
  that stopped a page early would otherwise leave the level looking ready with
  the user's answers missing, and the next `finish` rejected `ungraded`. For any other cascade the same sequence runs the first time
  the user opens it on this device, behind a progress bar (the share of the
  level's rows placed), and so needs a connection for whatever it has never
  fetched. **The player waits for that sequence only**: the cascade's keys and
  cards then download in the background at once, while the player fetches the
  cards it shows, and the 200 after each, on demand, as it does for a cascade
  just created. So a cascade of 64,000 questions opens in seconds, not minutes,
  and is studied online until its badge on the Cascades page says "Available
  offline"; going offline before then leaves the cards not yet fetched showing
  "answer needs a connection". A cascade in the
  window or kept automatically opens offline, recomputing positions if needed; if
  its cards are gone the question still shows, from the `questions` store, and
  the reveal shows "answer needs a connection", so grading
  still works, with a typed card falling back to flashcard mode (see
  [Typed mode](#typed-mode-anagram-quizzes-only)). **A card whose key the
  device does not hold either**, which only a download that never finished
  leaves, shows "this question needs a connection" and cannot be graded: the
  three actions move past it and emit nothing, so the attempt cannot be
  finished until the keys arrive, which the ordinary "every question is graded"
  rule already enforces. At the last card of a run, or of the attempt, the
  device therefore emits no `finish_segment` and no `finish`: Show / Next does
  nothing and the player says "some questions in this segment still need a
  connection", with the count, so the user is never left pressing a dead
  control. The ladder marks such a level as still downloading. **Cards record
  which of definitions and hooks they hold.** When a cascade's settings ask
  for something its cards lack, the download manager refetches that
  cascade's cards, as full cards with the flags the settings now ask for,
  on the same schedule as index lists: at once for cascades in the window or
  kept automatically, on first open otherwise, behind the same progress. The
  settings are read from the cascade as the device sees it, overlay included,
  so a change not yet sent already refetches. Cards also record the revision
  of what an admin can replace in them (the lexicon's definitions, or a Leave
  Value cascade's leave values), and a cascade whose cards are from an older
  revision than its row names has them fetched again the same way (see
  [Replacing definitions and leave values](#replacing-definitions-and-leave-values)). Until they
  arrive the player shows the words without the missing part, with one line
  in the answer area saying definitions are downloading, or need a
  connection. No confirmation is asked for the size; the window is already
  the user's opt-in. The download
  manager evaluates the window, and drops what has left it, after every pull;
  a budget-dropped cascade is neither
  fetched nor dropped again, since it already holds nothing. Lists are fetched
  one quiz per call, deepest level first, so the quiz the user will play next
  is ready before the waiting levels above it; new non-source quizzes are rare
  per pull, so no batch endpoint is needed. Grade rows pulled for a quiz in
  the window whose index list has not arrived yet are stored as they arrive
  and get their positions then; for a cascade outside the window, not kept
  automatically and holding no rows here they are not sent at all, since the device
  leaves it out of the sync
  request's `question_rows_for`; a cascade whose rows the drop pass spared for
  its pending operations stays in the list, so its rows never go stale
  (see [The sync cycle](#the-sync-cycle)). A
  device's sync therefore costs time proportional to the graded rows of the
  cascades in its `question_rows_for`, none on a fresh device, and never to
  index lists or positions, so any account's first sync takes seconds, and
  **Available offline** means index lists, positions, question keys and cards
  are all present and no quiz is pending.
- The player shows **Available offline** or download progress. While a download
  is still running and the device is online, the player fetches the pages it
  needs on demand, so studying never waits for a download to finish. **That
  fetch takes priority**: the download manager yields while one is outstanding
  and does not start another page of its own, because both spend the one
  `DOWNLOAD_RATE_PER_MINUTE` bucket and a background download must never be
  what makes the card in front of the user read "answer needs a connection". A
  `429` on either is honoured as [Security](#authentication) describes, so the
  card waits for `Retry-After` rather than falling back.
- Answer data above a 500 MB soft limit is evicted, least recently opened on
  this device first. Only the `cards` store is ever evicted, never the
  `questions` store, never unsynced operations, and never the cards of a
  cascade with pending operations. Keeping the keys is what lets a cascade
  whose answers are gone still be played and exported: the question is local, only the answer is not,
  and a typed card falls back to flashcard mode (see
  [Typed mode](#typed-mode-anagram-quizzes-only)).
  An automatic keep by size protects a cascade's rows from the **window**
  alone, never its cards and never its rows from the budget, so the limit
  still holds; when its cards are evicted the badge shows
  download progress instead of **Available offline**, which is never shown for
  a cascade whose cards are gone — and **"answers need a connection" while the
  device is offline**, since there is no progress to show until the download
  manager can fetch again, and a bar sitting at nothing would read as a stuck
  download rather than as the state the reveal already explains. No page
  lists what the device holds: the Cascades page's badges say, per cascade,
  whether it is on this device, and the budget and answer limit are **per
  user**, so a device several accounts have used can hold several of each.
  An account's data leaves the device by logging out with **Remove this
  account's data from this device** ticked (see
  [Authentication while offline](#authentication-while-offline)).
- **Local size.** A cascade costs one copy of its quiz rows in the base plus the
  overlay's few hundred rows, or, while an offline session's grades are still
  unsent, one overlay row per pending grade: roughly 100–200 bytes per question
  per level in IndexedDB, so a 300,000-question cascade with two levels is on
  the order of 60–120 MB before its question keys and answers, plus about 3 MB
  of keys, and up to half as much again until a
  fully offline attempt has drained. **Cleared levels count too**, since their
  rows stay until the cascade leaves the window, so a Ladder cascade that has
  cleared five 150,000-question levels inside the fortnight holds those rows
  as well; the window is what bounds them, and the automatic keep never
  protects them. The [scale test](#scale-tests) asserts the row count
  and records the bytes. When a cascade leaves the window and is not kept
  automatically, the device drops everything it can fetch or recompute again: every
  quiz's question rows, graded or not, their positions, its question keys and
  its cards, keeping
  only the cascade, quiz and attempt rows; nothing is dropped while the cascade
  has pending operations or its player is open in any tab (each player tab
  holds a Web Lock named for its cascade, and the drop pass skips every
  cascade whose lock `navigator.locks.query()` reports held; where Web Locks
  is missing, only the last-open time protects a cascade and the pass skips
  just the cascade the running tab's own player has open). On the next open the index lists come back from the
  questions endpoint, each active quiz's graded rows for its current attempt
  from `GET /api/cascades/:id/quizzes/:quiz_id/grades`, and the positions from
  the seeds, behind the same progress. The device syncs before that fetch,
  and if the fetched `(attempt, shuffle_seed)` still differ from its quiz
  row's it discards the fetch and syncs again; it never builds positions from
  a fetch that does not match its row. A cleared quiz's rows are fetched only
  when the user restores or exports it, on any device, since no pull carries
  them. On the device, `restore_quiz` on a
  quiz with no local question rows writes the overlay quiz row (attempt + 1,
  the seed, cursor 0) and marks it pending; when the restore is acknowledged,
  step 3 of the rebase promotes nothing for it, and if the device is online
  the download manager runs the full sequence for that one quiz at once (index
  list, graded rows, positions, hash check) together with the cascade's missing
  question keys, so the level is playable when the user opens it;
  offline, its first open fetches its list and grades. The restore was an
  open, so the cascade is in the window and the drop pass leaves those rows
  alone. So the window and the automatic keep bound local storage: the base
  holds question rows only for cascades in the window or kept automatically,
  plus cascade, quiz and attempt rows for the rest.
- **A total budget bounds the rows and keys**, because the window alone does
  not: a hundred cascades of 300,000 questions each, all opened inside a
  fortnight, would be gigabytes, and the 500 MB soft limit governs the
  answers only. `ROW_STORAGE_BUDGET` (2 GB, beside the window in
  `lib/sync/config.ts`) covers the base's question rows, their positions and
  the `questions` store. When the total is over it, the drop pass drops
  cascades in last-opened order, oldest first, until the total is under the
  budget; so a cascade can leave before its 14 days are up, which is the only
  thing that overrides the window. It takes them in **two tiers**: first every
  cascade that is not kept, oldest first, and then the ones kept
  **automatically by size**, oldest first. It never drops one that holds
  pending operations or one with its player open, and nothing else is exempt,
  so the pass gets under the budget unless everything left is one of those.
  The automatic keep has to be in the second tier
  rather than skipped, because the budget exists for a device full of large
  cascades and every cascade large enough to fill it is automatically kept: a
  pass that skipped them could never bring forty 300,000-question cascades
  under 2 GB, which is the case the budget was written for. What the automatic
  keep still buys in that case is order — the small unkept cascades go first,
  and a large one is refetched on its next open only when nothing smaller is
  left to drop.
- **A budget drop is remembered, or it would undo itself.** A cascade the
  budget drops is typically still inside the 14-day window — that is the whole
  point of the budget overriding it: the pass takes the oldest last-open first,
  and on a device that is over budget that can be a cascade opened days ago. The window is judged from the `meta`
  store's last-open times, which a drop does not change, so without a record
  the next pull's download manager would see the cascade in the window and
  refetch its index lists, grades, keys and cards at once, putting the base
  back over the budget for the following pass to drop again — an endless
  drop-and-refetch cycle that would spend `DOWNLOAD_RATE_PER_MINUTE` forever
  and never settle. So the pass **records the id** in the `meta` store (`budget_dropped`), and from then on the
  device treats that cascade exactly as it treats one outside the window: no
  index lists, no graded rows, no keys and no cards are fetched for it, it is
  left out of the sync request's `question_rows_for` (it holds no rows and will
  not be opened by itself), and its quizzes stay pending. **Opening it clears
  the mark**, like any other open: the open refreshes its last-open time, its
  rows come back through the ordinary first-open sequence, and it is a
  candidate for the window and the budget again like any cascade. The
  [quota path](#on-the-device) below runs the same pass and so leaves the same
  mark, which is why its retry does not refetch what it just dropped. The mark
  goes with the cascade's other `meta` entries when a tombstone or a full
  pull's deletion removes it.
- **A quota error is handled, not assumed away.** A `QuotaExceededError` from
  any IndexedDB write aborts that unit of work alone. The device then runs the
  **drop pass** as though `ROW_STORAGE_BUDGET` were exceeded **and then the
  answer eviction** as though the 500 MB limit were, in that order — rows and
  keys first because they are the cheaper thing to fetch again, a tenth of the
  requests answers cost — and retries once. Eviction has to run too: the
  `cards` store is usually the largest thing on the device, and a browser whose
  quota is below the two limits together can be over it with nothing for the
  drop pass to take. What the retry means depends on which write failed:
  - **A pull's per-cascade transaction or a download**: the sync cursor is left
    unadvanced, the staging rows are for the next pull to discard and the outbox
    is untouched (a cascade whose transaction had already committed has had its
    acknowledged operations dropped with it, and no other), so nothing the user
    did is lost and studying continues on what is already local. For a pull the
    retry is the same request made again, which the server answers from its
    records.
  - **An `applyLocally`**: the aborted unit **is** what the user just did. The
    grade, cursor move or finish reached neither the overlay nor the outbox, so
    the player cannot pretend it was saved and cannot advance past the card. It
    stays on that card and shows the storage message where the grade would go
    ("This device is full. Free space by deleting cascades you no longer need,
    or by logging in to another account used here and logging out with its
    data removed.", with **Try again**), and writes the action when the user frees space —
    the one place in the plan where studying stops, because the alternative is a
    Show / Next that silently does nothing.
  If the retry also
  fails, the sync status reads "not enough room on this device". When the
  space belongs to an account that is not signed in, the remedy is to log in
  as it and log out with its data removed, since the drop pass and eviction
  are per user; no page lists the accounts with data here (a list of them
  read as clutter, and on a device used by one person it never helps).
- The app calls `navigator.storage.persist()` on first login. Some browsers,
  notably Safari, can still clear site data after a period of not being used.

### Operations

| Operation | Fields | Server applies it when… | Effect |
|---|---|---|---|
| `grade` | quiz, attempt, attempt seed, question `idx`, grade, at (stored as `graded_at`, as `move_cursor`'s `at` is stored as `cursor_moved_at`; there is no separate `graded_at` field) | the quiz is active, its cascade is not trashed, the attempt and its seed match, the question is in the quiz (else `not found`), and the question is ungraded, or its current grade is from this device, or the device had seen the current grade (`seen_seq`, below), or the operation's `at` is later than the stored `graded_at` | Set the grade and the device that set it, and update counters. A device's own grades apply in `device_seq` order whatever their timestamps; `graded_at` only arbitrates between devices that changed the same question without seeing each other's change |
| `move_cursor` | quiz, attempt, attempt seed, position, at | the quiz is active, its cascade is not trashed, the attempt and its seed match, the position is not below `run_start`, is below `next_boundary(quiz)` when the quiz has one and below the question count otherwise, and the cursor is unset, or was last set by this device, or had been seen by the device (`seen_seq`), or the new `at` is later | Set the cursor, `cursor_moved_at` and the device that moved it. The outbox keeps only the latest pending cursor per quiz, re-appended with a fresh `device_seq` (see [The sync cycle](#the-sync-cycle)). A rejected cursor move (`bad_cursor`) is logged but never counted in a notice; it is not the user's work |
| `finish` | quiz, attempt, attempt seed, shuffle seed, new quiz id | the quiz is active, its cascade is not trashed, it is at the deepest level, the attempt and its seed match, every question is graded, and `new_quiz_id` is not already a quiz (`invalid`) | Apply [Cascade Rules](#cascade-rules) using the server's grades and the quiz's own progression; any new quiz uses the device's id; record the attempt. A reset or new quiz starts at cursor 0, stamped with the operation's `at` and device. The attempt row and any new level are added to the cascade's and the account's [storage](#storage-limit), past the limit or not: studying never fails for storage. The result carries the outcome the server reached and the new quiz's question count and `questions_hash`, so the device can see when the server's grades led somewhere else (see [Conflicts](#conflicts)) |
| `finish_segment` | quiz, attempt, attempt seed, segment end, shuffle seed, new quiz id | the quiz is active, its cascade is not trashed, it is at the deepest level, the attempt and its seed match, its segment size is greater than 0, the segment end is a multiple of it strictly between 0 and the question count and greater than the cursor, every question before the segment end is graded, no quiz already exists for this quiz, attempt and segment end, and `new_quiz_id` is not already a quiz (`invalid`) | Create the drill quiz one level down from the misses in positions `run_start` … segment end − 1 (nothing if there are none), and set the cursor and `run_start` to the segment end, stamping `cursor_moved_at` and `cursor_device_id` from the operation; a drill quiz's level is added to the [storage](#storage-limit) as a finish's is. See [Segments](#segments) |
| `set_cascade_options` | cascade, the changed [settings](#settings) (any of `segment_size`, `progression`, `require_alphabetical`, `clear_threshold`, `answer_mode`, `show_definitions`, `show_hooks`, `reveal_correct`, `show_found_count`, `show_probability`, `definition_column`, `leave_value_decimals`), at | the cascade exists, is neither trashed nor purged, every carried value is in range (segment size 0 or 5 … `MAX_QUIZ_QUESTIONS`, progression one of the two, alphabetical order a flag, clear threshold 1–100, answer mode `flashcard` or `typed`, `show_definitions`, `show_hooks` and `reveal_correct` flags, leave value decimals 0–3; otherwise `invalid`, so an out-of-range value is a rejection and never a constraint violation recorded as `error`), and either its options were last changed by this device (`options_device_id`), or the device had seen its current options (`seen_seq` against `options_seq`), or `at` is later than its `options_changed_at`; otherwise rejected as `stale` | Set the carried fields, `options_changed_at` and `options_device_id`, as one unit. The three quiz options affect only later quizzes; the clear threshold applies at once, to every finish from then on; the other settings apply at once, to what the player shows |
| `set_quiz_options` | quiz, changed option fields (the three quiz options only: a `clear_threshold`, `answer_mode`, `show_definitions`, `show_hooks`, `reveal_correct` or `leave_value_decimals` is a `400`), at | the quiz is active, its cascade is not trashed, every carried value is in range as for `set_cascade_options`, `progression` and `segment_size` are not carried for a `segment_chain` quiz and `progression` is not carried for the Source quiz, which its rules ignore (`invalid`), and either its options were last changed by this device (`options_device_id`), or the device had seen its current options (`seen_seq` against `options_seq`), or `at` is later than its `options_changed_at`; otherwise rejected as `stale` | Set the carried fields, `options_changed_at` and `options_device_id`, as one unit |
| `restore_quiz` | quiz, shuffle seed | the quiz is cleared and not purged | Push it back as the new deepest level with a new attempt shuffled by the seed, cursor 0 stamped from the operation; bring back its cascade if it was trashed, and only then set `cleared_at` to now on its other cleared quizzes |
| `trash_cascade` | cascade | the cascade is not trashed (`trashed`) | Trash it |
| `restore_cascade` | cascade | the cascade is trashed (`not_trashed`) and not purged | Restore it as it was, setting `cleared_at` to now on its cleared quizzes |
| `purge_quiz` | quiz | the quiz is cleared (`not_cleared`) and its cascade is not trashed (`trashed`) | Delete it permanently and record a tombstone; subtract its level and its attempt rows from the cascade's and the account's [storage](#storage-limit), stamping the cascade with this sequence so its new figure is pulled |
| `purge_cascade` | cascade | the cascade is trashed (`not_trashed`) | Delete it and all its quizzes permanently and record tombstones; take its [storage](#storage-limit) off the account's total |

Every operation also carries its `id`, `device_seq`, the device's
timestamp, and `seen_seq`: the device's sync cursor when the operation was
created, or 0 when the device has never synced. `device_id` is sent once per
sync request and applies to every
operation in it; an operation-level `device_id` is a `400`.

**The cursor is the position of the card being shown.** Show / Next on the
card at position `p` saves its grade and emits `move_cursor` to `p + 1`, and
Previous emits `move_cursor` to `p − 1`, never below `run_start`. From the last
card of a run that is not the last run the device emits the card's `grade` and
then only `finish_segment`, and from the last card of the attempt the card's
`grade` and then only `finish`, with no cursor move; those two are the only
operations that move the cursor onto or past a run boundary, and neither leaves
it at the question count. So the cursor is always below the question count, a
device that follows this never has a cursor move rejected, and the rail's
`37 / 250` is the cursor plus one.

**`seen_seq` decides what "latest" means.** A pull delivers every row with
`updated_seq` up to the device's cursor, so `seen_seq` says exactly which version
of a row the device had in front of it. When a grade, cursor move or options
change arrives for a row whose `updated_seq` is at most the
operation's `seen_seq`, the device saw the current value and changed it
knowingly, and the change applies whatever the timestamps say. Only when the row
has moved on since the device last pulled, the true concurrent case, does the
server fall back to comparing timestamps. Device clocks therefore never decide
between a change and the change a user made after seeing it. For grades the
comparison is against the question row's `updated_seq`, which moves only when
the grade does. For options it is against the cascade or quiz row's
`options_seq`, the sequence of its last options change, because those rows'
`updated_seq` also moves with every grade counter and cursor move and would
make the rule fall back to timestamps far too often.

**Device clocks are clamped.** Wherever a timestamp is compared or stored for
these rules (`graded_at`, `cursor_moved_at`, `options_changed_at`,
and `finished_at`, which is clamped
although nothing compares it), the server uses
`least(at, now() + 5 minutes)`, so a device whose clock is a year ahead can
win a concurrent comparison by at most five minutes and its later changes
lose to real later ones. The operation itself is still applied; only the
timestamp is capped. A clock that is behind is left alone, since an offline
device's timestamps are legitimately old. **A device's own changes never
compete on timestamps**: grades, cursor moves and options each
record the device that last changed them, and a later change
from that same device applies in `device_seq` order whatever its `at`, so
two option changes from a fast clock in one batch are both applied rather
than the second losing to the first's clamped stamp.

**Rejection reasons are a fixed vocabulary**, because monitoring counts them:
`not_found` (the target belongs to another user, was purged, **never existed** —
the quiz an operation rejected earlier in the same batch was to create — or names
a question not in the quiz; which of those it was decides the notice, see
[Conflicts](#conflicts)), `trashed`, `not_active` (the quiz is cleared), `not_deepest`,
`stale_attempt` (attempt number or seed mismatch), `ungraded`, `bad_segment` (no
segment size, not a multiple, not past the cursor, or past the end),
`duplicate_segment`, `stale` (a grade, cursor move or options
change that lost the `seen_seq` and timestamp comparison to another device's),
`not_cleared` (restore or purge of a quiz that is not cleared), `not_trashed`
(restore or purge of a cascade that is not trashed), `bad_cursor`
(below `run_start`, or at or past the next boundary or the question count),
`invalid` (a malformed operation, including a `seen_seq` above the user's
`sync_seq`) and `error` (a database error that is not transient, such as a
constraint violation, inside the operation's savepoint; see
[The sync cycle](#the-sync-cycle)). Each condition in the table maps to one of
these. A rejection with reason `error` is handled on the device like any other
rejection, and when it is a `finish` or `finish_segment` the notice's first
sentence is "Level N could not be saved on the server."; `invalid` on one of
those takes the same sentence; `error` or `invalid` on a `restore_quiz` reads
"This quiz could not be restored on the server."; and `error` on a grade takes
the grade sentence under [Conflicts](#conflicts).

**The attempt seed is what ties operations together.** A `grade`, `move_cursor`,
`finish` or `finish_segment` names the `shuffle_seed` of the attempt it was
played under. Two devices can both produce "attempt 4" of the same quiz, each
from its own finish or restore, but never with the same seed, so the server
rejects an operation from the losing device's attempt as `stale_attempt`
instead of applying its grades to a different shuffle. On the device the same
rule defines "depends on": during the replay after a pull, an outbox operation
is dropped when its `(quiz, attempt seed)` is held neither by the base nor by an
earlier operation replayed in the same pass, and likewise an operation on a quiz
that neither the base nor an earlier replayed operation created. The check is
made in replay order, never as a filter against the base alone, because a
`finish` still waiting in the outbox legitimately owns the attempt seeds of the
grades queued behind it. The dropped grades are what the notices count.

**A trashed cascade is frozen.** Every operation on it or on its quizzes other
than `restore_cascade`, `restore_quiz` and `purge_cascade` is rejected with the
reason `trashed`; that includes `purge_quiz`, since a trashed cascade is purged
as one unit. The player does not open a trashed cascade; it shows the
ladder as it was and offers **Restore**.

### The sync cycle

`POST /api/sync` does a **push** and then a **pull**, in one request.

**Push.** The request itself is checked before anything is locked or applied: a
body carrying more than `SYNC_MAX_OPS` operations, a `page_token` together with
any operations, a `question_rows_for` naming more than `MAX_QUESTION_ROWS_FOR`
(1,000) cascades, a
non-numeric `app_version`, or an operation-level `device_id` is a `400` with
nothing written. An operation whose `device_seq` is below 1, or already recorded
for this device under a different `id`, is rejected `invalid` like any other
malformed operation, so a device bug never reaches the
`(user_id, device_id, device_seq)` constraint and is never recorded as `error`,
which alarms. Then:
1. The server locks the user row and takes a new value of the user's sync
   sequence: `UPDATE users SET sync_seq = sync_seq + 1 RETURNING sync_seq`. The
   lock also means two syncs for the same user never run concurrently. Every row
   this request changes is stamped with that value.
2. Operations are applied in `device_seq` order, one savepoint each. An
   operation whose `id` has already been recorded **for this user** returns its
   recorded result without being applied again, the same result in every field,
   so a `finish` whose first response was lost is acknowledged on its second
   send with the same outcome, count and hash and promotes its rows exactly as
   it would have the first time; an `id` recorded for another
   user is rejected as `not found`. **Records are kept only as long as a resend
   could need them.** A device drops a batch from its outbox only after it has
   received that batch's response, and sends in `device_seq` order, so the
   lowest `device_seq` in a request proves that every earlier operation of that
   device was acknowledged. The server keeps that figure per device in
   `sync_devices.acked_below`, raising it with each request that carries
   operations (a retried batch after a lost response starts at the same
   `device_seq`, so it raises nothing). In the same transaction it deletes that
   device's records **below the mark whose operations return no result
   fields** — every kind but `finish`, `finish_segment` and `restore_quiz`, for
   which a repeat needs only "applied" or the rejection's reason. The three
   result-bearing kinds are kept for `SYNC_RETENTION_DAYS`, since their
   outcome, count and hash must come back unchanged, and there are a few per
   attempt. An operation that arrives **below its device's mark with no
   record** — only a stale resend can, from a second tab that read the outbox
   before the rebase dropped it where Web Locks are missing — is answered
   `applied` and **not applied again**, so a replayed grade can never overwrite
   the newer grade the same device made after it. Records past
   `SYNC_RETENTION_DAYS` go too, so an operation older than that, which only a
   device offline that long can resend, is applied afresh; that is almost
   always a `stale_attempt` or `not_cleared` rejection, and such a device is
   also past the `426` line, so it reloads before it resends.
3. Each operation is recorded as `applied` or `rejected`, with a reason and,
   for a `finish` or `finish_segment`, its `outcome`, and for those and a
   `restore_quiz` its `new_quiz_question_count` and
   `new_quiz_questions_hash`. One
   rejection does not stop the rest of the batch.
4. A savepoint that fails with a database error is rolled back. A **transient**
   error (serialization failure, deadlock detected, lock or statement timeout,
   lost connection) aborts the whole request with `503` and `Retry-After` and
   records nothing, so the device sends the same batch again and every
   operation is applied then. Any **other** database error, such as a
   constraint violation from a rules bug, records that one operation as
   `rejected` with reason `error`, logs the operation in full, and the batch
   continues. `error` should never occur, so monitoring alarms on any.

**Pull.**
1. The server returns every row belonging to the user with `updated_seq` greater
   than the device's cursor and at most the sequence this request's push took,
   in this table order: cascades, quizzes, quiz attempts, quiz questions,
   then tombstones for purged items, so a quiz row
   always precedes its questions. A quiz question row is sent exactly when its
   `updated_seq` is past the cursor, **it is graded, its quiz is active, and
   its cascade is in the request's `question_rows_for`** (the cascades in the
   device's window and not budget-dropped, kept automatically, or whose base holds
   question rows; with an
   empty list a pull carries no
   question rows at all, and the quizzes left out stay pending on the device;
   a cleared quiz's rows never travel, see [Downloads](#on-the-device)); a quiz's full index
   list never travels in a pull, however new the quiz is (the device fetches it
   on demand, see [Downloads](#on-the-device), and a Source quiz's is implied).
   A row carries only the question index and grade; positions are never sent,
   because the device derives them from the quiz's `shuffle_seed`.
   Within a table rows are ordered by primary key, and a page runs up to
   **50,000 rows of any kind**, counting cascades, quizzes, attempts, question
   rows and tombstones alike, with an opaque page token that encodes the table
   and the primary key it stopped at, the
   request's `question_rows_for`, and **the sequence the first page's push
   took**, which every later page uses as its ceiling. Bounding the total
   rather than the question rows alone is what keeps a pull that carries no
   question rows in hand: a cleared quiz's rows never travel, so an attempt
   studied with a segment size of 5 on a 300,000-question quiz can leave
   60,000 chain quizzes in the Trash (see [Quiz options](#quiz-options)) and,
   a retention period later, 60,000 tombstones, each of which a question-row
   bound would have delivered as one unpaged response. Tables are still sent
   in their order, so `quizzes` is exhausted before `quiz_questions` begins
   and a quiz row still precedes its own question rows however the pages
   fall. A
   request with a page token carries no operations and takes no new sequence,
   and the token's list stands for the rest of the pull; a page
   request's own list is ignored. Fixing the ceiling in the token is what
   makes a paged pull one snapshot.
2. When the last page arrives, the device's cursor is set to the sync sequence
   the push took. Rows another device commits between two pages have a higher
   sequence and arrive on the next sync. **Every response, paged or not, also
   carries `storage: { used, limit }`**, the account's
   [storage](#storage-limit) read after the push, and the device writes it into
   `meta.server` (as `storage_bytes` and `max_storage_bytes`), so a finish that
   took the account over its limit shows on the Cascades page with the sync
   that applied it. Each pulled cascade row carries its own `storage_bytes`;
   the device never counts a cascade's figure itself.
3. If the device's cursor is below the user's `sync_floor_seq` (the highest
   tombstone sequence the purge task has pruned; tombstones are pruned after
   30 days), the server replies `resync_required`; a cursor at or above the
   floor has missed no pruned tombstone, even when older tombstones remain
   above the floor. That response carries the `results` of the push that
   arrived with it and no `changes`. The device does nothing with those
   results: it keeps the batch in its outbox and makes a **full pull** that
   sends the same batch again, which the server answers from its records
   (step 2), so the operations are acknowledged in the response that carries
   their rows. Acknowledging them from the `resync_required` response, with
   nothing pulled, would clear the device's own rows for a level one of them
   created before the server's rows had arrived, and the operations queued on
   that level would then be refused in the replay and lost. A full pull is a
   sync request with
   `cursor: null`, pushed exactly like any other sync (it may carry
   operations, and usually does on a first sync, since a device can create a
   cascade and study it before it has ever synced), which the server answers
   with every row of the user that still exists, trashed cascades and cleared
   quizzes included, in the usual pages and with no tombstones, and to which
   it never answers `resync_required`. On the last page the device applies the pull
   exactly as steps 2 to 5 below, with one addition: every base row of a
   cascade, quiz, attempt or graded question that the full pull did not carry
   **and whose `updated_seq` is at most the sequence the full pull took** is
   deleted, which is what tombstones would have done. **Every base row carries
   the sequence of the response that wrote it** — a pull's `sync_seq`, a
   promotion's, a creation's, or, for rows fetched from the questions or
   grades endpoints, that of the sync the device made first — which is what
   this comparison reads, because a question row's own `updated_seq` is never
   sent. So rows an earlier pull wrote carry a lower sequence and go, while a
   cascade the device
   created through `POST /api/cascades` while the pull was in flight carries a
   higher sequence and is left alone. A cascade the deletion removes loses its
   `questions` and `cards` entries in the same transaction as its rows, as a
   tombstone does, since nothing else would ever reclaim them: the drop pass
   only sees cascades the base still holds, and eviction orders answers by a
   last-open time an orphan has none of. The same transaction also removes that
   cascade's entries from the `meta` store — its last-open time and its
   budget-dropped mark — since nothing else ever
   would, and the device's sizes would otherwise count a cascade that no
   longer exists. The deletion of graded question rows
   applies only to the **active** quizzes of cascades in the request's
   `question_rows_for`, since the pull carries no row for a cleared quiz and
   none for a cascade left out of the list, which by definition holds no rows
   to delete; the drop pass governs every other cascade's rows. Nothing else is
   discarded: the ungraded question rows and positions of a quiz whose
   `(attempt, shuffle_seed)` is unchanged are kept, as after any pull, so a
   resync never refetches an index list or recomputes an order it already
   has. The device then sets its cursor to the sequence that request took,
   lowers every pending operation's `seen_seq` to that cursor where it is
   higher, and its outbox survives. A device that has never
   synced sends `cursor: null` on its first sync for the same reason: a
   cursor of 0 on an account whose tombstones have been pruned is below the
   floor, and would otherwise be told to resync forever. A cursor **above** the user's
   `sync_seq`, which only a database restored to an earlier point can produce,
   gets the same reply before any operation is applied, so nothing is rejected
   as `invalid` for a `seen_seq` the server no longer recognises; the
   [restore procedure](#restoring) makes this case unreachable in practice.

**Applying a pull on the device** works like a rebase, run once after the last
page of the pull has arrived. Pages are written as they come, to one of two
places. Question rows go straight to the base when the player could not be
using an order they might disturb: for a quiz in the window or kept automatically
whose `pending` flag is not set (the grades endpoint brings a pending quiz
everything it needs, so nothing is written for it here), grade rows for an
unchanged attempt of a quiz that is also not flagged pending, and every row of
a quiz that has no base row at all (new to
the device, so no positions exist yet). Everything else
(cascade rows, quiz rows, attempt rows, tombstones, and the
question rows of a quiz whose base row exists with a different
`(attempt, shuffle_seed)`) goes to a **staging** store. So the bulk of a large
pull, on a new device as on an old one, is written once. Positions for every quiz
that needs a rebuild are computed from the staging rows in a worker first,
outside any transaction; then, per cascade, one IndexedDB transaction moves
the staging rows and their positions into the base, deletes and promotes
overlay rows, and replays the outbox (steps 2 to 4 below). The move judges
the window from the `meta` store's last-open times and its budget-dropped ids,
and the automatic keep from
the **pulled** quiz rows, never the base's, and sets the `pending` flag on the
active quizzes of a cascade the device left out of `question_rows_for`, whose
question rows the pull therefore did not carry, **and whose rows the base does
not hold**; a quiz whose rows are complete is never flagged, since the cascade
it belongs to was in the list and its rows arrived. The player reads only base and
overlay, never staging, so it never sees a quiz row from one page beside
positions from an older attempt. An interrupted pull, or a browser closed
between two cascades' transactions, leaves the cursor unadvanced and staging
rows the next pull discards, and re-pulling from the old cursor converges:
1. Drop every outbox operation the server has now acknowledged, whether applied
   or rejected, and note which cascades they touched. **Each cascade's are
   dropped inside that cascade's transaction** (steps 2 to 4), never ahead of
   it: what an acknowledged `finish` created is known only from its result, so
   an operation that left the outbox before its cascade's rows were applied
   would, after a closed tab, leave the next pull unable to tell that the level
   was made here, and the answers queued on that level would be refused in the
   replay. A cascade whose transaction did not commit still holds its
   operations, the next sync sends them again, and the server answers them
   from its records.
2. Write the server's rows into the **base** stores. Two different things can
   follow. A **rebuild** happens when a pulled quiz's `(attempt, shuffle_seed)`
   differs from the base's, or the base does not have the quiz: its question
   rows are created or reset, grades cleared, positions computed from the seed
   in a worker, and the pulled grades applied on top. A quiz whose `pending`
   flag is set stays pending whatever rows the base holds, and the cases below
   apply only to quizzes without the flag. When the attempt and seed
   match, what happens depends on what the base holds: rows with positions
   need nothing; rows without positions (a quiz whose index list has just
   arrived) get a **materialisation**, which computes positions over the
   existing rows and touches nothing else, so retained grades survive; and no
   rows at all leave the quiz **pending**, unless its pulled row shows
   `correct_count + missed_count = 0`, in which case only the index list is
   needed and no grades fetch is made. Otherwise (a cascade whose rows the
   drop pass removed, or one the staging move skipped) its `pending` flag is
   set: on first
   open, or in the download manager's post-pull sequence when the cascade is
   in the window, the device syncs,
   fetches the index list, then the quiz's graded rows from the grades
   endpoint, computes positions and hash-checks, as
   [Downloads](#on-the-device) describes. A pull's grade rows for a pending
   quiz are never used to rebuild it. A rebuild or materialisation runs only once the quiz's rows are complete: at once
   for a Source quiz, whose rows are idx 0 … count − 1 and are created locally;
   for any other quiz once its index list has been fetched, or at once when its
   graded rows already number `question_count`; and at the last page of the pull for
   a reset, which sends only the rows graded since. A quiz the pull reports
   as cleared takes neither path, and its `pending` flag is cleared if it was
   set: whatever rows
   and positions the base holds for it stay as they are until the cascade
   leaves the window, so a level finished on this device can still be exported
   from the Trash offline, and a device holding none of its rows, or only part
   of them, fetches them when a restore or an export needs them (see
   [Downloads](#on-the-device)). A level that **one batch both made and
   cleared** has no rows in the base yet, and a cleared quiz's rows never
   travel: its rows are the device's own, promoted in step 3 on their hash
   like any created quiz's. Deleted with the overlay instead, they would leave
   a restore of that level still waiting in the outbox with nothing to reset,
   and every answer given after the restore would be refused in the replay.
   So the player never sees a
   quiz with a new order and no grades. A quiz that an operation applied in
   this batch created or reset takes neither path here **when the pulled quiz
   row's `(attempt, shuffle_seed)` equals that of the rows the device built
   for it in the overlay**: its rows arrive by promotion in step 3, and it
   counts as complete once they have. When they differ, because the server's
   outcome did something else to the finished quiz than the device did (the
   device cleared it and the server reset it, or the reverse), the quiz takes
   the ordinary path above like any pulled quiz whose seed differs from the
   base's or whose grades the base already holds in full. After any
   rebuild, materialisation or promotion the device hashes its rows and
   compares the result with the quiz row's `questions_hash`; a mismatch on the
   quiz being played is handled like an outcome mismatch (rebase, refetch,
   notice), and on any other quiz by refetching the index list. For a cascade
   outside the download window the work is recorded as pending and done on
   first open instead (see [Downloads](#on-the-device)).
3. Delete the **overlay** rows of every cascade that an acknowledged operation
   or the pull touched, with one exception: the question rows and positions the
   device built for a quiz that an **applied** `finish`, `finish_segment` or
   `restore_quiz` created or reset are moved into the base rather than deleted.
   For a quiz the operation **reset or restored**, the condition is the one
   step 2 used: the pulled quiz row's `(attempt, shuffle_seed)` equals the
   device's rows' (its question set is fixed for life, so its hash needs no
   check). For a quiz the operation **created**, the pulled quiz row must
   exist and the result's `new_quiz_questions_hash` must equal the hash of the
   device's rows, which it does whenever the server built the quiz from the
   same grades; a matching count is not enough, since two miss sets of the
   same size can differ. So a finish never ends with a fetch, and an offline
   finish's new level is playable the moment it is acknowledged. Promoted rows
   are stamped with the response's `sync_seq`, like the quiz row they belong
   to, so a full pull in flight never deletes them. **A promoted row takes
   the device's question and the server's grade and place**: the overlay's
   rows also show what the operations still waiting in the outbox did to the
   quiz, and the base is the server's. So a promoted row carries a grade only
   when an applied `grade` of this batch, or the pull itself, gave it one, and
   the replay in step 4 puts the waiting grades back and counts each. Promoted
   with a waiting grade already on it, the row would add nothing to the quiz
   row's counters in the replay, and the level's own `finish`, queued behind,
   would be refused `ungraded` and dropped with everything studied after it —
   which is every offline session whose 500-operation batch boundary falls
   between the finish that made a level and that level's finish. For the same
   reason a **created** quiz is promoted on its question hash alone: when a
   `finish` still waiting has since given the overlay a later attempt of it,
   the rows are the right questions in another order, and they are placed by
   the pulled row's seed. When the
   hashes differ, the rows are dropped, the index list fetched, and the
   outcome-mismatch notice shown, since grades on the missing questions were
   not kept. When the server's outcome carries no new quiz at all (a
   `finish_segment` the device computed as `drilled` that the server applied as
   `continued`, or a `finish` the server answered `cleared` with no misses,
   `completed` or `reshuffled`), the device's rows are dropped
   with no fetch, since there is nothing to fetch, and the notice is shown.
   Anything else that existed only in the overlay, such as
   a quiz created by a `finish` the server rejected, disappears here, and rows
   the server has now confirmed are read from the base from now on.
4. Replay the operations still waiting in the outbox into the overlay, in
   `device_seq` order, using the same cascade rules. An operation is dropped and reported (see below) when its
   attempt seed or quiz is held neither by the base nor by an earlier operation
   in this replay, or when it no longer applies. A replay drop takes the
   reason the rules would have given on the server, since the replay runs the
   same checks, and every operation dropped for one cause makes one notice,
   counted together. Steps 2 to 4 run in one
   IndexedDB transaction per cascade that includes the outbox store, and the
   operations to replay are read inside it, so the player never observes an
   empty overlay, and an `applyLocally` from another tab during the rebase
   waits for it and then lands on the rebuilt overlay.

   **The fast path.** For a cascade where every acknowledged operation was
   applied, none of them created, reset or restored a quiz, and **every pulled
   row of that cascade carries `updated_seq` equal to the response's
   `sync_seq`**, the sequence this push took — read from that column on its
   cascade, quiz and attempt rows, and from each question group's
   `min_updated_seq`, folded across every page of the pull, on its question
   rows, since a question row's own
   `updated_seq` never travels — steps 3 and 4 reduce to deleting
   the overlay rows that no remaining outbox operation touches: every other
   overlay row already reflects the pending operations in order, and nothing
   that could change their outcome has arrived. A row another device changed
   that this push then stamped again passes that test, and that is harmless:
   any pending operation that conflicted with the foreign change was rejected,
   which forces the full path, and one that did not conflict still applies as
   the overlay shows it. A row stamped by another device alone carries a lower
   sequence and forces the full path, and a tombstone for a quiz or cascade
   counts as a pulled row of that cascade for this test, with its `seq` as the
   sequence. A pending `finish` at the end of the outbox is not re-validated on
   such a batch; it is when the full path next runs. This is what keeps a
   large offline session's drain linear: each of the 600 batches of a
   300,000-grade attempt deletes its own 500 overlay rows instead of clearing
   and replaying the other 299,500. The full path runs for any other batch: a
   rejection, a created or reset quiz, or a row from another device.
5. Refresh the player if what it was showing changed.

**When the device syncs:**
- half a second after a new operation, if online, and no more than once a
  second while operations keep arriving, which keeps a fast session under
  `SYNC_RATE_PER_MINUTE`
- on the browser's `online` event
- when the tab becomes visible again
- every 30 seconds while the app is open
- **when the server says another device changed something** (below)
- right after logging in
- and, while the outbox still holds more than one batch, again as soon as the
  previous response arrives, subject to `429` backoff, so a long offline
  session drains in minutes rather than one batch per interval

Pushes are sent in batches of up to 500 operations. A batch with a large
`finish` still fits easily, because shuffle seeds replace orderings. The outbox
keeps only the latest pending `move_cursor` per quiz: a new one removes the
pending one and is appended with a fresh `device_seq`, never written into the
old slot, so it can never overtake a `finish_segment` queued after the old one.
`device_seq` therefore has gaps, which the server allows; only the order
matters. So a 300,000-question
attempt studied offline is about 300,000 operations, or 600 requests, and the
per-user sync rate limit (`SYNC_RATE_PER_MINUTE`) is set so that drains in
minutes, not hours, and the rebase's fast path (above) keeps each
acknowledgement's work proportional to its own batch; the
[scale test](#scale-tests) asserts the budget. `429`
backoff applies to sync like any other request, and so does `503`: the device
resends the same batch after `Retry-After`, and nothing is dropped, because
nothing was recorded.

#### Telling the other devices

Studying on a phone with the desktop open beside it, the desktop would see the
phone's answers only at its next 30-second sync. So **the server tells an
account's other devices when something changes**, and they sync at once,
within a second or two of the change:

- Every change that advances an account's `sync_seq` — a push that applied an
  operation, shared [device settings](#this-device-or-all-of-them), creating
  or duplicating a cascade, a [purge](#purge-task) — sends a Postgres
  `NOTIFY` on `acrodont_changes`, naming the account and the device that made
  it, **in the change's own transaction**, so it goes out only once the change
  is committed, and to every instance. A sync that applies nothing sends none.
- Each instance runs one `LISTEN` (started with its first stream) and fans the
  notes out to the open streams of that account, all but the stream of the
  device that made the change.
- The stream is `GET /api/sync/events?user=<id>&device=<id>`, Server-Sent
  Events, held by the tab that leads the account's syncing. `EventSource`
  cannot send `X-Acrodont-User`, so `user` carries the same check. It sends
  `changed` events (with data: `EventSource` drops an event without any), a
  comment every 20 seconds through the load balancer's and nginx's idle
  timeouts, and ends after five minutes, when the browser opens it again with
  the session checked again; the server's shutdown ends every stream, so a
  deploy is not held open by them.
- **An account's streams are limited**, per instance like every other limit,
  because each holds a connection, a task and a receiver for its five minutes
  and is the one request a signed-in caller can hold open for nothing: at most
  `SYNC_STREAMS_PER_USER` (16) open at once, and `SYNC_STREAM_RATE_PER_MINUTE`
  (30) opens a minute. A device needs one stream, held by the tab that leads
  its syncing, and opens it once every five minutes, so neither is in reach of
  a person's devices. An open past either is a `429` with `Retry-After`; the
  device opens the stream again later (below) and syncs every 30 seconds
  meanwhile.
- **Nothing depends on a note arriving.** A device still syncs on every
  trigger above; a stream opened again syncs, since a change may have come
  while it was closed; a listener that loses its connection tells every stream
  to sync; and a stream the server refuses (signed out) stays closed, leaving
  the 30-second sync. A browser opens a stream again by itself only after a
  dropped connection: an answer that is not a stream (a `502` while the server
  is being replaced, a `429`) ends it for good, so the device opens a new one
  itself, after 5 seconds and then twice as long each time up to five minutes,
  unless the sync engine says the account needs to log in.

### Conflicts

Conflicts need **two devices changing the same cascade while at least one is
offline**. Using one device on a plane never conflicts. The rules:

| Situation | Result |
|---|---|
| The same question graded on two devices in the same attempt | If one device had seen the other's grade (`seen_seq`), its change wins as a deliberate regrade. Otherwise the later `graded_at` wins; a stored grade's time is kept to the second, so of two grades in the same second the one that reaches the server later wins. A grade that loses is rejected as `stale` and counted in a notice on the losing device. |
| The same quiz finished on two devices | The first `finish` the server receives wins. The other device's `finish` is rejected as `stale_attempt` when the first finish reset the quiz, or `not_active` when it cleared it. Its operations on the attempt seeds it created (the reset quiz's next attempt, the level it created locally) are dropped by the rebase, because the server has neither seed. The device shows: "Level 3 was finished on another device. 42 answers from this device weren't kept." |
| A quiz restored on one device and purged on another | Whichever operation arrives first wins; the other is rejected. |
| The same quiz restored on two devices | The first `restore_quiz` wins. The second is rejected as `not_cleared`, and its grades name an attempt seed the server never had, so the rebase drops them and counts them in the notice. |
| Grades arriving for a quiz that has since been cleared or reset | Rejected as `not_active` (cleared) or `stale_attempt` (reset). They belong to an attempt that no longer exists, and the losing device counts them in the notice for whatever finished it. |
| The same run finished on two devices | The first `finish_segment` wins. The second is rejected, as a duplicate for that quiz, attempt and segment end when the run missed something, or — when it missed nothing, so no drill quiz exists to be a duplicate of — because its segment end is not past the cursor; both take the run-finished-elsewhere notice below. The device rebases onto the drill quiz the first one created, if there is one. The loser's grades on its own drill quiz are dropped, since the server never saw that quiz, and counted in the notice. |
| A question of an already-passed run regraded on another device | The grade applies: a `grade` needs only an active quiz and a matching attempt seed, and never checks the position against `run_start` (see [Segments](#segments)). It changes that attempt's counters and nothing else, because the run's drill quiz already exists and `origin_segment_end` is unique per parent attempt, so the run cannot descend again. The regrading device's own `move_cursor` inside the passed run is rejected as `bad_cursor`, which is never counted, and its `finish_segment` for that boundary as `duplicate_segment`, which carries the run notice. A question graded correct at Level N while it is being drilled at Level N + 1 is the ordinary case of the same question on several levels. |
| A cascade trashed on one device while the other keeps studying it | The trash wins once it reaches the server. The other device's grades, cursor moves, finishes and option changes on that cascade are rejected as `trashed` and dropped in the rebase, with a notice: "This cascade was moved to the Trash on another device. 17 answers from this device weren't kept." Restoring it brings back what the server has. |
| A cascade trashed on one device while another restores one of its quizzes | Whichever arrives first applies, and the other applies on top, since `restore_quiz` is allowed on a trashed cascade: a restore after the trash brings the cascade back with the restored quiz as its deepest level; a trash after the restore puts the restored quiz in the Trash with the cascade. The device that trashed it sees the cascade back on its next pull, with no notice, because nothing of its own was dropped. |
| The same trash, restore or purge sent from two devices | The first applies. The second is rejected (`trashed`, `not_trashed`, `not_cleared` or `not_found`) with no notice, because nothing that was the user's work was dropped. |
| A cascade purged on one device while the other, offline throughout, kept studying it | The tombstone wins. The other device's operations on it are rejected as `not_found` and dropped, the tombstone removes the cascade with its question keys and answers, and the notice reads "This cascade was deleted, on another device or by the Trash's retention period. 200 answers from this device weren't kept.", with no Restore hint, since there is nothing to restore. |
| The same quiz finished on one device and a run of it finished on another | Whichever arrives first wins. A `finish` after a `finish_segment` is rejected because the quiz is no longer the deepest level; a `finish_segment` after a `finish` is rejected because its attempt is out of date. The loser's dependent operations are dropped. |
| A quiz restored on one device while the other finishes the deepest level | Whichever arrives first wins. If the restore lands first, the `finish` is rejected because its quiz is no longer the deepest level. If the finish lands first, the restore still applies, on top of the new deepest level. |
| Two different quizzes restored on two devices | Both apply, in arrival order; the second becomes the deeper of the two. A `grade` needs only an active quiz, never the deepest one, so the first device's grades on its restored quiz are all kept, and its `finish` is rejected as `not_deepest` until the deeper level, the one restored second, is cleared. Nothing of its work is dropped, so no answers are counted; the notice is the `not_deepest` one below. |
| Quiz options changed on one device while the quiz was finished on another | Rejected if the quiz is no longer active, with no notice, since an option on a finished quiz has nothing left to apply to; the rebase drops the overlay row. Otherwise the change applies to the reset quiz. |
| Quiz or cascade options changed on two devices | **The later operation wins whole**: this covers every one of a cascade's [settings](#settings) (the threshold, answer mode, definitions, hooks, reveal grade and leave rounding as well as the quiz options), and a widening or a copy, which are ordinary `set_cascade_options`. Unless the device had seen the row's current options (`seen_seq`), an operation whose `at` is older than the row's last change is rejected as `stale`, even when it carries a different field, and the rebase reverts that field on the losing device. One timestamp per row is enough for this, and the loser simply sets the option again. |
| A quiz created while the cascade's options were different | Nothing happens to it. Options are copied at creation and never revisited. |
| A `finish` applied with a different outcome than the device computed | Another device's grade changed the score, or an options change on the finished quiz changed its progression, so the server cleared where the device descended, or the reverse, or built the new quiz from a different set of misses. The result's `new_quiz_questions_hash` is what tells the device whether the server's new quiz holds the same questions as its own. The new quiz has the same id and seed on both sides, so the device's grades on it stand wherever the question exists in the server's copy; a grade for a question the server's copy lacks is rejected as `not found`. When the two sides disagree about the finished quiz itself (one cleared it, the other reset it), the device's rows for it are not promoted; the quiz is rebuilt from the pulled row like any quiz whose seed differs from the base's, or, when the server cleared it, the base's rows and positions stay as they are, as for any cleared quiz. The device rebases the cascade and, when the outcome kind (cleared, replaced, descended, completed, reshuffled) or the level structure differs from what it showed, tells the user: "Level 2 came out differently on the server because of changes made on another device." When only the new quiz's question count differs, nothing is said. **This path never opens the completion screen**, even when the server's outcome is `completed`: that screen reports `peak_depth` and `attempts_since_completion`, which the server's own `Completed` has already reset to 1 and 0, and the result carries neither, so the device has no honest numbers to show — the pulled row's would read "after 1 level and 0 attempts". The notice stands, and the Complete badge appears from the pulled cascade row like any other. The screen is shown only for a `Completed` this device computed and the server confirmed, where the device's own rule run reported both numbers before resetting them. Rejected grades, if any, are counted in the usual "weren't kept" notice, separately. |
| A quiz's segment size changed on one device while another device passed a boundary | The `finish_segment` is rejected if its segment end is no longer a multiple of the size the server has. The drill quiz it created locally and the grades on it are dropped, with the usual notice. |
| The cascade's options changed on one device while another, offline with the old options, finished a quiz or restored one | The server builds the new or restored quiz from the options it has, so the device's local copy of that quiz may carry different options. The rebase replaces it with the server's row, and any `finish_segment` the device sent against a segment size the server's copy does not have is rejected and dropped. |
| The cursor moved on two devices in the same attempt | A device that had seen the other's cursor (`seen_seq`) wins; otherwise the later `cursor_moved_at`. A device's own moves always apply in order. If the winning cursor is already past a boundary the loser then tries to pass, the loser's `finish_segment` is rejected and its drill quiz dropped, with the usual notice. |
| This device's settings changed on two devices | Never a conflict: the display settings and controls are per device. Shared with all devices from two devices, the later share wins, per setting. |

Rejected operations are never retried. After the rebase, the device shows what
the server has, and a notice appears only when the user's own work was dropped:
grades, and the finishes and quizzes built from them. Rejected cursor moves and
option changes are never counted, and a grade the server kept is never counted
either, whatever happened to the finish after it. The notice's first sentence
follows the rejected or replay-dropped operation and its reason. For a `finish` or
`finish_segment`: `stale_attempt` or `not_active` "Level N was finished on
another device."; `not_deepest` "Another level was added below Level N on another device.
Finish it first."; `trashed` "This cascade was moved to the Trash on another
device."; `not_found` "This cascade was deleted, on another device or by the
Trash's retention period."; `duplicate_segment` "This segment of Level N was
finished on another device.", **and so does a `bad_segment` whose cause was
that the segment end is not past the cursor**, because that is the same
situation seen through a different check: a run that missed nothing creates no
drill quiz, so `quizzes_one_per_segment` has nothing to catch a second device's
`finish_segment` with and the cursor test catches it instead — telling that user
the size or place "was changed" would name a change nobody made; `bad_segment`
keeps the sentence below for its other causes (no segment size, not a multiple
of it, or past the question count) "Level N's
segment size or place was changed on another device."; `ungraded` "Level N has
answers the server did not get. Finish it again."; `invalid` and `error` as under
[Operations](#operations). For a `restore_quiz`: `not_cleared` "This quiz was
restored on another device."; `not_found` "This quiz was deleted, on another
device or by the Trash's retention period."; `invalid` and `error` as under
[Operations](#operations). For grades rejected with no
**rejected** `finish`, `finish_segment` or `restore_quiz` of this device behind
them, whether because this device sent none or because the one it sent was
applied, the
first sentence follows the grades' reason: `stale_attempt` or `not_active`
"Level N was finished on another device."; `stale` "Level N was also answered
on another device."; `error` "Level N's answers could not be saved on the
server."; `trashed` and `not_found` the cascade sentences above, the latter only
in the deletion case the paragraph below sets out.
The second sentence, "K answers
from this device weren't kept.", appears only when K is greater than 0.
**`not_found` is three situations, and only one of them is a deletion.** The
reason covers a target the server never had as well as one it purged (see
[Operations](#operations)), and one response routinely holds both, since a
rejection does not stop the batch. So the device decides the sentence from what
it holds, not from the reason alone:
- The cascade is **gone** from the base, or a tombstone for it arrived in the
  same pull: the sentences above, the deletion ones.
- The missing quiz is one an **earlier rejected operation in the same response**
  was to create — the ordinary offline chain, where a `finish` rejected
  `not_deepest` or `stale_attempt` means the level behind it never existed on
  the server. Every such rejection is a **dependent** of that one: it takes no
  sentence of its own and its grades are counted in that operation's notice, so
  a device that finished two levels on a plane sees one notice naming the first
  level and one count, not a second notice saying the cascade was deleted.
- The cascade and the quiz are there but the **question** is not, which is the
  [outcome-mismatch](#conflicts) case the server's own miss set produces: the
  came-out-differently sentence stands and those grades are counted in the usual
  "weren't kept" line, with no deletion sentence.
Monitoring therefore sees `not_found` rejections after a `not_deepest` or
`stale_attempt` as a matter of course, and they are expected rather than a sign
of divergence (see [Monitoring](#deployment-and-operations)).

### Authentication while offline

- **Signed-in state.** The app keeps the signed-in account in the `signed_in`
  pointer of the unscoped database described under
  [On the device](#on-the-device), beside that account's row in its `accounts`
  table, reads the pointer
  before anything else at startup, and treats the user as signed in until a sync
  is answered with `401`. Nothing on that path needs a connection, so a reload or
  a browser restart on a plane opens the right per-user database and lands on the
  cascade the user was studying rather than on the login page.
- **A tab is bound to one account, and so is every request it sends.** The
  session cookie is one per origin, shared by every tab, while each tab runs as
  the account whose database it opened, and the sync leader is elected per
  account, so two tabs running as two accounts each sync. Without a binding, a
  login for Bob in one tab would let Alice's tab push its outbox **as Bob**,
  where every operation is rejected `not_found` and dropped for good, and pull
  Bob's rows into Alice's database, a full pull deleting her base on the way.
  So every authenticated request the app sends carries the user id the tab runs
  as, in an `X-Acrodont-User` header read from `meta`, and the server refuses a
  request whose header differs from the session's user with `401` **before
  anything is applied or read** (see [Security](#authentication)). The ordinary
  `401` rule then does the right thing: the tab keeps its data and its outbox and
  shows **Log in to sync**. At startup, once online, the app compares
  `GET /api/auth/me`'s `user_id` with the pointer and treats a difference the same
  way. And because the first request after a switch may be minutes away, every
  tab listens on a `BroadcastChannel` for changes to the `signed_in` pointer: a
  tab whose account is no longer the signed-in one stops syncing and downloading
  and shows **signed out in another tab**, keeping its data, and does not reload
  on its own. It **resumes** when the pointer names its own account again — the
  user logged out and back in elsewhere, say to clear **Log in to sync** — since
  the cookie is then that account's again and the account-binding check lets its
  requests through.
- **Expired session.** A `401` during sync, from an expired session or "Sign out
  everywhere", keeps all local data and the outbox, and shows **Log in to
  sync**. Studying continues. Once the user logs in again, the outbox is pushed.
  This holds even when the session was revoked on purpose: a device that is out
  of the user's hands keeps its downloaded word lists, which is accepted,
  because wiping on `401` would also destroy the unsynced work of a user who
  pressed Sign out everywhere while their phone was offline.
- **A different user.** If a different user logs in on the device, the previous
  user's local data stays, untouched, until that user logs in again.
- **A deleted account** is the one case where a `401` is not the whole story.
  The device that ran `DELETE /api/account` removes its own copy at once (see
  [Authentication](#authentication)), because keeping data for an account that
  can never sign in again would leave it on the device for good. Any other
  device finds out on its next sync, is answered `401`, and follows the rule
  above — its data and outbox stay, it shows **Log in to sync**, and only the
  user's own removal action or the browser clearing site data reclaims the
  space.
- **Logging out.** The app tries to sync first, then **always completes
  locally**: it clears the `signed_in` pointer whether or not
  `POST /api/auth/logout` succeeded, so the next startup shows the login page
  even on a plane, and that request is queued and retried at the next
  connection on which no account is signed in (and after any `429` backoff) so
  the session cookie is cleared server-side too. **The queue is the flag on that account's `accounts` row**, in the
  unscoped database, not the outbox: the outbox lives in the per-user database,
  which the removal action in this same dialog deletes, and a logout that
  vanished with it would leave the cookie alive for its whole TTL on a device the
  user has walked away from. The retry runs **only while no account is signed
  in** — at a startup that finds no pointer, or straight after a logout — and
  the flag is cleared on a `2xx` or on **any `4xx` but `429`**, and left for
  later only on a `429`, a `5xx` or a network error. The test is whether the
  request could ever be accepted, not which status came back: a `401` means the
  session is already gone, and a `403` means this request will never be accepted
  as it stands. Naming the class rather than a list of statuses matters because
  what the retry carries is not up to the app. **The state it waits for is that
  no account is signed in, which is not the same as no cookie**: the session
  cookie is `httpOnly`, only the server's own logout response clears it, so the
  browser still holds it and sends it with the retry. The request is therefore an
  ordinary cookie-authenticated write, and the app **sends the double-submit CSRF
  token** with it, read from the CSRF cookie, which carries the session cookie's
  TTL and so is there whenever the session cookie is; that path is a `2xx`, and
  it is what actually clears the cookie. Only when both cookies have expired,
  which is what a device offline past their TTL meets, does the request arrive
  with no session cookie, and then the endpoint
  [needs neither a session nor a CSRF token](#auth-and-account) and answers
  `2xx` as well, because there is nothing left to clear. The one `403` left is a
  session cookie with the CSRF cookie gone — a browser that cleared part of its
  site data. For that the app asks `GET /api/auth/me` once, which sets the
  token again for a session that still holds, and sends the logout once more,
  so the cookie is cleared rather than left valid on a machine someone else
  may use; if that too is refused, the class rule above clears the flag
  rather than
  firing the same doomed request at every startup for the life of the
  installation. It runs only while no account is signed in
  because the endpoint clears whatever session cookie the browser holds, and the
  browser holds one: a login for another account replaces the cookie this
  logout was for, so firing the queued request afterwards would sign **that**
  account out of a session it never left. That is why a login clears every
  pending flag (see [On the device](#on-the-device)): once a new session cookie
  has been set, the cookie the queued logout meant to clear is already gone, and
  the request has nothing left to do. Until it goes through, the cookie the browser still holds grants nothing
  through the app, which never acts on a session without a signed-in pointer,
  and it is the same window a copied stateless token already has (see
  [the logout endpoint](#auth-and-account)). That user's
  per-user database is **kept**, exactly as it is when a different user logs in,
  so logging back in here finds its cascades, keys and cards already local and
  pushes anything the outbox still holds. When operations are unsent the dialog
  says how many and that they will sync the next time that user logs in on this
  device. The dialog also offers **Remove this account's data from this
  device**, which deletes the per-user database and, when the outbox is not
  empty, says how many changes that discards. It then empties that account's
  `accounts` row — its totals and its last-signed-in time — and deletes the row
  itself **unless the row still holds an unacknowledged logout**, in which case
  a row carrying that account's id, its username and the flag alone survives
  until the request goes through and is deleted when the flag clears. Because `ROW_STORAGE_BUDGET` and
  the answer limit are per user, a device several accounts have used can hold
  several budgets; each account's data leaves only by its own logout with
  removal (or by account deletion).

---

## Schema

There is a single migration, `backend/migrations/0001_initial.sql`, run by SQLx
at startup (SQLx creates its own `_sqlx_migrations` table). It is edited in
place until the first deployment, and each edit is logged in
`docs/migration-edits.md`. From the first `terraform apply` on, migrations
are **append-only and additive**, with no "until the real launch" exception.
Birdtest kept editing its first migration after going live, which cost it
production resets, deleted backups and every user re-registering.
- **Numbered files**, never editing or removing an applied one.
  `scripts/deploy.sh` refuses a change under `backend/migrations/` that is not
  an added file, and `backend/build.rs` makes a new file rebuild the crate,
  since `sqlx::migrate!` embeds the directory at compile time.
- **Additive only:** new tables, nullable or defaulted columns, indexes. Drops
  and renames wait a release.
- **A new enum or CHECK value is not additive:** ship the code that reads it one
  release before the code that writes it.
- **The server's migrator ignores migrations it does not know**
  (`set_ignore_missing`), so a rolled-back image starts on the newer schema.
  That is safe only because of the rules above.
- **Prefer designs that need no schema change.** Devices offline with an old app
  for up to `SYNC_RETENTION_DAYS` must keep syncing, too.
**Two tasks starting together are safe**: SQLx takes a Postgres advisory lock
around the run, so a rolling deploy's second task waits and then finds every
migration applied and proceeds to bind. Nothing else in the plan serialises
startup, so this is the reason a hand-rolled runner is not used. The
full schema:

```sql
-- =========================================================================
-- Acrodont schema
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- -------------------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------------------

CREATE TYPE quiz_type AS ENUM ('anagram', 'definition', 'leave_value');

CREATE TYPE grade AS ENUM ('correct', 'missed');

CREATE TYPE anagram_answer_mode AS ENUM ('flashcard', 'typed');

-- 'cleared' means finished and in the Trash, whether or not the score met the
-- clear threshold (see Progression).
CREATE TYPE quiz_status AS ENUM ('active', 'cleared');

-- What a finish below the clear threshold does.
CREATE TYPE quiz_progression AS ENUM ('ladder', 'drill');

-- How a quiz came to exist.
CREATE TYPE quiz_origin AS ENUM (
    'source',             -- created from the filter search
    'clear_replacement',  -- the misses of a cleared quiz, at the same level
    'drill_replacement',  -- Drill progression: the misses of a quiz that was not cleared,
                          -- at the same level
    'descent',            -- Ladder progression, or the Source quiz at any score: the
                          -- misses of a quiz that was not cleared, one level down
    'segment'             -- the misses of one run of a quiz, one level down
);

CREATE TYPE finish_outcome AS ENUM (
    'cleared',     -- score met the threshold; quiz to the Trash (never the Source quiz)
    'replaced',    -- Drill: score did not meet the threshold; quiz to the Trash anyway
    'descended',   -- Ladder, or the Source quiz at any score: quiz reset, misses one level down
    'completed',   -- Source quiz, no misses: quiz reset in place; cascade complete
    'reshuffled'   -- nothing correct; quiz reset in place
);

CREATE TYPE sync_op_type AS ENUM (
    'grade', 'move_cursor', 'finish', 'finish_segment', 'restore_quiz',
    'trash_cascade', 'restore_cascade', 'purge_quiz', 'purge_cascade',
    'set_cascade_options', 'set_quiz_options'
);

CREATE TYPE sync_op_status AS ENUM ('applied', 'rejected');

CREATE TYPE sync_entity AS ENUM ('cascade', 'quiz');

CREATE TYPE condition_type AS ENUM (
    'anagram_match',
    'pattern_match',
    'subanagram_match',
    'length',
    'in_lexicon',
    'in_word_list',
    'num_vowels',
    'includes_letters',
    'probability_order',
    'limit_by_probability_order',
    'playability_order',
    'limit_by_playability_order',
    'num_unique_letters',
    'point_value',
    'takes_prefix',
    'takes_suffix',
    'part_of_speech',
    'definition',
    'consists_of',
    'num_anagrams',
    'front_inner_hook',
    'back_inner_hook',
    'leave_value'
);

CREATE TYPE part_of_speech AS ENUM (
    'adjective',
    'adverb',
    'conjunction',
    'definite_article',
    'indefinite_article',
    'interjection',
    'noun',
    'preposition',
    'pronoun',
    'verb'
);

-- -------------------------------------------------------------------------
-- Accounts
-- -------------------------------------------------------------------------

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            CITEXT NOT NULL UNIQUE
                            CHECK (username ~ '^[A-Za-z0-9_]{3,32}$'),
    email               CITEXT NOT NULL UNIQUE
                            CHECK (length(email) BETWEEN 3 AND 254),
    password_hash       TEXT NOT NULL,                  -- Argon2 PHC string
    email_confirmed_at  TIMESTAMPTZ,
    is_admin            BOOLEAN NOT NULL DEFAULT false, -- set only via SQL
    session_generation  INTEGER NOT NULL DEFAULT 0,     -- bumped to revoke all sessions
    sync_seq            BIGINT NOT NULL DEFAULT 0,      -- last sync sequence value issued
    sync_floor_seq      BIGINT NOT NULL DEFAULT 0,      -- tombstones at or below this were pruned
    storage_bytes       BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
                            -- the sum of the user's cascades' and saved searches'
                            -- storage_bytes, kept in the same transactions (Storage limit)
    storage_limit_bytes BIGINT CHECK (storage_limit_bytes >= 0),
                            -- set only via SQL: replaces MAX_STORAGE_BYTES_PER_USER
                            -- for this account
    device_settings     JSONB NOT NULL DEFAULT '{}'::jsonb
                            CHECK (jsonb_typeof(device_settings) = 'object'),
                            -- device settings shared with all of the account's
                            -- devices: setting name -> {value, at} (Settings)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (sync_floor_seq <= sync_seq)
);

CREATE TABLE email_confirmations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash   BYTEA NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32), -- SHA-256
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,               -- created_at + 24 hours
    used_at     TIMESTAMPTZ
);
CREATE INDEX email_confirmations_user_id ON email_confirmations (user_id);

CREATE TABLE password_reset_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32), -- SHA-256
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,               -- created_at + 30 minutes
    used_at     TIMESTAMPTZ
);
CREATE INDEX password_reset_tokens_user_id_unused
    ON password_reset_tokens (user_id) WHERE used_at IS NULL;

-- -------------------------------------------------------------------------
-- Catalog (uploaded by admins; immutable once uploaded)
-- -------------------------------------------------------------------------

CREATE TABLE letter_distributions (
    id           SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9 _-]{1,32}$'),
    uploaded_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per line of the uploaded MAGPIE letter distribution file.
CREATE TABLE letter_distribution_tiles (
    letter_distribution_id  SMALLINT NOT NULL
                                REFERENCES letter_distributions (id) ON DELETE CASCADE,
    position                SMALLINT NOT NULL CHECK (position >= 0),
                                -- line number from 0; the tile order; 0 is the blank
    letter                  TEXT NOT NULL CHECK (octet_length(letter) BETWEEN 1 AND 8),
    blank_letter            TEXT NOT NULL CHECK (octet_length(blank_letter) BETWEEN 1 AND 8),
    count                   SMALLINT NOT NULL CHECK (count >= 0),  -- tiles of this kind in the bag
    value                   SMALLINT NOT NULL CHECK (value >= 0),  -- points
    is_vowel                BOOLEAN NOT NULL,
    fullwidth_letter        TEXT,
    fullwidth_blank_letter  TEXT,
    PRIMARY KEY (letter_distribution_id, position),
    UNIQUE (letter_distribution_id, letter),
    UNIQUE (letter_distribution_id, blank_letter),
    CHECK ((position = 0) = (letter = '?')),
    CHECK (position <> 0 OR (blank_letter = '?' AND value = 0 AND NOT is_vowel)),
    CHECK (position = 0 OR (letter       !~ '[\[\],?*.[:space:]]'
                        AND blank_letter !~ '[\[\],?*.[:space:]]')),
    CHECK ((fullwidth_letter IS NULL) = (fullwidth_blank_letter IS NULL))
);

CREATE TABLE lexicons (
    id                      SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                    TEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9_-]{1,32}$'),
    letter_distribution_id  SMALLINT NOT NULL REFERENCES letter_distributions (id),
    word_count              INTEGER NOT NULL CHECK (word_count > 0),
    definitions_revision    INTEGER NOT NULL DEFAULT 1 CHECK (definitions_revision >= 1),
                                -- raised by each replacement of the lexicon's definitions,
                                -- the one part of a lexicon that can change (Immutability
                                -- and deletion); a cascade row carries it, and a device
                                -- fetches again the answers it holds from an older one
    uploaded_by             UUID REFERENCES users (id) ON DELETE SET NULL,
    uploaded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lexicons_letter_distribution_id ON lexicons (letter_distribution_id);

-- A lexicon's words, packed: one row per lexicon. The text is one line per
-- word, `word TAB playability TAB definition LF`, the word in canonical MAGPIE
-- notation, in upload order, compressed with zstd by the server (so Postgres
-- stores it as it is: STORAGE EXTERNAL). Every instance reads the whole
-- lexicon into memory and nothing queries a word in SQL; a row per word took
-- five times the space. The words and playabilities never change; the
-- definitions are replaced whole by a definitions upload, which raises
-- lexicons.definitions_revision. Upload validation checks each word, playability and
-- definition (see File formats); a text that does not parse fails the load.
CREATE TABLE lexicon_words (
    lexicon_id  SMALLINT PRIMARY KEY REFERENCES lexicons (id) ON DELETE CASCADE,
    words       BYTEA NOT NULL CHECK (octet_length(words) > 0)
);
ALTER TABLE lexicon_words ALTER COLUMN words SET STORAGE EXTERNAL;

-- At most one per lexicon. Leaves use the lexicon's letter distribution.
CREATE TABLE leave_sets (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lexicon_id   SMALLINT NOT NULL UNIQUE REFERENCES lexicons (id),
    leave_count  INTEGER NOT NULL CHECK (leave_count > 0),
    values_revision INTEGER NOT NULL DEFAULT 1 CHECK (values_revision >= 1),
                     -- raised by each replacement of the set's values, as
                     -- lexicons.definitions_revision is by its definitions'; the
                     -- leaves themselves never change
    uploaded_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, lexicon_id)   -- target of cascades' composite foreign key
);

-- A leave set's leaves, packed as a lexicon's words are: one row per set, the
-- text one line per leave, `leave TAB value LF`, the leave in canonical MAGPIE
-- notation (1–6 tiles in distribution order, blanks first), compressed with zstd.
-- The values are replaced whole by a values upload, which raises
-- leave_sets.values_revision.
CREATE TABLE leave_values (
    leave_set_id  INTEGER PRIMARY KEY REFERENCES leave_sets (id) ON DELETE CASCADE,
    leaves        BYTEA NOT NULL CHECK (octet_length(leaves) > 0)
);
ALTER TABLE leave_values ALTER COLUMN leaves SET STORAGE EXTERNAL;

-- -------------------------------------------------------------------------
-- Filter specifications (shared by saved searches and cascades)
-- -------------------------------------------------------------------------

CREATE TABLE search_specs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    quiz_type   quiz_type NOT NULL,   -- the type this spec's In Word List entries were
                            -- canonicalised under: a leave is sorted into tile order and
                            -- a word is not, so loading the spec under a type on the
                            -- other side of Leave Value flags that row rather than
                            -- silently reading leaves as words. Duplicate copies it
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_specs_user_id ON search_specs (user_id);

CREATE TYPE group_op AS ENUM ('and', 'or');

-- AND / OR groups of a spec. Group 0 is the top of every spec and has no
-- parent; every other group and every condition belongs to exactly one group.
-- Children of a group, conditions and groups alike, are ordered by
-- order_in_group, which the application keeps unique per group.
CREATE TABLE search_groups (
    spec_id         UUID NOT NULL REFERENCES search_specs (id) ON DELETE CASCADE,
    id              SMALLINT NOT NULL CHECK (id BETWEEN 0 AND 99),
    parent_id       SMALLINT,                       -- NULL only for group 0
    op              group_op NOT NULL,
    order_in_group  SMALLINT NOT NULL CHECK (order_in_group BETWEEN 0 AND 99),
    PRIMARY KEY (spec_id, id),
    FOREIGN KEY (spec_id, parent_id) REFERENCES search_groups (spec_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK ((id = 0) = (parent_id IS NULL)),
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE search_conditions (
    spec_id               UUID NOT NULL REFERENCES search_specs (id) ON DELETE CASCADE,
    position              SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 99),
                              -- row number within the spec
    group_id              SMALLINT NOT NULL,
    order_in_group        SMALLINT NOT NULL CHECK (order_in_group BETWEEN 0 AND 99),
    condition_type        condition_type NOT NULL,
    negated               BOOLEAN NOT NULL DEFAULT false,

    -- Parameters. Which ones are set depends on condition_type (see CHECK below).
    entries               TEXT COMPRESSION lz4,
                              -- In Word List only: its entries in canonical MAGPIE
                              -- notation (see Tiles), deduplicated, in byte order,
                              -- each ending with a line break. Converted to tiles at
                              -- search time.
    text_value            TEXT CHECK (length(text_value) BETWEEN 1 AND 500),
                              -- pattern, tiles, prefix or suffix in canonical form
                              -- (see Tiles): MAGPIE notation, or space-separated
                              -- pattern tokens; or definition text as typed; or,
                              -- for In Lexicon in a saved search, the lexicon's
                              -- name, which the canonical-form check never sees. A pattern is what
                              -- needs the room, not a prefix: a 14-tile prefix of
                              -- 8-byte tiles is 140 characters, but a tile set has no
                              -- size cap, so 15 positions each holding a set of the
                              -- distribution's consonants run past 350 characters
                              -- ("8-letter words with no vowels" writes one per
                              -- position). The application checks the canonical
                              -- form's length before insert and reports it as a
                              -- field error naming the limit
    part_of_speech_value  part_of_speech,
    other_lexicon_id      SMALLINT REFERENCES lexicons (id),
                              -- In Lexicon in a cascade's spec, which pins the
                              -- lexicon. A saved search's In Lexicon row holds the
                              -- lexicon's name in text_value instead and pins
                              -- nothing (see Immutability and deletion)
    min_value             INTEGER CHECK (min_value >= 0),
    max_value             INTEGER CHECK (max_value >= 0),
    min_leave_value       DOUBLE PRECISION
                              CHECK (min_leave_value NOT IN ('NaN'::float8,
                                     'Infinity'::float8, '-Infinity'::float8)),
    max_leave_value       DOUBLE PRECISION
                              CHECK (max_leave_value NOT IN ('NaN'::float8,
                                     'Infinity'::float8, '-Infinity'::float8)),
                              -- as for every stored value and playability: Postgres
                              -- treats NaN as equal to itself and above everything,
                              -- so a NaN pair would pass min <= max below and then
                              -- match no leave at all
    lax                   BOOLEAN,

    PRIMARY KEY (spec_id, position),
    FOREIGN KEY (spec_id, group_id) REFERENCES search_groups (spec_id, id) ON DELETE CASCADE,

    CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
    CHECK (min_leave_value IS NULL OR max_leave_value IS NULL
           OR min_leave_value <= max_leave_value),

    -- Not is only allowed where Zyzzyva allows it.
    CHECK (NOT negated OR condition_type IN (
        'anagram_match', 'pattern_match', 'subanagram_match', 'in_lexicon',
        'in_word_list', 'includes_letters', 'takes_prefix', 'takes_suffix',
        'part_of_speech', 'definition', 'front_inner_hook', 'back_inner_hook')),

    -- Exactly the parameters each type uses are present.
    CHECK (CASE
        WHEN condition_type IN ('anagram_match', 'pattern_match', 'subanagram_match',
                                'includes_letters', 'takes_prefix', 'takes_suffix',
                                'definition')
            THEN text_value IS NOT NULL
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 1
        WHEN condition_type IN ('length', 'num_vowels', 'num_unique_letters',
                                'point_value', 'num_anagrams')
            THEN num_nonnulls(min_value, max_value) = 2
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 2
        WHEN condition_type IN ('probability_order', 'limit_by_probability_order',
                                'playability_order', 'limit_by_playability_order')
            THEN num_nonnulls(min_value, max_value, lax) = 3
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 3
        WHEN condition_type = 'consists_of'
            THEN num_nonnulls(text_value, min_value, max_value) = 3
             AND max_value <= 100
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 3
        WHEN condition_type = 'part_of_speech'
            THEN part_of_speech_value IS NOT NULL
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 1
        WHEN condition_type = 'in_lexicon'    -- the id in a cascade's spec, the
                                               -- name in a saved search's
            THEN num_nonnulls(text_value, other_lexicon_id) = 1
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 1
        WHEN condition_type IN ('in_word_list',   -- its entries are in entries
                                'front_inner_hook', 'back_inner_hook')  -- no parameters
            THEN num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, min_leave_value,
                              max_leave_value, lax) = 0
        WHEN condition_type = 'leave_value'    -- either bound may be open, not both
            THEN num_nonnulls(min_leave_value, max_leave_value) >= 1
             AND num_nonnulls(text_value, part_of_speech_value, other_lexicon_id,
                              min_value, max_value, lax) = 0
    END),
    CHECK ((condition_type = 'in_word_list') = (entries IS NOT NULL))
);
CREATE INDEX search_conditions_other_lexicon_id
    ON search_conditions (other_lexicon_id) WHERE other_lexicon_id IS NOT NULL;

CREATE TABLE saved_searches (
    id          UUID PRIMARY KEY,           -- device-generated, so a save can be retried
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    spec_id     UUID NOT NULL UNIQUE REFERENCES search_specs (id),
    storage_bytes BIGINT NOT NULL CHECK (storage_bytes >= 0),  -- its spec's, by the
                            -- storage formula (Storage limit); counted in users.storage_bytes
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

-- -------------------------------------------------------------------------
-- Cascades and quizzes
-- -------------------------------------------------------------------------

CREATE TABLE cascades (
    id                UUID PRIMARY KEY,           -- device-generated, so creation can be retried
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    quiz_type         quiz_type NOT NULL,
    lexicon_id        SMALLINT NOT NULL REFERENCES lexicons (id),
    leave_set_id      INTEGER,                    -- Leave Value cascades only
    spec_id           UUID NOT NULL REFERENCES search_specs (id),
                          -- a private copy, never a saved search's or another
                          -- cascade's spec; Duplicate copies it again
    clear_threshold   SMALLINT NOT NULL CHECK (clear_threshold BETWEEN 1 AND 100),

    -- Quiz options: what every quiz created for this cascade starts with.
    segment_size         INTEGER NOT NULL DEFAULT 0
                             CHECK (segment_size = 0 OR segment_size BETWEEN 5 AND 300000),
                                 -- 0 = no segments; the minimum of 5 rules out the
                                 -- one-question run. See Quiz options for the
                                 -- ceil(question_count / S) bound on chain quizzes
    progression          quiz_progression NOT NULL DEFAULT 'ladder',
    require_alphabetical BOOLEAN NOT NULL DEFAULT false,
    answer_mode          anagram_answer_mode NOT NULL DEFAULT 'flashcard',
                                 -- the cascade's own, never a quiz's (Typed mode)
    show_definitions     BOOLEAN NOT NULL DEFAULT true,  -- Anagram: each anagram's definition on reveal
    show_hooks           BOOLEAN NOT NULL DEFAULT true,  -- Anagram: hooks on reveal
    reveal_correct       BOOLEAN NOT NULL DEFAULT true,  -- a reveal marks the card correct
                                 -- (false: missed) until toggled
    show_found_count     BOOLEAN NOT NULL DEFAULT false, -- Anagram: typed mode's "3 of 9 found"
    show_probability     BOOLEAN NOT NULL DEFAULT false, -- each word's probability order on reveal
    definition_column    BOOLEAN NOT NULL DEFAULT true,  -- a definition beside its word (false: beneath it)
    leave_value_decimals SMALLINT NOT NULL DEFAULT 0    -- Leave Value: decimal places shown
                             CHECK (leave_value_decimals BETWEEN 0 AND 3),
    options_changed_at   TIMESTAMPTZ NOT NULL,   -- device time of creation or of the latest
                             -- set_cascade_options; an older operation is rejected whole
    options_seq          BIGINT NOT NULL,            -- sync sequence of that change, for seen_seq
    options_device_id    UUID NOT NULL,              -- the device that made it (the creator at first);
                                                     -- its own next change always applies

    question_count    INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 300000),
    question_keys     TEXT COMPRESSION lz4 NOT NULL,
                          -- the cascade's questions in search order, one key per
                          -- line (alphagram, word or canonical leave, in MAGPIE
                          -- notation); a question's idx is its line. Immutable.
    depth             INTEGER NOT NULL CHECK (depth >= 1),
                          -- number of active levels; Level 1 is always the Source quiz
    peak_depth        INTEGER NOT NULL DEFAULT 1 CHECK (peak_depth >= depth),
                          -- deepest level reached since the last completion (or creation)
    attempts_since_completion INTEGER NOT NULL DEFAULT 0
                          CHECK (attempts_since_completion >= 0),
                          -- attempts finished on any level since the last completion;
                          -- the completion screen shows both, then both reset
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,                -- latest finish of the Source quiz with no misses
    trashed_at        TIMESTAMPTZ,                -- set only by the user
    storage_bytes     BIGINT NOT NULL CHECK (storage_bytes >= 0),
                          -- the rows the account holds because of this cascade, by the
                          -- storage formula (Storage limit): set at creation, changed by
                          -- every new level and attempt and every purged quiz, each with
                          -- an updated_seq bump; counted in users.storage_bytes
    updated_seq       BIGINT NOT NULL,

    -- The leave value set must belong to the cascade's lexicon.
    FOREIGN KEY (leave_set_id, lexicon_id) REFERENCES leave_sets (id, lexicon_id),

    -- An account's cascades each have their own name, the Trash included: a
    -- purged cascade's name is free again.
    UNIQUE (user_id, name),

    CHECK ((quiz_type = 'leave_value') = (leave_set_id IS NOT NULL))
);
CREATE INDEX cascades_user_activity ON cascades (user_id, last_activity_at DESC);
CREATE INDEX cascades_user_seq ON cascades (user_id, updated_seq);
CREATE INDEX cascades_trashed_at ON cascades (trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX cascades_spec_id ON cascades (spec_id);
CREATE INDEX cascades_lexicon_id ON cascades (lexicon_id);
CREATE INDEX cascades_leave_set_id ON cascades (leave_set_id) WHERE leave_set_id IS NOT NULL;

CREATE TABLE quizzes (
    id                UUID PRIMARY KEY,           -- device-generated, the Source quiz included
    cascade_id        UUID NOT NULL REFERENCES cascades (id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    level             INTEGER NOT NULL CHECK (level >= 1),
                          -- for a cleared quiz, the level it was cleared from;
                          -- 1 only ever for the Source quiz
    origin            quiz_origin NOT NULL,
    origin_quiz_id    UUID REFERENCES quizzes (id) ON DELETE SET NULL,
    origin_attempt    INTEGER CHECK (origin_attempt >= 1),   -- the attempt it came out of
    origin_segment_end INTEGER CHECK (origin_segment_end >= 1),
                          -- segment quizzes: the run boundary it came from, in the parent's
                          -- positions. Recorded as a position, not a run number, so changing
                          -- the segment size mid-attempt cannot re-descend a finished run.
    status            quiz_status NOT NULL DEFAULT 'active',
    segment_chain     BOOLEAN NOT NULL DEFAULT false,
                          -- a run's drill quiz and every replacement of it: Drill for
                          -- life and never segmented (see Segments)

    -- Quiz options, copied from the cascade at creation and editable afterwards.
    segment_size         INTEGER NOT NULL DEFAULT 0
                             CHECK (segment_size = 0 OR segment_size BETWEEN 5 AND 300000),
    progression          quiz_progression NOT NULL DEFAULT 'ladder',
    require_alphabetical BOOLEAN NOT NULL DEFAULT false,
    options_changed_at   TIMESTAMPTZ NOT NULL,   -- device time of creation or of the latest
                             -- set_quiz_options; an older operation is rejected whole
    options_seq          BIGINT NOT NULL,            -- sync sequence of that change, for seen_seq
    options_device_id    UUID NOT NULL,              -- the device that made it; its own next
                                                     -- change always applies

    attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    shuffle_seed      BIGINT NOT NULL,            -- the u64 seed of the current attempt's order,
                                                  -- stored as its two's-complement i64; identifies
                                                  -- the attempt in sync operations
    questions_hash    BIGINT NOT NULL,            -- FNV-1a 64 of the ascending question indexes
                                                  -- (see Deterministic shuffles); fixed for life.
                                                  -- Stored as its two's-complement i64, like
                                                  -- shuffle_seed above: a hash with its top bit set
                                                  -- reads back negative, and the wire form is the
                                                  -- unsigned decimal either way (see API)
    question_count    INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 300000),
    correct_count     INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
    missed_count      INTEGER NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
    cursor            INTEGER NOT NULL DEFAULT 0,
    cursor_moved_at   TIMESTAMPTZ,                -- device time, for latest-wins between devices
    cursor_device_id  UUID,                       -- the device that last moved it
    run_start         INTEGER NOT NULL DEFAULT 0, -- the last run boundary passed in this attempt
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_seq       BIGINT NOT NULL,            -- the sync sequence that created it;
                                                  -- informational. The rebase decides new
                                                  -- versus reset from its own base, never from this
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at        TIMESTAMPTZ,
    updated_seq       BIGINT NOT NULL,            -- also bumped when any of its questions change

    CHECK ((status = 'cleared') = (cleared_at IS NOT NULL)),
    CHECK ((origin = 'source') = (level = 1)),             -- Level 1 is the Source quiz
    CHECK (origin <> 'source' OR status = 'active'),      -- and it is never cleared
    CHECK (origin <> 'source' OR (origin_quiz_id IS NULL AND origin_attempt IS NULL)),
    CHECK ((origin = 'segment') = (origin_segment_end IS NOT NULL)),
    CHECK (origin <> 'segment' OR segment_chain),            -- a run's misses start a chain
    CHECK (NOT segment_chain OR (progression = 'drill' AND segment_size = 0)),
    CHECK (correct_count + missed_count <= question_count),
    CHECK (cursor >= 0 AND cursor < question_count),      -- the card being shown
    CHECK (run_start BETWEEN 0 AND cursor),                -- Previous never crosses a boundary
    CHECK ((cursor_moved_at IS NULL) = (cursor_device_id IS NULL))
);
CREATE UNIQUE INDEX quizzes_one_active_per_level
    ON quizzes (cascade_id, level) WHERE status = 'active';
CREATE UNIQUE INDEX quizzes_one_source ON quizzes (cascade_id) WHERE origin = 'source';
CREATE INDEX quizzes_cascade_id ON quizzes (cascade_id);   -- purges and the FK cascade
CREATE INDEX quizzes_user_seq ON quizzes (user_id, updated_seq);
CREATE INDEX quizzes_cleared_at ON quizzes (cleared_at) WHERE status = 'cleared';
CREATE INDEX quizzes_origin_quiz_id ON quizzes (origin_quiz_id) WHERE origin_quiz_id IS NOT NULL;
-- One descent per run per attempt, so a repeated or racing finish_segment cannot make two.
CREATE UNIQUE INDEX quizzes_one_per_segment
    ON quizzes (origin_quiz_id, origin_attempt, origin_segment_end)
    WHERE origin = 'segment';

-- A level's questions and their grades, packed: one row per run of up to 256
-- of its questions in idx order (a chunk); a question's place in that run is
-- its slot. A question's position in the attempt is never stored: it is
-- computed from the quiz's shuffle_seed (Deterministic shuffles). See Storage
-- limit for what a chunk costs.
CREATE TABLE quiz_cards (
    quiz_id      UUID NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
    first_idx    INTEGER NOT NULL CHECK (first_idx BETWEEN 0 AND 299999),
                     -- the chunk's first question; the chunks of a quiz in
                     -- first_idx order are its questions in idx order
    n            SMALLINT NOT NULL CHECK (n BETWEEN 1 AND 256),
                     -- the questions in the chunk
    idxs         BYTEA COMPRESSION lz4,
                     -- the chunk's questions after first_idx, ascending, each
                     -- as the difference from the one before it, a LEB128
                     -- varint; NULL for the Source quiz, whose chunk holds
                     -- first_idx, first_idx + 1, …
    cards        BYTEA COMPRESSION lz4,
                     -- NULL while nothing is graded. Otherwise ceil(n / 4)
                     -- bytes of grades, two bits a slot from the low bits up
                     -- (0 ungraded, 1 correct, 2 missed), then one record per
                     -- graded question in (sequence, slot) order: the slot
                     -- (one byte), the device that set the grade as a 1-based
                     -- index into devices (one byte; so a device's own regrade
                     -- always applies), the sync sequence of the grade as a
                     -- varint of its difference from the record before (from 0
                     -- for the first; for seen_seq and pulls), and its device
                     -- time in whole seconds since 1970 as a zigzag varint of
                     -- its difference from the record before (latest-wins
                     -- between devices is decided to the second). A cleared
                     -- quiz keeps its grades and no records (Trash).
    devices      UUID[] NOT NULL DEFAULT '{}',
    updated_seq  BIGINT NOT NULL,
                     -- the latest grade's sequence here (the creation's at
                     -- first), so a pull reads only the chunks that changed
    PRIMARY KEY (quiz_id, first_idx),
    CHECK (cards IS NULL OR octet_length(cards) >= (n + 3) / 4)
);

-- A chunk as one row per question, for the view below.
CREATE FUNCTION quiz_card_rows(first_idx INTEGER, n SMALLINT, idxs BYTEA, cards BYTEA)
RETURNS TABLE (question_idx INTEGER, grade SMALLINT, graded_at TIMESTAMPTZ, graded_seq BIGINT, graded_by SMALLINT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    q    INTEGER[] := ARRAY[first_idx];
    ats  BIGINT[]  := array_fill(NULL::BIGINT, ARRAY[n]);
    seqs BIGINT[]  := array_fill(NULL::BIGINT, ARRAY[n]);
    bys  INTEGER[] := array_fill(NULL::INTEGER, ARRAY[n]);
    p    INTEGER := 0;
    len  INTEGER;
    b    INTEGER;
    v    BIGINT;
    sh   INTEGER;
    slot INTEGER;
    seq  BIGINT := 0;
    secs BIGINT := 0;
BEGIN
    IF idxs IS NULL THEN
        q := ARRAY(SELECT generate_series(first_idx, first_idx + n - 1));
    ELSE
        len := octet_length(idxs);
        WHILE p < len LOOP
            v := 0; sh := 0;
            LOOP
                b := get_byte(idxs, p); p := p + 1;
                v := v | ((b & 127)::BIGINT << sh); sh := sh + 7;
                EXIT WHEN b < 128;
            END LOOP;
            q := q || (q[cardinality(q)] + v::INTEGER);
        END LOOP;
    END IF;
    IF cards IS NOT NULL THEN
        p := (n + 3) / 4;
        len := octet_length(cards);
        WHILE p < len LOOP
            slot := get_byte(cards, p) + 1;
            bys[slot] := get_byte(cards, p + 1);
            p := p + 2;
            v := 0; sh := 0;
            LOOP
                b := get_byte(cards, p); p := p + 1;
                v := v | ((b & 127)::BIGINT << sh); sh := sh + 7;
                EXIT WHEN b < 128;
            END LOOP;
            seq := seq + v;
            v := 0; sh := 0;
            LOOP
                b := get_byte(cards, p); p := p + 1;
                v := v | ((b & 127)::BIGINT << sh); sh := sh + 7;
                EXIT WHEN b < 128;
            END LOOP;
            secs := secs + ((v >> 1) # -(v & 1));
            seqs[slot] := seq;
            ats[slot] := secs;
        END LOOP;
    END IF;
    FOR i IN 1 .. n LOOP
        question_idx := q[i];
        grade := CASE WHEN cards IS NULL THEN 0 ELSE (get_byte(cards, (i - 1) / 4) >> (2 * ((i - 1) % 4))) & 3 END;
        graded_at := to_timestamp(ats[i]);
        graded_seq := seqs[i];
        graded_by := NULLIF(bys[i], 0);
        RETURN NEXT;
    END LOOP;
END
$$;

-- The chunks as one row per question, as the table was before it was packed:
-- for reading in tests, scripts and support queries, never by the server's
-- hot paths. question_idx is an index into cascades.question_keys. A cleared
-- quiz's rows have a grade and no time, device or sequence.
CREATE VIEW quiz_questions AS
SELECT c.quiz_id,
       r.question_idx,
       CASE r.grade WHEN 1 THEN 'correct'::grade WHEN 2 THEN 'missed'::grade END AS grade,
       r.graded_at,
       c.devices[r.graded_by] AS graded_by_device_id,
       r.graded_seq AS updated_seq
FROM quiz_cards c
CROSS JOIN LATERAL quiz_card_rows(c.first_idx, c.n, c.idxs, c.cards) AS r;

-- One row per finished attempt. Immutable.
CREATE TABLE quiz_attempts (
    quiz_id         UUID NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
                        -- denormalised exactly as quizzes.user_id is, so a pull can
                        -- find this user's changed attempt rows through one index
                        -- range scan. Attempt rows are not narrowed by
                        -- question_rows_for and travel for cleared quizzes too, so
                        -- without it the candidate set is every quiz the user owns:
                        -- 60,000 chain quizzes would mean 60,000 seeks per sync
    attempt         INTEGER NOT NULL CHECK (attempt >= 1),
    question_count  INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 300000),
    correct_count   INTEGER NOT NULL CHECK (correct_count >= 0),
    missed_count    INTEGER NOT NULL CHECK (missed_count >= 0),
    outcome         finish_outcome NOT NULL,
    shuffle_seed    BIGINT NOT NULL,              -- the order this attempt was played in, as its
                                                 -- two's-complement i64, like quizzes.shuffle_seed
    finished_at     TIMESTAMPTZ NOT NULL,         -- device time
    updated_seq     BIGINT NOT NULL,
    PRIMARY KEY (quiz_id, attempt),
    CHECK (correct_count + missed_count = question_count)
);
CREATE INDEX quiz_attempts_user_seq ON quiz_attempts (user_id, updated_seq);

-- -------------------------------------------------------------------------
-- Sync bookkeeping
-- -------------------------------------------------------------------------

-- Operations received, so a repeated operation is recognised. A record whose operation
-- returns no result fields is deleted once its device has shown it received the result
-- (below sync_devices.acked_below); finish, finish_segment and restore_quiz records are
-- kept for SYNC_RETENTION_DAYS. See The sync cycle.
-- Looked up by (user_id, id): an id another user has already used is rejected, never replayed.
CREATE TABLE sync_operations (
    id           UUID PRIMARY KEY,                -- device-generated operation id
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    UUID NOT NULL,
    device_seq   BIGINT NOT NULL CHECK (device_seq >= 1),
    op_type      sync_op_type NOT NULL,
    status       sync_op_status NOT NULL,
    reason       TEXT,
    -- The result fields of an applied finish, finish_segment or restore_quiz,
    -- returned unchanged when the operation is sent again.
    outcome      TEXT,
    new_quiz_question_count  INTEGER CHECK (new_quiz_question_count >= 1),
    new_quiz_questions_hash  BIGINT,           -- two's-complement i64, like quizzes.questions_hash
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, device_id, device_seq),
    CHECK ((status = 'rejected') = (reason IS NOT NULL)),
    CHECK (status = 'applied' OR num_nonnulls(outcome, new_quiz_question_count,
                                              new_quiz_questions_hash) = 0),
    CHECK ((new_quiz_question_count IS NULL) = (new_quiz_questions_hash IS NULL))
);
CREATE INDEX sync_operations_received_at ON sync_operations (received_at);

-- Per device, the device_seq below which every operation is known to have been
-- acknowledged: raised to the lowest device_seq of each request that carries
-- operations. An operation below it with no record is answered applied and not
-- applied again.
CREATE TABLE sync_devices (
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    UUID NOT NULL,
    acked_below  BIGINT NOT NULL DEFAULT 1 CHECK (acked_below >= 1),
    PRIMARY KEY (user_id, device_id)
);

-- Records of purged cascades and quizzes, so other devices remove them. Pruned after 30 days.
CREATE TABLE sync_tombstones (
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    entity      sync_entity NOT NULL,
    entity_id   UUID NOT NULL,
    seq         BIGINT NOT NULL,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, entity, entity_id)
);
CREATE INDEX sync_tombstones_user_seq ON sync_tombstones (user_id, seq);
CREATE INDEX sync_tombstones_deleted_at ON sync_tombstones (deleted_at);

-- Export download tokens that have been redeemed, so a token is used once
-- whichever task receives it. The token itself is a signed PASETO; only its
-- spent jti is stored. Pruned by the purge task once expired.
CREATE TABLE export_tokens_spent (
    jti         UUID PRIMARY KEY,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX export_tokens_spent_expires_at ON export_tokens_spent (expires_at);

-- -------------------------------------------------------------------------
-- Catalog load status per backend instance (see Loading changes into
-- running servers). An instance writes a row when it has built an item's
-- index and refreshes heartbeat_at every 60 seconds; rows older than
-- 3 minutes belong to a dead instance and are ignored, then pruned.
-- -------------------------------------------------------------------------

CREATE TYPE catalog_item_kind AS ENUM ('letter_distribution', 'lexicon', 'leave_set');

CREATE TABLE catalog_instance_status (
    instance_id   UUID NOT NULL,                 -- minted at startup
    item_kind     catalog_item_kind NOT NULL,
    item_id       INTEGER NOT NULL,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, item_kind, item_id)
);
CREATE INDEX catalog_instance_status_heartbeat ON catalog_instance_status (heartbeat_at);
```

Notes on the schema:

- **No JSONB.** Filter parameters are typed columns, and a per-type `CHECK`
  guarantees each stored condition has exactly the parameters its type uses.
  The AND / OR tree is `search_groups` rows, with group 0 at the top; group
  depth, the 100-row total and non-empty groups are checked by the application.
  The Rust `ConditionKind` enum is loaded from these rows and written back to
  them. A round-trip test (see [Testing](#testing)) covers all 23 types and the
  group tree. Sync
  operation payloads are not stored at all; only each operation's id, type and
  result are kept, the result including the outcome, count and hash a finish
  or restore reported, so a repeat gets the same answer.
- **The cascade stack is enforced by the database where it can be.** At most one
  active quiz per level, exactly one Source quiz, which is the only quiz that
  can be at Level 1 and is always active, at most one quiz per (parent quiz,
  attempt, run boundary), a segment-chain quiz always on Drill progression with
  no segments, and
  `depth` at least 1.
- **Which clock stamps a row.** `cleared_at`, `trashed_at` and `completed_at`
  are set to the server's `now()` when the operation that causes them is
  applied, never from the operation's `at`, so the purge clocks and the
  Complete badge count from when the server learned of the change: a finish
  played offline three weeks ago still gets a full retention period. Both
  `last_activity_at` columns take `greatest(existing, clamped at)` instead, so
  late-synced old work never lowers them. They
  are stamped by `grade`, `finish`, `finish_segment`, `restore_quiz` and
  `restore_cascade` (the cascade's by all five, the quiz's by the first three
  and by `restore_quiz` on the restored quiz) and never by cursor moves,
  option changes, trashing or purging, so
  the Cascades page ordering reflects when the studying happened, not when it
  synced (the download window is judged on each device from its own last-open
  times). Only `graded_at`, `cursor_moved_at`,
  the options timestamps and `finished_at` carry device time
  for their own comparisons.
- **Quiz options are copied, never referenced.** `cascades` holds what new
  quizzes start with and `quizzes` holds what each quiz actually uses, so
  changing a cascade's options can never rewrite the rules a quiz in progress is
  being played under. Both sets of columns are plain typed columns with the same
  names, so the copy is one `INSERT … SELECT`.
- **Tiles are validated by the application.** A `CHECK` cannot parse MAGPIE
  notation against a distribution, so the upload validator guarantees:
  - every word parses into 1–15 non-blank tiles of its lexicon's distribution
  - every leave parses into 1–6 tiles of its lexicon's distribution, within bag
    counts, written in canonical order, and its value's absolute value is at
    most 1,000,000, so the shared rounding never leaves 64-bit range
  - a distribution's positions run 0..n−1 with no gaps, and no `letter` or
    `blank_letter` is longer than 8 bytes (the schema checks the bytes; the
    upload reports the line), and no `blank_letter` equals another tile's
    `letter`, so upper-cased typed text maps to one tile
- **Catalog deletion is refused while in use.** References to
  `letter_distributions`, `lexicons` and `leave_sets` from other catalog rows,
  cascades and search conditions have no `ON DELETE` action, so deleting a
  referenced item fails. Deleting an unreferenced lexicon or leave value set
  cascades to its words or values. The admin API checks references first so it
  can explain the refusal.
- **Deleting an account** is a single `DELETE FROM users`. Everything the user
  owns cascades from `users`. References between user-owned rows
  (`saved_searches.spec_id`, `cascades.spec_id`) use the default `NO ACTION`,
  which Postgres checks at the end of the statement. Cascaded deletes of both
  sides therefore succeed, while deleting a spec that is still in use fails.
  Catalog items the user uploaded stay, with `uploaded_by` set to `NULL`.
- **Purging a cascade** deletes its question index, quizzes, questions and
  attempts by cascade. In the same transaction, the application deletes the
  cascade's spec, which nothing else ever references because saved searches and
  Duplicate each take their own copy, writes tombstones for the cascade and
  each quiz, bumps the user's sync sequence, and takes the cascade's
  `storage_bytes` off `users.storage_bytes`.
- **The 300,000 ceiling** lives in `cascades.question_count`,
  `quizzes.question_count`, `quiz_attempts.question_count` and the two
  `segment_size` columns (`BETWEEN … 300000`), and in `quiz_cards.first_idx`
  (`BETWEEN 0 AND 299999`), so no configuration can exceed it.
- **Storage figures** (`cascades.storage_bytes`,
  `saved_searches.storage_bytes`, `users.storage_bytes`) are never negative,
  and `users.storage_limit_bytes`, when set, is not either (see
  [Storage limit](#storage-limit)).
- **Invariants left to the application** because a `CHECK` cannot see other
  rows. Integration tests and the shared rule vectors cover each one.
  - `question_idx < cascades.question_count`, and `position < quizzes.question_count`
  - `quizzes.user_id` and `quiz_attempts.user_id` equal their cascade's and
    quiz's `user_id`, and the spec belongs to the same user
  - `cascades.depth` equals the number of active quizzes, and the active levels
    are exactly `1..depth`. **Nothing bounds `depth`**: under Ladder a finish
    with any miss adds a level, so a user who keeps missing the same question
    keeps adding one, each costing a quiz row and its question rows. That is
    left uncapped on purpose — refusing a descent would be the one place a
    finish could fail for a reason the user cannot act on, and every level costs
    a full graded attempt — so the display collapses instead of the rule
    refusing (see [CascadeLadder](#frontend))
  - the counters on `quizzes` match its questions' grades
  - `search_conditions.entries` is set exactly on `in_word_list` conditions,
    its entries are canonical for their spec's `quiz_type`, and one spec holds
    at most 300,000 of them across all its rows
  - every `search_groups` row other than group 0 and every condition has a
    parent that exists, groups nest at most 4 deep, no group is empty, and
    `order_in_group` is unique among a group's children
  - `question_key` exists in the cascade's lexicon or leave value set
  - an `in_lexicon` condition uses `other_lexicon_id` in a cascade's spec and
    `text_value` (the lexicon's name) in a saved search's spec, never the other
    way round; a save converts the id to the name, and creation resolves the
    name back to an id, refusing a name that no longer exists
  - an `in_lexicon` condition's `other_lexicon_id` shares the letter
    distribution of the lexicon the spec is searched against
  - `word_count` and `leave_count` match their rows
  - `cascades.storage_bytes` is what the [storage formula](#storage-limit)
    counts from the cascade's live rows, `saved_searches.storage_bytes` its
    spec's, and `users.storage_bytes` the sum of the user's cascades' and saved
    searches' figures, all changed in the transaction that changes the rows;
    the purge task recounts the users' totals on every run and corrects drift
  - an account's total stays within its limit through every creation, Start
    over and saved search, though finishes may take it past (nothing bounds
    how many cascades or saved searches it holds)
  - every input action has at least one binding
  - a segment quiz's `origin_segment_end` is a multiple of the parent's segment
    size at the time, is less than the parent's `question_count`, and its
    questions are exactly the questions its parent had graded missed in
    positions from the parent's `run_start` at the time up to, but not
    including, that boundary
  - `segment_chain` is set on every quiz with origin `segment`, on every
    replacement of a `segment_chain` quiz, and on nothing else
  - a quiz waiting because of a segment descent has its cursor and `run_start`
    at that boundary
  - `peak_depth` is the greatest `depth` the cascade has had since its last
    `completed_at`, and `attempts_since_completion` the number of attempts
    finished since then, on any level, **whether or not the quizzes that held
    them still exist**. Neither is derivable from the rows that survive: the
    purge task deletes a cleared quiz's `quiz_attempts` rows a retention
    period after it was cleared, and nothing records the depths a cascade
    passed through. Both are maintained only by the
    [rule functions](#rule-implementation) and never recomputed, so the
    invariant test checks them against the operation history and never against
    the surviving `quiz_attempts` rows
  - `shuffle_seed` reproduces the quiz's positions through the shared shuffle
  - a quiz's options were copied from its cascade when it was created, which
    only the creating code can guarantee, so the rule vectors check it

### Purge task

Each backend instance runs an hourly background task. It first takes
`pg_try_advisory_lock`, so only one instance purges at a time. It works one
user per transaction, and within a user it locks the user row first (the
`sync_seq` bump) and only then touches that user's cascades and quizzes, the
same order a sync takes, so a purge and a sync for one user never deadlock.
Purging a cascade is one `DELETE` per table by cascade id, and the
[scale test](#scale-tests) holds a 300,000-question purge to a budget.

**A run is bounded per user.** One transaction purges at most
`PURGE_MAX_QUIZZES_PER_USER_PER_RUN` quizzes (5,000 by default), oldest
`cleared_at` first, and leaves the rest for the next run. The bound is there
because the work is not spread out in time the way the retention period
suggests: one segmented attempt can clear 60,000 chain quizzes within hours
(see [Quiz options](#quiz-options)), so they all age out in the same hour, and
one transaction deleting them all would hold the user row — which every sync
for that user waits on — long enough for those syncs to reach the statement
timeout and be answered `503`. Capped, a Trash that large drains over a few
hourly runs while the user keeps syncing, and the Trash's purge dates stay
true to within those runs. The cap counts the cleared quizzes a run purges **on
their own**, each of which costs its own delete and tombstone. A **trashed
cascade is still purged whole**, since half a cascade is not a state the Trash
has, and it is cheap for its size — bulk statements by cascade id, which the
[scale test](#scale-tests) budgets at 300,000 questions — but a run that has
reached its cap starts no further cascade and leaves it for the next. Then
it:

- **purges** cleared quizzes whose `cleared_at` is older than
  `TRASH_RETENTION_DAYS` and whose cascade is not trashed, and trashed cascades
  whose `trashed_at` is older than that together with every quiz in them,
  writing tombstones and bumping each affected user's sync sequence, and
  taking what each held off its cascade's and its user's
  [storage](#storage-limit)
- **recounts** every user's `storage_bytes` from their cascades' and saved
  searches' figures, and for any that drifted, recounts again under the user
  row's lock, logs the difference and corrects it
- **prunes** `sync_operations` and `sync_tombstones` older than
  `SYNC_RETENTION_DAYS`, raising each affected user's `sync_floor_seq` to the
  highest tombstone sequence it removed
- **deletes** accounts that were never confirmed and whose last confirmation
  code expired more than 7 days ago, so an abandoned registration does not hold
  an email address forever
- **prunes** `export_tokens_spent` rows past their `expires_at`
- **prunes** `catalog_instance_status` rows whose heartbeat is older than
  3 minutes, left by instances that have stopped

**One failure does not stop a run.** Each step runs whatever the others did,
and a step that works account by account goes on to the next account when
one fails; every failure is logged, with the account, and the run is then
reported as failed. One account's bad row therefore cannot keep every other
account's Trash from being purged, or the pruning and the recount from
running, hour after hour. What a purge frees is counted from the rows with
the current sizes, so a figure never goes below zero: taking more off than
was once added would fail the column's CHECK, and the recount corrects the
total either way.

---

## Authentication

The flows are the conventional ones, built directly on Axum:

- **Register** (`/register`): username, email and password. The server
  validates all fields and returns `400` with **every** field error at once.
  **The strength rule**, which a reset's new password meets too: 8 to 128
  characters, then a `zxcvbn` score of at least 3, scored against the
  username, the address and the address's local part. zxcvbn matches each
  input whole, so the address alone would let `jsmith` through for
  `jsmith@example.com`. A crafted password costs zxcvbn close to a second, so
  scoring runs on the blocking pool in turns of its own, at most two at once:
  a flood of scorings waits on scoring alone, never on sign-in's hashing or
  any other request. A request waits at most 10 seconds for a turn and is
  otherwise answered `503` with `Retry-After: 10`, which
  `/reset-password/confirm` shows as the server being busy checking passwords.
  A taken username is reported as a field error, since usernames are not secret,
  and that check runs before anything below, so a `400` never also sends an
  email. An email already in use gets the same response as a successful
  registration.
  **Registration closes at `MAX_ACCOUNTS`, 750 accounts.** The number is a
  constant in the backend (`backend/src/auth/routes.rs`), deliberately not a
  setting: raising it is a release. It counts accounts that hold a place:
  confirmed, or with a confirmation code still valid. The count and the check
  run inside the registration's transaction, after it takes a
  transaction-scoped advisory lock that every registration takes in turn, so
  concurrent registrations cannot pass the limit together. At the limit every
  registration gets `403 registration_closed` and sends nothing, a new address
  and a known one alike; the check runs before the address is looked up, so a
  closed site reveals nothing about which addresses have accounts. The
  register page says "Acrodont isn't taking new accounts right now." A stack
  with `DEV_LOGIN` on, which only a local one can have, does not apply the
  limit, since the end-to-end journeys register an account per spec on a stack
  kept between runs.
  The password is hashed on every path, whether or not the hash is stored, so
  the response takes the same time whichever branch runs.
  If that email belongs to a **confirmed** account, its owner is emailed a
  notice instead. If it belongs to an account that was **never confirmed**: while
  its code is still valid, a fresh code is sent to the same address and both
  stay valid until they expire, so a stranger who knows the address cannot keep
  the real registrant from confirming; once the code has expired, the old
  account row is deleted (its dependents go by cascade) and the new
  registration creates a fresh one through the ordinary path, with a new id,
  username and password, and a fresh code is sent. A username held by an
  unconfirmed account is taken while that account's latest code is valid and
  free once it has expired, in which case the old row is deleted as above. So an expired code never
  strands an address, and either way the form cannot be used to find out which
  emails have accounts. The password is hashed with Argon2. A confirmation code
  (32 random bytes) is emailed, and only its SHA-256 is stored, with a 24-hour
  expiry. At most three confirmation, notice or reset emails are sent to one
  address in 24 hours per requesting IP, and twenty per address in all; further
  requests get the same response and send nothing, and the per-IP scope means
  a stranger cannot use the cap to block the address's owner. A
  registration that replaces an expired unconfirmed account still replaces it
  when the cap has been reached; its code goes out with the next registration
  after the window. Registration inserts only the user row: it takes no sync
  sequence, so a new account's `sync_seq` starts at 0, the column default, and
  its first pull carries nothing until it has a cascade.
- **Confirm email** (`/confirm-email?code=…`): the page submits the code; on
  success the user is sent to `/login`, which says "Your email address is
  confirmed. Log in to start." Login is refused with `403` until the
  email is confirmed.
- **Login**: by **username** and password, never by email, so the `403` for an
  unconfirmed account reveals nothing that the public username does not. Rate
  limited on **failed** attempts, per IP and per username
  (`LOGIN_FAILURES_PER_IP_PER_MINUTE` and
  `LOGIN_FAILURES_PER_USERNAME_PER_MINUTE`, 10 each): a request takes a token
  from both buckets **before** any Argon2 verify runs and is refused with
  `429` when either is empty, so no guess past the limit ever costs a hash,
  and it gives both tokens back unless the verify fails. Taking first is what
  makes the limit hold for requests that arrive together: a bucket looked at
  before the verify and spent after it lets a whole burst through. A
  successful login spends nothing, because guessing is what the limits
  exist to stop, and a club or tournament room logging in together from one
  address must not lock itself out; more than ten of its logins in the air at
  the same instant can be told `429` for a second, since each holds a token
  while its verify runs. A username no account could have (not 3 to 32
  letters, digits or underscores) is answered `401` at once: it costs no
  hash, takes no token and is never kept as a bucket's key, however long it
  is. **Argon2 runs in turns**, at most four hashes or verifies at once on
  the blocking pool, for every endpoint that hashes: each holds 19 MiB while
  it runs, so a burst of sign-ins is otherwise gigabytes at once. A request
  waits at most 10 seconds for a turn and is otherwise answered `503` with
  `Retry-After: 10`; a login turned away so keeps its tokens.
  The per-username limit lets anyone who
  knows a username keep its owner out for a minute at a time by failing on
  purpose; that is accepted over unlimited guessing against one account. The
  other auth endpoints that need no session — register, confirm-email,
  reset-password and its confirm — share one per-IP bucket,
  `AUTH_RATE_PER_IP_PER_MINUTE` (30), on top of the email caps under Register
  and the reset's own limits under Password reset.
  `GET /api/auth/me` needs a session and is not on a per-IP bucket, and neither
  is logout, whose queued retry already honours `429`. On success the server sets:
  - a PASETO **v4.local** session token (32-byte key from
    `SESSION_SIGNING_KEY`) in an `httpOnly`, `SameSite=Lax` cookie named
    `acrodont_session`, `Secure` in production, with a 30-day TTL. `Lax`
    rather than `Strict` so that a cascade link opened from an email or a chat
    arrives signed in instead of triggering a spurious "Log in to sync"; CSRF
    protection comes from the double-submit token, not from SameSite
  - a CSRF cookie, readable by scripts (not `httpOnly`), for double-submit on
    every state-changing request. It carries the **same TTL as the session
    cookie**, never a browser-session lifetime, and is re-set on every
    response that accepts or renews a session, `GET /api/auth/me` included,
    which the app calls at startup. Otherwise a browser restart would drop it
    while the 30-day session cookie survived, and every sync would fail CSRF
    with no `401` to show **Log in to sync**

  The token carries the user id and the account's `session_generation`. Every
  request re-reads the user row, including `is_admin`, so a deleted account, a
  bumped generation, or a revoked admin flag takes effect immediately. The long
  TTL is deliberate: a device that has been offline for weeks can still sync as
  soon as it reconnects. The TTL slides: a sync made in the last seven days
  of a cookie's life is answered with a fresh cookie of the full TTL, so an
  active user is never signed out for age, and a device that stays offline
  past the TTL sees **Log in to sync** with its local data intact.
- **Password reset** is how a password is set by someone who cannot sign in;
  a signed-in user changes it on `/account` (below).
  - **Asking** (`/reset-password`, from "Forgot password?" on `/login`)
    answers `202 {}` whether or not the address has an account, and the lookup and the email happen after the
    response, so both branches take the same time. If the address belongs to
    a confirmed account, a 30-minute single-use token is emailed (only its
    SHA-256 is stored), and the mail carries the account's username too:
    signing in asks for it, and someone who has forgotten a password may have
    forgotten that as well. The mail goes only to the address's owner.
    Asking is limited to `RESET_RATE_PER_HOUR` (5) an hour **per caller** and
    **per address named** (lower-cased), on top of the per-IP auth bucket and
    the email caps under Register. Something that is not an address gets the
    same `202` and goes no further: it is never kept as a bucket's key. The first bounds bulk probing; the second
    stops one address being buried in reset mail from many sources. Past
    either, the answer is `429` with `Retry-After`, alike for every address,
    so the limit reveals nothing about which addresses have accounts.
  - **Setting the new password** (`/reset-password/confirm?token=…`) reads
    the link first, without a lock (hash match, unused, unexpired): a wrong or
    spent link is `400 invalid_token` and costs neither a score nor a hash.
    It then takes a scoring turn and charges **the link's own bucket**,
    `RESET_RATE_PER_HOUR` an hour, whoever sends it. A link refused a weak
    password still works, so without that bucket a link replayed from many
    addresses would be a queue of scorings that no per-address limit bounds;
    charging only once a turn is held means a request turned away busy
    (`503`) spends none of the owner's tries. The password is held to the
    strength rule against the account's username and address, then hashed,
    both outside any transaction, so neither wait holds a lock. Then one
    transaction locks the account row (`FOR NO KEY UPDATE`; an account
    deleted meanwhile leaves nothing to lock, and the link is
    `invalid_token`), spends the token (checked again, so a link spent
    meanwhile is `invalid_token` too), spends **every other outstanding reset
    token** for the account, so an earlier link cannot be replayed, stores the
    new hash and increments `session_generation`. That signs out every
    session, an attacker's included: a reset is what someone does who
    suspects another person has access. The `204` clears the caller's session
    and CSRF cookies as well, and the page forgets any session it holds and
    goes to `/login` with no message: signing in with the new password is the
    confirmation.
- **Change password** is on `/account`: the current password and the new one
  (`POST /api/account/password`). Nothing is typed but the two passwords and
  no mail is sent: the session says whose account it is. A wrong current
  password is a `current_password` field error; the new one is held to the
  strength rule against the account's username and address
  (`new_password`). Tries are limited to `RESET_RATE_PER_HOUR` an hour per
  account, since each costs a hash and maybe a scoring, and is a guess at the
  password by whoever holds the session. The password re-entry of Sign out
  everywhere and of Delete account draws on the same bucket, for the same
  reason: past it, each answers `429` with `Retry-After`. A try is counted
  once its Argon2 turn is held, as a link's is once its scoring turn is, so a
  request turned away busy (`503`) spends none. A change stores the
  new hash, spends every outstanding reset token (they were asked for under
  the old password), and, like Sign out everywhere, bumps
  `session_generation` and issues a new session to this device: every other
  session is signed out and this one keeps working.
- **Sign out everywhere** and **delete account** (each with password
  re-entry) are on `/account`. Sign out everywhere bumps `session_generation`,
  which signs out every other session, and issues a new session to the current
  device, since the user has just re-entered the password here and
  "everywhere" means everywhere else. A device that wants to be signed out as
  well uses Log out.
  **Deleting the account clears this device's copy of it.** On a `2xx` the app
  runs the same **Remove this account's data from this device** path the logout
  dialog offers (see
  [Authentication while offline](#authentication-while-offline)): the per-user
  database and the `accounts` row go, with no queued logout, since the session
  is already void, and the app lands on the log-in page. Without that step the
  `401`-keeps-everything rule would apply to an account that can never log in
  again, leaving its question keys and downloaded answers on the device for good. Another device
  holding that account's data learns of the deletion only when a sync answers
  `401`, where the ordinary rule applies: it keeps its data and shows
  **Log in to sync**, and its Account page still offers logging out with the
  data removed.
  **An account replaced under the same username goes too.** Usernames are
  unique, so another account with data here under the signed-in account's
  username was deleted, or its server reset (a local stack's
  `./scripts/dev.py --reset` makes a new `dev` each time): at every sign-in
  and app start the device deletes that account's database and row, which
  would otherwise sit on the device forever, since nothing can sign in
  to it again.

Security generally:

- CSRF double-submit on every cookie-authenticated `POST`, `PUT`, `PATCH` and
  `DELETE`, including `/api/sync`. The one exception is
  `POST /api/auth/logout` **when the request carries no session cookie**, which
  is not a cookie-authenticated request: it has no session to act on and nothing
  to forge, and refusing it would strand the
  [queued logout](#authentication-while-offline) made by a device whose cookies
  have both expired. With a session cookie present it is checked like any other
  write, which is the ordinary case for that queued logout, since the cookie it
  exists to clear is still in the browser; the app sends the token from the CSRF
  cookie, whose TTL is the session cookie's.
- `/api/admin/*` requires `is_admin`, and non-admins get `404`, so the admin
  surface is not advertised.
- `governor` rate limits on auth endpoints, and per-user limits on search,
  preview, cascade creation, saving and loading a saved search, sync, opening the
  [event stream](#telling-the-other-devices) (`SYNC_STREAM_RATE_PER_MINUTE`, with
  `SYNC_STREAMS_PER_USER` open at once), export, admin uploads, and
  the card, question-list and grades pages, which are the expensive calls. Each
  has a named refill rate in [Configuration](#configuration):
  `DOWNLOAD_RATE_PER_MINUTE` for the one shared bucket over the card,
  question-list and grades pages, `SEARCH_RATE_PER_MINUTE` for search, preview,
  cascade creation, saving a search and loading one — `GET /api/searches/:id`
  reads up to 300,000 word-list rows and returns megabytes, so it is as
  expensive as the preview beside it — `EXPORT_RATE_PER_MINUTE`,
  `ADMIN_UPLOAD_RATE_PER_MINUTE` — a 100 MB body with a 120-second synchronous
  validation behind it is the most expensive call in the plan, admins are few,
  and ten a minute is far more than any real cataloguing session needs — and
  `SYNC_RATE_PER_MINUTE`. The download default of 120 is what this plan's
  download claims rest on: reopening one 300,000-question cascade with two
  active quizzes costs at most about 51 requests (six grades pages per quiz, six
  index-list pages for the non-source quiz, whose list is the only one ever
  fetched, three keys pages and thirty answer pages), so one such reopen
  fits inside a minute; a first sync
  with several kept cascades fills over several minutes behind the download
  progress; and the keys-only pass costs a tenth of the requests, since its
  pages hold ten times as many rows, so ten cascades' keys fit in the bucket
  that one cascade's answers would have filled. In bytes the pass is about a
  quarter of cards without definitions, not a tenth, so it is the request
  count and not the bandwidth that this default is sized against. The buckets are in memory, and each
  instance forgets a bucket once it has refilled (on the purge task's timer,
  with the email caps' addresses outside their 24 hours), so the memory they
  take follows recent callers and not every caller there has ever been. Every limit in this plan holds per
  backend instance and the deployment's task count multiplies it: with two
  tasks the login limit is effectively twenty failures a minute per username. Until a
  shared limiter is needed, the Terraform module caps the service at two
  tasks and the runbook states the multiplier; moving the buckets to a shared
  store later changes no protocol.
- **The two endpoints that need no session are limited per IP**, by
  `CATALOG_RATE_PER_MINUTE`: `GET /api/lexicons` and
  `GET /api/letter-distributions/:name`, sized for a room of devices behind one
  address rather than for one device (see [Configuration](#configuration)). Every other limit above is per user and
  therefore needs a session, and these two read the database on every call —
  the distribution deliberately straight from `letter_distribution_tiles` and
  never from an in-memory index, so nothing caches it — which would otherwise
  leave an unauthenticated client free to spend the same connection pool every
  signed-in user's sync and search share. They key on the same
  `X-Forwarded-For` entry the login limits do.
- `429` responses carry `Retry-After`, and **every client of a limited endpoint
  honours it**, not only the sync engine: the download manager pauses that
  cascade's fetches until then, keeping its progress indicator as it was, and
  the builder's preview treats a `429` exactly as it treats a `503`. This is
  not an edge case on the download path — the bucket above is deliberately
  sized so that a first sync with several kept cascades fills over several
  minutes, so a `429` is the ordinary signal to wait, and a client that read it
  as a failed page would freeze a download or spin against the limit. **Create
  Cascade, Duplicate and Save Search… honour it too**, retrying after
  `Retry-After` with the same body exactly as they retry a `5xx`, which their
  device-minted ids make safe; they share the search bucket with the builder's
  preview, and the preview holds two slots back for them (see
  [Creating a cascade](#creating-a-cascade)).
- `TRUSTED_PROXY_HOPS` controls which `X-Forwarded-For` entry per-IP limits key
  on (1 behind the ALB and behind the compose Nginx).
- **Every authenticated request names its account.** The app sends the user
  id it is running as in `X-Acrodont-User`, and the server answers `401` without
  applying or reading anything when that id differs from the session's user or
  is missing, so a cookie replaced by a login in another tab, or planted by a
  login CSRF, can never make one account's device act on another's data (see
  [Authentication while offline](#authentication-while-offline)). Logout and
  `GET /api/auth/me` are exempt, and the export download is authorised by the
  token its header-checked token request issued (see [API](#api)).
- Every cascade, quiz, saved-search and sync query filters by
  `user_id`. Another user's resource returns `404`, not `403`, and in a sync
  operation it is rejected as "not found".

---

## API

All endpoints are JSON under `/api`, except the multipart admin uploads, and a
JSON endpoint refuses a request whose `Content-Type` is not `application/json`
with `415`, which is what keeps a cross-site form, which cannot send that type
without a preflight, from posting to login or registration, the two writes the
CSRF token does not cover. Every request that needs a session also carries
`X-Acrodont-User`, the account the calling tab runs as, and a mismatch with the
session is a `401` (see [Security](#authentication)). Three requests are handled
differently. The export download, a navigation that cannot set a header, is
authorised by the single-use token the header-checked
`POST /api/cascades/:id/export-token` issued. Logout carries no header and is
**exempt**, since it can only clear the cookie it receives and never reads or
writes an account's data, and the queued logout runs, by design, while no tab is
signed in as anyone. And `GET /api/auth/me` is **exempt**: it changes nothing and
reports whose cookie the browser holds, which is exactly what the startup
comparison needs to read and what lets a client holding only the session cookie
recover its CSRF token. Every
endpoint except `auth/*`, `/health`, `GET /api/lexicons` and
`GET /api/letter-distributions/:name` requires a session. Those two are limited
per IP by `CATALOG_RATE_PER_MINUTE` instead of per user (see
[Authentication](#authentication)), since a per-user bucket needs a session.

JSON request bodies are accepted up to `API_MAX_BODY_BYTES` (default 16 MB),
enough for a filter tree holding a 300,000-entry In Word List; Axum's default of
2 MB is not. Admin uploads have their own limit.

### Auth and account

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create an account; sends the confirmation email |
| `POST` | `/api/auth/confirm-email` | Confirm with the emailed code |
| `POST` | `/api/auth/login` | Start a session. `429` once the caller's address or the username has no failure token left; `503` with `Retry-After: 10` when no Argon2 turn comes within 10 seconds (see [Authentication](#authentication)) |
| `POST` | `/api/auth/logout` | Clear the session cookie **and the CSRF cookie**, so no token outlives the session it was issued with; login re-sets both. The token is stateless, so a copy of it stays valid until its TTL; a user who suspects a copy uses **Sign out everywhere**. This is the one endpoint that needs **neither a session nor a CSRF token** *when no session cookie arrives with it*: there is then nothing to clear and nothing to forge, and it answers `2xx`, so a device offline past both cookies' TTL is not left retrying forever. With a session cookie it is CSRF-checked like any other write, which is the ordinary state of the [queued logout](#authentication-while-offline). It is **exempt from the account-binding `X-Acrodont-User` check**: the queued logout is sent while no account is signed in, so it could never satisfy it, and a `401` would clear its flag with the cookie still alive. The queued logout runs when no account is **signed in**, not when no cookie is held, and the `httpOnly` session cookie it exists to clear is still in the browser, so the app sends the double-submit token with it. Either way the answer is a `2xx`, never a `401`-or-`403` guess |
| `POST` | `/api/auth/reset-password` | Body `{ email }` → `202 {}` whether or not the address has an account; the lookup and the reset email (with the account's username) follow the response. `429` past `RESET_RATE_PER_HOUR` per caller or per address named, alike for every address (see [Authentication](#authentication)) |
| `POST` | `/api/auth/reset-password/confirm` | Body `{ token, password }` → `204`, clearing the caller's session and CSRF cookies. The link is checked first (`400 invalid_token`, before any scoring), then the link's own `RESET_RATE_PER_HOUR` bucket (`429`), then the strength rule against the account's username and address (`400` field error on `password`; the link still works); `503` with `Retry-After: 10` when no scoring turn comes within 10 seconds. Spends every outstanding token of the account and bumps `session_generation`. The way to change a password without a session; signed in, it is `POST /api/account/password` |
| `GET` | `/api/auth/me` | `{ user_id, username, is_admin, trash_retention_days, max_quiz_questions, storage_bytes, max_storage_bytes }` or `401`, where `storage_bytes` is the account's [storage](#storage-limit) and `max_storage_bytes` its effective limit (`users.storage_limit_bytes` when set, otherwise `MAX_STORAGE_BYTES_PER_USER`), both numbers. Login and dev-login answer with the same body. Exempt from the account-binding `X-Acrodont-User` check, since it only reports whose session cookie the browser holds, which the startup comparison reads. The retention period, the cap and the storage figures go into the `meta` store, so the Trash can show purge dates offline, the option forms validate segment size against the server's cap, and the Cascades page and the builder show the account's storage offline |
| `POST` | `/api/account/password` | Body `{ current_password, new_password }` → `204`. A wrong current password or a weak new one is a `400` field error. Stores the new hash, spends the account's reset tokens, bumps `session_generation` and re-issues this device's cookies, as Sign out everywhere does |
| `POST` | `/api/account/sign-out-everywhere` | Body `{ password }`. Bump `session_generation` and re-issue this device's session and CSRF cookies, so every other session is refused from its next request while this one keeps working. `429` past `RESET_RATE_PER_HOUR` passwords typed for the account, with Change password and Delete account |
| `DELETE` | `/api/account` | Delete the account (requires password; `429` past the same per-account bucket). On a `2xx` the device removes its own local copy of that account, as [Authentication](#authentication) describes |

A cascade's settings are read and written through sync, not a separate
endpoint. This device's settings stay on it, except those the user shares
with **all your devices**: they travel in the sync request's and response's
`device_settings` and are kept in `users.device_settings` (see
[Settings](#settings)).

### Catalog and search

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lexicons` | `[{ name, letter_distribution, word_count, leave_count, max_num_anagrams, max_order_rank, max_leave_num_anagrams, max_leave_order_rank }]`, where every `leave_` figure is `null` for a lexicon without leave values. The four maxima are the range [ceilings](#filter-reference) the client cannot derive for itself, all taken from the [index](#derived-attributes): `max_num_anagrams` is the largest `num_anagrams` over the words, and `max_order_rank` the size of the largest length bucket, which is the highest rank Probability Order and Playability Order can reach, with the two `leave_` figures the same over the leaves, by size. The other ceilings need no endpoint: the quiz type gives 15 or 6, `GET /api/letter-distributions/:name` gives the highest tile value behind Point Value's, and `word_count` and `leave_count` are the two limit filters', which rank a whole group's survivors together. Only items loaded by every live instance, per `catalog_instance_status`, are listed, so no listed item can fail on another instance. |
| `GET` | `/api/letter-distributions/:name` | `{ name, tiles: [{ letter, blank_letter, count, value, is_vowel }] }` in tile order (blank first), for parsing, display and the tile palette. Read straight from `letter_distribution_tiles`, never from an in-memory index, so it needs no `catalog_instance_status` gate and a device can fetch a distribution from an instance that is still indexing the lexicons built on it |
| `POST` | `/api/search/preview` | Body `{ lexicon, quiz_type, filters }` → `{ count, sample[], over_cap, storage_bytes }`, where `storage_bytes` (a number) is what a cascade made from this search would hold as created, by the [storage formula](#storage-limit) with the keys' real bytes and the spec, which is exactly what creation then stores, or `400` with `{ errors: [{ path, field, message }] }`, where `path` is the row's child indexes from the top group |
| `GET` | `/api/searches` | `[{ id, name, quiz_type, word_list_entries, created_at, updated_at }]`: the user's saved searches **without their trees**, with `word_list_entries` the tree's total In Word List entries, so the list **Load Search…** shows stays small however many 300,000-entry lists a user keeps (as many as fit in the account's [storage](#storage-limit)) |
| `GET` | `/api/searches/:id` | One saved search's whole tree, `{ id, name, quiz_type, filters }`, in the same shape `POST` accepts, In Word List entries included: what Load Search… fetches for the search the user picks, and rebuilds the form from. The `quiz_type` is what lets the builder flag an In Word List row on load. `404` for another user's or a deleted search |
| `POST` | `/api/searches` | Save `{ id, name, quiz_type, filters, overwrite? }`, where `id` is a device-generated UUID minted when Save is pressed and reused for any retry of that press, exactly as for [cascade creation](#cascades-and-sync): a request whose `id` the server already holds for this user returns that saved search unchanged, so a save whose response was lost is not refused on its retry as `name_taken` or `storage_limit` by its own first attempt, and an `id` held by another user is refused with `409`. `name` is required and 1–100 Unicode scalar values, otherwise a `400` field error. `quiz_type` is what the entries were canonicalised under and is stored on the spec. **The tree is validated as it is for a preview**, for everything that does not need a lexicon — the [group](#groups) rules, each type's parameters, negation, applicability to `quiz_type`, ranges against that type's floor and its **type-fixed** ceiling (Length, Number of Vowels and Number of Unique Letters at 15 or 6, Consists of at 100), canonical form and length, and the tree's [300,000-entry In Word List total](#filter-reference) — and a failure is `400` with the same `{ errors: [{ path, field, message }] }` shape, never a stored spec. What a save cannot check is whatever depends on the lexicon, since a saved search carries none and can be loaded against any: tile membership in a distribution, and the three ceilings a target sets — Point Value's (15 × the highest tile value), the order filters' (the target's largest bucket) and Number of Anagrams' (the target's largest count). Those rows are flagged on load and refused at creation. The builder also refuses to save while any row is **flagged** (see [Filter applicability](#filter-applicability-by-quiz-type)), naming the row, because a flagged In Word List row saved under the current type would record leave-canonical entries as `anagram`, or the reverse, and nothing afterwards could tell. A name the user already has answers `409` with `{ error: "name_taken" }` unless `overwrite` is `true`, which the UI sends after confirming; the overwrite deletes the replaced saved search and its spec and stores the new one under the request's `id`, so a retried overwrite is recognised by that `id` like any other save. The search's spec counts toward the account's [storage](#storage-limit) (`saved_searches.storage_bytes`): `409` with `{ error: "storage_limit", used, limit, needed }` when it does not fit, checked inside the transaction after locking the user's row, as creation's is, so two simultaneous saves cannot both take the last space; an overwrite needs only what it adds to the search it replaces, and one that adds nothing is never refused |
| `DELETE` | `/api/searches/:id` | Delete a saved search and its spec, locking the user's row first as a save does, and take its storage off the account's total |

`filters` is the top group. A group is `{ "op": "and" | "or", "children": [] }`
and a child is either a group or a condition, told apart by `op` versus `type`:

```json
{ "op": "and", "children": [
    { "type": "length", "negated": false, "min": 7, "max": 7 },
    { "op": "or", "children": [
        { "type": "includes_letters", "negated": false, "tiles": "Q" },
        { "type": "includes_letters", "negated": false, "tiles": "Z" } ] } ] }
```

Two more conditions:

```json
{ "type": "probability_order", "negated": false,
  "min": 1, "max": 1000, "lax": true }
```

```json
{ "type": "leave_value", "negated": false, "min": 10.0, "max": null }
```

`type` is one of `anagram_match`, `pattern_match`, `subanagram_match`, `length`,
`in_lexicon`, `in_word_list`, `num_vowels`, `includes_letters`,
`probability_order`, `limit_by_probability_order`, `playability_order`,
`limit_by_playability_order`, `num_unique_letters`, `point_value`,
`takes_prefix`, `takes_suffix`, `part_of_speech`, `definition`, `consists_of`,
`num_anagrams`, `front_inner_hook`, `back_inner_hook` or `leave_value`. Only the
parameters that type uses are accepted (the inner hook filters take none); any
extra field is a `400`. Every condition also carries `negated`, a boolean, which
is `true` only for the types the [Filter reference](#filter-reference) marks
negatable. The parameter fields, by type:

| `type` | Fields | Value form |
|---|---|---|
| `anagram_match`, `pattern_match`, `subanagram_match` | `pattern` | pattern tokens in canonical form, single spaces between them (`. W * M . S`) |
| `length`, `num_vowels`, `num_unique_letters`, `point_value`, `num_anagrams` | `min`, `max` | integers |
| `probability_order`, `limit_by_probability_order`, `playability_order`, `limit_by_playability_order` | `min`, `max`, `lax` | integers, and a boolean |
| `consists_of` | `tiles`, `min`, `max` | MAGPIE notation, and integer percentages 0–100 |
| `includes_letters`, `takes_prefix`, `takes_suffix` | `tiles` | MAGPIE notation |
| `in_lexicon` | `lexicon` | the lexicon's **name**, as in the preview and creation bodies; the server resolves it to an id for a cascade's spec and stores the name for a saved search's |
| `in_word_list` | `entries` | an array of entries, each in MAGPIE notation, canonical for the request's `quiz_type` |
| `part_of_speech` | `part_of_speech` | one of `adjective`, `adverb`, `conjunction`, `definite_article`, `indefinite_article`, `interjection`, `noun`, `preposition`, `pronoun`, `verb` |
| `definition` | `text` | free text, 1–500 characters, matched case-insensitively |
| `front_inner_hook`, `back_inner_hook` | — | — |
| `leave_value` | `min`, `max` | numbers, either one `null` for an open bound, not both |

These are the wire names on both sides; the Rust `ConditionKind` may name its
fields as it likes (`min_pct`, `max_pct`), but serialises to this table. The
[contract fixture](#contract-fixtures) that keeps `lib/filters.ts` and the
backend's condition schema in step is generated from this table, so the first
person to write it copies names rather than choosing them.

### Cascades and sync

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cascades` | Body `{ id, source_quiz_id, device_id, at, name, lexicon, quiz_type, clear_threshold, segment_size, progression, require_alphabetical, answer_mode, filters }`. `name` is required, 1–200 Unicode scalar values, and one the account's cascades do not already use, the Trash included (`400` on the field `name` otherwise, checked before the search); the device builds the default summary itself (see [Creating a cascade](#creating-a-cascade)). The cascade row carries the lexicon's `definitions_revision` and, for a Leave Value cascade, its leave values' `leave_values_revision` (`null` otherwise). `device_id` is recorded as `options_device_id` on the cascade and the Source quiz, so the creating device's option changes never compete on timestamps. `id` and `source_quiz_id` are device-generated UUIDs minted when the button is pressed and reused for any retry of that press, never regenerated on retry; a request whose `id` the server already holds for this user returns the existing cascade and Source quiz unchanged, so a lost response never makes a duplicate or counts its storage twice, and an `id` or `source_quiz_id` held by another user is refused with `409` (`invalid`), never that user's row. `at` is the device's timestamp, used for `options_changed_at` on the cascade and the Source quiz exactly as operations' `at` is, so the creating device's first option change is never `stale` against a server clock. Runs the search **before opening any transaction**, then in one short transaction locks the user's row, checks the [storage limit](#storage-limit) against what the new cascade will hold, stores the question index and shuffles the Source quiz with a server-generated seed, and returns `{ cascade, source_quiz, sync_seq }`, whose `cascade` carries `storage_bytes` as a pulled row does, and adds that to `users.storage_bytes`. A cheap check before the search refuses an account already at or over its limit without spending one (`needed` 0), and the lock therefore never covers the search's CPU or its wait for a `SEARCH_CONCURRENCY` permit, so a creation can never block the [purge task](#purge-task) on the same user's row for the length of a search. `source_quiz` carries its `shuffle_seed` rather than its positions: the device derives the Source quiz's order with the shared [shuffle](#deterministic-shuffles) over `idx` 0…count−1, and writes the cascade, the Source quiz and its question rows straight into its base stores from this response, so its first pull finds nothing to rebuild. `sync_seq` is informational; the device does **not** advance its sync cursor from this response, so its next sync pulls the rows the creation stamped. The cascade's private spec is stored with this request's `quiz_type`, which is what an In Word List row's entries were canonicalised under and what Duplicate copies. `422` if the search is empty or over the cap. `409` with `{ error: "storage_limit", used, limit, needed }` when the cascade does not fit (see [Storage limit](#storage-limit)). A `5xx`, such as a deadlock or timeout inside the creation transaction, is retried by the device with the same body, which the device-minted ids make safe, and so is a `429`, after `Retry-After`, since this endpoint shares `SEARCH_RATE_PER_MINUTE` with the builder's preview. The threshold, the three [quiz options](#quiz-options) and the answer mode are required, so an omitted one is a `400`: the builder sends the defaults every new cascade starts with (`CASCADE_SETTING_DEFAULTS`; see [Settings](#settings)). The other settings (`show_definitions`, `show_hooks`, `reveal_correct`, `leave_value_decimals`) are not in the request and take their column defaults; Duplicate copies all of them from the original. The Source quiz is created with a copy of the options. |
| `POST` | `/api/cascades/:id/duplicate` | Body `{ id, source_quiz_id, device_id, at }`, minted per press exactly as for creation and subject to the same repeat, timestamp and `options_device_id` rules. New cascade, named after the original with the next free number, with a copy of the spec and the same threshold and options; returns the same shape. Subject to the [storage limit](#storage-limit), with the original's questions and a copy of its spec as what it needs. |
| `GET` | `/api/cascades/:id/cards?from=<idx>&limit=<n>&hooks=<0\|1>&definitions=<0\|1>&keys=<0\|1>`, or `?idx=<i,j,…>&hooks=…&definitions=…` | Answer cards `[{ idx, key, answer }]` for question indexes `from`…`from+limit−1` (`limit` ≤ 10,000), or for the comma-separated indexes in `idx` (at most 1,000, returned in idx order; never with `from`, `limit` or `keys`, else `400 invalid_idx`) — the player's read-ahead, which asks for the next cards in its quiz's own order. With `hooks=1`, an Anagram answer's words carry `probability_order` (the word's rank by probability among the lexicon's words of its length), `front_hooks`, `back_hooks` and the booleans `front_inner` and `back_inner` (the word less its first, or last, tile is a word), and a Definition card carries `word`: `{ word, probability_order, front_hooks, back_hooks, front_inner, back_inner }` beside its answer. The device splits each row between its `questions` store (the `key`) and its `cards` store (the rest), so eviction can take the answer and leave the question (see [On the device](#on-the-device)). With `keys=1` the response is `{ from, keys: [...] }` — the keys alone, in idx order, since the range makes every index implied — and **`limit` ≤ 100,000**, which at about 10 bytes a key is roughly the size of one 10,000-card page: a 300,000-question cascade's keys are three requests where its answers are thirty, a tenth of the cost in the shared rate bucket, and about a quarter of the bytes of cards without definitions (see [Downloads](#on-the-device)). It is what the download manager fetches first, so a cascade becomes playable and self-gradable before its answers arrive; `hooks` and `definitions` are then a `400`. A Leave Value `answer` is a JSON number written as the shortest text that round-trips the stored `f64`, which `JSON.parse` reads back exactly. Card pages are served `Cache-Control: private, no-store`, because the device keeps every byte it fetches in IndexedDB and a second copy in the browser's HTTP cache would sit outside every budget the plan states; only the questions endpoint, whose index lists are small and refetched by the pending path, keeps immutable caching. Responses are compressed. |
| `GET` | `/api/cascades/:id/quizzes/:quiz_id/questions?from=<n>&limit=<n>` | The quiz's question indexes `[idx…]` in idx order, `limit` ≤ 50,000. A quiz's question set never changes, so it is served with the same immutable caching. Fetched when the device materialises a quiz; never part of a pull. `404` for another user's, a purged, or a Source quiz, whose indexes are implied. |
| `GET` | `/api/cascades/:id/quizzes/:quiz_id/grades?from=<idx>&limit=<n>` | The quiz's graded rows for the attempt its row names, which for a cleared quiz is the attempt it finished on (its grades each dated that finish, the quiz's `last_activity_at`, since a cleared quiz keeps no grade times), as the parallel arrays a pull uses, in idx order, with the quiz row's `attempt` and `shuffle_seed` so the device can tell whether they belong to the order it holds. `from` is an **index, not an offset**, as on the card pages: the response holds the graded rows whose `question_idx` is in `from … from+limit−1`, `limit` ≤ 50,000, so the device pages the index space by `from += limit` until `from` reaches the cascade's `question_count` and a sparse page — most of a quiz's questions may be ungraded — means nothing is left behind. The questions endpoint below reads `from` the other way, as an offset into a dense list, which is why the two are written `<idx>` and `<n>`. There is no `min_updated_seq` here, which only a pull's fast path needs; the device stamps these rows with the sequence of the sync it made before the fetch. Not cacheable. Fetched when the device materialises a quiz whose rows it dropped on leaving the download window; never part of a pull. If the device's quiz row names a different attempt or seed, the device discards the response, syncs and fetches again. `404` for another user's or a purged quiz. |
| `POST` | `/api/cascades/:id/export-token` | Body: the export's choices, as the query of the export row below. Checks the session, `X-Acrodont-User`, the cascade and quiz, and `EXPORT_RATE_PER_MINUTE`, answering `401`, `404` and `429` with `Retry-After` exactly as any other request does, which a navigation could not show the page; on success returns `{ url }`, the export URL with a token valid for **60 seconds and one use**, bound to this user and these choices: a PASETO under the HKDF-derived export key, which any task can verify and no session validator can decrypt, its use recorded in `export_tokens_spent` (see [Exporting words](#exporting-words)). The dialog navigates a hidden `<iframe>` to it at once, and mints a new one for any retry |
| `GET` | `/api/cascades/:id/export?scope=<cascade\|quiz>&quiz_id=<uuid>&which=<all\|correct\|missed\|ungraded>&format=<txt\|csv>&lines=<answers\|questions>&columns=<list>&order=<study\|alphabetical>&definitions=<0\|1>&hooks=<0\|1>&decimals=<0-3>&token=<token>` | The same file the device builds locally (see [Exporting words](#exporting-words)), streamed as `text/plain` or `text/csv` with a `Content-Disposition` filename. Used when the device doesn't have what the export needs. `token` is the single-use, 60-second token the row above issued for exactly these choices; it is the request's proof of account, since a download navigation cannot send a header, and an expired, reused or mismatched token answers `204 No Content`, which the dialog's hidden frame discards. `404` for another user's or a purged cascade, and for a `quiz_id` that is not this cascade's, has been purged, or is unknown. |
| `GET` | `/api/sync/events?user=<id>&device=<id>` | Server-Sent Events: a `changed` event whenever another device of the account syncs a change (see [Telling the other devices](#telling-the-other-devices)). The session cookie, and `user` in place of `X-Acrodont-User`, which `EventSource` cannot send; a mismatch or no session is a `401`. An open past the account's `SYNC_STREAM_RATE_PER_MINUTE` or with `SYNC_STREAMS_PER_USER` already open is a `429` with `Retry-After`. Ends after five minutes |
| `POST` | `/api/sync` | Body `{ device_id, app_version, cursor, page_token?, question_rows_for[], ops[], device_settings? }` (`device_settings`: values shared with all the account's devices, see [This device, or all of them](#this-device-or-all-of-them)), where `app_version` is the frontend build's **monotonic integer build number**, injected into the SPA at build time and compared numerically against `MIN_APP_VERSION` (see [Configuration](#configuration)) — never a hash or a semver string, so "too old to sync" is one comparison and raising the floor is one number in the task definition; the build's git hash is logged beside it for support but decides nothing. `question_rows_for` lists every cascade whose question rows this device holds or wants: in its window and not [budget-dropped](#on-the-device), kept automatically by size, **or whose base already holds question rows** (at most `MAX_QUESTION_ROWS_FOR`, 1,000 cascades, a protocol bound rather than a quota: a device holding rows for more splits them across requests; 1,001 is a `400`). The third case is what keeps a cascade the drop pass spared for its pending operations from going stale: the device holds its rows, so it must keep receiving their changes. A cascade the device holds no rows for and will not open is left out, and stays pending on the device. It is expected on every non-paged request, an omitted field means an empty list, ids that belong to another user or no longer exist are ignored, and the server omits `quiz_questions` rows for every other cascade. `cursor` is `null` for a full pull (a first sync or a resync), whose operations are pushed like any other's → `{ results: [{ op_id, status, reason?, outcome?, new_quiz_question_count?, new_quiz_questions_hash? }], changes: { cascades[], quizzes[], quiz_questions[], quiz_attempts[], tombstones[] }, sync_seq, next_page_token?, resync_required?, storage: { used, limit }, device_settings }`. `storage` is on every `200` and `426` response: the account's [storage](#storage-limit) and its effective limit, as numbers, read after the push so it counts what the push's finishes and purges changed; the device keeps them in `meta`. Pulled `cascades[]` rows carry `storage_bytes`, decimal text like every 64-bit value. `outcome` is set on an applied `finish` (a `finish_outcome`) or `finish_segment` (`drilled` or `continued`), and `new_quiz_question_count` and `new_quiz_questions_hash` whenever a quiz was created, reset or restored: the created quiz's when one was created, otherwise the reset or restored quiz's own; a repeated operation returns the recorded fields unchanged; pulled `quizzes[]` rows carry `questions_hash`. |

On the wire, `quiz_questions` changes are grouped per quiz as parallel arrays
(`question_idx[]`, `grade[]`, `graded_at[]`), with no positions: the device
derives the order from the quiz row's `attempt` and `shuffle_seed`. Each group
also carries **`min_updated_seq`**, the lowest `updated_seq` among that group's
rows in this page, as decimal text. One number per quiz per page, rather than
one per row, is what lets the rebase's [fast path](#the-sync-cycle) tell a page
that only echoes this push's own work from one carrying another device's grade,
without adding ten bytes to each of the millions of rows a large first sync
moves. A quiz's rows can span a page break now that a page is bounded by its
total rows, so the device **folds the minimum across every page of the pull**
and the fast path tests that folded value, never the last page's alone.
Every pulled `cascades[]`, `quizzes[]` and `quiz_attempts[]` row carries its own
**`updated_seq`**, and every tombstone its **`seq`**, both as decimal text, for
the same test: the fast path reads that column on those rows exactly as it reads
`min_updated_seq` on the question groups, and the sequence the device stamps its
base rows with is the response's, not the row's, so nothing else on the device
could stand in for it.

An operation on the wire:

```json
{ "id": "0192f0c4-…", "device_seq": 118, "seen_seq": 5120,
  "at": "2026-09-15T14:03:22.418Z",
  "type": "finish",
  "quiz_id": "0192f0a1-…", "attempt": 2, "attempt_seed": "1180591620717411303",
  "shuffle_seed": "9241873301934422881", "new_quiz_id": "0192f0c4-…" }
```

A grade, whose `at` is the one timestamp it carries and becomes `graded_at`:

```json
{ "id": "0192f0c2-…", "device_seq": 117, "seen_seq": 5120,
  "at": "2026-09-15T14:03:19.004Z",
  "type": "grade",
  "quiz_id": "0192f0a1-…", "attempt": 2, "attempt_seed": "1180591620717411303",
  "question_idx": 4411, "grade": "missed" }
```

Seeds are sent as decimal strings, because JSON numbers lose precision above
2⁵³. So are `questions_hash` and `new_quiz_questions_hash`, and the seeds and
hashes on pulled `quizzes[]` and `quiz_attempts[]` rows: **every 64-bit value
on the wire is the decimal text of the unsigned value**, never a JSON number,
and the device stores it as text or `BigInt`, never as a `number`. Postgres has
no unsigned 64-bit type, so every one of these is stored as its
**two's-complement i64** (see [Schema](#schema)) and converted back on the way
out: a seed or hash with its top bit set — about half of them — reads back
negative, and a server that serialised that `i64` would send a value no device
could match. The hash
contract vector fixes the wire form, with one fixture above 2⁶³ for exactly
this. `attempt_seed` is the seed of the attempt
the operation was played under and `shuffle_seed` the seed for what the
operation creates.

A segment descent and an options change on the wire:

```json
{ "id": "0192f0c9-…", "device_seq": 119, "seen_seq": 5121,
  "at": "2026-09-15T14:41:07.902Z",
  "type": "finish_segment",
  "quiz_id": "0192f0a1-…", "attempt": 2, "attempt_seed": "1180591620717411303",
  "segment_end": 100,
  "shuffle_seed": "4519004437287701013", "new_quiz_id": "0192f0c9-…" }
```

```json
{ "id": "0192f0d1-…", "device_seq": 120, "seen_seq": 5121,
  "at": "2026-09-15T14:41:30.117Z",
  "type": "set_quiz_options",
  "quiz_id": "0192f0a1-…", "segment_size": 40 }
```

`set_cascade_options` and `set_quiz_options` carry only the fields that changed,
out of `segment_size`, `progression` and `require_alphabetical`, and for
`set_cascade_options` also `clear_threshold`, `answer_mode`,
`show_definitions`, `show_hooks`, `reveal_correct`, `show_found_count`,
`show_probability`, `definition_column` and `leave_value_decimals`; any other
field is a `400`.

### Admin

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/catalog` | Every distribution, lexicon and leave value set, with sizes, uploader, upload time, reference counts and per-instance load status. Each item's `storage_bytes` is its [storage](#admin); a lexicon's and a leave value set's `index_bytes` and `build_ms` are its in-memory index on this instance (`null` until built) |
| `POST` | `/api/admin/letter-distributions` | Multipart `name`, `file`. `201` with the distribution, or `400` with `{ errors: [{ line, message }], total_errors }`. |
| `DELETE` | `/api/admin/letter-distributions/:id` | `409` with what still uses it |
| `POST` | `/api/admin/lexicons` | Multipart `name`, `letter_distribution`, `file` |
| `POST` | `/api/admin/lexicons/:id/definitions` | Multipart `file`: [replaces the lexicon's definitions](#replacing-definitions-and-leave-values). `201` with `{ id, name, word_count, definitions_changed, definitions_revision }`; `400` with the upload error list when anything but definitions differs, or nothing does |
| `DELETE` | `/api/admin/lexicons/:id` | `409` with what still uses it |
| `POST` | `/api/admin/leave-sets` | Multipart `lexicon`, `file` |
| `POST` | `/api/admin/leave-sets/:id/values` | Multipart `file`: [replaces the set's values](#replacing-definitions-and-leave-values). `201` with `{ id, lexicon, leave_count, values_changed, values_revision }`; `400` with the upload error list when the leaves differ, or no value does |
| `DELETE` | `/api/admin/leave-sets/:id` | `409` with what still uses it |

`GET /health` checks the database connection and that every catalog item present
at startup is indexed.

---

## Frontend

SvelteKit static SPA. The routes:

| Route | Page |
|---|---|
| `/` | No page of its own. It goes to the Cascades page, the landing page, when logged in, where logging in lands too, and to the log-in page (with Create an account) when logged out. A deleted account ends on the log-in page. With no lexicon yet, the empty Cascades page says so (and, to an admin, where to upload one). Every logged-in page but the player shows the site header (`AppHeader`): Acrodont (home, the Cascades page); for admins only, a Main nav holding just Admin; then the sync status and the account link. New cascade and the Trash are on the Cascades page, not in the header |
| `/register`, `/register/check-email`, `/confirm-email`, `/login` | Auth |
| `/reset-password` | "Reset your password": an address, then "If that address has a confirmed account, a reset link is on its way, with the account's username. The link expires in 30 minutes." |
| `/reset-password/confirm` | "Choose a new password" (every device will be signed out), one field and **Set new password**. On success it forgets any session this tab holds and goes to `/login` with no message. A `429` says "Too many tries, with this link or from this address. Try again in N minutes, or ask for a new link."; a `503` says the server is busy checking passwords; a spent or expired link says to ask for a new one; a link with no token says so, with a link to ask for a new one, and shows no form |
| `/` | Cascades page, the landing page (an old link to `/cascades` redirects here): the account's [storage](#storage-limit) against its limit with a meter, New cascade, then one compact row per cascade — its name, type, lexicon, clear threshold and options, the one-line ladder (`L1 · 250 (waiting) → L2 · 38 (12/38 done, 31.58%)`), its size, its download status and Move to Trash; the rest is in the player's Settings. Below the cascades, the [Trash](#trash) (`#trash`) |
| `/cascades/new` | Cascade builder (type, lexicon, filter rows, load/save search, name, preview with what the cascade will use against the account's storage), with no settings: a note says a new cascade's settings are changed in its Settings once it is created |
| `/cascades/:id` | Player for the cascade's deepest level, whose Settings dialog holds the ladder and every [setting](#settings), the cascade's and this device's |
| `/trash` | No page of its own: redirects to `/#trash`, so an old link lands on the Cascades page scrolled to the Trash |
| `/account` | Log out (with **Remove this account's data from this device**), sync status, change password (current and new), sign out everywhere, delete account. Nothing about storage: the Cascades page has the account's. No settings: those are in a cascade's Settings (☰ → Settings in the player) |
| `/admin` | Catalog overview with delete actions (admins only; others get a not-found page): a card per kind (letter distributions, lexicons, leave values), each with its **Upload** button, its items a table on a wide screen and a list of entries, figures under each name, on a phone, so nothing scrolls sideways |
| `/admin/letter-distributions/new`, `/admin/lexicons/new`, `/admin/leave-sets/new` | Upload forms with validation error lists |

Modules:

- **`lib/cascade/`**: the cascade rules and the SplitMix64 and Fisher–Yates
  shuffle. Pure TypeScript, tested against the shared test vectors.
- **`lib/local/`**: the IndexedDB schema, migrations and typed accessors. Reads
  go through one accessor that returns the overlay's row when there is one and
  the base's otherwise, so the rest of the app never knows there are two
  stores. Every write the player makes goes through `applyLocally(op)`, which
  writes the changed rows into the overlay, reads and advances the next
  `device_seq` in `meta`, and appends the operation to the
  outbox, all in one IndexedDB transaction, so two tabs can never mint the
  same sequence; the base is written only by the sync
  engine. One tab at a time runs the sync engine and the download manager,
  elected with the Web Locks API (`navigator.locks.request` on a per-user
  lock held for the tab's life); the other tabs read the shared stores and
  show the leader's status. Where Web Locks is missing, every tab syncs and
  idempotency keeps that correct, at the cost of duplicate rebase work.
- **`lib/sync/`**: the sync engine (triggers, push, paged pull, rebase, backoff,
  `401` handling) and the download manager (its own `429` and `Retry-After`
  backoff, yielding to a page the player needs, card pages split into the
  `questions` and `cards` stores with `keys=1` first, the 14-day policy,
  `ROW_STORAGE_BUDGET`, the automatic keep by size, eviction of answers only, and the
  quota-error path).
- **`lib/settings/cascade.ts`**: a cascade's [settings](#settings):
  `CASCADE_SETTINGS` (the fields `set_cascade_options` can carry), `appliesTo`
  and `kindOf` (which settings only one kind of cascade has), `reachable` (the
  cascades a widening reaches: not in the Trash, of that kind), `applyToAll`
  (one `set_cascade_options` per cascade that differs), `copySources` (the
  other cascades not in the Trash, most recently studied first) and
  `copySettings` (one `set_cascade_options` with every setting of the chosen
  cascade that applies to both and differs). The defaults every new cascade
  starts with are `CASCADE_SETTING_DEFAULTS` in `lib/local/rows.ts`.
- **`lib/settings-info.ts`**: what each setting does (`INFO`), which
  `SettingRow` writes under the setting's name, and the line each of the two
  groups says about where it applies (`SCOPE`).
- **`lib/export/`**: builds a word list or CSV from the local stores, in a worker
  and in chunks, and decides when the export has to come from the server
  instead. The Rust and TypeScript formatters are held to one set of fixtures in
  `contract-fixtures/export/`, so the file a device writes and the file the
  server streams are byte-identical.

Components:

- **`FilterGroup`**: an AND / OR group: its operator switch, its ordered
  children (rows and nested groups), and drag-and-drop between groups. The top
  of the builder is one of these.
- **`FilterRow`**: one component per condition. It is driven by a single
  frontend table (`lib/filters.ts`) giving each type's label, parameter inputs,
  defaults, bounds, whether Not is allowed, and which quiz types it applies to.
  The Leave Value filter uses decimal inputs that may be left blank. The backend
  has its own validation; this table only drives the UI, and a contract test
  keeps the two in step (see [Testing](#testing)).
- **`TilePalette`**: clickable tiles for the current distribution, shown under
  tile inputs when the distribution has any multi-character or non-ASCII tile.
  Tiles are inserted whole and never re-split.
- **`TileText`**: renders MAGPIE notation, drawing multi-character tiles as
  single joined tiles without brackets.
- **`CascadeLadder`**: the levels of a cascade, with sizes, attempts, last
  scores, the current run of any segmented level, which level is current, a
  pending level shown as "waiting for download", and per-level **Quiz
  options** and **Export…** actions. Above twelve levels the ones between the
  Source quiz and the deepest few collapse into one row with their count, behind
  **Show more**, the way the [Trash](#trash) collapses a chain group: nothing bounds a
  cascade's depth (see [Schema](#schema)), so the panel cannot assume the list
  is short. The compact ladder on the [Cascades page](#cascades-page) shortens
  the same way, keeping Level 1 and the deepest level with `+N more` between
  them.
- **`QuizOptionsForm`**: segment size, progression and alphabetical order, each
  explained behind its ⓘ, and the warning when `question_count / segment_size`
  is above 2,000 for the size in the field, before it is saved (see
  [Quiz options](#quiz-options)). It serves the player's Settings twice (the
  level being studied, and levels made from now on, apart by `idPrefix`); it
  is told whether it is editing a cascade or a quiz, and its `onchange` runs
  as soon as a change is complete, which the page saves through the matching
  operation: a choice or checkbox at once, a segment size when its field is
  left or Enter is pressed. Turning **Study in segments** on saves nothing
  until a size is entered. For a
  segment-chain quiz it shows progression and segment size as fixed and offers
  only alphabetical order, and for the Source quiz it hides progression.
- **`ExportDialog`**: the scope, selection, format and column choices of
  [Exporting words](#exporting-words), a live count of the **questions** the
  selection holds — with the entry count beside it only when the cascade's cards
  are complete locally, since an answers export writes one line per word and the
  words live in the `cards` store that eviction empties — and the fallback notice
  when the export needs data the device does not have.
- **`PlayerLayout`**: chooses the desktop layout (side rails around the quiz area)
  or the touch layout (top bar, drawer, touch zones) from `pointer: fine` and
  window width.
- **`QuizArea`**: turns input into the three actions:
  - desktop mouse and wheel events inside the area, and key events
  - touch zones, with tap-versus-drag detection
  - typed-mode protection
  - the repeat guard (a per-device setting, 50 ms by default)
  - suppressing the context menu, autoscroll and paste

  The rest of the player only ever sees `show_next`, `toggle_grade` and
  `previous`.
- **`Flashcard`**: question, answer and grade display. The font scales for long
  alphagrams and long definitions.
- **`lib/components/settings/`**:
  - **`ControlsEditor`**: the binding list per action, the capture box,
    conflict and reserved-stroke notices, and **Reset controls to defaults**,
    under Device Settings in the player's Settings. It saves to this device's `meta` store
    (`lib/player/controls`), never through an operation. Escape in the capture
    box cancels the capture and goes no further, so it does not close
    Settings.
  - **`ApplyWider`**: the line under a cascade setting just changed: "✓ Saved
    for this cascade", then "Also use for: all N cascades", which runs
    `applyToAll` and then says "✓ Used for all N cascades" (see
    [One cascade, or all of them](#one-cascade-or-all-of-them)). It stays
    until the dialog closes.
- **`TypedAnagramCard`**: answer input, found counter, the found list with
  the latest found word in green, the last entry taken under the input (green
  if right, red if wrong; a wrong entry also turns the input red until the
  next keystroke), give-up and override controls. It checks entries against the card's answer list
  locally, sets aside an entry that is not an anagram of the question without
  counting it, and, when the quiz requires alphabetical order, against the
  furthest answer entered so far, marking an out-of-order answer and showing the
  hint for what comes next.
- **`AnagramAnswerList`**: shared by both anagram modes. Renders words with
  optional hooks and definitions, and highlights unfound words. Hooks go through
  `TileText` with the case rule under [Answers](#answers), so a multi-character
  tile is never shown in the form that means a blank.
- **`LeaveValue`**: formats a raw value with a sign and the cascade's number of
  decimal places.
- **`FinishBanner`**: the non-blocking message after each finish.
- **`SyncStatus`**: Synced, Waiting to sync, Syncing…, Offline, Log in to
  sync, not enough room on this device, **signed out in another tab** (see
  [Authentication while offline](#authentication-while-offline)), or
  **reload to keep syncing** — the
  `426` state (see [Deployment](#deployment-and-operations)), shown from the
  first `426` until a sync succeeds, because the app never reloads on its own,
  a plain reload is served the old build by the old worker, and its own reload
  action can activate the new one only online, so this state can last
  days and "Waiting to sync" would promise a sync that cannot
  happen — plus notices about dropped work.
- **`OfflineBadge`**: Available offline, download progress, "answers need a
  connection" for a cascade whose cards are gone while the device is offline, or
  "not downloaded on this device, open to download" for one whose question rows
  this device does not hold.
- **Settings**: the one settings dialog, in the player (its menu's Settings,
  ⚙ on a phone), with a Cascade Settings and a Device Settings section (see
  [Desktop layout](#desktop-layout)). A cascade setting is applied locally
  through a `set_cascade_options` operation, a level option through
  `set_quiz_options`, and either updates the current card straight away.
- **`SettingRow`**: one setting: its name with an ⓘ (`InfoTip`) beside it
  saying what it does (from `INFO` in `lib/settings-info.ts`), nothing under
  the name, and the control at the row's right end.
- **`TrashList`**: the [Trash](#trash) section of the Cascades page: groups by
  cascade, Show more paging, Restore, Export… and Delete forever, and
  provisional dates, with the Trash's total storage, each group's, and what
  each Delete forever frees.
- **`lib/cascades/storage.ts`**: the account's [storage](#storage-limit) on
  the device: the per-row costs (`STORAGE_COSTS`, equal to
  `contract-fixtures/storage.json` by test), `DEFAULT_STORAGE_LIMIT` until the
  server has reported one, `storageState` (`ok`, `almost` from 90%, `over`),
  `levelBytes` for one level's share, and `formatBytes` in decimal units. It
  imports nothing, so the session can read it without the local stores. The
  device shows the server's figures and counts only a level's share itself.
- **`lib/builder/preview.ts`**: the builder's preview, which carries the
  server's `storage_bytes` for the search, so the builder can say what the
  cascade will use and disable Create Cascade when it won't fit.
- **`TrashList`**: the Trash under the Cascades page's list. Each entry's
  buttons wrap onto a line of their own on a phone. The page bumps its `version` when it moves a cascade to
  the Trash, so the list shows it at once, and its `onchange` refreshes the
  cascades above after a restore or a deletion.
- **`AppHeader`**: the site header on every logged-in page but the player:
  Acrodont (to the Cascades page), a Main nav with Admin for admins only (no
  nav otherwise), the sync status and the account link.
- **`WordListEditor`**: paste or upload a file for In Word List, showing the
  count and how many entries are not valid in the lexicon. It recounts whenever
  the quiz type or the lexicon changes, and shows the row's flag when the type
  crosses Leave Value (see
  [Filter applicability](#filter-applicability-by-quiz-type)).
- **`UploadForm`**: shared by the three admin uploads. Shows upload progress,
  then either the created item or the error list.

---

## Configuration

Everything is read from environment variables: a `.env` file locally, ECS task
definition values in production, with secrets from SSM. A malformed value fails
startup rather than falling back to a default.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required |
| `SESSION_SIGNING_KEY` | — | Required; 32 bytes as hex. The PASETO v4.local key for session cookies; the export-token key is derived from it with HKDF (label `acrodont export token`), so there is still one secret to manage and no token of one kind decrypts as the other |
| `BIND_ADDR` | `0.0.0.0:8080` | |
| `SESSION_TTL_SECONDS` | `2592000` (30 days) | |
| `SECURE_COOKIES` | `false` | `true` in any TLS deployment |
| `MAIL_BACKEND` | `console` | `console`, `ses` or `file`. `file` is the console backend plus one JSON file per message in `MAIL_OUTBOX_DIR`, named for its recipient, which `scripts/stack.py` and the end-to-end tests read instead of the log; every local stack uses it |
| `MAIL_OUTBOX_DIR` | — | Required with `MAIL_BACKEND=file` |
| `MAIL_MAX_PER_SECOND` | `1` | With `ses`: messages wait in a bounded queue (an hour's worth) drained at this rate, the SES account's maximum send rate (1 in the sandbox, usually 14 after), since SES refuses a faster burst. Each send times out at 30 s; a message whose link expired while queued is dropped; every failure is logged with `alarm = "mail_failed"` |
| `MAIL_FROM` | `no-reply@acrodont.local` | |
| `PUBLIC_URL` | `http://localhost:5173` | Base URL for email links |
| `MAX_QUIZ_QUESTIONS` | `300000` | May be lowered; a value above 300,000 fails startup. Lowering it bounds **new** values only: cascades and quizzes already holding a larger segment size keep working and are never rewritten, and the forms clamp what they prefill (see [Quiz options](#quiz-options)) |
| `MAX_STORAGE_BYTES_PER_USER` | `10000000` (10 MB) | The [storage limit](#storage-limit): what an account's cascades (the Trash included) and saved searches may hold on the server, in bytes, by the storage formula. Checked inside the creation, Duplicate and save transactions; reported by `/api/auth/me` as `max_storage_bytes`. Must be at least 1. An account's `users.storage_limit_bytes`, set only through SQL, replaces it for that account. There is no limit on how many cascades or saved searches an account has |
| `SEARCH_TIMEOUT_MS` | `2000` | Production sets 4,000: on half a vCPU a search runs at half a core's speed |
| `SEARCH_CONCURRENCY` | `2` | Searches running at once per instance, sized to the task's vCPUs. A request waiting longer than `SEARCH_TIMEOUT_MS` for a permit gets `503` with `Retry-After`, never `422` |
| `EXPORT_CONCURRENCY` | `2` | Server-streamed exports at once per instance (production sets 1). A permit is held for the whole stream and taken before the token is spent; a request waits up to 50 seconds for one, then gets `503` with `Retry-After`. It is what bounds peak memory (the catalog plus this many exports) whatever the number of users |
| `TRASH_RETENTION_DAYS` | `30` | Y: how long cleared quizzes and trashed cascades stay in the Trash |
| `SYNC_RETENTION_DAYS` | `30` | How long operation records and tombstones are kept. A device offline longer resyncs in full on its return; its unsent work still applies |
| `SYNC_MAX_OPS` | `500` | Operations accepted per sync request; a request carrying more is a `400` |
| `MIN_APP_VERSION` | `0` | The lowest frontend build number `/api/sync` accepts. `0` refuses nothing; raising it is a deploy-time change, made only when a sync API change cannot stay compatible, and a request below it gets `426` after its operations are applied |
| `PURGE_INTERVAL_SECONDS` | `3600` | |
| `PURGE_MAX_QUIZZES_PER_USER_PER_RUN` | `5000` | Quizzes one purge transaction takes for one user, oldest `cleared_at` first; the rest wait for the next run, so a Trash holding tens of thousands of chain quizzes never holds that user's row for one long transaction |
| `ADMIN_UPLOAD_MAX_BYTES` | `104857600` (100 MB) | |
| `API_MAX_BODY_BYTES` | `16777216` (16 MB) | JSON request bodies, sized for a 300,000-entry In Word List |
| `SYNC_RATE_PER_MINUTE` | `120` | Per-user sync requests; sized so a full offline attempt drains in minutes |
| `SYNC_STREAM_RATE_PER_MINUTE` | `30` | Per-user; opens of `GET /api/sync/events`. A device opens its stream once every five minutes |
| `SYNC_STREAMS_PER_USER` | `16` | Event streams one account may hold open at once on an instance; an open past it is a `429`. A device holds one, in the tab that leads its syncing (one per tab only where the browser has no Web Locks) |
| `DOWNLOAD_RATE_PER_MINUTE` | `120` | Per-user; the one shared bucket over the card, question-list and grades pages. Sized for one 300,000-question cascade's reopen per minute |
| `SEARCH_RATE_PER_MINUTE` | `30` | Per-user; search, preview, cascade creation, saving a search and loading one (`GET /api/searches/:id`) |
| `EXPORT_RATE_PER_MINUTE` | `10` | Per-user; server-streamed exports, counted when the dialog asks for an export token, since that is the request whose `429` the page can see |
| `ADMIN_UPLOAD_RATE_PER_MINUTE` | `10` | Per-user; the three admin upload endpoints, each of which can carry 100 MB and hold a connection for 120 seconds |
| `CATALOG_RATE_PER_MINUTE` | `300` | **Per IP**, for the two endpoints that need no session: `GET /api/lexicons` and `GET /api/letter-distributions/:name`. A device needs one of each per login plus one distribution per pulled cascade on a new device, but the bucket is per **address**, and a club or tournament room behind one address is dozens of devices logging in at once; 300 covers a room of about a hundred. A larger room waits out `429`s, which every client honours, rather than failing |
| `LOGIN_FAILURES_PER_IP_PER_MINUTE` | `10` | Failed logins per IP; a successful login spends nothing, so a room logging in together is not locked out |
| `LOGIN_FAILURES_PER_USERNAME_PER_MINUTE` | `10` | Failed logins per username, taken before any Argon2 verify and given back unless it fails |
| `AUTH_RATE_PER_IP_PER_MINUTE` | `30` | Per IP; register, confirm-email, reset-password and its confirm. Not `GET /api/auth/me`, which needs a session, and not logout |
| `RESET_RATE_PER_HOUR` | `5` | Password resets an hour, each key its own bucket: asking for a link per caller (`ip:`) and per address named (`em:`, lower-cased), setting a password per link (`tok:`), whoever sends it, and typing the password behind a session per account (`pw:`: Change password, Sign out everywhere, Delete account). On top of `AUTH_RATE_PER_IP_PER_MINUTE` and the email caps |
| `CATALOG_RECONCILE_SECONDS` | `60` | Fallback reload interval if a notification is missed |
| `TRUSTED_PROXY_HOPS` | `0` | `1` behind the ALB or compose Nginx |
| `DEV_LOGIN` | `false` | `true` only on a local stack: adds `POST /api/dev/login {username}`, a session for a confirmed account without its password, answered as `/api/auth/login` is, for `./scripts/dev.py --login-as`. Startup **refuses** it together with `SECURE_COOKIES=true`, so a TLS deployment cannot start with it on; without it the route does not exist (404) |

Client-side limits (14-day download window, 500 MB answer storage soft limit,
the 2 GB `ROW_STORAGE_BUDGET` for rows and question keys, the 50,000-row
`AUTO_KEEP_OFFLINE_ROWS` threshold for the automatic keep, 30-second sync
interval, the 400 ms `PREVIEW_DEBOUNCE_MS` and the 2-second
`PREVIEW_MIN_INTERVAL_MS`) are constants in `lib/sync/config.ts`.

---

## Development

### One command

```bash
./scripts/dev.py
```

That is the whole setup. With no arguments it builds and starts a complete
Acrodont on <http://localhost:5173>, seeded with the licensed catalog in
`fixtures/licensed/` (English, CSW24 with its definitions, and CSW24's leave
values, downloaded on the first run) and a confirmed admin account `dev`. The
[fixture catalog](#the-fixture-catalog) (EN-FIX, EN-FIX-OLD, CA-FIX) is for the
automated tests: dev.py uploads it only with `--fixtures`, or when there is no
licensed catalog, so the builder is never empty. It opens the browser
on the home page **already signed in**, then stays in the foreground
streaming a filtered backend log until Ctrl-C, which stops the stack (its data
is kept). The log shows errors and warnings, sync rejections, and a
ready-to-click link for every confirmation or reset mail. It needs Docker and
Python 3.8 or later; everything else is built in containers. It is safe to run
again at any time, since each step checks whether it has already been done.

What it does, in order:

1. **Checks before touching anything**, and fails naming what is missing:
   - Docker and compose v2;
   - the site's port is free (or held by this project's own stack);
   - each licensed catalog file exists and has the right number of fields
     (a two-column lexicon fails here, not as an upload error minutes later).

   It takes a lock per `--project`, so a second run cannot reset or stop the
   stack under the first, and it reads `.env` for `ACRODONT_PORT` and
   `BIND_HOST`.
2. **Builds** the backend and frontend images (unless `--no-build`). The
   frontend is the production-style build, because the Vite dev server does not
   register the service worker and offline studying is half the product.
3. **Brings up `docker compose`**: Postgres, the backend, and Nginx on :5173,
   published on loopback only (Docker's published ports bypass the host
   firewall; `BIND_HOST=0.0.0.0` to test from a phone). The backend runs every
   migration before it binds.
4. **Waits for `/health`**, which only reports ready once every catalog item in
   the database has been indexed. If the backend stops while starting, it gives
   up at once with the reason. A migration SQLx refuses as edited means "run
   with `--reset`"; a port clash points at compose's error and the flag that
   moves the port.
5. **Creates a confirmed user** `dev` through the real registration path:
   `POST /api/auth/register`, the confirmation code read from the stack's mail
   outbox (`MAIL_BACKEND=file`), `POST /api/auth/confirm-email`, and only then
   `is_admin` set with SQL, because [no endpoint can](#admin). Registering
   rather than inserting rows means the account is made exactly as a user's
   is. The
   password is a fixed passphrase that meets the `zxcvbn` rule,
   `correct-tile-rack-bingo`, printed on every run.
6. **Uploads the catalog** through the real admin API, as that user, skipping
   anything already present.
7. **Seeds the scenarios** asked for, through the real API.
8. **Opens the browser** at `/dev-login?username=dev&next=/`. The page calls
   `POST /api/dev/login` (`DEV_LOGIN`, which exists only on a local stack) and
   then makes the session this tab's own exactly as a login does (`adoptSession`
   in `lib/auth/session.svelte.ts`). A cookie alone would not do: the app signs
   in from its own IndexedDB pointer, not from whatever cookie the browser
   holds.

Useful flags:

| Flag | Effect |
|---|---|
| `--scenario NAME` | Seed a study state through the real API; repeatable. `studying` (Level 1 finished with misses, Level 2 half graded), `finished` (the completion screen), `segments` (runs of five, one finished with a miss), `typed` (typed answers on), `trash`, `limits` (cascades until the account holds 90–100% of its [storage limit](#storage-limit), each the broadest search that still fits; on the fixture catalog, whose cascades are tens of KB, run it with `--env MAX_STORAGE_BYTES_PER_USER=1000000`), `big` (one cascade near `MAX_QUIZ_QUESTIONS` from the real catalog), `saved-searches`. Operations go through `POST /api/sync`, so the server's rules check them; the quiz state they need is read with SQL, as the integration tests do |
| `--real-catalog [DIR]`, `--no-real-catalog` | Upload the licensed files `DIR/manifest.json` lists, in the fixture manifest's form. Done by default from `$ACRODONT_CATALOG_DIR`, else from `fixtures/licensed/`, which dev.py downloads when it has no `manifest.json` (if the download fails, the fixture catalog stands in); `--no-real-catalog` leaves it out, and the fixture catalog stands in. The licensed files never enter the repository (`fixtures/licensed/` is gitignored). `scripts/build-licensed-catalog.py` makes the folder from two public repositories at pinned commits: the words, definitions and playability values from the Zyzzyva database in [CrowdsourcedDefs](https://github.com/jvc56/CrowdsourcedDefs) `editions/2/CSW24.zip`, and the leave values decoded from [MAGPIE-DATA](https://github.com/jvc56/MAGPIE-DATA) `data/lexica/CSW24.klv2`; the distribution is `fixtures/magpie-data/english.csv`. It writes the upload's three-column lexicon, the leave values and the manifest |
| `--stats` | Print each catalog index's size, its build time, the catalog load time and the backend's memory: what the production task's memory is sized from |
| `--users N` | N more confirmed users (`dev2`, `dev3`, …) for multi-account work |
| `--login-as USER`, `--no-login` | Which account the browser opens signed in as, or none |
| `--two-devices` | Two isolated Chromium profiles signed in as the same user: the quickest way to watch sync |
| `--fresh` | A new deployment: `--reset`, then no user, no catalog, and the first-admin steps printed |
| `--snapshot NAME`, `--restore NAME\|DUMP` | Save the database to `.dev/snapshots/NAME`, or restore one. A restore goes into a new database, then is swapped in with both renames in one transaction while the backend is stopped, and the [sync sequences are bumped](#restoring). A dump that is not a local snapshot (a production dump) is always scrubbed with `scripts/scrub.sql`: every address replaced, every password the dev password, every session revoked |
| `--distribution NAME=FILE`, `--lexicon NAME:DIST=FILE`, `--leaves LEXICON=FILE` | Upload single catalog files as well. Repeatable |
| `--fixtures` | Also upload the fixture catalog (EN-FIX, EN-FIX-OLD, CA-FIX and their leave values), otherwise used only when there is no licensed catalog |
| `--keep-up`, `--detach` | Leave the stack running on Ctrl-C, or start, seed, open and exit |
| `--no-build` | Restart without rebuilding the images |
| `--hot-reload` | Also run the Vite dev server on :5174, for fast UI work. The service worker is only on :5173 |
| `--reset` | Drop the database volume and the built frontend, then start clean |
| `--project NAME`, `--port N` | Run an isolated second stack |
| `--env KEY=VALUE` | Override any [configuration variable](#configuration). Repeatable |
| `--no-browser`, `--quiet` | For scripts and SSH sessions |
| `--down` | Stop the stack; `--down --volumes` also discards its data |

### How it is put together

`dev.py` is a command line over `scripts/stack.py`, which is the only place
that knows how to bring a Acrodont up, and `scripts/scenarios.py`, which seeds
study states. `stack.py`'s entry points:

| Entry point | What it does |
|---|---|
| `stack.up(project, port, env, build)` | Compose up, then wait for `/health`, giving up at once with the backend's last lines if it stops. Each project gets its own env file, signing key and mail outbox under `.stack/`. Returns the base URL |
| `stack.seed(base_url, catalog, user)` | Create the confirmed admin user, then upload each catalog item through the admin API, skipping what exists. It honours `429` and `Retry-After` like every other client |
| `stack.ensure_user(base_url, user)` | A confirmed account through registration, logged in |
| `stack.reset(project)` | `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and restart the backend |
| `stack.down(project, volumes)` | Stop the stack, optionally discarding its volumes |

Everything that needs a running Acrodont goes through these — `dev.py`, the
[end-to-end tests](#end-to-end-tests), the [scale tests](#scale-tests) and CI —
so there is one definition of "a working instance". A change to the stack
cannot fix the tests while breaking local development, or the other way round.
See [What the tests reuse](#what-the-tests-reuse). `JOURNEYS.md` is the
manual walk through a `dev.py` instance that precedes a launch.

### Day to day

- **Email.** Mail is printed as a link in dev.py's log, and kept as files in
  `.stack/<project>.outbox/`.
- **Offline.** Use :5173, not :5174, then either the browser DevTools
  **Offline** toggle or `docker compose stop backend`. The app can't tell the
  two apart, and stopping the backend leaves the database alone, so restarting
  picks up where it left off.
- **After editing a migration**, run `./scripts/dev.py --reset`. SQLx refuses
  to run a migration whose checksum has changed (dev.py says so), and the site
  data in the browser has to be cleared too, because local sync cursors no
  longer match anything on the server. `--snapshot NAME` first keeps a copy.
- **Two accounts, one browser** is the quickest way to see that IndexedDB is
  scoped per user (`--users 1`, then `--login-as dev2` in another window);
  `--two-devices` is the quickest way to see sync.
- **Rust and TypeScript rule changes go together.** Both implement
  [the cascade rules](#rule-implementation), and the shared vectors are what
  keeps them honest, so run `make test-unit` before assuming a divergence is a
  sync bug.
- **Builds are capped** at two cargo jobs (`CARGO_BUILD_JOBS`), because an
  uncapped release build of the AWS SDK froze a 16 GB machine.

---

## Deployment and Operations

Sized for the [scale assumptions](#overview): one user at first, at most 750
accounts (`MAX_ACCOUNTS`). The stack costs about $53 a month (docs/runbook.md, "What it
costs"). Birdtest, a sibling app on the same stack that has been live since
October 2026, taught most of what follows (BIRDTEST_LESSONS_PLAN.md).

- **Terraform** in `infra/` covers:
  - VPC with public subnets for the ALB **and the Fargate tasks**, and private
    subnets for RDS. There is no NAT gateway (about $37 a month) and no VPC
    endpoints: the tasks have public addresses, and their security group admits
    only the ALB.
  - ALB with an ACM certificate, HTTP → HTTPS redirect, a 120-second idle
    timeout for admin uploads, and invalid header fields dropped. Nginx's
    `keepalive_timeout` (130 s) must outlast the idle timeout, or the ALB
    reuses connections Nginx has closed and answers 502; a Vitest test pins it.
    With `redirect_www` the certificate also names `www.<domain>` and both
    listeners answer that host with a `301` to the bare domain, which is the
    site's one address.
  - ECS cluster (Container Insights off; ECS Exec sessions never logged), one
    service of **one task** with backend and Nginx containers, at **0.5 vCPU
    and 2 GiB**, on **Fargate Spot** by default (`use_fargate_spot`).
    - **Spot:** Acrodont is local-first. Studying never needs the server and
      sync retries, so a Spot interruption's minute or two without the API goes
      unnoticed.
    - **Sizing:** `SEARCH_CONCURRENCY` is 1, `SEARCH_TIMEOUT_MS` 4,000 and
      `EXPORT_CONCURRENCY` 1, so the catalog plus one export bounds memory.
    - **One task:** this makes the in-memory rate limits exact. Deploys still
      roll with no gap: minimum healthy 100%, maximum 200%. The new task serves
      before the old one drains, which is safe because Acrodont runs correctly
      as two instances.
    - **Startup and shutdown:** a circuit breaker rolls back a release whose
      task cannot start, and an EventBridge rule mails why. `stopTimeout` is
      120 s so graceful shutdown can finish a streaming export. The container
      health check's `startPeriod` (240 s) must stay at least twice the measured
      catalog load, which the backend logs as `load_ms`. `/health` fails
      while the database is away, so the container's check and the target
      group's each allow ten misses 30 seconds apart before the task is
      replaced: a database restart (the weekly maintenance window, a minor
      upgrade, a class change) is ridden out by a task that keeps its catalog
      in memory, where a replacement could not start until the database was
      back and would then index everything again.
  - An **ops task definition** on the ops image (Postgres 16 client and
    server, python3, `restore.py`, `acrodont-master-psql`). Every SQL step of
    the runbook runs from it, by `scripts/prod-sql.sh` and
    `scripts/prod-shell.sh`. There is no bastion, and RDS is never public.
  - RDS Postgres `db.t4g.micro`, 20 GiB gp3 with storage autoscaling,
    **7-day** point-in-time recovery (`db_backup_retention_days`); the nightly
    dumps cover anything older. An RDS event subscription reports low storage,
    failure and allocation near the autoscaling ceiling.
  - SES domain identity, MAIL FROM subdomain, account-level suppression of
    bounces and complaints, and alarms on the bounce and complaint rates and on
    any failed send.
  - SSM parameters, referenced **by ARN only**: declared as resources, their
    decrypted values would sit in Terraform's state. `scripts/init-db-roles.sh`
    creates them.
  - CloudWatch log group (30 days), the alarms in docs/runbook.md, an AWS
    budget and a cost-anomaly subscription.
  - ECR repositories with immutable tags and a 40-image lifecycle rule.
  - `infra/tests/` runs `terraform test` offline against a mock provider. It
    pins each variable validation: every value AWS would otherwise refuse
    half-way through an apply.
- **Deploys** run from the operator's machine: `scripts/deploy.sh`, with
  Terraform as the only deployer, so its state always says what is running.
  - It refuses a dirty tree, a commit not on `origin/main`, a commit whose CI
    run on `main` is not green (a branch's run of the same commit is only the
    Push tier, see [Running the tests](#running-the-tests)), and a change to
    an applied migration.
  - It builds only the images ECR lacks: backend, ops and frontend, tagged with
    the commit.
  - It sets `image_tag` in `prod.tfvars` (kept in the state bucket), then plans
    behind a gate that refuses to delete or replace the database, a bucket, the
    network, a KMS key or an ECR repository.
  - It applies, then waits until the running task has the applied image, CPU
    and memory, and the targets are healthy.
  - `scripts/rollback.sh` puts an earlier release back through the same gate.
  - The backend runs migrations before it binds, with `ignore_missing`, so a
    rolled-back image starts on the newer schema. The ALB health check waits
    for `/health`, which includes the catalog indexes being loaded, before
    sending traffic.
  - **Security headers:** the content security policy is split between the two
    places that can each express part of it, because neither can hold all of it.
    - **SvelteKit's `kit.csp`, in `hash` mode**, writes a
      `<meta http-equiv="Content-Security-Policy">` into every built page:
      `default-src 'self'; script-src 'self' <the build's hashes>; style-src 'self' 'unsafe-inline'; object-src 'none'`.
      `adapter-static` starts the app from an **inline** bootstrap `<script>`,
      which a plain `script-src 'self'` would block, leaving a blank page online
      and offline alike; the hashes allow exactly that script and nothing else,
      and only the build knows them, so Nginx could not send them. Styles take
      `'unsafe-inline'` because Svelte's transitions insert `<style>` elements
      and the component library's positioning sets inline `style` attributes.
      The script policy is the part that matters: the CSRF cookie is readable
      by scripts by design, so injected script is what it keeps out. It must be
      present in the **SPA fallback page** in particular, because that is the
      `index.html` the service worker serves for every navigation, and
      `adapter-static` renders the fallback separately from prerendered routes,
      so whether `kit.csp` reaches it depends on the SvelteKit version and the
      adapter's options. A missing policy fails **open** — the app boots, nothing
      is logged, and injected script runs — so `npm run build` ends with a check
      over `build/index.html` that fails the build unless it holds that
      `<meta>` policy with `'self'` and at least one hash in `script-src` and no
      `'unsafe-inline'` there.
    - **Nginx sends, on every response**,
      `Content-Security-Policy: frame-ancestors 'self'`, since a `<meta>` policy
      cannot carry `frame-ancestors`, plus `X-Content-Type-Options: nosniff`
      and, in production, `Strict-Transport-Security: max-age=31536000`. The
      browser enforces both policies, and they do not overlap.

    `frame-ancestors` is `'self'` and not `'none'`, and there is no
    `X-Frame-Options: DENY`, because the [server export](#exporting-words)
    downloads through a same-origin hidden frame: the usual "deny all framing"
    hardening would make every server export silently produce nothing. The
    policy still keeps any other site from framing the app.
  - **Caching:** Nginx serves `service-worker.js` and `index.html` with
    `Cache-Control: no-cache`, so devices pick up new app versions, and hashed
    assets as immutable.
  - **Sync compatibility:** a sync API change must stay compatible with the
    previous app version for at least `SYNC_RETENTION_DAYS`, because devices can
    be offline with an old app that long. The sync request carries the app
    version — the build number described under [the endpoint](#cascades-and-sync) —
    and a request below `MIN_APP_VERSION` gets `426` with a
    reload prompt, after its operations have been accepted. The `426` body
    carries the same `results` array and the same pull as a `200`, and the
    device takes both exactly as it takes a `200`'s (further pages are asked
    for by token, which are never refused for the version), so what it just
    pushed stays on the device as the server has it; acknowledging the
    operations without their pull would clear the device's rows for them with
    nothing in their place. It then shows
    [`SyncStatus`](#frontend)'s **reload to keep syncing** until a sync
    succeeds. It keeps the rest of the outbox and goes on letting the user
    study, because the `426` applied the operations it carried and more are
    safe to hold. The prompt is not the end of it: the app never reloads on its
    own initiative, the prompt can be dismissed, and a plain reload is answered
    by the old service worker, so the state's reload action runs the
    `SKIP_WAITING` handshake under [App shell](#on-the-device) rather than a bare
    reload; and offline the new worker cannot even be fetched, so the state
    persists until the device is online and the handshake runs.
- **Granting admin** in production is `scripts/confirm-user.sh --admin USER`,
  one SQL statement run from the ops task. It is documented in the runbook.
- **Catalog uploads** happen in the browser at `/admin`. Every running instance
  picks up changes through `LISTEN/NOTIFY`, with no restart or redeploy.
- **Backups** have their own section: see [Backups](#backups).
- **Capacity**: RDS storage autoscaling is on (20 GiB, growing up to five
  times that), with RDS storage events mailed, because large cascades (about
  5 MB at 300,000 questions as created, plus about 2.9 MB for each full-size
  level) are the main driver of database growth. The
  [storage limit](#storage-limit) bounds them: at 750 accounts at the limit
  the worst case is 7.5 GB by the formula, of live rows. Dead row versions
  from grading wait for vacuum on top of it, and sync records are not
  counted: allowing twice the live figure, 15 GB, the worst case still fits
  the starting allocation with the tenth that autoscaling keeps free and
  about 3 GB for Postgres itself, which is where the 750 comes from. A
  realistic one is a small fraction of that. Filter specs
  count toward the same limit: a 300,000-entry In Word List of 8-letter words
  costs about 2.7 MB of `search_conditions.entries` (its bytes plus a line
  break an entry), which is the **most one spec can hold**, since the 300,000
  entries are a whole tree's allowance and not one row's (see
  [In Word List](#filter-reference)).
  `sync_operations` would have outgrown both: studying emits about two
  operations per card (a grade and, online, its own cursor move), at roughly
  250 bytes a record with its indexes, so keeping every record for 90 days
  would hold about 150 MB for each 300,000-card pass, 25 times the 6 MB
  cascade it describes, and outside the storage limit. Records of result-free operations are therefore deleted as soon as
  their device has acknowledged them (see [The sync cycle](#the-sync-cycle)), so
  the table holds about one batch per active device plus a few `finish`,
  `finish_segment` and `restore_quiz` records per attempt. Task memory is sized
  to the catalog, and each index's size is visible in `/admin`.
- **Monitoring**: sync rejections are counted by type and reason in logs and
  graphed. A rise in rejections outside the expected `stale_attempt`, `stale`,
  `not_active` and `not_deepest` cases, which ordinary two-device use
  produces — together with the `not_found` rejections that follow one of those in
  the same batch, when the level behind the rejected operation never reached the
  server (see [Conflicts](#conflicts)) — points
  to a divergence between the Rust and TypeScript rules, and any `error`
  rejection alarms, since it means a database error the rules did not expect.

---

## Backups

Everything that matters is in Postgres. The catalog can be uploaded again from
the admin's own files, and the frontend is rebuilt from the repository, so the
database is the only thing whose loss could not be undone.

### What is backed up

| Layer | What | Where | Kept |
|---|---|---|---|
| **Point in time** | RDS automated backups with PITR | The RDS backup store, same region | 7 days (`db_backup_retention_days`); the nightly dumps cover anything older, at up to a day's loss |
| **Nightly dump** | `pg_dump --format=custom` of the whole database | An encrypted, versioned, object-locked S3 bucket in a second region | 90 days, then a monthly dump for a year |
| **Schema only** | `pg_dump --schema-only`, committed nowhere but attached to each release | The same bucket | With its dump |

The nightly dump runs as a scheduled Fargate task on the ops image (the
backend's build plus Postgres 16 and python3), with a read-only database role.
Its task role can write dumps but read only the daily dump it copies to
`monthly/`; the drill's can only read. It writes to a key named for the day,
so a corrupted dump cannot overwrite a good one, and the bucket's versioning and
object lock mean neither can a mistake or a compromised task role. The dump
streams to the bucket, so a `pg_dump` that dies part-way still leaves an
object under the day's key; a run whose dumps both succeeded writes a marker
beside it last (`daily/YYYY-MM-DD.ok`, holding the dump's size), and the
drill and `restore.py` take no dump without its marker or of another size.
The size comparison below is likewise made against the last dump that has
one.

Uploaded catalog files are **not** backed up. They are licensed data that
Acrodont never stores as files, only as rows, and those rows are in the dump.

### Alarms

- No successful dump in **36 hours**.
- A dump more than 30% smaller than the previous finished one, which catches
  a run that succeeded with much of the data missing.
- A backup or drill task that exits non-zero or never starts (no image to
  pull, no secret to read), within minutes (an EventBridge rule on the task's
  exit code and its stop code: a task that never started has no exit code).
- RDS storage events: low storage, failure, and allocation near the
  autoscaling ceiling. A fixed free-storage threshold is meaningless under
  storage autoscaling, since free space is measured against the current
  allocation.

### Restoring

The runbook has the full procedure; the parts specific to Acrodont are:

1. **Restore into a new database**, never over the live one, and check a
   scrubbed copy of the same dump on a local stack (`./scripts/dev.py
   --restore DUMP`: `/health` and a few cascades) before any cutover.
   The new database is owned by the app role and restored as that role: the
   app could neither read nor migrate one the master user made. The cutover
   (`scripts/cutover-db.sh`) repoints the app's URL and the nightly dump's
   together, so the dump never goes on reading the abandoned database.
2. **Re-index the catalog**: `/health` stays not-ready until every lexicon and
   leave value set has been built into memory, which takes a few seconds per
   item. Nothing has to be re-uploaded.
3. **Force a resync.** This is the one step that is easy to forget and impossible
   to skip. A restore to an earlier point makes the server's sync sequences go
   backwards, so a device that synced after the restore point has a cursor at
   or ahead of the server's and would silently ignore rows it should pull, and
   its pending operations carry a `seen_seq` the server would call `invalid`.
   Setting the floor to the restored `sync_seq` would catch only the devices
   that do not need it. After a restore, set every user's `sync_seq` **and**
   `sync_floor_seq` to `sync_seq + 2^32`, a value above any cursor a device
   could hold (the constant needs no knowledge of the lost state, and a
   `BIGINT` has room for it). Every device's cursor is then below the floor,
   so its next sync answers [`resync_required`](#the-sync-cycle) and it
   rebuilds its local state from the server; every row stamped from now on is
   above every old cursor; and no pending operation's `seen_seq` exceeds
   `sync_seq`, so the push in that same request is applied first, exactly as
   the sync cycle describes. `scripts/restore.py` performs this step.
4. **Expect some lost work**, and say so. Devices keep their outbox, so anything
   a device had not yet pushed is pushed again after the resync and survives.
   Work that was pushed after the restore point and only lived on the server is
   gone.

### The drill

**Monthly, automatically.** The `acrodont-drill` task (`scripts/drill.py`)
restores the newest finished nightly dump into a Postgres started inside its own task,
never on the production instance. Birdtest's drill once ran against production
and could fill its storage. It restores as the app role into a database that
role owns, as a real restore is made, so a restore only a superuser could
make fails here first. It then checks:
- every table the schema-only dump names is present;
- migrations are recorded;
- there are users, and every cascade has its questions;
- the sequence bump leaves every user's floor at `sync_seq`, above 2^32.

It reports `DrillSucceeded` and `DrillSeconds`; a failure mails at once.

**Quarterly, by hand**, the part a machine cannot do. Restore the latest dump
locally with `./scripts/dev.py --restore DUMP` (scrubbed, sequences bumped).
Use a second browser profile whose cursor is **ahead** of the restored server
and whose outbox holds unsent grades. Check that the grades are applied, the
device resyncs rather than diverging, and no operation is rejected as
`invalid`. The date and the measured restore time go in the runbook.

### Locally

`./scripts/dev.py --snapshot NAME` and `--restore NAME` use `scripts/backup.py`
on the development stack, so the code that runs nightly in production is the
code that snapshots a local database before a risky migration edit.

---

## Testing

Five layers, each with a job the others can't do:

| Layer | Runs with | Needs | Covers |
|---|---|---|---|
| **[Unit](#unit-tests)** | `make test-unit` | Nothing | The search engine, tiles, probability, the cascade rules on both sides, and the export formatters |
| **[Integration](#integration-tests)** | `make test-integration` | Postgres | The real router and the real schema: auth, admin, uploads, cascades, sync, purges |
| **[End-to-end](#end-to-end-tests)** | `make test-e2e` | The whole stack | What a person actually does, including offline and two devices |
| **[Scale](#scale-tests)** | `make test-scale` | Postgres | 300,000 questions end to end, within a time budget |
| **[Parity](#zyzzyva-parity)** | `make test-parity` | Licensed data, local only | That a search returns what Zyzzyva returns |

Two things are shared by every layer and by
[local development](#development): the fixture catalog and the contract
fixtures.

### The fixture catalog

`fixtures/catalog/` is a small, hand-built catalog committed to the repository.
It contains made-up and public-domain words only, **no licensed data**:

- an English-style distribution
- a Catalan-style distribution with multi-character tiles (`NY`, `QU`, `L·L`)
  and `Ç`
- a lexicon and a leave value set for each

It is small enough to index in milliseconds and odd enough to catch the tile
bugs a pure A–Z lexicon would hide. The same files are parsed directly by the
backend unit tests, uploaded through the admin API by `scripts/stack.py` when it
seeds, and therefore present in every end-to-end run **and** in every
`./scripts/dev.py`. So the catalog a developer clicks around in is the catalog
the tests assert on, and a fixture that stops parsing breaks both at once.

### Contract fixtures

`contract-fixtures/` holds the JSON that keeps the Rust and TypeScript sides
from drifting. Each file is loaded by a `cargo test` and by a Vitest, and neither
side is allowed to generate the file it is checked against.

- **Shared rule and shuffle vectors** (`contract-fixtures/cascade/`): sequences
  of operations with the expected cascade state after each one, and seeds with
  their expected permutations. Both `cargo test` and the frontend unit tests
  (Vitest) must pass every vector. Together they cover:
  - all five finish outcomes, including exactly-at-threshold scores and
    thresholds of 1 and 100
  - climbing back up
  - **The Source quiz**: a finish with misses at any score resetting it and
    descending, under Ladder and under Drill; a finish with no misses
    completing the cascade and leaving it playable at Level 1; a cascade
    completed a second time; and the Source quiz never appearing in the Trash
  - restoring into live, complete and trashed cascades
  - purges
  - **Drill progression**: a quiz replaced below the threshold, one cleared at or
    above it, the nothing-correct reset, and a cascade completed with the Source
    quiz plus one drill level
  - **Segments**: run boundaries for sizes that do and don't divide the question
    count; a run with no misses creating nothing; a run with misses creating a
    Drill quiz one level down and leaving the cursor at the boundary; drilling
    that quiz down to nothing and coming back to the right run; a segment
    descent inside a Ladder cascade and inside a Drill one; a segment size at or
    above the question count behaving like 0; `next_boundary` returning None
    for a segment size of 0, one at or above the question count, and a
    segment-chain quiz, with no division by the size; a segment size of 4
    refused on both sides while 0 and 5 are accepted; the run number, total and
    within-run position for a uniform attempt and again after a mid-attempt size
    change (250 questions, `run_start` 100, S switched to 30, reading
    `run 4 of 9 · 1 of 20`), and on the last run of a 250-question quiz with
    S = 100, where `next_boundary` is None and the length comes from the
    question count, reading `run 3 of 3 · 1 of 50`, for a size that divides the
    count and one that does not; segments turned on at cursor 200 of a
    250-question quiz whose `run_start` is still 0, reading
    `run 1 of 5 · 201 of 250`, where `next_boundary` is None although four
    boundaries lie inside the quiz, so the numbering rule's reading of a
    mid-attempt change is fixed by a vector rather than discovered; an attempt of 40 questions with S = 5 and every run
    missing something creating exactly 8 chain quizzes, the
    `ceil(question_count / S)` bound; the segment size changing
    mid-attempt, including to a value that puts the next boundary before a
    boundary already descended
  - **Options**: every new quiz taking the cascade's options, a change to a quiz
    not touching the cascade or its siblings, a change to the cascade not
    touching existing quizzes, and a segment chain staying Drill and unsegmented
    in a Ladder cascade through two replacements; a quiz switched to Drill in a
    Ladder cascade finishing as Drill, and a quiz switched to Ladder in a Drill
    cascade descending; and a `set_quiz_options` on a waiting upper-level quiz,
    with the boundary it produces when the user climbs back to it
  - **Restore**: a restore onto a mid-attempt quiz leaving that quiz's attempt,
    grades and cursor untouched; the restored quiz's attempt number going up by
    one and its order coming from `seed` unmodified; an ordinary quiz restored
    after the cascade's segment size changed taking the new size; a restore
    into a Drill cascade; a restore on top of a segment-chain deepest level,
    with the chain resuming its parent's run after the restored quiz clears; a
    restored
    segment-chain
    quiz staying Drill with no segments in a Ladder cascade and returning to
    the level above it when cleared
  - **Run starts**: `run_start` following each boundary passed, drilled or not;
    a size change after a descent starting the next run at `run_start`, not at
    the previous multiple of the new size; Previous refusing to go below
    `run_start`; a `finish_segment` at or below the cursor being rejected;
    `run_start` of 100 on a 250-question quiz surviving a change of the segment
    size to 0 and to 300,000, with `next_boundary` None and Previous still
    refused below 100 on both sides, so neither module clears it; and
    `run_start` 119, reached with S = 7 on a 300-question quiz, with the size
    then set to 120, giving a next boundary of 120 and a run of one question,
    which both modules compute alike and neither refuses
  - **Attempt seeds**: a grade, cursor move or run finish naming a seed the
    server does not have being rejected as `stale_attempt`; and a replay of an
    outbox holding 1,200 operations with a `finish` at position 700, synced in
    three batches, losing nothing
  - **Completion counts**: `peak_depth` and `attempts_since_completion` across
    two completions, the completing attempt included in the count, a
    segmented Source quiz whose drilled misses still make the finish a descent,
    and `peak_depth` rising to 2 on a restore into a completed cascade and to
    3 on a segment descent below a restored quiz
  - **Leave value text**: `0.15` → `0.2` and `0.25` → `0.3` at one place,
    `2.5` → `3` at none, `-0.04` → `0.0` and `0.04` → `0.0` with no sign either
    way, `±1000000` at three places, the upload bound, where the rounded integer
    is the largest either side ever formats, and the exact export form with
    no `+`
  - **Question hashes**: `questions_hash` for a one-question quiz, a
    300,000-question Source quiz, and two three-question sets that share a
    count but differ in one index, each with its exact wire form as decimal
    text; every fixture hash and seed is above 2⁵³, so a side that parsed one
    as a JSON number would fail the vector, and **one hash and one attempt seed
    are above 2⁶³**, so a side that treated the stored `i64` as the value would
    fail it too
- **Contract test**: the frontend filter table and the backend condition schema
  are both generated or checked against one shared JSON fixture in
  `contract-fixtures/`, itself generated from the
  [parameter table](#catalog-and-search) under the API's filter JSON, so a new
  filter parameter cannot be added on one side only and no field name is chosen
  twice. The fixture holds one valid condition per type, serialised by each
  side and compared byte for byte, and one with an extra field, which both
  sides refuse.
- **Storage costs** (`contract-fixtures/storage.json`): the per-row sizes of
  the [storage formula](#storage-limit), which `backend/src/storage.rs` and
  `frontend/src/lib/cascades/storage.ts` each carry as constants (the backend
  image builds from `backend/` alone) and a test on each side keeps equal to
  the file.

### Unit tests

Pure functions and in-memory structures, no database and no network.

**Backend** (`cargo test --lib`), against [the fixture catalog](#the-fixture-catalog):

- **Search engine**:
  - Every example in Zyzzyva's search help, recreated with a fixture that
    contains the example words: `ETX.`, `PI..Z`, `Z[AEIOU][AEIOU]`, `*JBX`,
    `AT..`, `.W*M.S`, `LX[AU]`, the Includes-Letters Q-not-U case, a two-tile
    `Not Includes AB` row matching words that lack either tile,
    `Consists of AEIOU 70–100`, and the lax tie cases. Zyzzyva writes its
    single-tile wildcard as `?`; Acrodont writes it as `.`, so the examples are
    translated.
  - Front Inner Hook and Back Inner Hook against a fixture holding SPORT, PORT
    and SPORTS, including a one-tile word and the negated forms.
  - Groups: `Length 7 AND (Includes Q OR Includes Z)`, an OR of two AND groups,
    a limit inside an AND group ranking that group's result within the
    parent's predicate survivors (`Length 7 AND (Includes V AND Limit 1–50)`
    giving the 50 most probable 7s with a V), a limit-only nested group under
    an AND parent equal to the same limit beside the parent's rows, a limit in
    a child of an OR group ranking within the OR group's candidates, a nested
    group with a limit under a top-level Length row giving the same result with
    and without the candidate shortcut, **a group holding both limit kinds**
    (`Length 7` with `Limit by Probability Order 1–50` and
    `Limit by Playability Order 1–10`) returning the intersection of the two
    slices — not the ten most playable of the fifty most probable, nor the
    reverse — and returning the same set when the two rows are swapped, and
    every validation error (empty
    group, depth over 4, more than 100 rows, and 100 rows each wrapped in their
    own group refused as 101 groups with a field error rather than reaching the
    insert).
  - Leave Value: inclusive bounds, open bounds, negative values, and a value
    exactly equal to a bound.
  - Leaves: `.` in a leave pattern matching the blank, a literal `?` matching
    only the blank, leave probability with the blank counted as an ordinary
    tile at the bag's blank count, Number of Anagrams 0 for a leave holding a
    blank, Number of Vowels not counting the blank, Consists of with and
    without `?` in the set, In Word List entries put in canonical leave order
    with invalid entries ignored, and In Lexicon negated against a second
    fixture lexicon on the same distribution.
  - Limits: a group holding only a limit row ranking every candidate; a limit
    in an OR group ranking the union; a lax row widening freely, a strict row
    not widening, and a strict row capping a lax one, each against the same
    ties as Zyzzyva's `WordEngine`; a min past the last survivor giving an empty
    result; and limited words collapsing to fewer alphagram questions than the
    range.
  - Validation, one case per message: min above max; a range that narrows
    nothing, measured against each filter's own floor, so `Length 1–15`,
    `Probability Order 1–N` and `Consists of 0–100` are refused at their
    defaults while `Length 2–15` and `Length 1–14` are accepted, where **N is
    the fixture's largest length bucket, not its word count**: the same row
    taken to the word count is a field error naming that bucket, since no
    per-length rank reaches it, while `Limit by Probability Order 1–<word
    count>` is a valid row at the word count, being ranked
    over a group's survivors instead, and the two figures the builder reads
    them from are `max_order_rank` and `word_count` on
    [`GET /api/lexicons`](#catalog-and-search); a
    **Number of Anagrams** row opening at 0 and the largest `num_anagrams` in
    the target, refused at those defaults and accepted one below the ceiling,
    with a bound above it a field error naming the ceiling, on a word target
    and on a leave target whose own largest count is lower; the same
    check against the **quiz type's own** ceiling, so on a Leave Value cascade
    `Length 1–6` and `Number of Vowels 0–6` narrow nothing and are refused
    where `Length 1–15` is refused for a different reason, its bound being
    above that ceiling, and `Length 1–5` is accepted; a Length or Point Value bound above a Leave Value cascade's
    ceiling, `?` in a word pattern or in a word cascade's tile list, a Leave
    Value row with both bounds blank, a
    filter that does not apply to the quiz type, an In Lexicon row naming a
    lexicon on another distribution, **four In Word List rows whose entries
    total 300,001** refused on the row that crosses the total while the same
    four totalling exactly 300,000 are accepted, a pattern that is not in
    canonical form, and a canonical pattern past the stored length — fifteen positions
    each holding a set of the distribution's consonants — reported as a field
    error naming the limit, while one just under it is accepted and stored.
  - The search deadline: a scan over a fixture large enough to exceed a 1 ms
    `SEARCH_TIMEOUT_MS` stops and reports "search too broad".
- **Tile handling**:
  - `A[NY]S` and typed `ANYS` both parse to three tiles.
  - Palette-inserted `N` + `Y` stay two tiles.
  - `N Y`, `[A NY]` and `[ANY]` tokenise as the canonical form says, and a
    non-canonical pattern is rejected by the server.
  - Malformed notation (`[`, `[]`, `[A]`, nested brackets) is rejected, as in
    MAGPIE's `ld_str_to_mls`.
  - Sort order follows the distribution file, with the blank first.
  - Vowel and point counts use the distribution.
- **Property tests** (`proptest`):
  - The shortcut candidate paths return the same results as a full scan, on a
    word target through the per-length buckets and the alphagram map and on a
    leave target through the per-size buckets and the canonical-leave lookup.
  - Anagram Match without wildcards returns exactly the alphagram map entry.
  - Negating a predicate partitions the candidates.
  - An OR group returns the union of its children's results, an AND group the
    intersection, and a limit inside a group is a subset of that group's
    unlimited result.
  - Limit ranges are subsets of the unlimited results.
  - Over random sequences of legal operations chosen from the current state
    (grades, cursor moves, run finishes at boundaries, segment-size changes
    including 0 and values past the question count, finishes, restores of
    ordinary and chain quizzes, trashing and restoring the cascade), the
    cascade stack stays valid: the active levels are exactly `1..depth`, Level
    1 is always the Source quiz, only the deepest level is played on a device, every
    level's questions come from the Source quiz, `run_start` never exceeds the
    cursor, a passed run never descends again, a chain quiz is never segmented
    and stays Drill, `origin_segment_end` is unique per parent attempt, and
    every quiz's rows hash to its `questions_hash`. A Vitest beside it checks
    the default-name summary for every filter type and a name cut at exactly
    199 scalar values plus `…`. The
    generator is seeded and shared with a Vitest that runs the same sequences
    through the TypeScript rules, so a divergence between the two modules shows
    up here rather than as sync rejections in production.
- **Probability tests** check `combinations` against brute-force enumeration of
  every draw from a small bag that spells the word with up to two blanks, for
  bags holding two, one and no blanks, and check that ranks, minimum ranks and
  maximum ranks are consistent on ties.
- **Passwords** (`auth/password.rs`): the dev passphrase meets the
  [strength rule](#authentication) and `password1` and a too-short password do
  not; a password strong on its own is refused when it is the address's local
  part; and scoring runs in its own turn off the executor, returning the same
  field error.
- **Storage** (`storage.rs`): the per-row constants equal
  `contract-fixtures/storage.json`; the [storage formula](#storage-limit)
  against hand-computed rows (a level, a new cascade, a spec whose In Word
  List entries are counted once each by their bytes); and the limit check:
  what fits, nothing past a full or over account, a change adding nothing
  never refused, and the account's own limit replacing the default.
- **Configuration**: `MAX_QUIZ_QUESTIONS` defaults to 300,000 and 300,001
  fails startup; `MAX_STORAGE_BYTES_PER_USER` defaults to 10,000,000 and `0`
  or a non-number fails startup.

**Frontend** (`npm run check`, then Vitest): `lib/cascade` against the shared
rule and shuffle vectors, `lib/local` against `fake-indexeddb`, `lib/sync`'s
rebase and backoff, and `lib/export`'s formatters against the export fixtures.
`lib/cascades/storage.ts` uses the server's per-row costs (equal to
`contract-fixtures/storage.json`), counts a level as its quiz row plus a row
per question, is `ok`, `almost` from 90% and `over` past the limit, and
formats in decimal units; and the sync engine writes every response's
`storage` into `meta.server`.
A Vitest over the cascade builder's preview feeds it a stubbed `503` with
`Retry-After` and asserts that the last count stays on screen with "the server
is busy" beside it, that one retry follows, and that no filter row is marked in
error, then the same for a stubbed `429`; that a run of keystrokes 100 ms
apart produces one request per `PREVIEW_DEBOUNCE_MS` rather than one per
keystroke; and that a run of keystrokes **500 ms** apart — past the debounce on
every pause — still produces one request per `PREVIEW_MIN_INTERVAL_MS`, so a
minute of that typing stays at or under `SEARCH_RATE_PER_MINUTE`, with the last
edit's count on screen when the run ends; that the preview stops at all but two
of that minute's slots and reads "the server is busy" rather than spending them,
so a **Create Cascade** pressed straight after a minute of editing is not
refused; that **two builder instances** sharing one stubbed bucket, each keeping
its own reserve, can still spend it between them, since neither sees the other's
requests; and that a stubbed `429` on Create Cascade is retried after
`Retry-After` with the same body and the same ids, creating one cascade, with
the button showing the busy state meanwhile; the server side of that path is asserted in-process under
[Integration tests](#integration-tests), because holding a search permit open
long enough to force the wait needs a hook the end-to-end stack must not have.
Another covers the filter rows' [ceilings](#filter-reference): a Number of
Anagrams row and a Probability Order row opening at `max_num_anagrams` and
`max_order_rank` from a stubbed `GET /api/lexicons`, a Point Value row at 15 ×
the highest tile value of the stubbed distribution, and a Limit by Probability
Order row at `word_count`, with each refused as narrowing nothing at that
default and each reporting the same ceiling in its field error one above it, so
a builder that reached for `word_count` on all four would fail on two rows.
Another renders `CascadeLadder` and the Cascades page's compact ladder for a
cascade of 30 levels, built by repeatedly missing one question, and asserts that
both collapse the middle levels behind a count with Level 1 and the deepest
level still shown, that **Show more** expands them, and that a 12-level cascade
collapses nothing.
Another covers the In Word List row across a quiz-type change: a list of leaves
stored in canonical order is flagged and recounted as invalid when the type
becomes Anagram, a list of 7-tile words is flagged and recounted when it becomes
Leave Value, and a change between Anagram and Definition flags nothing and
leaves the count alone; and the same on the load path, where a saved search whose
spec records `leave_value` is flagged the moment it loads into an Anagram
builder, from the stored type alone, with no change having happened in the
form; and **Save Search… refused while that row is flagged**, naming the row,
so leave-canonical entries can never be stored under `anagram`.
The `lib/local` tests include two writers in one `fake-indexeddb` never
minting the same `device_seq`, a write from a second tab during a rebase
landing on the rebuilt overlay, and a fixture database at each earlier schema
version, holding an outbox and an overlay, opening at the current version with
every row intact. They also cover the unscoped database: two accounts signing in
leaving two `accounts` rows and one `signed_in` pointer, a logout clearing the
pointer and no row, a startup with no pointer opening no per-user database,
removing an account's data with **no** pending logout deleting its row and its
database while the other account's survive, and the whole path running with
`indexedDB.databases()` deleted from the global, since Safari and Firefox lack
it. They also assert that `storageLine`'s figures (a function no page calls today) for an account that is not signed in come from its `accounts` row with **no `open` on its database**, and
cover the queued logout end to end: removing the data of an account that
**does** hold an unacknowledged logout leaving a row carrying its id, username
and flag alone, absent from `storageLine`, and deleted once the request goes
through; the flag clearing on a `2xx`, on a `401` and on a `403` — the class is
any `4xx` but `429`, and a `403` is what a browser that cleared only its CSRF
cookie would meet — while a `429`, a `503` and a network error each leave it
set; the retry carrying the **CSRF token from the cookie** whenever that cookie
is there, since the `httpOnly` session cookie goes with the request whether the
app wants it to or not, and carrying none once both cookies have expired; the
retry being sent at a startup with no pointer and **not** sent while an account
is signed in; and a second account's login clearing every pending flag, so the
queued logout never reaches the server after the cookie it was for was
replaced. A fixture unscoped
database at each earlier version opens at the current one with its rows and
pointer intact.
The rebase tests cover: a rejected `finish` removing the quiz it created in
the overlay; rejected grades on a trashed cascade disappearing from the overlay
although no server row changed; an applied `finish` with a different outcome
kind showing the notice and one differing only in question count staying
silent; a pulled quiz with a new seed being rebuilt; a pull that only echoes the device's own operations emptying the overlay, the grades then read from the base; the
outbox keeping one `move_cursor` per quiz, re-appended after a queued
`finish_segment`; the engine draining a 600-batch outbox back to back; a stale-rejected change to a cascade's settings reverting it while the other
device's change stands; a second device building a
Source quiz from a pull that carries no question rows; a reset pulled with no
graded rows completing its rebuild at the last page; a cascade outside the
download window fetching its index lists and materialising on first open, and,
when it leaves the window with nothing pending, dropping every question row,
position and card while keeping its cascade, quiz and attempt rows, then on
reopen fetching index lists and graded rows and materialising with every
grade intact; a cascade created while a full pull is in flight surviving the last page; a level promoted from an acknowledged `finish` by a full pull's own response keeping its rows and the answers queued on it; **a tab closed between two cascades' transactions** leaving the cursor unadvanced, the first cascade's acknowledged operation gone with its rows and the second's acknowledged `finish` still in the outbox, so the next sync sends it again and the answers queued on the level it made, beyond that sync's batch, are kept; **a level's own `finish` queued behind the batch that made the level** being applied with everything studied after it, whether it clears the level or descends from it, the base holding the server's level with no answer yet after the first acknowledgement; answers queued behind the finish that reset their quiz being counted once it is acknowledged; an answer regraded behind that batch being promoted as the server has it; **a level made and cleared inside one acknowledged batch** keeping its rows in the base, in the finished attempt's order and graded, so that a restore of it queued behind the batch keeps the answers given after it; a pull for an out-of-window cascade
writing no question rows and leaving its quizzes pending; a grades fetch whose
attempt differs from the base row being discarded and the device syncing
again; a grades fetch cut off after its first page being made again, because the rows it wrote fall short of the quiz row's
`correct_count + missed_count`, while the same fetch run to `question_count`
clears the flag in one pass; an outbox of the 1,200-operation vector's shape (1,002 operations, built by hand) with its `finish` dropped in replay
showing one `stale_attempt` notice counting the grades behind it; the drop
pass removing a 300,000-question cascade's rows within budget; a full
segmented attempt pushed as the device emits it producing no `bad_cursor` or
`bad_segment` rejection and its `finish` applied, not `ungraded`; an out-of-window cascade opened again ending with every grade present; grade rows arriving in a pull for a pending quiz being written
nowhere and the quiz staying pending until the full sequence runs; a new
unplayed quiz materialising with an index-list fetch and no grades request,
and the drop pass leaving such a quiz unflagged; a cascade active on another
device but never opened here holding no question rows and no cards until first
open, one over the automatic keep threshold being kept automatically once it is opened, a cascade opened here 15 days ago leaving this device's window, a grade recording an open while a `trash_cascade` and a `set_cascade_options` record none, and the drop pass sparing the rows of an out-of-window cascade that holds pending operations or whose player is open; an
offline restore of a quiz with no local rows leaving it
pending until first open; an export of a quiz holding only part of its rows, or a set that fails the hash check, reporting the rows missing before it writes anything;
a pull that reports a pending quiz cleared clearing its flag; eviction taking an automatically kept cascade's answers while
sparing its rows and its question keys, and taking
them in **last-opened order, oldest first** — three cascades with distinct last-open times and a limit that fits two, the oldest alone losing its answers — with the
player then showing that cascade's questions from the `questions` store and
"answer needs a connection" on the reveal, grading still saved, and a
questions-only export of it still written from local data; a **typed** anagram
card of that cascade falling back to flashcard mode, its grade starting Correct
and Toggle deciding it, rather than every entry counting wrong; a card whose key
never arrived, from a download stopped part way, reading "this question needs a
connection", emitting no grade, with a
questions-only export of that cascade falling back to the server, and the last
card of that card's run emitting no `finish_segment` while the player names how
many questions still need a connection; the download
manager fetching every in-window cascade's keys with `keys=1` before any cascade's answers; a tombstone removing a cascade with its question rows and its last-open time; the drop pass removing a cascade's question keys along with its rows, and the next open fetching the rows back with every grade;
a quiz cleared offline and a cascade trashed offline each listed in the Trash as provisional, with no date it is deleted forever, the trashed cascade gone from the Cascades page, and the acknowledged row replacing the cascade's; the drop pass dropping the least recently opened unkept cascade
when the base's rows and keys pass `ROW_STORAGE_BUDGET`, before its 14 days are up; the same pass taking its two tiers in order, so an **automatically kept** cascade,
even the least recently opened, is dropped only once every unkept one is gone,
and then oldest first with none exempt; a cascade the budget dropped **while it was
still inside the window** being marked in `meta` and left alone by the next
pull's download manager — no index list, no grades, no keys, no cards, absent from `question_rows_for` — so the pass settles in one run
instead of dropping and refetching the same cascade forever, then opening it
clearing the mark and fetching it back whole, a marked cascade over
`AUTO_KEEP_OFFLINE_ROWS` counting as neither wanted nor kept until it is
opened, and the same mark left by a forced drop (in the scale tier); a `QuotaExceededError` thrown by a pull's per-cascade transaction leaving the cursor unadvanced and the outbox intact, asking once for room to be made and making the pull again with the same batch, which then loses nothing, and on a second failure reporting no room, with the status no longer "Syncing…", the staging rows left for the next pull and studying continuing until a later sync applies everything; the same error thrown by an **`applyLocally`**
instead, where the grade reached neither the overlay nor the outbox: the player
stays on that card with the storage message in place of the grade, Show / Next
advances nothing, and the grade is written once a cascade is removed and the
retry succeeds; the download manager reading a missing
distribution's tiles from the `distributions` store; a `finish` rejected `ungraded` after a `not_found` grade being dropped and leaving the missing question to grade; an acknowledged offline `finish` leaving its new level playable in the one request that acknowledged it, with no index list asked for, and a same-count, different-set promotion refused by `new_quiz_questions_hash`, its list marked to be fetched, with the notice; a `finish` the device computed as
`cleared` that the server applied as `descended` leaving the finished quiz
rebuilt from the server's seed with no grades, the reverse leaving the base's
graded rows untouched with no fetch, and a `finish_segment` computed as
`drilled` but applied as `continued` dropping the drill quiz with no request,
and the same for a `finish` the server answered `completed` where the device had built a new level, with the came-out-differently notice and `completed_at` from the pulled row;
a `finish` acknowledged on its second send, after a lost response, promoting
its rows with no notice; the fast path taking a batch of applied grades
without touching the other pending grades' overlay rows or reading the cascade's other pending operations; every base row carrying the sequence of the response that
wrote it, so a full pull deletes the rows an earlier pull wrote and spares those a creation or a promotion wrote while it was in flight;
a `restore_quiz` rejected with reason `error` dropping its overlay quiz row and
showing the could-not-be-restored notice; a batch whose only acknowledged
operation is an applied `purge_cascade` taking the fast path with its tombstone
still applied in step 2; a `finish` rejected `stale_attempt` with dropped grades showing both sentences; **two offline finishes in one batch**,
the first rejected `not_deepest` and the second — with the grades on the level it
created — rejected `not_found` because that level never reached the server,
showing **one** notice, the `not_deepest` one, whose count covers both levels'
dropped grades and which never says the cascade was deleted, while the same
`not_found` on a cascade the pull's tombstone removed does show the deletion
sentence, and grades rejected `not_found` for questions the server's own miss set
lacks show the came-out-differently sentence with their count and no deletion
sentence; the drop pass running after a pull; a cleared quiz
pulled by a new device arriving as one row with no question rows, restorable
offline and pending until online, and a Trash export of it fetching its
rows; a `finish` clearing a quiz leaving that quiz's rows and positions in
the base, so a Trash export of it works offline; a pull that reports a quiz cleared never flagging it pending; a full pull deleting no base row of a cascade with
pending operations although it is absent from `question_rows_for`; a `stale`
grade beside an applied `finish` with a matching outcome showing the grade's
own sentence; a new order-filter row opening at rank 1; the drop pass in a
browser without Web Locks skipping the running tab's open cascade; the drop
pass skipping a cascade whose player is open in a second tab that holds its
Web Lock; a cascade pulled from another device having its distribution fetched and stored, and typed mode on one whose
distribution is missing showing "needs a connection"; a `set_quiz_options`
with a segment size above the cap `/api/auth/me` reported being refused on the device; a resync on a device holding five 300,000-question cascades
comparing base and pull within the [scale test](#scale-tests)'s budget; the
Cascades page showing **Available offline**, not the download label, for a
cascade opened inside the window; the `stale_attempt` grade notice for grades with no finish of this device behind them; a `finish` rejected `not_active` showing the
finished-elsewhere sentence; a cascade over `AUTO_KEEP_OFFLINE_ROWS` not being dropped when it leaves the
window, and eviction taking its cards all the same; cards fetched
without definitions, the cascade's setting turned on offline, and the cards refetched with definitions on reconnect, read from
the cascade as the device sees it, before the change is sent; a first sync
sending `cursor: null`; a `resync_required` response answered by a
`cursor: null` pull that sends the same batch again, replacing the base and replaying the rest
of the outbox with nothing lost, a batch holding a finish with answers queued
on the level it made included, and deleting a quiz the full pull
did not carry; an interrupted pull converging on the next
sync; a `426` acknowledging its operations and applying their pull (the level
an acknowledged finish made stays, with the answers queued on it), showing **reload to keep syncing**
rather than a waiting count, keeping the rest of the outbox and the grades that
follow it, and still showing that state after a reload the service worker
answered from its cache, until a sync succeeds; a `503` and a `429` each resending the same batch with the outbox intact (the wait itself is a stand-in the tests do not time); a change stream the browser gave up being opened again after a wait that doubles, one the browser is reopening itself being left to it, and one refused while the account needs to log in staying closed. The **download manager** has its own: a `429` on a cards page being waited out and that page fetched again, with no page lost or fetched twice; and a page the player needs on the current card taking priority, so the download manager starts nothing while one is outstanding.

**Not asserted by any test today.** Each of these is behaviour this plan
states and the code is written to; none has a test whose body would fail if it
broke, so none should be read as covered: the full path being chosen from a
pulled question group's `min_updated_seq`, or from a cascade, quiz or attempt
row's `updated_seq` or a tombstone's `seq`, below the response's `sync_seq`
(which path ran is not observed by any test); grades queued behind an applied
`purge_cascade` being dropped when the full path next runs; a page of a pull
written while the player is on the quiz changing nothing the player reads until
the last page; a pending mark surviving the index-list fetch until the grades
arrive, and a cascade re-entering the window through a pull rather than an
open; a `questions_hash` mismatch found after materialisation refetching the
list; a cleared level's rows fetched for a Trash export being dropped when the
cascade leaves the window and fetched again for a second export, and an export
of rows that lack positions; a restored quiz's sequence fetching the cascade's
missing keys, its surviving the next drop pass, and its taking the server's
options row; a full pull's deletion removing a cascade's `questions` and
`cards` entries and its budget-dropped mark and sizes (a tombstone's removal of
keys and cards is not asserted either: the device in that test holds none); the
keys coming back on the open after a drop; a cascade studied for 15 days
staying in the window, one studied elsewhere leaving it, and an export counting
as an open; a `purge_quiz` or `set_quiz_options` not refreshing the last-open
time; the quota path's retry refetching nothing, and **the drop pass running
before the answer eviction** when a pull finds no room (the engine test sees
only that room was asked for once); a completion computed while another
device's finishes were unpulled showing this device's own counts, the
came-out-differently path opening **no completion screen**, and a `finish` the
server answered `reshuffled`; a `finish` rejected `not_deepest` with every
grade kept showing its sentence alone, and the `stale` and `not_active` grade
notices with no finish behind them; a quiz already holding a segment size above
a lowered cap still playing, and Settings prefilling the cap (`clampPrefill`);
a grades-fetch row written while a full pull is in flight being spared; a
resync refetching no index list for an unchanged seed; the budget pass's own
skip of a cascade with pending operations (the window's pass is tested); the
second and third cascades' order under eviction; `429`s on keys, index-list and
grades pages, the progress indicator across one, and ten 300,000-question
cascades draining through a bucket that answers `429` from the 120th request of
a minute; and a multi-page full pull promoting a level. `Retry-After`'s length
is never timed.

The **export formatters** are held to one set of fixtures on both sides.
`contract-fixtures/export/` covers all three quiz types, the four selections,
both formats, both orderings for a quiz export and the cascade export offering
only one, a selection with no entries in both formats
(zero bytes, and the header row alone), multi-character tiles in MAGPIE notation, CSV
quoting of definitions with commas and quotes, CRLF versus LF line endings,
multi-word anagram answer cells, an anagram row whose definitions contain ` / `
and one whose definition contains ` | ` (written as it is, since the cell is
for reading),
the `hooks` and `grade` cell forms including a word with four front hooks in
tile order, leave values at every decimal setting, empty `definition` and
`hooks` cells for Leave Value rows, the
filename rule applied to a default cascade name with `·` and `–` in it, to a
name holding a character outside the Basic Multilingual Plane (one `_`, not
two) and to a name longer than 100 characters, and the
cascade-wide definition of correct and missed across several active quizzes. A Rust test and a Vitest test
run the same fixtures, and an [integration test](#integration-tests) checks that
`GET /api/cascades/:id/export` returns the same bytes for the same request.

### Integration tests

`cargo test` with `TEST_DATABASE_URL`, driving the real router in-process
against a real Postgres. Each test runs in its own transactional database, so
they run in parallel and leave nothing behind.

- **Upload validation tests**: one failing file per rule under
  [File formats](#file-formats). Each asserts the line numbers in the error list
  and that nothing was written. A file with many errors reports the first 1,000
  and the total. Every letter distribution file in MAGPIE-DATA, fetched at a
  pinned commit, uploads unchanged and produces the expected tiles.
- **Schema tests**:
  - Every one of the 23 condition types round-trips through
    `search_conditions` and back into an equal `ConditionKind`, In Lexicon in
    both of its stored forms — the id in a cascade's spec, the name in a saved
    search's — with a row holding both, or neither, rejected by the `CHECK`, and a nested
    AND / OR tree round-trips through `search_groups` unchanged, with the spec's
    `quiz_type` carried back out beside it.
  - For each type, inserting a row with a missing or extra parameter, or with
    Not where it isn't allowed, is rejected by the `CHECK`.
  - A spec of 100 groups round-trips, and a 101st is rejected by the `id`
    `CHECK`, which is the constraint the application's group cap is set to, so
    the two can never disagree about where the limit is.
  - A Leave Value condition with `NaN`, `Infinity` or `-Infinity` in either
    bound is rejected by the `CHECK`, including the `NaN`–`NaN` pair that
    satisfies `min_leave_value <= max_leave_value`, and a finite pair at the
    upload bound of ±1,000,000 is accepted.
  - A `text_value` of 500 canonical characters is stored and one of 501 is
    rejected by the `CHECK`, so the field error the application reports first
    and the column's own limit are the same number.
  - A Leave Value cascade whose leave value set belongs to another lexicon is
    rejected by the composite foreign key.
  - Replacing a lexicon's definitions, and a leave value set's values: every
    difference but the replaceable part is refused with the upload error list
    and nothing stored; a replacement raises the revision, keeps the stored
    order, gives every cascade on the item a new `updated_seq` and no other,
    and is what cards, searches and the admin overview then show; while the
    instance's index is older than the row's revision, cards that carry the
    replaced part answer `503` and the others do not.
  - An account's cascade names: a second cascade of a name is a `400` on
    `name`, in the Trash or not, and not for another account; Duplicate
    numbers its copy, replacing a number already there and cutting a name at
    the limit; the unique constraint holds under a direct update.
  - A second active quiz at the same level, a second Source quiz, a Source quiz
    at any level but 1 or with status `cleared`, a non-Source quiz at Level 1,
    and a cascade with `depth` 0 are each rejected.
- **Sync integration tests** (`cargo test`, `TEST_DATABASE_URL`):
  - A repeated operation is applied once and gets the same result in every
    field, `outcome`, `new_quiz_question_count` and `new_quiz_questions_hash`
    included.
  - A `finish` whose `shuffle_seed` and resulting `questions_hash` are both
    **above 2⁶³** is applied, stored as negative `BIGINT`s, and answered — and
    then pulled, and fetched again as a repeat — with the unsigned decimal text
    the device sent and computed, so the device's hash comparison matches and no
    outcome-mismatch notice appears; the same seed sent back as an
    `attempt_seed` on a later `grade` is recognised rather than rejected as
    `stale_attempt`.
  - Operations are applied in `device_seq` order, and one rejection doesn't stop
    the batch.
  - Two simulated devices cover every row of the [Conflicts](#conflicts) table.
  - Pulls return exactly the rows changed since the cursor, across page
    boundaries, with the first page's `question_rows_for` and sequence ceiling
    fixed for every page even when a later page request sends a different list
    and another device commits a row between two pages.
  - A page holds at most 50,000 rows of any kind: a pull of 60,000 cleared
    chain quizzes is paged although it carries no question rows at all, and so
    is the pull of their 60,000 tombstones after the retention period; no page
    exceeds the limit, each row appears once, and a quiz row still precedes its
    own question rows across a page break that falls inside `quizzes`.
  - Each `quiz_questions` group carries `min_updated_seq` as decimal text,
    equal to the lowest `updated_seq` among its rows in that page, so a page
    holding one grade from an earlier push beside this push's own reports the
    earlier sequence; every cascade, quiz and attempt row carries its own
    `updated_seq` and every tombstone its `seq`, as decimal text, so a pull
    holding one cascade row from an earlier push beside this push's own reports
    both sequences and the device can tell them apart; and a quiz whose rows span a page break reports a minimum
    per page, with the earlier device's grade on the first of them, so a device
    that folded only the last page would wrongly take the fast path.
  - Search concurrency: with `SEARCH_CONCURRENCY=1` and a short
    `SEARCH_TIMEOUT_MS`, a second concurrent search is answered `503` with
    `Retry-After` and never `422`, while a search admitted on an idle instance
    returns its results.
  - Purges produce tombstones, and a cursor below `sync_floor_seq` gets
    `resync_required` carrying the push's `results` and no `changes`, while a
    cursor between the floor and the oldest kept tombstone does not; so does
    a cursor above `sync_seq`, with none of the request's operations applied;
    after the restore procedure's sequence bump a device whose cursor was
    ahead of the server has its operations applied and is told to resync; a
    `cursor: null` request on an account whose floor is above 0 returns every
    row and no tombstones, never `resync_required`; and a `cursor: null`
    request carrying 200 grades from a device that created its cascade and
    never synced applies them and returns every row.
  - A pulled cascade row carries its settings (`show_definitions`,
    `show_hooks`, `reveal_correct`, `leave_value_decimals`, at their defaults
    for a new cascade), and no pull carries a `preferences` object.
  - The grades endpoint returns a quiz's graded rows in pages with its attempt
    and seed, and `404` for another user's or a purged quiz. `from` is an index,
    so a 300,000-question quiz whose only 400 graded rows sit above index
    250,000 answers the first five pages with no rows and the sixth with all
    400, and every page's rows fall inside its own `from … from+limit−1` window.
  - A sync whose `question_rows_for` omits a cascade carries none of its
    question rows, one with an empty list carries no question rows at all, and
    one naming another user's cascade or a purged id has those ids ignored.
  - `/api/lexicons` omits an item while a second instance is still completing
    its startup load and lists it once that instance turns ready, and an item
    an instance drops leaves that instance's `catalog_instance_status` rows at
    once.
  - `GET /api/cascades/:id/cards` with `keys=1` returns `{ from, keys: [...] }`
    with no per-row index, accepts a `limit` of 100,000 and refuses 100,001,
    refuses `hooks` or `definitions` with `400`, and lists the same keys in the
    same order as the full form for the same range; a card page is served
    `no-store` while the questions endpoint keeps its immutable caching. On a
    Catalan Definition cascade of 15-tile words the same page's keys run to tens
    of bytes each, which is why the estimate under
    [On the device](#on-the-device) is a range and the budget measures; the test
    records the page's bytes per key on both that cascade and an English anagram
    one, so the 100,000-row limit's sizing is measured rather than assumed.
  - A device-created quiz id that already exists is rejected.
  - Grades pushed for a cascade purged on another device are rejected as
    `not_found`, and the same pull carries its tombstone.
  - A repeated `finish_segment` for the same quiz, attempt and boundary is
    applied once, and two devices racing on one boundary produce one drill quiz;
    and when that run **missed nothing**, so the winner created no drill quiz,
    the loser is rejected on the cursor test rather than as a duplicate and the
    device shows the run-finished-elsewhere sentence, not the size-or-place one.
  - `finish_segment` is rejected for a quiz with no segment size, for a boundary
    that is not a multiple of it, for one at or past the question count, and for
    one with ungraded questions before it; a `set_cascade_options` or
    `set_quiz_options` carrying a segment size of 1 to 4 is rejected as
    `invalid`, and the schema `CHECK` refuses such a row directly.
  - Options operations resolve whole: with one device changing
    segment size and the other progression with interleaved timestamps, the
    later operation is applied, the earlier is rejected as `stale`, and the
    row matches the later one alone.
  - The first `grade` on an ungraded question and the first `move_cursor` on a
    fresh quiz are applied.
  - A device's own regrade with an earlier `graded_at` is applied; another
    device's earlier grade is not, and is rejected as `stale`, as is an
    earlier cursor move from another device; a second `finish` after one
    that cleared the quiz is rejected `not_active` and after one that reset
    it `stale_attempt`; another device's earlier grade whose
    `seen_seq` covers the current grade is applied; the same for cursor moves,
    options, including an options change by a device that had
    seen the options but not a later cursor move on the same quiz
    (`options_seq`); a grade's `at` stored as its `graded_at`, the grade
    carrying no other timestamp; a grade dated a year ahead is stored at
    `now() + 5 minutes` and loses to a real grade ten minutes later, and a
    `finish` dated a year ahead records `finished_at` at `now() + 5 minutes`;
    and two
    option changes from one device with a clock
    a day ahead, sent in one batch, are both applied
    (`options_device_id`); a stale `set_cascade_options` carrying
    `leave_value_decimals` loses whole.
  - `move_cursor` is rejected below `run_start`, at or past the next run
    boundary, and at the question count of a quiz with no boundary; a
    `device_seq` gap left by a coalesced cursor move is accepted.
  - A `grade` for a question that is not in the quiz is rejected as not found.
  - A pull sends only graded question rows of active quizzes and never an
    index list or a cleared quiz's rows, sends each
    quiz row before its question rows, and orders tables as specified; the
    questions endpoint returns a quiz's index list in pages, `404` for a Source
    quiz, and the same bytes for the quiz's whole life.
  - A sync whose `app_version` is below `MIN_APP_VERSION` gets `426` with its
    operations applied and their `results`, while the build number equal to it
    syncs normally, and a non-numeric `app_version` is a `400`; an operation whose `seen_seq` is
    above the user's `sync_seq` is rejected as `invalid`; and a `trash_cascade`
    on a trashed cascade, a `restore_cascade` or `purge_cascade` on an active
    cascade and a `purge_quiz` on a purged quiz are rejected as `trashed`,
    `not_trashed`, `not_trashed` and `not_found`.
  - A repeated `POST /api/cascades` or duplicate with the same `id` returns
    the existing cascade and takes no second slot; an `id` held by another
    user is refused; and an options change seconds after creation from a
    device whose clock is behind the server is applied, not `stale`.
  - A cascade creation runs its search before opening a transaction: with a
    slow search, the purge task for the same user acquires that user's row
    while the search is still running, and neither blocks the other; a
    creation over the limit is refused before the search runs at all, and one
    that loses the limit race after searching is refused with `409`.
  - Restoring a trashed cascade, or one of its quizzes, resets `cleared_at` on
    its remaining cleared quizzes, and the purge task leaves them for a full
    retention period afterwards, while a quiz restored in an active cascade
    leaves its siblings' `cleared_at` untouched; a `finish` whose `at` is 40
    days old, applied today, clears a quiz the purge task leaves alone for a
    full retention period, while the cascade's `last_activity_at` is 40 days
    old on a cascade with no newer activity, and an older `at` never lowers
    either `last_activity_at` column.
  - `finish` is rejected while a question is ungraded, and applied with an
    outcome that differs from the sender's when another device's grade moved
    the score across the threshold.
  - `peak_depth` and `attempts_since_completion` are unchanged by a purge: a
    cascade with fifteen attempts since its last completion has its cleared
    quizzes purged, which deletes their `quiz_attempts` rows, and both
    counters still read what the finishes set, so the completion screen counts
    work the retention period has swallowed.
  - A `grade` on a question in a run another device has already passed is
    applied: it moves that attempt's counters, the run's drill quiz is not
    duplicated (`quizzes_one_per_segment`), the grading device's
    `move_cursor` inside the passed run is rejected `bad_cursor` and its
    `finish_segment` for that boundary `duplicate_segment`.
  - A `set_cascade_options` or `set_quiz_options` carrying a segment size of 3,
    a segment size above `MAX_QUIZ_QUESTIONS`, or an unknown progression, or a
    `set_cascade_options` carrying a clear threshold of 0, 101 or 50.5, is
    rejected as `invalid` before any write, so no such operation is ever
    recorded with reason `error`; the same for a `set_cascade_options`
    carrying `leave_value_decimals` of 4, −1, `"2"` or 1.5, and for an
    operation of a type the server does not know (`set_bindings`, which
    controls no longer use, and `set_preferences`, since no setting is the
    account's) — each `invalid`, with the row unchanged and
    nothing recorded as `error`, since an `error` alarms (see
    [Monitoring](#deployment-and-operations)).
  - A `restore_quiz` whose application raises a database error inside its
    savepoint is recorded `rejected` with reason `error`, leaving the rest of
    the batch applied.
  - Saving a search that would not fit in the account's
    [storage](#storage-limit) is refused with `409` and
    `{ error: "storage_limit", used, limit, needed }`; two simultaneous saves
    compete for the last space and only one takes it; an overwrite of an
    existing name counts only the difference; and deleting a search frees
    exactly what it held.
  - `GET /api/letter-distributions/:name` answers from an instance that has
    not finished indexing the lexicons built on that distribution, since it
    reads `letter_distribution_tiles` directly.
  - Every limited endpoint carries the limit its bullet in
    [Security](#authentication) names: with each rate lowered to 1, a second
    call in the same minute to a card page, a search, a saved search's
    `GET /api/searches/:id`, an export, a sync and an
    **admin upload** is answered `429` with `Retry-After`, and spending one
    bucket leaves the others untouched.
  - The auth limits: with `LOGIN_FAILURES_PER_IP_PER_MINUTE` at its default,
    twenty **successful** logins for twenty accounts from one address all
    succeed, while the eleventh **failed** login from that address in the minute
    is refused with `429` before any Argon2 verify runs, and a login for another
    username from a second address still succeeds; the eleventh failure for one
    username is refused from any address; with both limits lowered to 3, of
    eight failed logins sent **at once** from one address, and of eight sent at
    once for one username, three are answered `401`, five `429`, and three
    verifies run; a 100,000-character username is answered `401` without a
    verify however often it is sent, and a reset asked for one `202` without
    spending the caller's hourly bucket; with `RESET_RATE_PER_HOUR` lowered to
    3, a fourth password typed into Sign out everywhere, Delete account or
    Change password is answered `429`, another account's first is not; and with
    `AUTH_RATE_PER_IP_PER_MINUTE` lowered to 1, a second register,
    confirm-email, reset-password or reset-password/confirm from one address in
    the minute answers `429` with `Retry-After`, while `GET /api/auth/me` and
    logout from that address do not.
  - The reset limits (`reset_limits`), at `RESET_RATE_PER_HOUR`'s default of 5
    with the per-IP auth bucket raised out of the way: five resets asked for
    one address from five addresses are answered `202`, and a sixth from a
    sixth address, the address in another case, `429`; five from one caller
    for five addresses are answered `202`, and its sixth, for a sixth
    address, `429`; a wrong link sent with a weak password is
    `400 invalid_token`, refused as a link rather than scored; and a real link
    refused a weak password five times from five addresses is answered `429`
    on its sixth try, a strong password from yet another address included.
  - The two endpoints that need no session are limited per IP: with
    `CATALOG_RATE_PER_MINUTE` lowered, `GET /api/lexicons` and
    `GET /api/letter-distributions/:name` answer `429` with `Retry-After` once
    the bucket is spent, the same requests from a second `X-Forwarded-For`
    address still succeed, and a signed-in user's sync on the same instance is
    unaffected, since the bucket is not shared with the per-user limits.
  - An operation id already recorded for another user is rejected as not found.
  - The request-level `400`s, each leaving nothing written and no operation
    recorded: `SYNC_MAX_OPS` + 1 operations, a `page_token` sent with an
    operation, a `question_rows_for` of `MAX_QUESTION_ROWS_FOR` + 1 (1,001) ids (1,000 is
    answered), an
    operation-level `device_id`, and a non-numeric `app_version`; and, as
    rejections rather than `400`s, an operation with `device_seq` 0 and one
    reusing a `device_seq` this device already sent under a different `id`,
    both `invalid`, with the `(user_id, device_id, device_seq)` constraint never
    reached and nothing recorded as `error`.
  - A pull spanning several pages returns each row once while another device
    commits between pages.
  - `set_quiz_options` naming `progression` or `segment_size` for a
    segment-chain quiz, or `progression` for the Source quiz, is rejected as
    `invalid`, and restoring a segment-chain quiz in a Ladder cascade keeps
    it on Drill with no segments.
  - `purge_quiz` on a quiz of a trashed cascade is rejected as `trashed`, and
    on an **active** quiz of a live cascade as `not_cleared`, which is also
    what a `restore_quiz` for a quiz another device already restored gets; the
    purge task leaves a trashed cascade's quizzes until the cascade's own purge,
    and every
    rejection in the suite carries a reason from the fixed list.
  - A database error injected inside one operation's savepoint (a `CHECK`
    violation) leaves the rest of the batch applied and records that operation
    as `rejected` with reason `error`; a forced serialization failure answers
    `503` with `Retry-After` and records nothing, and the same batch sent again
    is applied in full; and the purge task running against a concurrent sync
    for the same user completes without a deadlock.
  - Re-registering an unconfirmed email re-sends a code while the old one is
    valid and replaces the account once it has expired, and its username is
    taken while the code is valid and free after; a fourth confirmation,
    notice or reset email to one address from one IP within 24 hours (with
    `RESET_RATE_PER_HOUR` raised, so the reset limits do not answer first) is not sent
    while the response stays the same and a request from another IP still
    sends, while the **twenty-first** to that address within 24 hours is not sent
    from any IP, however many addresses the requests come from, so the per-IP cap
    cannot be walked around with a fresh IP each time; and a replacement made under the cap still
    replaces the account and sends its code with the next registration after
    the window; the purge task deletes stale unconfirmed accounts.
  - A 300,000-question `finish` and reset complete within budget, and the reset
    is pulled by another device as one quiz row. The integration suite
    (`sync_faults.rs`) runs this case at 130,000 questions, as `pull.rs` runs
    the grades endpoint's; the [scale tests](#scale-tests) cover the finish at
    300,000.
  - The event stream: another device of the account hears of a change at
    once, the device that made it and another account do not, and a stream
    needs the session and the account it names; with `SYNC_STREAMS_PER_USER`
    at 2 and `SYNC_STREAM_RATE_PER_MINUTE` at 5, a third stream while two are
    open is a `429` and takes no place, another account's count is its own, a
    stream the client closed gives its place back, and an open past the
    minute's rate is a `429` with a place free, while `POST /api/sync` is
    limited by neither.
  - Shared device settings merging per setting by the later `at`, coming back
    on every response, refusing malformed shares and a `NUL`, and a share
    stamped decades ahead being kept as five minutes from now at most, so the
    next share takes the setting back.
- **Other integration tests** (`cargo test`, `TEST_DATABASE_URL`) drive the real
  router in-process, covering:
  - the auth flows, including the reset-password response taking the same time
    whether or not the address has an account, and the CSRF cookie carrying
    the session cookie's TTL and being re-set by `GET /api/auth/me`, so a
    client holding only the session cookie recovers a usable token; a logout
    clearing **both** cookies, and a login after it re-setting both; and
    `POST /api/auth/logout` with **no cookies at all** — what a device offline
    past both cookies' TTL sends — answered `2xx` rather than `401` or a CSRF
    `403`, while the same request **with** a session cookie and no CSRF token is
    refused `403` like any other write, and **with the session cookie and a
    matching token** — the ordinary queued logout, whose cookie the browser
    still holds — answered `2xx` with both cookies cleared
  - a **password reset** (`password_reset`): the reset email carrying the
    account's username ("Your Acrodont username is …"); a weak password and
    one that is the account's address each refused as a `password` field
    error with the link still working after; the strong password accepted
    with `204` and the caller's session cookie cleared; every other
    outstanding token spent and every session answered `401`; the link
    refused a second time; and the new password logging in. And a
    **signed-in password change** (`a_signed_in_password_change`): a wrong
    current password and a weak new one each a field error with nothing
    changed; then `204`, this session working, every other answered `401`,
    and only the new password logging in
  - saved-search overwrite answering `409` without `overwrite` and replacing
    the old spec with it, and delete removing the spec; a save recording its
    `quiz_type` on the spec, `GET /api/searches/:id` returning it, and Duplicate
    copying it onto the new cascade's spec; a **round trip** of a tree holding
    nested AND and OR groups, every parameter shape and a 10,000-entry In Word
    List, saved and then read back from `GET /api/searches/:id` equal to what was
    sent, child order included, since that response is the only thing
    Load Search… has to rebuild the form from, while `GET /api/searches` lists
    the same search with `word_list_entries` 10,000 and **no tree at all**, and
    `GET /api/searches/:id` for another user's search answers `404`; a save
    whose response is lost, retried with the same `id` and body, returning the
    saved search rather than `name_taken`, and with the account then at its
    storage limit rather than `storage_limit`, with one row stored and counted
    once; an `id` held by another user refused with `409`; a missing name and
    a 101-scalar-value name each answered `400` with a field error, and a
    100-scalar-value name stored; and a save validating its tree like
    a preview — an empty group, a fifth nesting level, a row that does not apply
    to the submitted `quiz_type`, a
    `text_value` past the limit and In Word List rows totalling more than
    300,000 entries each answered `400` with the same
    `{ path, field, message }` errors and nothing written, while a tile that is
    not in some other lexicon's distribution is **not** an error, since a saved
    search carries no lexicon
  - `/api/lexicons` omitting an item one of two in-process instances has not
    loaded, and listing it once both have written `catalog_instance_status`
    rows, with a stale heartbeat ignored; and its four derived maxima —
    `max_num_anagrams`, `max_order_rank` and the two `leave_` figures, `null`
    on a lexicon without leave values — equal to the same maxima computed by
    brute force over the fixture catalog, since they are the only
    [filter ceilings](#filter-reference) the builder cannot work out for itself
  - admin authorization: non-admins get `404` on every admin route, and
    revoking `is_admin` takes effect on the next request
  - **Account binding**: a sync, a card page, a cascade creation and an export
    token request sent with Bob's session cookie but `X-Acrodont-User` naming Alice — or with
    no header at all — each answered `401` with nothing applied, recorded,
    pulled or streamed, and the same requests with Bob's id succeeding; and a
    `POST /api/auth/login` or `/api/auth/register` sent as `text/plain` with a
    JSON-shaped body answered `415` with no cookie set; `GET /api/auth/me` with
    `X-Acrodont-User` naming another account answered with the **cookie's**
    `user_id` and a fresh CSRF cookie rather than `401`; and
    `POST /api/auth/logout` with a session cookie, a
    matching CSRF token and **no** `X-Acrodont-User` answered `2xx` with both
    cookies cleared, as the queued logout sends it
  - **Sign out everywhere** with two sessions for one user: a wrong password
    refused and nothing changed; with the right one, the other session's next
    request answered `401` while the session that pressed it gets fresh session
    and CSRF cookies and its next sync succeeds
  - uploads followed by catalog reload across two in-process app instances
    sharing one database (`NOTIFY`), and the reconcile fallback
  - two app instances booted **at the same time against an empty database** both
    reaching ready, with the migrations applied once and `_sqlx_migrations`
    holding one row per migration, which is what a rolling deploy does on every
    release that carries one
  - deletion refused for each kind of reference, and allowed once unreferenced;
    a lexicon named only by a **saved search's** In Lexicon row deleted without
    refusal, `/admin` counting only cascades, and that saved search then loading
    with the row flagged and refused at creation, while an In Lexicon row in a
    live or trashed cascade's spec still refuses the deletion
  - cascade creation for all three types, a new cascade taking the default
    settings, Duplicate (including at the storage limit, refused with
    `storage_limit`, the original being purged afterwards, the copy holding
    the same storage, and the copy keeping the original's threshold, options,
    answer mode and other settings), card pages, a missing
    or 201-scalar-value `name` refused with `400`, and a
    300,000-entry In Word List accepted under `API_MAX_BODY_BYTES` while eight
    rows of 250,000 entries — a body well under the same limit — are refused
    with a field error on the row that crosses the tree's 300,000 total, on
    creation and on preview alike, with nothing written
  - the [storage limit](#storage-limit) (`backend/tests/storage.rs`): the
    preview's `storage_bytes` is exactly what creation stores, on the cascade
    row, on the user's total and as the formula counts the rows; creation and
    Duplicate past the limit refused with `409` and
    `{ error: "storage_limit", used, limit, needed }`, writing nothing, and an
    account already at its limit refused before any search with `needed` 0;
    two simultaneous creations racing for the last space, one winning; a
    finish that takes the account over its limit still applied, with the pull
    and every sync response showing the new figure; purging a cleared quiz or
    a trashed cascade, through sync or the purge task, freeing exactly what
    was counted, trashing and restoring changing nothing, and each change
    reaching the pull; the purge task recounting a drifted total; a
    `question_rows_for` of 1,000 answered; and the calibration: a
    20,000-question anagram cascade made from a 20,000-entry In Word List and
    studied through two half-missed finishes, its live rows copied into
    fresh tables with every index, measured with `pg_total_relation_size`,
    the formula within ±20% of it (it reads 1.012 times the measurement)
  - `/api/auth/me` reporting `storage_bytes` and `max_storage_bytes`, the
    configured limit or the account's `storage_limit_bytes`, and no cascade
    count
  - creating a cascade with each combination of quiz options, and the Source
    quiz carrying the copy
  - every export endpoint selection, for all three quiz types, including an
    export of a quiz in the Trash and a `404` for another user's cascade, each
    through a token from `POST /api/cascades/:id/export-token`; the token
    request answering `401` for a mismatched `X-Acrodont-User`, `404` for a
    purged quiz and `429` with `Retry-After` past `EXPORT_RATE_PER_MINUTE`; and
    the download answering `204` for a token used twice, a token 61 seconds old,
    and a token presented with choices other than those it was issued for; and a
    token issued by one of two in-process instances redeemed on the other, then
    refused on a second redemption on either, since its use is recorded in
    `export_tokens_spent` and not in either process; and an export token
    presented as the `acrodont_session` cookie, and a session token presented
    as an export token, each refused, since the export key is derived from the
    session key and neither decrypts under the other
  - the purge task, including two instances running it at the same time
  - one user being unable to reach another's cascades through REST or sync
  - the application-level invariants listed under [Schema](#schema), among
    them each cascade's `storage_bytes` equalling what its rows hold and the
    user's total equalling the sum of its cascades' and saved searches', after
    every operation in the shared rule vectors

### End-to-end tests

Playwright against the whole stack, in a real browser, with the production-style
build and a registered service worker. This is the only layer that can prove the
offline promises, so it is where the plane, the two devices and the expired
session live.

#### What the tests reuse

Playwright's `globalSetup` does not know how to start a Acrodont. It calls the
same `scripts/stack.py` entry points that
[`./scripts/dev.py`](#how-it-is-put-together) calls, in the same order:

| Reused | How the suite uses it differently |
|---|---|
| `stack.up` | Project `acrodont-e2e` and a port from the environment, so a suite can run beside a development stack without disturbing it |
| The production-style frontend build | Not differently at all — the offline journeys need the real service worker, which is exactly why `dev.py` serves that build too |
| `stack.seed`, through the admin API | Seeds only [the fixture catalog](#the-fixture-catalog); licensed files are never available to CI. Every run therefore registers and confirms the `dev` account through the real endpoints, so a passphrase the strength check refused, or a registration side effect seeding skipped, fails the suite at its first step; and `make test-e2e-seeding` runs it once more with `ADMIN_UPLOAD_RATE_PER_MINUTE=2`, where seeding must wait out `429`s and still finish (CI's Main tier, and any push that changes `scripts/`) |
| `stack.reset` | Called between suites rather than by hand. Most specs don't need it, because each one registers its own user |
| `stack.down` | With `--volumes` at the end of a CI run |

Everything the tests need that a developer wouldn't goes through the same
`--env` flag a developer would use, so there is **no test-only code path in the
server**: `SESSION_TTL_SECONDS` short for the expired-session journey (the
`@ttl` pass), `TRASH_RETENTION_DAYS=0` with a short `PURGE_INTERVAL_SECONDS`
for the purge journey (`@purge`), and `MAIL_BACKEND=file` so the confirmation
code can be read out of the stack's mail outbox (or `console`, out of the
backend's logs — which is also how a developer confirms an account locally).
Every suite stack also raises the per-IP auth and catalog limits
(`AUTH_RATE_PER_IP_PER_MINUTE`, `CATALOG_RATE_PER_MINUTE`), because every
browser of every Playwright worker comes from `127.0.0.1`; no journey asserts
those limits, and the integration tests do. A state that only data can make,
such as one account's own storage limit (`users.storage_limit_bytes`, for
the storage-limit journey) or 5,000 cleared chain quizzes, is written with SQL
into the stack's Postgres for the journey's own account, so it needs no stack
of its own.

The journeys run side by side, four Playwright workers against one stack
(`E2E_WORKERS`): each registers its own user. The few that change what every
other journey stands on are tagged `@serial` and run after the rest, one at a
time: the admin journey (it changes the catalog, as the seeded `dev` admin),
the export journey (it stops the backend) and the update journey (it rebuilds
the frontend and restarts the stack). A journey that needs the server or the
frontend built differently is tagged `@env` plus its pass (`@ttl`, `@purge`,
`@answers`, `@budget`) and runs on a stack of its own, with the update journey (`@full`) on one
more. `make test-e2e-main` brings every one of those stacks up before any
journey starts, runs the `@env` passes side by side, then the update journey
alone (it restarts its stack), and takes the stacks down at the end: Docker
starting or stopping a stack changes the host's network interfaces, and
Chromium then drops the page loads under way in every browser on the machine
(`net::ERR_NETWORK_CHANGED`), so a stack must not start or stop beside a
running journey. The backend image of every suite stack is the release binary built on
the host and copied into a thin image (`backend-prebuilt` in
`docker/backend.Dockerfile`), not compiled again inside Docker.

What the sharing buys: a broken compose file, a missed `/health` condition, a
changed seeding step or a renamed environment variable fails `./scripts/dev.py`
and `make test-e2e` in the same way, in the same place, and is fixed once. The
failure mode it removes is the familiar one where CI has its own quietly
divergent way of starting the app.

`make test-e2e BASE_URL=https://…` skips `stack.up` and seeding and runs the
journeys against an existing instance instead, given an admin account in the
environment. That is how a deployment is smoke-tested and how the
[restore drill](#the-drill) checks a restored database.

Since the builder sets nothing, a journey that needs a cascade with settings
other than the defaults makes it through the API (`apiCascade` in
`e2e/tests/support.ts`) and changes them with `apiSettings`: a
`set_cascade_options` sent through `/api/sync` as another device would,
before the browser has seen the cascade, so it downloads with them.
`plainCascade` uses the two to make a cascade without hooks or definitions,
which is what the journeys sized in answer bytes were measured on. Both go
through the ordinary endpoints, so there is still no test-only path.

#### The journeys

- Register, confirm, log in, create an anagram cascade (with the 90%
  threshold every new cascade starts with), and see every cascade rule applied
  as expected:
  - Finish Level 1 below the threshold and go down to Level 2.
  - Clear Level 2 with misses and get a replacement at Level 2.
  - Clear it with no misses and climb back to Level 1's reshuffled quiz.
  - Finish Level 1 with no misses, see the completion screen, choose Keep
    studying and land on the reset Source quiz at Level 1.
- **The plane:**
  1. Create a cascade and wait for Available offline.
  2. Go offline (`context.setOffline(true)`) and reload the page.
  3. Still offline, close and reopen the browser context, and see the studied
     cascade rather than the login page, which is what the unscoped `signed_in`
     pointer is for (see [On the device](#on-the-device)).
  4. Study through several finishes, including a descent and a clear.
  5. Restore a quiz from the Trash.
  6. Go back online and see Synced.
  7. In a fresh browser context, log in and see identical cascade state, grades
     and question order.
- **Two devices:** finish the same level offline in two browser contexts,
  reconnect both, and see the second device's notice and matching final state.
- **Session expiry while offline:** study, expire the session, reconnect, see
  Log in to sync, log in, and see the work synced.
- **Browser restart with a live session:** study, close and reopen the browser
  context keeping its persistent cookies, and see the next sync succeed rather
  than fail CSRF.
- **Logging out.** With nothing unsent, Log out lands on the login page, and a
  reload while offline stays there rather than showing the last account's
  cascades. Logging back in finds every cascade still local, with no download.
  **Offline**, Log out still lands on the login page, and on reconnecting the
  queued `POST /api/auth/logout` goes through, after which the old session
  cookie is gone. In the same state — logged out offline with the request still
  queued — a **second account logging in before the connection returns** keeps
  its session: no logout is sent while it is signed in, its next sync succeeds
  rather than answering `401`, and the first account's flag is gone, since the
  login replaced the cookie the request was for. With unsent work, the dialog names the count and says those
  changes sync at
  the next login here, and **Remove this account's data from this device**
  deletes the per-user database after naming what that discards. A second
  account logging in on the same browser sees none of the first account's
  cascades, and the browser's `accounts` store (which the journey reads, since
  no page lists it) holds both; no logout is sent while it is signed in.
  Logging out with its **own** data removed lands on the log-in page and
  leaves the store holding the first account alone, which then logs in and
  finds its cascades. **No page lists the accounts with data on a device or
  removes another account's data** (see [On the device](#on-the-device)), so
  no journey does either; the row left for a logout still queued, and its
  going once the request is through, are covered by the unit tests of
  `lib/local/accounts.ts` alone.
- **Switching accounts in another tab:** as Alice, grade twenty cards offline
  in one tab; in a second tab, log out and log in as Bob; see the first tab show
  **signed out in another tab** at once and stop syncing. Reconnect, and see
  that no request from the first tab was applied as Bob: Alice's twenty grades
  are still in her outbox, Bob's cascades are nowhere in Alice's database, and
  logging in as Alice again pushes the twenty grades. Then, with two tabs as
  Alice, log out and back in as Alice in one of them and see the other pass
  through **signed out in another tab** and resume syncing and downloading
  without a reload.
- **Updating the app:** with a card open, deploy a second build and see the card
  undisturbed and "a new version is ready" offered; accept it and see the new
  build running after one reload. With `MIN_APP_VERSION` raised past the old
  build, see **reload to keep syncing**, press its reload while online and see it
  clear, where a plain browser reload had not; and with a second tab open on the
  old build and a card revealed in it, accept the update in the first tab and
  see only that tab reload, the second keep its revealed card, show that the app
  was updated in another tab, finish that card from the old build's cache, and
  report the update rather than block the new build's IndexedDB upgrade.
- **The account forms** (`forms.spec.ts`): registering from the log-in
  page's link, logging in before the address is confirmed, following the
  mail's confirmation link (and a second use of it), a wrong password,
  Forgot password and its mail's link with a weak password and then a strong
  one (and a second use of the link), the old password refused and the new
  one accepted, and Sign out everywhere with a wrong and the right password.
  The links come from the stack's mail outbox. The other journeys register
  and confirm through the API.
- **Changing the password** from `/account` (`accounts.spec.ts`): a wrong
  current password is said under its field and nothing is changed. The same
  spec sees a Cascades row's quiz type after its name.
- **Deleting the account** from `/account`, with a second account's data also on
  the browser, lands on the log-in page, leaves no per-user database or
  `accounts` row for the deleted account — so the browser's `accounts` store, read by the journey, holds only the second — and a reload offers the login page rather than the deleted
  account's cascades. On a second browser context still signed in as that
  account, the next sync answers `401`, it shows **Log in to sync** with its
  cascades still readable, and its Account page still offers to remove them.
- Switch to typed mode: the input sits at the bottom of the page, a found word
  shows in the answer space with no hooks or definitions, an entry that is
  not an anagram of the question (`RETAINX`) stays in the input with "not an
  anagram of the question" and never shows as the last entry, an anagram that
  is not an answer (`EINARST`) turns the input red until the next keystroke,
  shows in red as the last entry under the input until the next entry, never
  shows in the answer, and grades missed, a found word shows in green as the
  last entry and is the one green word among the found words in the answer
  space (the latest of them all once every anagram is found), finding every anagram reveals nothing until Enter on an empty input,
  which then grades correct, a repeated entry is ignored, a right click before the reveal does nothing while a
  left click only focuses the input, the next card's input has the focus with
  no click, and switching modes mid-card clears the entries. Two answers typed on one line (`RETAINS NASTIER`) stay in the input
  with "not an anagram of the question" and the card, with every anagram then found,
  still grades correct. That the typed input keeps Enter and `Shift+T` when they are bound to Toggle grade is a unit test's (`inputOwns`), not a journey's; the controls journey checks only that Ctrl+Backspace still acts as Previous from the input.
- With **alphabetical order** on, entering answers in order grades correct, and
  an out-of-order answer reveals the card at once, missed, with "Out of order".
  With the option off, the same sequence grades correct.
- On a 1000 × 500 window, the nine AEINRST anagrams with definitions are shrunk
  to fit the quiz area, which does not scroll.
- **Segments and progression:** with a cascade made with a segment of 5, finish
  the first run with misses, see the drill level, clear it down to nothing,
  come back to run 2 at the right question, see Previous refuse to go back into
  run 1, and finish the quiz. Switch the current quiz's progression to Drill
  in Settings (saved as soon as it is changed, "✓ Saved for this level", no
  Save button), finish below the threshold, and see the quiz replaced
  at the same level instead of a new level appearing; then switch the
  progression of levels made from now on to Drill (saved at once, with no
  offer to use it for all cascades, since there is no other) and see the next
  new quiz take it while a quiz in progress keeps its own. Change a quiz's
  segment size in Settings mid-attempt (saved when Enter is pressed) and see
  the next boundary move. Then set
  the size to 0 mid-attempt and see the Segment row disappear while Previous
  still refuses to go back into the finished run, with the reason shown.
  Throughout, the status bar's two rows read as [Desktop layout](#desktop-layout)
  says: the Segment row under the Level row with its own figures, a drill
  shown as the segment's second pass with the Level row still on the level
  above, and at phone width each row's name on its own line.
- **Export:** download the missed words of a level as a word list and the whole
  cascade as a CSV, offline, and check the contents; then ask for definitions
  that were never downloaded, while offline, and see the fallback notice. With
  the cascade's cards complete, the dialog shows the selection's question count
  and its entry count; with the answers evicted and the app offline, it still
  shows the question count, from the `questions` store, and drops the entry count
  rather than blocking or showing a line count it cannot know. Online, export a
  cascade with definitions the device never downloaded, so it comes from the
  server through a token, and double-click **Export**: one file arrives, the dialog stays on screen, and exactly one export request is answered `200`. (That a second use of a token is answered `204` is the [integration test](#integration-tests)'s; the button is disabled while the first press is at work, so the journey may send no second request at all. Nothing in the journey looks at the service worker, the sync leader or the account's `BroadcastChannel`, so the frame never loading the app is not asserted beyond the dialog staying up.) All of this runs with the production security
  headers and the build's own `<meta>` policy on, so a `frame-ancestors` or
  `X-Frame-Options` change that blocked the frame would fail here. The suite's
  first journey also asserts that the app **boots** under that policy, with no
  CSP violation reported in the console, so a build whose bootstrap hash is
  missing, or a header that re-added `script-src 'self'`, fails before
  anything else runs; and, since a page with **no** policy also boots cleanly,
  that the policy is **present**: the `index.html` the service worker serves
  carries the `<meta>` policy, its `script-src` holds `'self'` and a hash but
  not `'unsafe-inline'`, and an inline script the test injects into the page
  is refused with a violation. **Installing** (`shell.spec.ts`): the manifest is
  served as `application/manifest+json` with its icons; once a cascade is
  available offline the header's status says Acrodont opens with no connection
  and the browser has been asked to keep the data; a `beforeinstallprompt` the
  test dispatches becomes an Install button that calls its `prompt()` and goes;
  a tab closed with no connection and a new one opened on the cascade shows its
  first card; and as an iPhone the tip shows, and stays gone once dismissed and
  reloaded. Then stop the backend between the token request and the download,
  so the download meets the proxy's error page, and see the app stay on screen
  with no file and the dialog offering to try again. With
  the cascade's answers evicted, export its questions offline and see a
  complete file, and see the cascade export offer no alphabetical toggle.
- **Answers gone, questions kept:** with a cascade's answers evicted and the
  anagram mode set to Typed, open it offline, see the alphagram and the
  flashcard fallback rather than a typed input, grade a card Correct, and see
  the grade sync as Correct. Then, on a cascade whose first download was stopped
  part way, reach a card past the last key and see "this question needs a
  connection" with no grade saved, then reach the last card of that run and see
  Show / Next do nothing and a message naming how many questions still need a
  connection.
- **Keys before answers:** create three cascades, go offline before any download
  finishes, and see every question and its grading available while the answers
  are still arriving.
- **Trash and purge:** clear a quiz, export its missed words from the Trash
  while offline with no fetch, then restore it and find it as
  the new deepest level, playable at once because the online restore fetched
  its list and grades before it was opened, then, with `TRASH_RETENTION_DAYS=0` and a short purge
  interval, watch a cleared quiz be purged and the tombstone remove it from a
  second browser context. Trash a cascade and see Delete forever offered on the
  cascade but not on the quizzes listed under it. Offline, see each Trash
  entry's purge date.
- A cascade whose segmented attempt left 5,000 cleared chain quizzes shows in
  the Trash within the suite's budget, showing one collapsed group with its count
  and earliest purge date, and expands to a first page of 100 behind **Show
  more**.
- With the account's own storage limit (`users.storage_limit_bytes`) set to
  20,000 bytes, create cascades until the builder says the next "won't fit" and
  Create Cascade is disabled; study two passes of one, missing everything, and
  see the account go over its limit (studying is never refused), the Cascades
  page say "Over your storage by …" with New cascade disabled; move that
  cascade to the Trash and see it still over; Delete forever and see room
  again, with Create Cascade enabled in the builder.
- The Cascades page shows the account's storage (`… of 10 MB used`) and no
  cascade count, each cascade's size, the Trash's total ("The Trash holds … of
  your storage.") and what Delete forever frees ("Delete forever (…)").
- Paste a 10,001-entry word list into an In Word List row and see the live
  preview pause behind a Preview button; change the lexicon and see an In
  Lexicon row on another distribution flagged.
- Offline, restore a quiz of a cascade this device has never opened, see the
  "downloads when online" note and the ladder's "waiting for download" level,
  go online and see it download without opening the cascade, then open it and
  play.
- Over the answer limit with two automatic keeps, see the least recently opened one's answers freed while its questions still show in the player (no page lists what the device holds; the journey reads the stores). Go offline
  and see that cascade's badge read "answers need a connection" rather than a
  download bar at zero, and see it return to progress on reconnecting.
- Over `ROW_STORAGE_BUDGET`, lowered with a test constant, see the least
  recently opened unkept cascade dropped before its window expires when an
  **automatically** kept one takes the total over, and the kept one's rows held
  while its player is open; then, with a second automatic keep and nothing
  unkept left, see the oldest automatically kept cascade dropped once its player
  closes, then the next. Stay online for several sync cycles and see them stay
  dropped — the storage total steady, no download progress reappearing, and the
  Cascades page offering "open to download" — then open one and see it come back whole.
- Trash a cascade offline and see it listed in the Trash with "deleted forever 30 days
  after this syncs", not missing from the cascades list and the Trash alike.
- In the Settings of a large cascade, type a segment size for the level being
  studied that would create more than 2,000 levels and see the warning naming
  the count before the size is saved.
- Turn on a cascade's hooks and definitions in its Settings, and see them in
  anagram answers: on the English
  fixture the hooks read Zyzzyva-style in lower case, and on a Catalan cascade a
  multi-character hook reads `NY`, not `ny`, so nothing on screen looks like a
  blank standing for a tile.
- **Desktop controls:**
  - Left click shows and advances, right click toggles, and middle click goes
    back, with no context menu appearing; with the repeat guard at its default of
    off, both clicks of a double click count; and a wheel binding fires once
    per flick.
  - Clicks on the status bar do nothing to the quiz.
  - Rebind Toggle grade to the wheel and to `Shift+T` in the player's
    Settings, under Device Settings, and see both work, survive a reload, and
    **not** reach a second browser context, which keeps the defaults: controls
    are per device.
  - (Not covered by a journey: wheel-down bound to Show / Next over a definition that overflows its panel, advancing without scrolling the text after the capture box's warning, with the scrollbar, Page Down and wheel-up still scrolling.)
  - A binding can't be removed from an action that has only one, and Escape
    cancels capture instead of being bound, leaving Settings open.
  - Binding a stroke that already belongs to another action **moves** it, with
    the notice, and leaves the old action with its remaining bindings.
  - In typed mode, bound letter keys type into the input instead of acting, and
    so do Space and Backspace — the defaults for Show / Next and Previous — while
    **Ctrl+Backspace** still acts as Previous, since only unmodified editing keys
    are held back, and middle click still goes back with the input focused.
- **Touch zones** (mobile viewport emulation, portrait and landscape): each
  zone fires its action, a drag in the Show / Next zone scrolls a long answer
  without advancing, and a quick double tap advances only once.
- Set a leave value cascade's decimals to 3 in its Settings and see a leave
  answer rendered to three places.
- **A cascade's settings** (`settings.spec.ts`): with two cascades, see no
  settings in the site header, none on the Account page, and none in the
  builder, which says where they are instead. Change one cascade's threshold
  and see "✓ Saved for this cascade · Also use for: all 2 cascades", with no
  offer for new cascades; leave it untaken and see the other cascade keep 80%.
  Change it again and take the offer, and see both cascades at the new value.
  Turn off Show hooks and see the offer read "all 2 anagram cascades". Make
  the first cascade typed, then, from the second, **Copy settings** from the
  first and see "✓ Copied 2 settings from “Alpha”.", hooks off and the typed
  input; copying again says "✓ “Alpha” already has the same settings."
- **What the Settings dialog holds** (`player.spec.ts`): the player menu's
  links are Acrodont and Account (no Cascades, New cascade or Trash); the
  dialog has no index of its sections and two sections only, Cascade Settings
  and Device Settings, with the controls in Device Settings and their **Reset
  controls to defaults** button.
- **Every setting explains itself** (`misc.spec.ts`): a setting's explanation
  is hidden until its ⓘ ("About this setting") is hovered, goes when the
  mouse leaves, and stays open after a click; the examples and the section
  headings' texts are behind ⓘs too, never written out.
- **Signed in, `/` is the Cascades page** (`home.spec.ts`): New cascade and
  the Trash ("The Trash is empty.") are on it, a regular user's header has no
  Main nav, Admin appears only for admins, and an old link to `/trash`
  redirects to `/#trash`.
- As an admin, upload a distribution, lexicon and leave value set, see a
  deliberately broken file rejected with line numbers, build a Leave Value
  cascade from the new set, replace the lexicon's definitions and the set's
  values and see the cascade's answer change on the device with no reload,
  and see deletion refused while the cascade exists.
- In the builder, build the same search twice and see the second suggested a
  numbered name, a name in use refused under the field, and Duplicate's copy
  numbered.

### Scale tests

Run at the 300,000-question ceiling ([Scale assumptions](#overview)), on a
scale lexicon of about CSW24's size (300,001 words). The ten concurrent
exports run at production's `EXPORT_CONCURRENCY` of one, against the
production task's 2 GiB. The server's half (`backend/tests/scale.rs`) passes
every budget at 300,000 (measured 2026-11-11):

| Case | Measured | Budget |
|---|---|---|
| Creation | 5.4 s | 20 s |
| Download | 2.0 s | 60 s |
| Push of 300,000 grades in 600 requests | 376 s | 600 s |
| Pull | 0.9 s | 60 s |
| Finish (300,000 rows reset, a 150,000-question Level 2) | 7.1 s | 20 s |
| Ten concurrent exports | 8.7 s, 473 MiB | 120 s, 2 GiB |
| Purge of a trashed cascade with three levels | 0.7 s | 30 s |
| Capped purge runs of 60,000 chain quizzes | 0.4–2.2 s each | 10 s |
| Incremental pull beside 60,000 chain quizzes | 7–10 ms | 500 ms |

The device's suites (`*.scale.ts`) use the same 300,000 questions, except
where PQ-019 runs a case at a tenth.

- **Scale tests**:
  - Create a 300,000-question cascade, download its cards, grade every question
    (half missed) through sync, finish, and assert the timings for creation,
    download, push (300,000 grades in 600 requests back to back, under the
    per-user sync rate limit), pull and finish stay within budget, assert
    that the rebase work per acknowledged batch stays proportional to the
    batch (the drain's total IndexedDB writes within a small multiple of the
    operation count), and assert
    the IndexedDB row count of one copy plus a small overlay once the outbox
    has drained, recording the
    bytes of the rows, the question keys and the answers separately, with the
    keys near 3 MB, and assert the keys-only pass for ten such cascades takes
    30 card-page requests in all, a tenth of the 300 their answers need, and
    that the bytes it moves are within a quarter of those ten cascades'
    answers rather than a tenth, the ratio
    [Downloads](#on-the-device) states. A 300,001-question search is refused with its count. A new device
    logging into an account with ten such cascades completes its first sync in
    under 5 seconds with no question rows transferred, since none is opened
    here; after opening all ten, with each Source quiz finished once, creating
    a 150,000-question Level 2, then fully graded again on its new attempt
    without finishing, and that Level 2 half graded (375,000 graded rows
    per cascade, about 3.75 million in all, 75
    pages), the sync that follows finishes within its measured budget —
    **300 seconds for the one heavily played cascade** (PQ-019: the worst
    measured rate, 1,500 graded rows a second, for its 375,000 rows, with room
    to spare; 49–107 s were measured for 162,500 rows while the cap was
    130,000, and 164 s for 375,000 on CI at 300,000), measured with the staging
    split (rows of quizzes new to the device and grade rows for unchanged
    attempts written once). The plan first asked 120 s for all ten, about
    13,500 graded rows a second; Chromium's IndexedDB, writing a row per
    question with its indexes, manages 1,500–3,300, and only storing rows
    differently on the device could close that gap. It is a one-time cost for a
    new device opening a cascade with a long history, behind the "getting this
    level ready" screen (PQ-019); and each cascade
    materialises on open within budget. The budgets are constants in the test beside the row
    counts they measure.
  - Ten concurrent `GET /api/cascades/:id/export` streams of a 300,000-question
    anagram cascade with definitions, the `EXPORT_RATE_PER_MINUTE` default,
    complete within budget without the task exceeding its memory reservation.
  - Upload a million-row leave file within the upload timeout.
  - Purge a trashed 300,000-question cascade with three levels within budget
    while a sync for the same user proceeds, on a `quizzes` table padded with
    a million rows of other users, asserting with `EXPLAIN` that the delete
    uses `quizzes_cascade_id`.
  - Purge a user whose segmented attempt left **60,000 cleared chain quizzes**
    all past `TRASH_RETENTION_DAYS` at once: assert each run takes at most
    `PURGE_MAX_QUIZZES_PER_USER_PER_RUN` of them, oldest `cleared_at` first,
    that each transaction stays within budget, that the expected number of runs
    empties the Trash, and that a sync for that user during each run is
    answered normally rather than `503`, since the user row is held only for one
    capped transaction.
  - An incremental pull on a user whose segmented attempt left **60,000 cleared
    chain quizzes**, each with its own `quiz_attempts` row, on tables padded
    with a million rows of other users: assert with `EXPLAIN` that the attempt
    query uses `quiz_attempts_user_seq` and the cascade and quiz queries their
    own `user_seq` indexes, that a pull with nothing changed reads a number of
    rows proportional to what changed rather than to the user's quiz count, and
    that it stays within a budget beside the row counts.
  - Resync a device holding five 300,000-question cascades, one of them with
    cleared levels whose rows a Trash export fetched, and assert the full
    pull's base comparison and deletions finish within budget and keep those
    cleared rows. A sixth cascade has run a segmented attempt with a segment
    size of 5 over 20,000 questions, leaving 4,000 chain quizzes in the Trash,
    so its pull pages on quiz rows alone: assert the page count, that no page
    exceeds 50,000 rows, and that the resync stays within the same budget.
  - Open a 300,000-question cascade, over `AUTO_KEEP_OFFLINE_ROWS` and so
    **automatically** kept, and fifteen days on, still kept, run the quota
    path's drop pass over it: assert it finishes within budget, the base holds
    only its cascade, quiz and attempt rows, and the cascade is marked
    budget-dropped. Run the pass on forty such cascades all inside the window,
    every one of them automatically kept, and assert it brings the base's rows
    and keys under `ROW_STORAGE_BUDGET` within budget, oldest last-open first
    and no more than needed, the most recently opened still whole: this is the
    case the budget exists for, and it is only reachable because an automatic
    keep is the pass's second tier rather than a skip. Then run one more pull
    and assert that **nothing is refetched**: every cascade the pass dropped is
    marked budget-dropped in `meta` although all forty are inside the window,
    the download manager issues no request for any of them, the sync request's
    `question_rows_for` names exactly the cascades still holding rows, and the
    base's total stays under the budget instead of oscillating. Run the
    same case on a cascade that also holds five cleared 150,000-question
    levels inside the window, asserting the row count before the pass counts
    them and the pass removes them too. The device's suite runs the
    many-cascade case at a tenth (PQ-019): twenty 56,000-question cascades,
    every one kept automatically, against a tenth of `ROW_STORAGE_BUDGET` and
    `AUTO_KEEP_OFFLINE_ROWS`, the heavy one with five cleared 28,000-question
    levels.
  - **An account of 500 cascades** (`scale-many.scale.ts`), since nothing
    bounds how many an account holds (see [Storage limit](#storage-limit)):
    with 500 cascades on the device, the Cascades page's summaries and the
    Trash's groups are each read within 10 seconds, every summary carrying its
    cascade's `storage_bytes`.

### Zyzzyva parity

- **Zyzzyva parity** (local only, needs licensed data): a script runs a
  checked-in list of saved searches against a real CSW24 upload and compares
  the word lists with exports from Zyzzyva for the same searches. Zyzzyva has
  no OR, so the parity searches are single AND groups, and the script writes
  Acrodont's `.` wildcard as Zyzzyva's `?`. The list includes a two-tile
  `Not Includes` row and a mixed-length limit (`Length 7–8`, `Limit by
  Probability Order 1–100`), so the negation's meaning and the limit's ranking
  value are checked against Zyzzyva itself. Differences are either fixed or recorded here as intended deviations.
  The run is also the only place the figures that need real data are measured,
  and it prints them beside the comparison: each index's build time and
  resident size (see [Catalog Indexes](#derived-attributes)) and the
  wall-clock time of every search on the list (see
  [Search Engine](#search-engine)). They are recorded, not asserted, since the
  data they need cannot be committed.
  It makes one cascade per search and deletes none, so its stack sets
  `MAX_STORAGE_BYTES_PER_USER=100000000000`, far past the default
  [storage limit](#storage-limit).

### Running the tests

| Command | What it runs |
|---|---|
| `make test-quick` | `make test-unit`'s backend and frontend halves side by side. About 2 minutes |
| `make test-unit` | `cargo test --lib`, `npm run check`, Vitest. No services |
| `make test-integration` | Every integration test binary's tests in one pool (`cargo nextest run`, 16 at a time) against a throwaway Postgres it starts itself |
| `make test-e2e-core` | Every end-to-end journey on one stack, four side by side, then the `@serial` ones; not the update journey or the `@env` passes |
| `make test-e2e SPEC=<file>` | One spec file (any Playwright file filter) on the suite's stack |
| `make test-e2e-main` | The update journey and the `@env` passes, each on a stack of its own: every stack up first, the `@env` passes side by side, the update journey alone, then the stacks down |
| `make test-e2e` | `test-e2e-core`, then `test-e2e-main`: the whole end-to-end suite |
| `make test-e2e-seeding` | Seeding under a two-a-minute upload limit |
| `make test-ops-image` | The ops image builds, `backup.py` dumps a seeded stack, and `drill.py` restores the dump inside the image |
| `make test-scale` | The 300,000-question budgets |
| `make test-parity` | Zyzzyva comparison; skipped with a notice unless the licensed files are present |
| `make test` | Unit, integration and end-to-end |

`E2E_KEEP_STACK=1` keeps the end-to-end stack after a run, and the next run
reuses it, rebuilding only what changed.

**Checking a change locally:**
- run `make test-quick`, `make test-integration`, and `make test-e2e
  SPEC=<file>` for each spec the change touches (`make test-e2e-core` when it
  touches many);
- push, and let CI's tiers run the rest;
- never run `make test-scale` locally, except to investigate a scale failure.
  To check a branch at scale before it merges, run CI by hand on it
  (`workflow_dispatch`) and keep working.

CI (`.github/workflows/ci.yml`) runs three tiers, each a superset of the last:

| Tier | When | What |
|---|---|---|
| **Push** | Every push, every branch | Clippy, the unit tests (a backend and a frontend job), `make test-integration`, `make test-e2e-core`, `make infra-validate`, `make ops-check`, `make contract-check` (the generators in `contract-fixtures/tools/` still write the checked-in fixtures). About 5 minutes |
| **Main** | A push to `main`, and a manual run on any branch | The Push tier, plus `make test-e2e-main`, `make test-e2e-seeding` and `make test-ops-image` (the last also on a push that changes `scripts/` or `docker/`) |
| **Nightly** | 04:30 UTC on `main` | The Main tier, plus `make test-scale` (which a manual run on any branch runs too). A failure opens (or comments on) one issue |

The seeding check also runs on a push that changes `scripts/`. A branch can be
green and still fail on `main`; deploys come from `main`, and
`scripts/deploy.sh` reads CI's run on `main` for the commit, so the deploy gate
is the full tier.

Parity never runs in CI, because the data cannot be committed. Every layer is
runnable with one command and no arguments, for the same reason the
development stack is: a test that is hard to start is a test that stops being
run.

---

## Delivery Phases

1. **Skeleton**: Compose stack, Axum and SQLx with the full `0001_initial.sql`,
   SvelteKit shell, `/health`, Terraform baseline.
2. **Accounts**: registration, email confirmation, login and logout, password
   reset, sessions and CSRF, rate limits, account page, admin authorization.
3. **Catalog**:
   - admin uploads with full validation for letter distributions, lexicons and
     leave value sets
   - tile parsing
   - `LexiconIndex` and `LeaveSetIndex` with every derived attribute
   - probability and playability ordering
   - `LISTEN/NOTIFY` reload
   - the `/admin` pages
4. **Search engine**: all 23 filters, including both limits, AND / OR groups, validation errors,
   unit, property and parity tests, `/api/search/preview`.
5. **Cascade builder**: filter rows, applicability rules, tile palette, word list
   editor, live preview, saved searches, the default settings every new
   cascade starts with, `POST /api/cascades`, card pages.
6. **Cascade rules**:
   - the Rust and TypeScript rule modules, including progression and segments,
     the deterministic shuffle, and the shared test vectors
   - the sync endpoint, operations, conflicts, tombstones and the purge task
7. **Local-first player**:
   - IndexedDB stores, the outbox and the sync engine
   - service worker, downloads and eviction
   - the player (desktop layout and configurable controls, touch zones,
     flashcard and typed modes with alphabetical order, the run indicator, the
     ladder, finish and run banners, the Settings dialog with a cascade's
     settings, quiz options and this device's)
   - the cascades and trash pages
   - exporting word lists, on the device and from the server
   - the offline Playwright journeys and the 300,000-question scale tests
8. **Production**: SES, ACM, deploy pipeline, backups and alarms, first catalog
   upload, restore drill.
