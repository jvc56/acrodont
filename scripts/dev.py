#!/usr/bin/env python3
"""./scripts/dev.py: a complete Wordfall on http://localhost:5173 in one command.

With no arguments it builds and starts the stack, seeds the fixture catalog
and a confirmed admin `dev`, opens the browser already signed in, and streams
a filtered backend log (errors, sync rejections, and a ready-to-click link for
every mail) until Ctrl-C, which stops the stack (its data is kept).

    ./scripts/dev.py --scenario studying --scenario trash   # seed study states
    ./scripts/dev.py --real-catalog --stats                 # licensed files, index sizes
    ./scripts/dev.py --two-devices                          # watch sync between two profiles
    ./scripts/dev.py --fresh                                # as a new deployment starts

A thin command line over scripts/stack.py (PLAN.md § Development), which the
end-to-end and scale tests use too, so the development environment cannot
drift from what the tests exercise. Safe to run again at any time.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenarios  # noqa: E402
import stack  # noqa: E402

ROOT = stack.ROOT
DEV_DIR = ROOT / ".dev"


def log(message: str) -> None:
    print(f"[dev] {message}", flush=True)


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"[dev] {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def _pair(value: str, sep: str, flag: str):
    if sep not in value:
        raise argparse.ArgumentTypeError(f"{flag} expects the form A{sep}B, got {value!r}")
    return value.split(sep, 1)


def load_env_file() -> None:
    """The repository's `.env`, as docker compose reads it: a WORDFALL_PORT or
    BIND_HOST set there applies to this script too. The environment wins."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)


# --- before anything starts -----------------------------------------------------


def compose_project_running(project: str, service: str) -> bool:
    out = subprocess.run(["docker", "compose", "-p", project, "ps", "-q", "--status", "running", service],
                         cwd=ROOT, capture_output=True, text=True)
    return bool(out.stdout.strip())


def port_in_use(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def check_catalog_files(catalog: "stack.Catalog") -> None:
    """Each licensed file exists and has the right number of fields on its
    first lines, so a two-column lexicon fails here, named, not as an upload
    error minutes later."""
    for item in catalog.items:
        if not item.path.is_file():
            fail(f"{item.kind} {item.name}: no file at {item.path}")
        if item.kind not in ("lexicon", "leaves"):
            continue
        sep, want = ("\t", 3) if item.kind == "lexicon" else (",", 2)
        with item.path.open(encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f, 1):
                if n > 5:
                    break
                fields = line.rstrip("\n").split(sep)
                if len(fields) != want:
                    shape = "word⇥playability⇥definition" if item.kind == "lexicon" else "leave,value"
                    fail(f"{item.path} line {n} has {len(fields)} fields; a {item.kind} file has {want} "
                         f"({shape}, PLAN.md § File formats)")


def preflight(args) -> None:
    """What has to be true before the stack is touched, each failure named."""
    if shutil.which("docker") is None:
        fail("docker is not installed or not on PATH")
    v = subprocess.run(["docker", "compose", "version", "--short"], capture_output=True, text=True)
    if v.returncode != 0:
        fail("`docker compose` (v2) is not available")
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        fail("the Docker daemon is not reachable (is it running, and may this user use it?)")
    if args.down or args.snapshot:
        return
    if port_in_use(args.port) and not compose_project_running(args.project, "frontend"):
        fail(f"port {args.port} is already in use by something else; pass --port N, "
             "or set WORDFALL_PORT in .env")
    if args.hot_reload and port_in_use(5174) and not compose_project_running(args.project, "vite"):
        fail("port 5174 (--hot-reload) is already in use; set WORDFALL_VITE_PORT in .env")


class ProjectLock:
    """Held for the whole run: a second dev.py on the same project would reset
    or stop the stack under the first. The lock goes with the process."""

    def __init__(self, project: str):
        DEV_DIR.mkdir(exist_ok=True)
        self.handle = (DEV_DIR / f"{project}.lock").open("a+")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.handle.seek(0)
            holder = self.handle.read().strip() or "unknown"
            fail(f"another dev.py (pid {holder}) is running project {project}; stop it first, "
                 "or give this one --project NAME --port N")
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(f"{os.getpid()}\n")
        self.handle.flush()


def explain(err: "stack.StackFailed", args) -> None:
    if err.reason == "schema_changed":
        log("the backend refused the database: it was made by an older edit of a migration SQLx "
            "has already applied (PLAN.md § Schema). Run again with --reset (the database's data "
            "goes; --snapshot NAME first keeps a copy).")
    elif err.reason == "compose":
        log(f"docker compose could not start the stack: its error is above. A host port in use? "
            f"--port moves the site (now {args.port}); BIND_HOST and WORDFALL_VITE_PORT live in .env.")
    else:
        log(f"the stack did not become healthy: {err}")
        if err.logs.strip():
            log("the backend's last lines:")
            print(err.logs.rstrip(), flush=True)


# --- the catalog ----------------------------------------------------------------


def real_catalog(directory: Path) -> "stack.Catalog":
    """Licensed files listed in DIR/manifest.json, in the fixture manifest's
    form: [{"kind": "distribution"|"lexicon"|"leaves", "name", "file", "parent"}].
    The files and the manifest stay outside the repository."""
    manifest = directory / "manifest.json"
    if not manifest.is_file():
        fail(f"--real-catalog: no manifest.json in {directory}. It lists the files, as "
             "fixtures/catalog/manifest.json does, with paths relative to that directory.")
    items = []
    for entry in json.loads(manifest.read_text()):
        items.append(stack.CatalogItem(kind=entry["kind"], name=entry["name"],
                                       path=(directory / entry["file"]).expanduser(),
                                       parent=entry.get("parent")))
    return stack.Catalog(items)


def build_catalog(args) -> "stack.Catalog":
    catalog = stack.Catalog() if (args.no_fixtures or args.fresh) else stack.fixture_catalog()
    if args.real_catalog:
        catalog.items += real_catalog(Path(args.real_catalog).expanduser()).items
    for d in args.distribution:
        name, path = _pair(d, "=", "--distribution")
        catalog.items.append(stack.CatalogItem("distribution", name, Path(path).expanduser()))
    for lx in args.lexicon:
        head, path = _pair(lx, "=", "--lexicon")
        name, dist = _pair(head, ":", "--lexicon")
        catalog.items.append(stack.CatalogItem("lexicon", name, Path(path).expanduser(), dist))
    for lv in args.leaves:
        name, path = _pair(lv, "=", "--leaves")
        catalog.items.append(stack.CatalogItem("leaves", name, Path(path).expanduser()))
    # Distributions first, then lexicons, then leave sets.
    order = {"distribution": 0, "lexicon": 1, "leaves": 2}
    catalog.items.sort(key=lambda i: order[i.kind])
    return catalog


def first_real_lexicon(catalog: "stack.Catalog") -> Optional[str]:
    fixtures = {i.name for i in stack.fixture_catalog().items}
    for item in catalog.items:
        if item.kind == "lexicon" and item.name not in fixtures:
            return item.name
    return None


def print_stats(args, http: "stack.Http") -> None:
    """Index sizes and the backend's memory: what infra/variables.tf's
    task_memory is sized from (BIRDTEST_LESSONS_PLAN.md COST-1)."""
    status, catalog = http.json("GET", "/api/admin/catalog")
    if status == 200:
        total = 0
        for section in ("lexicons", "leave_sets"):
            for item in catalog.get(section, []):
                size = item.get("approx_bytes") or item.get("index_bytes") or 0
                total += size
                built = item.get("build_ms")
                name = item.get("name") or item.get("lexicon")
                log(f"stats: {section[:-1]} {name}: {size / 2**20:.1f} MiB"
                    + (f", built in {built} ms" if built is not None else ""))
        log(f"stats: catalog indexes in all: {total / 2**20:.1f} MiB")
    cid = subprocess.run(["docker", "compose", "-p", args.project, "ps", "-q", "backend"],
                         cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if cid:
        mem = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", cid],
                             capture_output=True, text=True).stdout.strip()
        log(f"stats: backend container memory: {mem}")
    for line in stack.backend_logs(args.project, 2000).splitlines():
        if "catalog loaded; ready" in line and "load_ms" in line:
            log(f"stats: {line.split('|', 1)[-1].strip()}")


# --- snapshots (DEV-2) ----------------------------------------------------------


SNAPSHOTS = DEV_DIR / "snapshots"


def snapshot(args) -> None:
    """The stack's database into .dev/snapshots/NAME, written to NAME.partial
    and renamed into place, so a failed run never leaves a snapshot that looks
    complete. An existing NAME is refused."""
    if not compose_project_running(args.project, "postgres"):
        fail(f"project {args.project} is not running; start it first")
    target = SNAPSHOTS / args.snapshot
    if target.exists():
        fail(f"{target} exists; choose another name, or delete it")
    partial = SNAPSHOTS / f"{args.snapshot}.partial"
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "backup.py"), "--project", args.project,
                        "--out", str(partial)])
    if r.returncode != 0:
        shutil.rmtree(partial, ignore_errors=True)
        fail("the snapshot failed; nothing was kept")
    partial.rename(target)
    log(f"snapshot {args.snapshot}: {target}")


def find_dump(spec: str) -> "tuple[Path, bool]":
    """(dump, is_a_dev_snapshot) for a snapshot name or a dump file's path."""
    snap = SNAPSHOTS / spec
    if snap.is_dir():
        dumps = sorted(snap.glob("*.dump"))
        if not dumps:
            fail(f"snapshot {spec} holds no .dump file")
        return dumps[-1], True
    path = Path(spec).expanduser()
    if not path.is_file():
        fail(f"--restore: no snapshot named {spec} in {SNAPSHOTS}, and no file at {path}")
    return path.resolve(), str(path.resolve()).startswith(str(SNAPSHOTS.resolve()))


def restore_into_stack(args) -> None:
    """Restores into a new database, scrubs a dump that is not a local
    snapshot, bumps the sync sequences, then swaps it in with both renames in
    one transaction while the backend is stopped: a restore in place emptied
    birdtest's database when it failed part-way, and two separate renames lost
    it. A production dump is always scrubbed (scripts/scrub.sql)."""
    dump, own = find_dump(args.restore)
    scrub = not own
    stamp = time.strftime("%Y%m%d%H%M%S")
    staging, old = f"wordfall_restore_{stamp}", f"wordfall_old_{stamp}"

    def psql(db: str, *extra: str, stdin=None, sql: Optional[str] = None):
        cmd = ["docker", "compose", "-p", args.project, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
               "-q", "-U", "wordfall", "-d", db, *extra]
        if sql is not None:
            cmd += ["-c", sql]
        return subprocess.run(cmd, cwd=ROOT, stdin=stdin, check=True)

    log(f"restoring {dump} into {staging}" + (" (scrubbed: not a local snapshot)" if scrub else ""))
    psql("postgres", sql=f"CREATE DATABASE {staging}")
    try:
        with dump.open("rb") as f:
            subprocess.run(["docker", "compose", "-p", args.project, "exec", "-T", "postgres", "pg_restore", "-U",
                            "wordfall", "-d", staging, "--no-owner", "--no-privileges", "--exit-on-error"],
                           cwd=ROOT, stdin=f, check=True)
        if scrub:
            with (ROOT / "scripts" / "scrub.sql").open("rb") as f:
                psql(staging, "-v", "dev_copy=1", stdin=f)
        sys.path.insert(0, str(ROOT / "scripts"))
        import restore as restore_py
        psql(staging, sql=restore_py.BUMP_SQL)
    except subprocess.CalledProcessError:
        psql("postgres", sql=f"DROP DATABASE IF EXISTS {staging}")
        fail("the restore failed; the stack's database is untouched")
    subprocess.run(["docker", "compose", "-p", args.project, "stop", "backend"], cwd=ROOT, check=True)
    psql("postgres", sql=(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'wordfall' AND pid <> pg_backend_pid();"))
    psql("postgres", "-1", sql=f"ALTER DATABASE wordfall RENAME TO {old}; ALTER DATABASE {staging} RENAME TO wordfall;")
    psql("postgres", sql=f"DROP DATABASE {old}")
    subprocess.run(["docker", "compose", "-p", args.project, "start", "backend"], cwd=ROOT, check=True)
    log("restored. Clear this site's data in the browser (DevTools → Application → Storage → Clear "
        "site data): devices resync after the sequence bump, but old profiles hold other accounts.")
    if scrub:
        log(f"every account's password is now {stack.User().password}; addresses are user-<id>@wordfall.invalid")


# --- the browser ----------------------------------------------------------------


def chromium() -> Optional[str]:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        path = shutil.which(name)
        if path:
            return path
    cache = Path.home() / ".cache" / "ms-playwright"
    found = sorted(cache.glob("chromium-*/chrome-linux*/chrome"))
    return str(found[-1]) if found else None


def open_two_devices(args, url: str) -> None:
    """Two isolated Chromium profiles, each its own device with its own
    IndexedDB, signed in as the same account: the quickest way to watch sync."""
    browser = chromium()
    if not browser:
        log("--two-devices: no Chrome or Chromium found (nor Playwright's); opening one browser instead")
        webbrowser.open(url)
        return
    for n in (1, 2):
        profile = DEV_DIR / "profiles" / args.project / f"device-{n}"
        profile.mkdir(parents=True, exist_ok=True)
        subprocess.Popen([browser, f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                          "--new-window", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    log(f"two devices: Chromium profiles in {DEV_DIR / 'profiles' / args.project}")


def first_admin_steps(base: str, project: str) -> str:
    return f"""
============================================================================
A fresh Wordfall has no accounts and no catalog. To make yourself its first admin:

 1. Register at {base}/register (any username; the address can be made up).
 2. Confirm it: the link is printed below as [mail] when it is sent.
 3. In a NEW terminal, in {ROOT}:

      docker compose -p {project} exec postgres psql -U wordfall -d wordfall -c "UPDATE users SET is_admin = true WHERE username = 'YOUR_NAME'"

    It prints UPDATE 1. Reload: an Admin link appears; upload the catalog there.

 On the live site step 1 is the same, the mail really arrives, and step 3 is
   scripts/confirm-user.sh --admin YOUR_NAME   (docs/runbook.md, One-time setup)
============================================================================"""


# --- the foreground log ----------------------------------------------------------


def describe_line(line: str, public_url: str) -> Optional[str]:
    """One backend log line, if it is worth showing: errors and warnings, sync
    rejections, and mail as a link to click."""
    _, _, payload = line.partition("|")
    payload = payload.strip()
    if not payload.startswith("{"):
        return None
    try:
        entry = json.loads(payload)
    except ValueError:
        return None
    fields = entry.get("fields", {})
    message = fields.get("message", "")
    level = entry.get("level", "")
    if message == "mail":
        to = fields.get("mail_to", "?")
        if fields.get("confirmation_code"):
            return f"[mail] confirm {to}: {public_url}/confirm-email?code={fields['confirmation_code']}"
        if fields.get("reset_token"):
            return f"[mail] reset {to}: {public_url}/reset-password/confirm?token={fields['reset_token']}"
        return f"[mail] to {to}: {fields.get('subject', '')}"
    if message == "sync operation rejected":
        return f"[sync] rejected {fields.get('op_type')}: {fields.get('reason')}"
    if level in ("ERROR", "WARN"):
        extra = {k: v for k, v in fields.items() if k != "message"}
        return f"[{level.lower()}] {message} {json.dumps(extra) if extra else ''}".rstrip()
    if message == "catalog loaded; ready":
        return f"[ready] catalog loaded in {fields.get('load_ms', '?')} ms"
    return None


def supervise(args, public_url: str) -> None:
    proc = subprocess.Popen(["docker", "compose", "-p", args.project, "logs", "-f", "--no-color", "--since", "1s",
                             "backend"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                            start_new_session=True)
    stopping = {"now": False}

    def stop(_signum, _frame):
        stopping["now"] = True
        proc.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            shown = describe_line(line, public_url)
            if shown:
                print(shown, flush=True)
        proc.wait()
        if not stopping["now"]:
            log("the backend's log ended (did the backend stop?)")
    finally:
        if args.keep_up:
            log(f"the stack is still up ({public_url}); ./scripts/dev.py --down stops it")
        else:
            log("stopping the stack (its data is kept; --keep-up leaves it running)")
            stack.down(args.project)


# --- the run --------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    run = p.add_argument_group("running")
    run.add_argument("--keep-up", action="store_true", help="leave the stack running on Ctrl-C")
    run.add_argument("--detach", action="store_true",
                     help="start, seed, open the browser and exit, leaving the stack running")
    run.add_argument("--no-build", action="store_true", help="start without rebuilding the images")
    run.add_argument("--hot-reload", action="store_true",
                     help="also run the Vite dev server on :5174 (no service worker there)")
    run.add_argument("--project", default=stack.DEFAULT_PROJECT, help="an isolated second stack's name")
    run.add_argument("--port", type=int, default=int(os.environ.get("WORDFALL_PORT", stack.DEFAULT_PORT)))
    run.add_argument("--env", action="append", default=[], metavar="KEY=VALUE",
                     help="override any configuration variable (PLAN.md § Configuration); repeatable")
    run.add_argument("--down", action="store_true", help="stop the stack")
    run.add_argument("--volumes", action="store_true", help="with --down, discard its data")
    run.add_argument("--quiet", action="store_true")

    data = p.add_argument_group("data")
    data.add_argument("--reset", action="store_true",
                      help="drop the database volume and the built frontend, then start clean")
    data.add_argument("--fresh", action="store_true",
                      help="a new deployment: --reset, then no user and no catalog; prints the first-admin steps")
    data.add_argument("--real-catalog", nargs="?", const=os.environ.get("WORDFALL_CATALOG_DIR", ""), default=None,
                      metavar="DIR", help="also upload the licensed files DIR/manifest.json lists "
                                          "(default DIR: $WORDFALL_CATALOG_DIR)")
    data.add_argument("--distribution", action="append", default=[], metavar="NAME=FILE",
                      help="upload a letter distribution file as well")
    data.add_argument("--lexicon", action="append", default=[], metavar="NAME:DIST=FILE",
                      help="upload a lexicon file as well")
    data.add_argument("--leaves", action="append", default=[], metavar="LEXICON=FILE",
                      help="upload a leave values file as well")
    data.add_argument("--no-fixtures", action="store_true", help="seed only what the flags above name")
    data.add_argument("--scenario", action="append", default=[], choices=sorted(scenarios.SCENARIOS),
                      help="seed a study state through the real API; repeatable: " + "; ".join(
                          f"{s.name}: {s.describe}" for s in scenarios.SCENARIOS.values()))
    data.add_argument("--users", type=int, default=0, metavar="N",
                      help="N more confirmed users (dev2, dev3, …), same password")
    data.add_argument("--stats", action="store_true",
                      help="print each catalog index's size and the backend's memory")
    data.add_argument("--snapshot", metavar="NAME", help="save the running stack's database to .dev/snapshots/NAME")
    data.add_argument("--restore", metavar="NAME|DUMP",
                      help="restore a snapshot, or a production dump (always scrubbed), then carry on")

    browser = p.add_argument_group("browser")
    browser.add_argument("--login-as", metavar="USER", help="open the site signed in as USER (default: dev)")
    browser.add_argument("--no-login", action="store_true", help="open the site signed out")
    browser.add_argument("--two-devices", action="store_true",
                         help="open two isolated Chromium profiles signed in as the same user")
    browser.add_argument("--no-browser", action="store_true")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    load_env_file()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.real_catalog == "":
        parser.error("--real-catalog needs a directory, or WORDFALL_CATALOG_DIR set")
    if args.fresh and (args.scenario or args.users or args.login_as or args.real_catalog):
        parser.error("--fresh seeds nothing: no --scenario, --users, --login-as or --real-catalog")
    if args.fresh:
        args.reset = args.no_login = True

    preflight(args)
    if args.down:
        stack.down(args.project, volumes=args.volumes)
        return 0
    lock = ProjectLock(args.project)  # noqa: F841 -- held until exit
    if args.snapshot:
        snapshot(args)
        return 0

    catalog = build_catalog(args)
    check_catalog_files(catalog)
    env = dict(_pair(e, "=", "--env") for e in args.env)

    if args.reset:
        stack.down(args.project, volumes=True)
        subprocess.run(["docker", "image", "rm", "-f", f"{args.project}-frontend"], check=False, capture_output=True)
        shutil.rmtree(DEV_DIR / "profiles" / args.project, ignore_errors=True)
        log("reset: clear this site's data in your own browser too (DevTools → Application → Storage → "
            "Clear site data): its sync cursors no longer match anything on the server.")

    profiles = ["hot-reload"] if args.hot_reload else []
    try:
        base_url = stack.up(args.project, args.port, env, build=not args.no_build, profiles=profiles)
    except stack.StackFailed as e:
        explain(e, args)
        return 1

    user = stack.User()
    http = None
    if args.restore:
        restore_into_stack(args)
        stack.wait_healthy(args.project, base_url)
    elif not args.fresh:
        http = stack.seed(base_url, catalog, user, project=args.project)
        for n in range(2, 2 + args.users):
            stack.ensure_user(base_url, stack.User(username=f"dev{n}", email=f"dev{n}@wordfall.local"), args.project)
            log(f"user dev{n} ready")
        if args.scenario:
            scenarios.seed(http, args.project, args.scenario, first_real_lexicon(catalog))
        if args.stats:
            print_stats(args, http)

    who = args.login_as or user.username
    url = base_url if args.no_login else (
        f"{base_url}/dev-login?username={urllib.parse.quote(who)}&next=/cascades")
    if not args.no_browser:
        if args.two_devices:
            open_two_devices(args, url)
        else:
            webbrowser.open(url)
    if not args.quiet:
        log(f"Wordfall is up at {base_url}")
        if not args.fresh:
            log(f"accounts: {user.username} (admin)"
                + "".join(f", dev{n}" for n in range(2, 2 + args.users))
                + f"; password {user.password}")
            if not args.no_login:
                log(f"signed in as {who}: {url}")
        if args.hot_reload:
            log("hot reload at http://localhost:5174 (no service worker there)")
        if args.fresh:
            print(first_admin_steps(base_url, args.project), flush=True)
    if args.detach:
        return 0
    log("streaming the backend's errors, sync rejections and mail; Ctrl-C stops"
        + ("" if args.keep_up else " the stack"))
    supervise(args, base_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
