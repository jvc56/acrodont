#!/usr/bin/env python3
"""The backup's S3 paths against a stand-in S3 and pg_dump (make ops-check).

backup.py's bucket path, the marker a finished run writes, and what
restore.py and drill.py make of a dump without one run nowhere else before
production: `make test-ops-image` dumps to a directory. Nothing here reaches
AWS or a database.
"""

from __future__ import annotations

import argparse
import atexit
import datetime as dt
import io
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class NoSuchKey(Exception):
    pass


class ClientError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    exceptions = types.SimpleNamespace(NoSuchKey=NoSuchKey)

    def __init__(self) -> None:
        self.o: dict = {}
        self.denied: set = set()

    def upload_fileobj(self, stream, bucket, key):
        self.o[key] = stream.read()

    def put_object(self, Bucket, Key, Body):
        self.o[Key] = Body

    def get_object(self, Bucket, Key):
        if Key not in self.o:
            raise NoSuchKey(Key)
        return {"Body": io.BytesIO(self.o[Key])}

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.o[Key])}

    def copy_object(self, Bucket, Key, CopySource, **kw):
        self.o[Key] = self.o[CopySource["Key"]]

    def download_file(self, bucket, key, path):
        if key in self.denied:
            raise ClientError("403")
        if key not in self.o:
            raise ClientError("404")
        with open(path, "wb") as f:
            f.write(self.o[key])

    def get_paginator(self, _):
        o = self.o
        return types.SimpleNamespace(paginate=lambda **kw: [{"Contents": [
            {"Key": k, "Size": len(v)} for k, v in sorted(o.items()) if k.startswith(kw["Prefix"])]}])


def fail(msg: str) -> None:
    sys.exit(f"backup-check: FAILED: {msg}")


def main() -> int:
    s3 = FakeS3()
    sys.modules["boto3"] = types.SimpleNamespace(client=lambda *a, **k: s3)
    import backup
    import drill
    import restore

    tmp = Path(tempfile.mkdtemp(prefix="acrodont-backup-check-"))
    atexit.register(shutil.rmtree, tmp, True)
    fake = tmp / "pg_dump"

    def pg_dump(body: str, rc: int) -> None:
        fake.write_text("#!/bin/sh\nprintf '%s'\nexit %d\n" % (body, rc))
        fake.chmod(0o755)

    os.environ["PATH"] = f"{tmp}:{os.environ['PATH']}"
    args = argparse.Namespace(project=None, database_url="postgres://x", s3_bucket="b", s3_region="r",
                              metrics_region=None)

    # A run that succeeds, on the first of a month: the marker holds the size, monthly too.
    pg_dump("a" * 1000, 0)
    backup.to_s3(args, dt.date(2026, 11, 1))
    if s3.o.get("daily/2026-11-01.ok") != b"1000":
        fail(f"a finished run left no marker with the dump's size: {sorted(s3.o)}")
    if s3.o.get("monthly/2026-11.ok") != b"1000" or "monthly/2026-11.dump" not in s3.o:
        fail("the monthly copy lacks its dump or its marker")
    for key in ("daily/2026-11-01.dump", "monthly/2026-11.dump"):
        if restore.check_complete(s3, "b", key) != 1000:
            fail(f"{key} is not taken as complete")

    # A pg_dump that dies part-way: the truncated object is there, the marker is not.
    pg_dump("a" * 10, 1)
    try:
        backup.to_s3(args, dt.date(2026, 11, 2))
        fail("a pg_dump that exited 1 counted as a backup")
    except RuntimeError as e:
        if "exited with 1" not in str(e):
            raise
    if "daily/2026-11-02.dump" not in s3.o or "daily/2026-11-02.ok" in s3.o:
        fail("a failed run wrote a marker, or the stand-in did not leave the truncated object")
    try:
        restore.check_complete(s3, "b", "daily/2026-11-02.dump")
        fail("a dump with no marker was taken as complete")
    except restore.Incomplete:
        pass
    if drill.newest_dump(s3, "b") != "daily/2026-11-01.dump":
        fail("the drill did not pass over the unmarked dump")
    if backup.previous_size(s3, "b", "daily/2026-11-03.dump") != 1000:
        fail("the size ratio would compare with a truncated dump")
    try:
        restore.fetch("s3://b/daily/2026-11-02.dump", "r", tmp)
        fail("restore.py fetched an unmarked dump")
    except SystemExit as e:
        if "no 2026-11-02.ok" not in str(e):
            raise
    if not restore.fetch("s3://b/daily/2026-11-02.dump", "r", tmp, unmarked=True).exists():
        fail("--unmarked did not fetch the dump")

    # The schema file beside a dump: one the bucket lacks is passed over, one
    # that cannot be read fails the drill.
    if drill.fetch_schema(s3, "b", "daily/2026-11-01.dump", tmp) is None:
        fail("the schema file beside a dump was not fetched")
    del s3.o["daily/2026-11-01.schema.sql"]
    if drill.fetch_schema(s3, "b", "daily/2026-11-01.dump", tmp) is not None:
        fail("a schema file the bucket lacks was reported as fetched")
    s3.denied.add("daily/2026-11-01.schema.sql")
    try:
        drill.fetch_schema(s3, "b", "daily/2026-11-01.dump", tmp)
        fail("a schema file that could not be read was passed over: the table check would be skipped in silence")
    except ClientError:
        pass

    # A failed rerun over a day that had succeeded: the marker names another size.
    try:
        backup.to_s3(args, dt.date(2026, 11, 1))
        fail("a pg_dump that exited 1 counted as a backup")
    except RuntimeError:
        pass
    try:
        restore.check_complete(s3, "b", "daily/2026-11-01.dump")
        fail("a dump a failed rerun overwrote was taken as complete")
    except restore.Incomplete:
        pass
    try:
        drill.newest_dump(s3, "b")
        fail("the drill took a dump with nothing complete in the bucket")
    except drill.DrillFailed:
        pass

    print("ok: backup.py's marker; restore.py and drill.py refuse a dump without it or of another size; "
          "the drill's schema file")
    return 0


if __name__ == "__main__":
    sys.exit(main())
