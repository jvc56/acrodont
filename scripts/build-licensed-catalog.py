#!/usr/bin/env python3
"""Build a licensed catalog folder that ./scripts/dev.py loads by default.

The upload format wants one lexicon file of word⇥playability⇥definition
(PLAN.md § File formats). Word lists usually come as separate files: words
with definitions, and playability values. This joins them, and writes the
folder dev.py and make test-parity read (default fixtures/licensed/, which is
gitignored, since the files are licensed):

    english.csv          the letter distribution (default: the fixture's)
    CSW24.tsv            word⇥playability⇥definition
    CSW24_leaves.csv     leave,value (copied, if given)
    manifest.json        what dev.py uploads, in order

    python3 scripts/build-licensed-catalog.py --name CSW24 \\
        --definitions ~/Dropbox/WordGameMisc/csw24.tsv \\
        --playability ~/Dropbox/WordGameMisc/CSW19-Playability.txt \\
        --leaves ~/Dropbox/WordGameMisc/CSW24.csv

--definitions is WORD⇥definition, one word per line: it is the word list.
--playability lines are WORD and a number, in either order, separated by
whitespace; words it does not list get 0, so they sort as the least playable.
Run it again with another --name to add a second lexicon to the folder.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Dict

ROOT = Path(__file__).resolve().parent.parent
NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")


def read_playability(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = line.split()
        if not fields:
            continue
        if len(fields) != 2:
            sys.exit(f"{path} line {n}: expected a word and a number, got {line!r}")
        a, b = fields
        if NUMBER.match(b):
            values[a.upper()] = b
        elif NUMBER.match(a):
            values[b.upper()] = a
        else:
            sys.exit(f"{path} line {n}: no number in {line!r}")
    return values


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True, help="the lexicon's name, e.g. CSW24")
    p.add_argument("--definitions", required=True, type=Path, help="WORD⇥definition per line")
    p.add_argument("--playability", type=Path, help="WORD and a number per line (default: every word 0)")
    p.add_argument("--leaves", type=Path, help="a leave,value file to copy alongside")
    p.add_argument("--distribution", type=Path, default=ROOT / "fixtures" / "catalog" / "english.csv",
                   help="the letter distribution file (default: the fixture english.csv)")
    p.add_argument("--distribution-name", default="english")
    p.add_argument("--out", type=Path, default=ROOT / "fixtures" / "licensed")
    args = p.parse_args()

    play = read_playability(args.playability.expanduser()) if args.playability else {}
    args.out.mkdir(parents=True, exist_ok=True)
    lexicon = args.out / f"{args.name}.tsv"
    words = missing = 0
    seen = set()
    with lexicon.open("w", encoding="utf-8", newline="\n") as out:
        for n, line in enumerate(args.definitions.expanduser().read_text(encoding="utf-8-sig").splitlines(), 1):
            if not line.strip():
                continue
            word, _, definition = line.partition("\t")
            word = word.strip().upper()
            definition = " ".join(definition.replace("\t", " ").split())[:10_000]
            if not definition:
                sys.exit(f"{args.definitions} line {n}: {word} has no definition (every word needs one)")
            if word in seen:
                sys.exit(f"{args.definitions} line {n}: {word} is listed twice")
            seen.add(word)
            if word not in play:
                missing += 1
            out.write(f"{word}\t{play.get(word, '0')}\t{definition}\n")
            words += 1

    dist = args.out / f"{args.distribution_name}.csv"
    if args.distribution.resolve() != dist.resolve():
        shutil.copyfile(args.distribution.expanduser(), dist)
    leaves = None
    if args.leaves:
        leaves = args.out / f"{args.name}_leaves.csv"
        shutil.copyfile(args.leaves.expanduser(), leaves)

    # The manifest keeps other lexicons already in the folder.
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    manifest = [e for e in manifest if e["name"] not in (args.name, args.distribution_name)]
    manifest.append({"kind": "distribution", "name": args.distribution_name, "file": dist.name})
    manifest.append({"kind": "lexicon", "name": args.name, "file": lexicon.name, "parent": args.distribution_name})
    if leaves:
        manifest.append({"kind": "leaves", "name": args.name, "file": leaves.name})
    order = {"distribution": 0, "lexicon": 1, "leaves": 2}
    manifest.sort(key=lambda e: order[e["kind"]])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"{lexicon}: {words} words, {missing} without a playability value (0)")
    if leaves:
        print(f"{leaves}: copied")
    print(f"{manifest_path}: {', '.join(e['kind'] + ' ' + e['name'] for e in manifest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
