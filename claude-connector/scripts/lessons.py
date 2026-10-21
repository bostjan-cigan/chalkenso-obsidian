#!/usr/bin/env python3
"""Lessons pulled from Chalkenso through the connector: what was pulled, what changed since, what was sent.

  python3 .claude/scripts/lessons.py record <note.md> <lessonId> <revision>   after writing a pulled lesson
  python3 .claude/scripts/lessons.py changed                                  lessons to send, one JSON per line
  python3 .claude/scripts/lessons.py sent <lessonId>                          after propose_lesson_revision took it
  python3 .claude/scripts/lessons.py check <note.md>...                       "<state>\t<path>" per note
  python3 .claude/scripts/lessons.py stop                                     the Stop hook (reads its JSON on stdin)

States: synced (the body is as pulled) | pending (changed since the pull) | not-pulled (not from Chalkenso).

What it keeps is in `.chalkenso/` at the vault root: `base/<lessonId>.md` is the lesson's text as pulled
(what the review in Chalkenso starts from), `state.json` the note, the revision and what was last sent.
Only the body counts: properties (frontmatter) stay in the vault and are never sent. Reads lessons,
never writes them.
"""

import hashlib
import json
import os
import re
import sys

VAULT = os.environ.get("CHALKENSO_VAULT") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STATE_DIR = os.path.join(VAULT, ".chalkenso")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
BASE_DIR = os.path.join(STATE_DIR, "base")
FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)


def body_of(text):
    """A note's body without its frontmatter, as it would be sent (outer blank lines dropped)."""
    match = FRONTMATTER.match(text)
    return (text[match.end():] if match else text).strip("\n").rstrip() + "\n"


def lesson_id_of(text):
    match = FRONTMATTER.match(text)
    if not match:
        return None
    found = re.search(r"^lessonId:\s*[\"']?([^\"'\s]+)", match.group(1), re.M)
    return found.group(1) if found else None


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def relative(path):
    full = path if os.path.isabs(path) else os.path.join(VAULT, path)
    return os.path.relpath(os.path.abspath(full), VAULT).replace(os.sep, "/")


def read(path):
    with open(os.path.join(VAULT, path), encoding="utf-8") as handle:
        return handle.read()


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"lessons": {}}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def find_note(lesson_id, remembered):
    """The lesson's note: where it was pulled to, or, after a move or rename, by its lessonId."""
    if remembered and os.path.isfile(os.path.join(VAULT, remembered)) and lesson_id_of(read(remembered)) == lesson_id:
        return remembered
    for folder, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.endswith(".md"):
                path = relative(os.path.join(folder, name))
                if lesson_id_of(read(path)) == lesson_id:
                    return path
    return None


def record(note, lesson_id, revision):
    path = relative(note)
    body = body_of(read(path))
    os.makedirs(BASE_DIR, exist_ok=True)
    with open(os.path.join(BASE_DIR, f"{lesson_id}.md"), "w", encoding="utf-8") as handle:
        handle.write(body)
    state = load_state()
    state["lessons"][lesson_id] = {"note": path, "revision": int(revision), "base": digest(body), "sent": None}
    save_state(state)
    return f"recorded\t{path}\trevision {revision}"


def changed():
    """Lessons whose body differs from the pull and that weren't sent like this already."""
    out = []
    state = load_state()
    for lesson_id, entry in sorted(state["lessons"].items()):
        note = find_note(lesson_id, entry.get("note"))
        if not note:
            continue
        current = digest(body_of(read(note)))
        if current != entry.get("base") and current != entry.get("sent"):
            out.append({
                "lesson_id": lesson_id,
                "note": note,
                "based_on_revision": entry.get("revision"),
                "base": relative(os.path.join(BASE_DIR, f"{lesson_id}.md")),
            })
    return out


def sent(lesson_id):
    state = load_state()
    entry = state["lessons"].get(lesson_id)
    if not entry:
        return f"not pulled\t{lesson_id}"
    note = find_note(lesson_id, entry.get("note"))
    if not note:
        return f"no note\t{lesson_id}"
    entry["note"], entry["sent"] = note, digest(body_of(read(note)))
    save_state(state)
    return f"sent\t{note}"


def check(note):
    path = relative(note)
    lesson_id = lesson_id_of(read(path))
    entry = load_state()["lessons"].get(lesson_id) if lesson_id else None
    if not entry:
        return f"not-pulled\t{path}"
    return f"{'synced' if digest(body_of(read(path))) == entry.get('base') else 'pending'}\t{path}"


def stop(stdin):
    """Claude is about to stop: when finished lessons wait to be sent, ask it to send them first (once)."""
    try:
        event = json.loads(stdin or "{}")
    except ValueError:
        event = {}
    if event.get("stop_hook_active"):
        return None
    waiting = changed()
    if not waiting:
        return None
    notes = ", ".join(entry["note"] for entry in waiting)
    return {
        "decision": "block",
        "reason": (
            f"These lessons changed since they were pulled and aren't in Chalkenso yet: {notes}. "
            "If the work on them is done, send them with the send-revisions skill and give the person the review links. "
            "If the person is still working on them, say they're waiting to be sent and stop."
        ),
    }


def main(argv):
    if len(argv) < 2 or argv[1] not in ("record", "changed", "sent", "check", "stop"):
        print(__doc__)
        return 2
    command, args = argv[1], argv[2:]
    if command == "record" and len(args) == 3:
        print(record(*args))
    elif command == "changed":
        for entry in changed():
            print(json.dumps(entry, ensure_ascii=False))
    elif command == "sent" and len(args) == 1:
        print(sent(args[0]))
    elif command == "check" and args:
        for note in args:
            print(check(note))
    elif command == "stop":
        decision = stop(sys.stdin.read())
        if decision:
            print(json.dumps(decision, ensure_ascii=False))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
