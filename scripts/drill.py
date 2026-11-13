#!/usr/bin/env python3
"""The monthly restore drill (PLAN.md § Backups → The drill; BIRDTEST_LESSONS_PLAN.md BAK-1).

Runs as the scheduled `acrodont-drill` task on the ops image. It restores the
newest nightly dump into a Postgres it starts inside its own task, never on the
production instance (birdtest's drill once filled production's storage and
pushed its autoscaling up for good), then checks what a restore must deliver:

  1. the dump (the newest whose run finished: it has its .ok marker and the
     size the marker names) restores with pg_restore --exit-on-error;
  2. the schema is complete: every table the schema-only dump names exists,
     and _sqlx_migrations holds at least one applied migration;
  3. the data is there: users exist, and every cascade's questions are present;
  4. restore.py's sequence bump runs, and leaves every user's sync_floor_seq
     equal to sync_seq and above 2^32, which is what forces devices to resync.

It reports Acrodont/Backups DrillSucceeded and DrillSeconds, and exits
non-zero on any failure, which the acrodont-drill-failed rule mails. The part a
machine cannot do (a second browser profile resyncing after the bump) stays in
the quarterly manual drill in docs/runbook.md.

Locally, against any dump file and a throwaway Postgres in this process:
    python3 scripts/drill.py --dump backups/acrodont-2026-11-08.dump
(needs initdb, pg_ctl and pg_restore 16 on PATH, and must not run as root
unless the postgres user exists.)
"""

from __future__ import annotations

import argparse
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import restore  # noqa: E402  (BUMP_SQL, BUMP: the same step a real restore runs)

PORT = 55433


class DrillFailed(Exception):
    pass


def newest_dump(s3, bucket: str) -> str:
    """The newest daily dump a successful run finished (restore.check_complete):
    a failed run's truncated object under a later day's key is passed over."""
    keys: List[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="daily/"):
        keys += [o["Key"] for o in page.get("Contents", []) if o["Key"].endswith(".dump")]
    if not keys:
        raise DrillFailed(f"no daily dump in s3://{bucket}/daily/")
    for key in sorted(keys, reverse=True):
        try:
            restore.check_complete(s3, bucket, key)
            return key
        except restore.Incomplete as e:
            print(f"drill: passing over a dump: {e}")
    raise DrillFailed(f"none of the {len(keys)} dumps in s3://{bucket}/daily/ is complete")


def as_postgres(cmd: List[str]) -> List[str]:
    """Postgres refuses to run as root; the ops image runs as root."""
    if os.geteuid() != 0:
        return cmd
    return ["runuser", "-u", "postgres", "--", *cmd]


def run(cmd: List[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, text=True, **kw)


def psql(sql: str) -> str:
    out = run(as_postgres(["psql", "-h", "127.0.0.1", "-p", str(PORT), "-d", "acrodont", "-v",
                           "ON_ERROR_STOP=1", "-At", "-c", sql]), stdout=subprocess.PIPE)
    return out.stdout.strip()


def start_postgres(work: Path) -> Path:
    data = work / "pgdata"
    if os.geteuid() == 0:
        uid = pwd.getpwnam("postgres")
        os.chown(work, uid.pw_uid, uid.pw_gid)
    run(as_postgres(["initdb", "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8"]),
        stdout=subprocess.DEVNULL)
    run(as_postgres(["pg_ctl", "-D", str(data), "-w", "-l", str(work / "postgres.log"),
                     "-o", f"-p {PORT} -c listen_addresses=127.0.0.1 -k {work}", "start"]),
        stdout=subprocess.DEVNULL)
    os.environ["PGUSER"] = "postgres"
    run(as_postgres(["createdb", "-h", "127.0.0.1", "-p", str(PORT), "acrodont"]))
    return data


def stop_postgres(data: Path) -> None:
    subprocess.run(as_postgres(["pg_ctl", "-D", str(data), "-m", "fast", "stop"]),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check(dump: Path, schema: Optional[Path]) -> List[str]:
    """The restored database's checks; returns what it found, raises on failure."""
    found = []
    tables = set(psql("SELECT tablename FROM pg_tables WHERE schemaname = 'public'").split())
    if schema is not None:
        wanted = set(re.findall(r"^CREATE TABLE public\.(\w+) ", schema.read_text(), re.M))
        missing = wanted - tables
        if missing:
            raise DrillFailed(f"tables missing after the restore: {sorted(missing)}")
        found.append(f"{len(wanted)} tables, as the schema-only dump names")
    for t in ("users", "cascades", "quiz_cards", "_sqlx_migrations"):
        if t not in tables:
            raise DrillFailed(f"table {t} missing after the restore")
    migrations = int(psql("SELECT count(*) FROM _sqlx_migrations WHERE success"))
    if migrations < 1:
        raise DrillFailed("no applied migration recorded")
    users = int(psql("SELECT count(*) FROM users"))
    cascades = int(psql("SELECT count(*) FROM cascades"))
    empty = int(psql("SELECT count(*) FROM cascades c WHERE c.question_keys = '' OR NOT EXISTS "
                     "(SELECT 1 FROM quizzes z JOIN quiz_cards k ON k.quiz_id = z.id WHERE z.cascade_id = c.id)"))
    if empty:
        raise DrillFailed(f"{empty} cascades have no questions after the restore")
    found.append(f"{migrations} migrations, {users} users, {cascades} cascades")
    psql(restore.BUMP_SQL)
    wrong = int(psql(f"SELECT count(*) FROM users WHERE sync_floor_seq <> sync_seq OR sync_seq < {restore.BUMP}"))
    if wrong:
        raise DrillFailed(f"the sequence bump left {wrong} users without the resync floor")
    found.append("the sequence bump forces every device to resync")
    return found


def report(region: Optional[str], ok: bool, seconds: float) -> None:
    if not region:
        return
    import boto3

    boto3.client("cloudwatch", region_name=region).put_metric_data(
        Namespace="Acrodont/Backups",
        MetricData=[
            {"MetricName": "DrillSucceeded", "Value": 1 if ok else 0, "Unit": "Count"},
            {"MetricName": "DrillSeconds", "Value": seconds, "Unit": "Seconds"},
        ],
    )


def main(argv: Optional[List[str]] = None) -> int:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--s3-bucket", help="the backups bucket (the newest daily dump is used)")
    p.add_argument("--s3-region")
    p.add_argument("--metrics-region", help="report Acrodont/Backups drill metrics here")
    p.add_argument("--dump", help="a local dump file instead of the bucket's newest")
    args = p.parse_args(argv)
    if not args.dump and not args.s3_bucket:
        p.error("--s3-bucket or --dump is required")

    started = time.monotonic()
    work = Path(tempfile.mkdtemp(prefix="acrodont-drill-"))
    data: Optional[Path] = None
    ok = False
    try:
        schema: Optional[Path] = None
        if args.dump:
            # Copied into the work directory, which the postgres user owns:
            # the original may be read-only or unreadable to it.
            given = Path(args.dump)
            dump = work / given.name
            shutil.copyfile(given, dump)
            sibling = given.with_name(given.name.replace(".dump", ".schema.sql"))
            schema = sibling if sibling.exists() else None
        else:
            import boto3

            s3 = boto3.client("s3", region_name=args.s3_region)
            key = newest_dump(s3, args.s3_bucket)
            dump = work / Path(key).name
            s3.download_file(args.s3_bucket, key, str(dump))
            schema = work / Path(key.replace(".dump", ".schema.sql")).name
            try:
                s3.download_file(args.s3_bucket, key.replace(".dump", ".schema.sql"), str(schema))
            except Exception:  # an older dump without its schema file: check the rest
                schema = None
            print(f"drill: s3://{args.s3_bucket}/{key} ({dump.stat().st_size} bytes)")
        if os.geteuid() == 0:
            shutil.chown(str(dump), "postgres")
        data = start_postgres(work)
        run(as_postgres(["pg_restore", "-h", "127.0.0.1", "-p", str(PORT), "-d", "acrodont",
                         "--no-owner", "--no-privileges", "--exit-on-error", str(dump)]))
        for line in check(dump, schema):
            print(f"drill: {line}")
        ok = True
    except Exception as e:  # any failure is a failed drill, reported and mailed
        print(f"drill FAILED: {type(e).__name__}: {e}", file=sys.stderr)
    finally:
        if data is not None:
            stop_postgres(data)
        shutil.rmtree(work, ignore_errors=True)
        seconds = time.monotonic() - started
        report(args.metrics_region, ok, seconds)
        print(f"drill: {'passed' if ok else 'failed'} in {seconds:.0f} s")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
