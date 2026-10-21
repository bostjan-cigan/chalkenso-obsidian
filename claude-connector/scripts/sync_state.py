#!/usr/bin/env python3
"""Sync state of lesson notes in a vault that works with Chalkenso through the connector.

  python3 .claude/scripts/sync_state.py check <note.md>...   prints "<state>\t<path>" per note
  python3 .claude/scripts/sync_state.py touch <note.md>...   nothing to do here (see below)

The same commands and `state()` as the plugin kit's sync_state.py, so its skills and graph.py work
unchanged. States come from lessons.py: synced (as pulled) | pending (changed since the pull) |
not-synced (not pulled from Chalkenso). `touch` has nothing to move: only a lesson's body is ever
sent, so property-only edits never need hiding.
"""

import sys

import lessons


def state(path):
    found = lessons.check(path).split("\t")[0]
    return "not-synced" if found == "not-pulled" else found


def main(argv):
    if len(argv) < 3 or argv[1] not in ("check", "touch"):
        print(__doc__)
        return 2
    for note in argv[2:]:
        print(f"{state(note)}\t{note}" if argv[1] == "check" else f"nothing to move\t{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
