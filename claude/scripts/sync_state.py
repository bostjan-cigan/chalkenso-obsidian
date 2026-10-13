#!/usr/bin/env python3
"""Sync state of lesson notes, computed the way the Chalkenso plugin does (computeNoteStatus in main.js).

  python3 .claude/scripts/sync_state.py check <note.md>...   prints "<state>\t<path>" per note
  python3 .claude/scripts/sync_state.py touch <note.md>...   moves lastSynced to now (see below)

States: synced | pending (edited after the last sync) | not-synced (no lesson id) | disabled (sync: false).
Production keys (lessonId, lastSynced) and developer-mode keys (devLessonId, devLastSynced) are both
checked; a note is pending when either environment is.

`touch` is for property-only edits (objectives, concepts, requires, ...): frontmatter is never
uploaded, so the plugin itself moves `lastSynced` along when it changes properties. Run `check`
BEFORE editing and `touch` only for notes that were `synced` then, and only if the body is unchanged.
Otherwise you would hide a real edit from the plugin.
"""

import os
import re
import sys
from datetime import datetime, timezone

TOLERANCE_S = 2.0  # SYNC_MTIME_TOLERANCE_MS in the plugin
ENVS = (("lessonId", "lastSynced"), ("devLessonId", "devLastSynced"))


def read_frontmatter(text):
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not match:
        return None, {}
    values = {}
    for line in match.group(1).splitlines():
        kv = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
        if kv:
            values[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    return match, values


def parse_iso(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def state(path):
    with open(path, encoding="utf-8") as handle:
        _, fm = read_frontmatter(handle.read())
    if fm.get("sync", "").lower() in ("false", "no", "off", "0"):
        return "disabled"
    envs = [(i, s) for i, s in ENVS if fm.get(i)]
    if not envs:
        return "not-synced"
    mtime = os.stat(path).st_mtime
    for _, synced_key in envs:
        synced_at = parse_iso(fm.get(synced_key, ""))
        if synced_at is not None and mtime - synced_at > TOLERANCE_S:
            return "pending"
    return "synced"


def touch(path):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    match, fm = read_frontmatter(text)
    if not match:
        return "no frontmatter"
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    block = match.group(0)
    changed = block
    for id_key, synced_key in ENVS:
        if fm.get(id_key) and fm.get(synced_key):
            changed = re.sub(
                rf"^{synced_key}:.*$", f"{synced_key}: {now}", changed, count=1, flags=re.M
            )
    if changed == block:
        return "nothing to move"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(changed + text[len(block):])
    return "moved to " + now


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("check", "touch"):
        print(__doc__)
        sys.exit(2)
    command, paths = sys.argv[1], sys.argv[2:]
    for path in paths:
        result = state(path) if command == "check" else touch(path)
        print(f"{result}\t{path}")


if __name__ == "__main__":
    main()
