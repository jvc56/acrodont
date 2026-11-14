"""Study states for `./scripts/dev.py --scenario NAME` (PLAN.md § Development).

Acrodont's equivalent of birdtest's job flags: each scenario creates a state
you would otherwise click your way into. Every write goes through the real
API (POST /api/cascades, POST /api/sync, POST /api/searches), so seeding stays
a smoke test and the server's rules check every operation as they would a
device's. Quiz state the operations need (attempt, seed, question order) is
read with SQL, as the backend's integration tests do: reading, never writing.

Each scenario is idempotent: it finds its cascade by name and leaves it be.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import stack

_MASK = (1 << 64) - 1


def shuffle(idx: List[int], seed: int) -> List[int]:
    """PLAN.md § Deterministic shuffles: SplitMix64 and Fisher–Yates, as in
    contract-fixtures/tools/reference.py. The indexes in position order."""
    v = sorted(idx)
    state = seed & _MASK
    for i in range(len(v) - 1, 0, -1):
        state = (state + 0x9E3779B97F4A7C15) & _MASK
        z = state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK
        z ^= z >> 31
        j = z % (i + 1)
        v[i], v[j] = v[j], v[i]
    return v

# The scenarios run on the stack's lexicon: CSW24 from the licensed catalog
# when it is there, else the fixture catalog's EN-FIX (154 words). Each is a
# length range capped by Probability Order, so its size is the same small one
# on either: `top` questions per length at most.
def length(lo: int, hi: int) -> dict:
    return {"op": "and", "children": [{"type": "length", "negated": False, "min": lo, "max": hi}]}


def small(lo: int, hi: int, top: int) -> dict:
    """Lengths lo…hi, the `top` most probable of each."""
    return {"op": "and", "children": [
        {"type": "length", "negated": False, "min": lo, "max": hi},
        {"type": "probability_order", "negated": False, "min": 1, "max": top, "lax": False},
    ]}


@dataclass
class Scenario:
    name: str
    describe: str
    run: Callable[["Seeder"], None]


class Rejected(RuntimeError):
    pass


class Seeder:
    """One device of the dev user, writing through the API."""

    def __init__(self, http: "stack.Http", project: str, fixture_lexicon: str = "EN-FIX",
                 real_lexicon: Optional[str] = None):
        self.http = http
        self.project = project
        # The lexicon every scenario but `big` uses: the real one when there is one.
        self.lexicon = real_lexicon or fixture_lexicon
        self.real_lexicon = real_lexicon
        self.device_id = str(uuid.uuid4())
        self.cursor: Optional[int] = None
        self.seq = 1
        self.app_version = int(stack.app_build())

    # -- reading ---------------------------------------------------------------

    def sql(self, query: str) -> List[List[str]]:
        out = stack.psql(self.project, query)
        return [line.split("|") for line in out.splitlines() if line]

    def cascade_named(self, name: str) -> Optional[str]:
        rows = self.sql(f"SELECT id FROM cascades WHERE user_id = '{self.http.user_id}' "
                        f"AND name = {quote(name)} ORDER BY created_at DESC LIMIT 1")
        return rows[0][0] if rows else None

    def deepest_active(self, cascade: str) -> Optional[str]:
        rows = self.sql(f"SELECT id FROM quizzes WHERE cascade_id = '{cascade}' AND status = 'active' "
                        "ORDER BY level DESC, created_seq DESC LIMIT 1")
        return rows[0][0] if rows else None

    def quiz(self, quiz: str) -> dict:
        attempt, seed = self.sql(f"SELECT attempt, shuffle_seed FROM quizzes WHERE id = '{quiz}'")[0]
        # Positions are never stored: the attempt's order is its questions
        # shuffled with its seed, as every device and the server compute it.
        members = [int(r[0]) for r in self.sql(
            f"SELECT question_idx FROM quiz_questions WHERE quiz_id = '{quiz}' ORDER BY question_idx")]
        positions = shuffle(members, int(seed) % 2 ** 64)
        # Seeds travel as unsigned decimal text; Postgres stores them signed.
        return {"attempt": int(attempt), "seed": str(int(seed) % 2 ** 64), "positions": positions}

    # -- writing ---------------------------------------------------------------

    def op(self, op_type: str, **fields) -> dict:
        o = {"id": str(uuid.uuid4()), "device_seq": self.seq, "seen_seq": self.cursor or 0,
             "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
             "type": op_type}
        o.update(fields)
        self.seq += 1
        return o

    def sync(self, ops: List[dict]) -> None:
        """Pushes `ops` in SYNC_MAX_OPS batches and follows every pull page."""
        for i in range(0, max(len(ops), 1), 500):
            batch = ops[i:i + 500]
            body = {"device_id": self.device_id, "app_version": self.app_version, "cursor": self.cursor,
                    "question_rows_for": [], "ops": batch}
            status, b = self.http.json("POST", "/api/sync", body)
            if status != 200:
                raise RuntimeError(f"sync answered {status}: {b}")
            for op, result in zip(batch, b.get("results", [])):
                if result.get("status") == "rejected":
                    raise Rejected(f"{op['type']} rejected: {result.get('reason')}")
            while b.get("next_page_token"):
                status, b = self.http.json("POST", "/api/sync", {
                    "device_id": self.device_id, "app_version": self.app_version, "cursor": self.cursor,
                    "page_token": b["next_page_token"], "question_rows_for": []})
                if status != 200:
                    raise RuntimeError(f"sync page answered {status}: {b}")
            if not b.get("resync_required"):
                self.cursor = int(b["sync_seq"])

    def create(self, name: str, filters: dict, *, lexicon: Optional[str] = None, segment_size: int = 0,
               quiz_type: str = "anagram", answer_mode: str = "flashcard") -> str:
        existing = self.cascade_named(name)
        if existing:
            return existing
        status, b = self.http.json("POST", "/api/cascades", {
            "id": str(uuid.uuid4()), "source_quiz_id": str(uuid.uuid4()), "device_id": self.device_id,
            "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "name": name, "lexicon": lexicon or self.lexicon, "quiz_type": quiz_type, "clear_threshold": 80,
            "segment_size": segment_size, "progression": "ladder", "require_alphabetical": False, "answer_mode": answer_mode,
            "filters": filters,
        })
        if status != 201:
            raise RuntimeError(f"creating {name!r} answered {status}: {b}")
        stack.log(f"scenario: created {name!r} ({b['cascade']['question_count']} questions)")
        return b["cascade"]["id"]

    def grades(self, quiz: str, marks: str, start: int = 0) -> List[dict]:
        q = self.quiz(quiz)
        return [self.op("grade", quiz_id=quiz, attempt=q["attempt"], attempt_seed=q["seed"],
                        question_idx=q["positions"][start + i], grade="correct" if m == "C" else "missed")
                for i, m in enumerate(marks)]

    def finish(self, quiz: str) -> dict:
        q = self.quiz(quiz)
        return self.op("finish", quiz_id=quiz, attempt=q["attempt"], attempt_seed=q["seed"],
                       shuffle_seed=str(uuid.uuid4().int % 2 ** 63), new_quiz_id=str(uuid.uuid4()))

    def size(self, quiz: str) -> int:
        return len(self.quiz(quiz)["positions"])


def quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


# -- the scenarios ---------------------------------------------------------------


def studying(s: Seeder) -> None:
    name = f"Studying: {s.lexicon} 2–7"
    if s.cascade_named(name):
        return
    c = s.create(name, small(2, 7, 20))
    source = s.deepest_active(c)
    n = s.size(source)
    # Level 1 finished with every fourth word missed, then half of Level 2.
    marks = "".join("M" if i % 4 == 3 else "C" for i in range(n))
    s.sync(s.grades(source, marks) + [s.finish(source)])
    level2 = s.deepest_active(c)
    if level2 and level2 != source:
        half = s.size(level2) // 2
        s.sync(s.grades(level2, "C" * half))


def finished(s: Seeder) -> None:
    name = f"Finished: {s.lexicon} sevens"
    if s.cascade_named(name):
        return
    c = s.create(name, small(7, 7, 25))
    source = s.deepest_active(c)
    s.sync(s.grades(source, "C" * s.size(source)) + [s.finish(source)])


def segments(s: Seeder) -> None:
    name = f"Segments: {s.lexicon} 2–5 in fives"
    if s.cascade_named(name):
        return
    c = s.create(name, small(2, 5, 6), segment_size=5)
    source = s.deepest_active(c)
    q = s.quiz(source)
    # The first segment graded with a miss and finished, so a chain quiz
    # holds its missed word; the second segment started.
    ops = s.grades(source, "CCMCC")
    ops.append(s.op("finish_segment", quiz_id=source, attempt=q["attempt"], attempt_seed=q["seed"],
                    segment_end=5, shuffle_seed=str(uuid.uuid4().int % 2 ** 63), new_quiz_id=str(uuid.uuid4())))
    s.sync(ops)
    s.sync(s.grades(source, "CC", start=5))


def typed(s: Seeder) -> None:
    """Typed answers for Anagram quizzes: the cascade's own answer mode."""
    name = f"Typed: {s.lexicon} 2–4"
    if not s.cascade_named(name):
        s.create(name, small(2, 4, 10), answer_mode="typed")


def trash(s: Seeder) -> None:
    name = f"Trashed: {s.lexicon} eights"
    if s.cascade_named(name):
        return
    c = s.create(name, small(8, 8, 20))
    s.sync([s.op("trash_cascade", cascade_id=c)])


# The searches `limits` fills an account with, broadest first.
FILLER_SEARCHES = [length(2, 15), length(2, 8), length(7, 8), length(2, 6), length(6, 6), length(5, 5),
                   length(4, 4), length(3, 3), length(2, 2), small(2, 2, 3)]
# At most this many fillers a run: a 10 MB account on the 154-word fixture
# catalog would need hundreds.
MAX_FILLERS = 60


def limits(s: Seeder) -> None:
    """The storage warning: cascades until the account holds 90% (and under
    100%) of its storage limit (STORAGE_LIMIT_PLAN.md § S6).

    Each filler is the broadest search whose cascade, by the preview's
    `storage_bytes`, still fits under the limit. On CSW24 a handful fill the
    default 10 MB. The fixture catalog's cascades are a few tens of KB, so
    there run it on a stack with a lowered limit:
    `./scripts/dev.py --fixtures --env MAX_STORAGE_BYTES_PER_USER=1000000 --scenario limits`.
    """
    status, me = s.http.json("GET", "/api/auth/me")
    if status != 200:
        raise RuntimeError(f"/api/auth/me answered {status}: {me}")
    limit = int(me["max_storage_bytes"])
    target = limit * 9 // 10
    sizes = []
    for filters in FILLER_SEARCHES:
        st, preview = s.http.json("POST", "/api/search/preview",
                                  {"lexicon": s.lexicon, "quiz_type": "anagram", "filters": filters})
        if st == 200 and preview["count"] > 0 and not preview["over_cap"]:
            sizes.append((int(preview["storage_bytes"]), filters))
    sizes.sort(key=lambda x: -x[0])
    i = 1
    made = 0
    while made < MAX_FILLERS:
        status, me = s.http.json("GET", "/api/auth/me")
        used = int(me["storage_bytes"])
        if used >= target:
            stack.log(f"scenario limits: {used:,} of {limit:,} bytes used")
            return
        fitting = [(n, f) for n, f in sizes if used + n <= limit]
        if not fitting:
            break
        name = f"Filler {i}"
        i += 1
        if s.cascade_named(name):
            continue
        s.create(name, fitting[0][1])
        made += 1
    status, me = s.http.json("GET", "/api/auth/me")
    stack.log(f"scenario limits: stopped at {int(me['storage_bytes']):,} of {limit:,} bytes; for the warning, "
              "lower the limit: --env MAX_STORAGE_BYTES_PER_USER=1000000")


def big(s: Seeder) -> None:
    """One cascade near MAX_QUIZ_QUESTIONS from the licensed catalog, to feel the scale in a browser."""
    if not s.real_lexicon:
        stack.log("scenario big: needs the licensed catalog (fixtures/licensed/, or --real-catalog DIR); skipped")
        return
    name = f"Big: {s.real_lexicon} 7–9"
    if s.cascade_named(name):
        return
    status, me = s.http.json("GET", "/api/auth/me")
    cap = int(me.get("max_quiz_questions", 300000))
    for lo, hi in ((7, 9), (7, 8), (7, 7)):
        st, preview = s.http.json("POST", "/api/search/preview",
                                  {"lexicon": s.real_lexicon, "quiz_type": "anagram", "filters": length(lo, hi)})
        if st == 200 and preview["count"] <= cap:
            s.create(f"Big: {s.real_lexicon} {lo}–{hi}", length(lo, hi), lexicon=s.real_lexicon)
            return
    stack.log("scenario big: no length range fits under MAX_QUIZ_QUESTIONS; skipped")


def saved_searches(s: Seeder) -> None:
    status, existing = s.http.json("GET", "/api/searches")
    have = {x["name"] for x in existing} if status == 200 else set()
    for name, filters in (("Sevens", length(7, 7)), ("Twos and threes", length(2, 3)), ("Eights", length(8, 8))):
        if name in have:
            continue
        st, b = s.http.json("POST", "/api/searches", {"id": str(uuid.uuid4()), "name": name,
                                                       "quiz_type": "anagram", "filters": filters})
        if st not in (200, 201):
            raise RuntimeError(f"saving search {name!r} answered {st}: {b}")


SCENARIOS: Dict[str, Scenario] = {s.name: s for s in [
    Scenario("studying", "a cascade part way down its ladder: Level 1 finished with misses, Level 2 half graded", studying),
    Scenario("finished", "a cascade whose Source quiz finished with no misses (the completion screen)", finished),
    Scenario("segments", "a cascade in segments of five, the first finished with a miss, the second started", segments),
    Scenario("typed", "typed answers on (a preference, for every Anagram cascade) and a cascade to try them", typed),
    Scenario("trash", "a cascade in the Trash", trash),
    Scenario("limits", "cascades up to the storage warning (90% of MAX_STORAGE_BYTES_PER_USER; on the fixture catalog with --env MAX_STORAGE_BYTES_PER_USER=1000000)", limits),
    Scenario("big", "one cascade near MAX_QUIZ_QUESTIONS from the licensed catalog (CSW24 by default)", big),
    Scenario("saved-searches", "three saved searches in the builder's Load dialog", saved_searches),
]}


def seed(http: "stack.Http", project: str, names: List[str], real_lexicon: Optional[str] = None) -> None:
    seeder = Seeder(http, project, real_lexicon=real_lexicon)
    for name in names:
        scenario = SCENARIOS[name]
        stack.log(f"scenario {name}: {scenario.describe}")
        scenario.run(seeder)
