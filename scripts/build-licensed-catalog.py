#!/usr/bin/env python3
"""Download CSW24 and build the licensed catalog folder ./scripts/dev.py loads.

Everything comes from two public repositories, at pinned commits, so every
machine builds the same catalog:

    CrowdsourcedDefs  editions/2/CSW24.zip   the Zyzzyva database: every word,
                                             its definition and its playability
    MAGPIE-DATA       data/lexica/CSW24.klv2 the leave values

and the letter distribution is fixtures/magpie-data/english.csv (MAGPIE-DATA's,
already in the repository). It writes, in the upload formats of PLAN.md
§ File formats, to fixtures/licensed/ (gitignored: CSW24 is licensed):

    english.csv          the letter distribution
    CSW24.tsv            word⇥playability⇥definition
    CSW24_leaves.csv     leave,value
    manifest.json        what dev.py uploads, in order (written last)

    python3 scripts/build-licensed-catalog.py

dev.py runs it on its own when the folder is missing. Run it again to rebuild;
to move to newer data, change the pinned commits below.
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sqlite3
import struct
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import List, Tuple

ROOT = Path(__file__).resolve().parent.parent
NAME = "CSW24"
DISTRIBUTION = "english"
CROWDSOURCED_DEFS = (
    "https://raw.githubusercontent.com/jvc56/CrowdsourcedDefs/"
    "e3fdc6ad4ff0770daf5267c01138ec738208e9d6/editions/2/CSW24.zip"
)
MAGPIE_DATA = (
    "https://raw.githubusercontent.com/jvc56/MAGPIE-DATA/"
    "dca53a155e47fa62ffc3c4b5da63f60bb7caf707/data/lexica/CSW24.klv2"
)
DISTRIBUTION_FILE = ROOT / "fixtures" / "magpie-data" / f"{DISTRIBUTION}.csv"


def download(url: str) -> bytes:
    print(f"downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def plain(x: float) -> str:
    """A decimal with no exponent, as the upload requires."""
    s = repr(float(x))
    if "e" in s or "E" in s:
        s = f"{x:.20f}".rstrip("0").rstrip(".")
    return s[:-2] if s.endswith(".0") else s


def read_words(zipped: bytes) -> List[Tuple[str, float, str]]:
    """(word, playability, definition) from the Zyzzyva database in the zip."""
    with zipfile.ZipFile(io.BytesIO(zipped)) as z, tempfile.TemporaryDirectory() as tmp:
        names = [n for n in z.namelist() if n.endswith(".db")]
        if len(names) != 1:
            sys.exit(f"CSW24.zip: expected one .db file, found {names}")
        db = Path(tmp) / "words.db"
        db.write_bytes(z.read(names[0]))
        con = sqlite3.connect(str(db))
        try:
            rows = con.execute("SELECT word, playability, definition FROM words ORDER BY word").fetchall()
        finally:
            con.close()
    words = []
    for word, playability, definition in rows:
        definition = " ".join((definition or "").replace("\t", " ").split())[:10_000]
        if not definition:
            sys.exit(f"CSW24.db: {word} has no definition (every word needs one)")
        words.append((word.upper(), playability or 0.0, definition))
    return words


def read_klv2(data: bytes) -> List[Tuple[str, float]]:
    """(leave, value) from a MAGPIE .klv2: a word graph of the leaves, then one
    little-endian float per leave, in the graph's word order."""
    n = struct.unpack_from("<I", data, 0)[0]
    nodes = struct.unpack_from(f"<{n}I", data, 4)
    at = 4 + 4 * n
    count = struct.unpack_from("<I", data, at)[0]
    values = struct.unpack_from(f"<{count}f", data, at + 4)
    if at + 4 + 4 * count != len(data):
        sys.exit("CSW24.klv2: unexpected length")
    leaves: List[str] = []

    # Each node: tile in the top 8 bits, accepts at bit 23, last sibling at
    # bit 22, first child's index in the low 22 (0: none). Tile 0 is the
    # blank. Depth first, siblings in order, is the values' order.
    def walk(p: int, prefix: str) -> None:
        while p:
            x = nodes[p]
            tile = x >> 24
            if tile > 26:
                sys.exit(f"CSW24.klv2: tile {tile} is not in the English distribution")
            leave = prefix + ("?" if tile == 0 else chr(64 + tile))
            if x & 0x800000:
                leaves.append(leave)
            walk(x & 0x3FFFFF, leave)
            p = 0 if x & 0x400000 else p + 1

    walk(nodes[0] & 0x3FFFFF, "")
    if len(leaves) != count:
        sys.exit(f"CSW24.klv2: {len(leaves)} leaves in the graph, {count} values")
    return list(zip(leaves, values))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=ROOT / "fixtures" / "licensed")
    args = p.parse_args()

    words = read_words(download(CROWDSOURCED_DEFS))
    leaves = read_klv2(download(MAGPIE_DATA))

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    # A build that stops part way leaves no manifest, so dev.py does not use it.
    manifest_path.unlink(missing_ok=True)

    lexicon = args.out / f"{NAME}.tsv"
    with lexicon.open("w", encoding="utf-8", newline="\n") as out:
        for word, playability, definition in words:
            out.write(f"{word}\t{plain(playability)}\t{definition}\n")
    leave_file = args.out / f"{NAME}_leaves.csv"
    with leave_file.open("w", encoding="utf-8", newline="\n") as out:
        for leave, value in leaves:
            v = f"{value:.3f}"
            out.write(f"{leave},{'0.000' if v == '-0.000' else v}\n")
    dist = args.out / f"{DISTRIBUTION}.csv"
    shutil.copyfile(DISTRIBUTION_FILE, dist)

    manifest = [
        {"kind": "distribution", "name": DISTRIBUTION, "file": dist.name},
        {"kind": "lexicon", "name": NAME, "file": lexicon.name, "parent": DISTRIBUTION},
        {"kind": "leaves", "name": NAME, "file": leave_file.name},
    ]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"{lexicon}: {len(words)} words")
    print(f"{leave_file}: {len(leaves)} leaves")
    print(f"{manifest_path}: {', '.join(e['kind'] + ' ' + e['name'] for e in manifest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
