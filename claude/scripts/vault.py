#!/usr/bin/env python3
"""Reading the curriculum vault: lesson and concept notes, courses, feedback notes, group copies.

Shared by `build_canvases.py`, `graph.py` and `graph_colors.py`. Reads only.

Course folders are where the Chalkenso plugin keeps them: `<root>/<Organisation>/Curriculums/<Course> –
<Version>` and `<root>/<Organisation>/Groups/<Course> – <Group>`. The plugin's settings
(`.obsidian/plugins/chalkenso/data.json`) say where each organisation's folders are and which
folders are mapped, so renamed or moved folders are found too. Only folder paths are read from it,
never its tokens.

Lessons link concepts two ways: `introduces` (taught in this lesson) and `uses` (relied on, taught
elsewhere). A lesson that still has the older `concepts` list is read as: the first lesson in its
course to list a concept introduces it, later ones use it.
"""

import difflib
import functools
import json
import os
import re
from collections import defaultdict
from urllib.parse import unquote

VAULT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PLUGIN_DATA = os.path.join(VAULT, ".obsidian", "plugins", "chalkenso", "data.json")
DEFAULT_ROOT = "Chalkenso"
KNOWLEDGE = "Curriculum Knowledge"
CONCEPTS = f"{KNOWLEDGE}/Concepts"
THROUGH_LINES = f"{KNOWLEDGE}/Through-lines"


def parse_scalar(value):
    value = value.strip()
    if value.startswith('"') and value.endswith('"') and len(value) > 1:
        try:
            return json.loads(value)
        except ValueError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'") and len(value) > 1:
        return value[1:-1].replace("''", "'")
    return value


def parse_inline_list(value):
    try:
        items = json.loads(value)
        if isinstance(items, list):
            return [str(i) for i in items]
    except ValueError:
        pass
    inner = value.strip()[1:-1]
    return [parse_scalar(p) for p in re.findall(r'"(?:[^"\\]|\\.)*"|[^,]+', inner) if p.strip()]


def read_note(path):
    """Frontmatter (flat keys, scalars and lists) and body of a note."""
    with open(os.path.join(VAULT, path), encoding="utf-8") as handle:
        text = handle.read()
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not match:
        return {}, text
    fm, key = {}, None
    for line in match.group(1).splitlines():
        item = re.match(r"^\s+-\s*(.*)$", line)
        if item and key:
            if not isinstance(fm.get(key), list):
                fm[key] = []
            fm[key].append(parse_scalar(item.group(1)))
            continue
        kv = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        if value.startswith("["):
            fm[key] = parse_inline_list(value)
        elif value:
            fm[key] = parse_scalar(value)
        else:
            fm[key] = None
    return fm, text[match.end():]


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def link_target(value):
    """`[[Target#heading|alias]]` -> `Target` (the note name, no folders)."""
    match = re.search(r"\[\[([^\]|#]+)", str(value))
    target = match.group(1) if match else str(value)
    return target.strip().split("/")[-1]


def _subfolders(parent):
    """Course folders directly in `parent`, without the plugin's own (`_detached`) or hidden ones."""
    full = os.path.join(VAULT, parent)
    if not os.path.isdir(full):
        return []
    return [f"{parent}/{d}" for d in sorted(os.listdir(full))
            if os.path.isdir(os.path.join(full, d)) and not d.startswith(("_", "."))]


@functools.lru_cache(maxsize=None)
def layout():
    """Where the plugin keeps courses: root folder, organisations' Curriculums and Groups folders,
    and the mapped folders (path -> is a group). Without plugin settings, `<root>/*/Curriculums` and
    `<root>/*/Groups` with the default root."""
    try:
        with open(PLUGIN_DATA, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    general = data.get("general") or {}
    root = (general.get("rootFolder") or DEFAULT_ROOT).strip("/")
    connections = general.get("connections") or []
    curriculums = [c["curriculumsFolder"] for c in connections if c.get("curriculumsFolder")]
    groups = [c["groupsFolder"] for c in connections if c.get("groupsFolder")]
    if not connections:
        for org in _subfolders(root):
            curriculums.append(f"{org}/Curriculums")
            groups.append(f"{org}/Groups")
    mapped = {f["path"]: bool(f.get("groupId")) for f in (data.get("curriculum") or {}).get("folders") or []
              if f.get("path")}
    return {"root": root, "curriculums": sorted(set(curriculums)), "groups": sorted(set(groups)),
            "mapped": mapped}


def is_group(folder):
    """Whether a course folder is a group's copy (`…/Groups/<Course> – <Group>`)."""
    places = layout()
    if folder in places["mapped"]:
        return places["mapped"][folder]
    parent = os.path.dirname(folder)
    return parent in places["groups"] or os.path.basename(parent) == "Groups"


def course_name(folder):
    base = os.path.basename(folder)
    course, _, version = base.partition(" – ")
    if is_group(folder):
        return base
    if not version:
        return course
    return version if len(version.split()) > 1 else f"{course} {version}"


def short_title(stem):
    return re.sub(r"^Lesson \d+\s*-\s*", "", stem)


def plural(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def hours(minutes):
    return f"{minutes / 60:g} h"


class Lesson:
    def __init__(self, path):
        self.path = path
        self.stem = os.path.splitext(os.path.basename(path))[0]
        fm, body = read_note(path)
        self.fm, self.body = fm, body
        number = re.search(r"Lesson (\d+)", self.stem) or re.search(r"Lesson (\d+)", path)
        self.number = int(number.group(1)) if number else None
        self.id = fm.get("lessonId") or fm.get("devLessonId") or path
        self.arc = fm.get("arc") or None
        self.objectives = as_list(fm.get("objectives"))
        # `introduces` / `uses`; a lesson with only the older `concepts` is resolved by its Course
        self.legacy = "introduces" not in fm and "uses" not in fm and "concepts" in fm
        self.untagged = "introduces" not in fm and "uses" not in fm and "concepts" not in fm
        self.listed = [link_target(c) for c in as_list(fm.get("concepts"))]
        self.introduces = [link_target(c) for c in as_list(fm.get("introduces"))]
        self.uses = [link_target(c) for c in as_list(fm.get("uses"))]
        self.concepts = self.introduces + self.uses
        self.requires = [link_target(r) for r in as_list(fm.get("requires"))]
        self.builds = link_target(fm["builds"]) if fm.get("builds") else None
        try:
            self.duration = int(fm.get("duration") or 0)
        except ValueError:
            self.duration = 0
        status = str(fm.get("status") or fm.get("lessonStatus") or fm.get("devLessonStatus") or "")
        self.status = status.lower()
        self.has_objectives = bool(re.search(r"^## Learning objectives\s*$", body, re.M))
        goal = re.search(r"^\*\*Goal:\*\*\s*(.+?)(?:\n\s*\n|\Z)", body, re.M | re.S)
        self.goal = " ".join(goal.group(1).split()) if goal else fm.get("shortDescription")
        self.image = self.find_image()

    def label(self):
        return f"L{self.number}" if self.number is not None else self.stem

    def find_image(self):
        """The first image the body embeds, found by file name next to the lesson."""
        for match in re.finditer(r"!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]", self.body):
            ref = unquote(match.group(1) or match.group(2)).split("|")[0].split("#")[0].strip()
            name = os.path.basename(ref)
            if not re.search(r"\.(svg|png|jpe?g|gif|webp)$", name, re.I):
                continue
            here = os.path.join(VAULT, os.path.dirname(self.path))
            for folder, _, files in os.walk(here):
                if name in files:
                    return os.path.relpath(os.path.join(folder, name), VAULT)
        return None


def load_course(folder):
    lessons = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(VAULT, folder)):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("_") and not d.startswith("."))
        for name in filenames:
            if name.endswith(".md") and not (name == "README.md" and dirpath.endswith(folder)):
                lessons.append(Lesson(os.path.relpath(os.path.join(dirpath, name), VAULT)))
    lessons.sort(key=lambda l: (l.number is None, l.number or 0, l.stem))
    return lessons


def load_notes(folder):
    """name -> (path, frontmatter, body) for every note in a knowledge folder, aliases included."""
    notes = {}
    full = os.path.join(VAULT, folder)
    if not os.path.isdir(full):
        return notes
    for name in sorted(os.listdir(full)):
        if name.endswith(".md"):
            path = f"{folder}/{name}"
            fm, body = read_note(path)
            entry = (path, fm, body)
            notes[name[:-3]] = entry
            for alias in as_list(fm.get("aliases")):
                notes.setdefault(str(alias), entry)
    return notes


def canonical(name, concepts):
    """A concept's note name, also when linked by one of its aliases."""
    entry = concepts.get(name)
    return os.path.basename(entry[0])[:-3] if entry else name


def concept_requires(name, concepts):
    """The concepts a concept note lists under `requires`."""
    entry = concepts.get(name)
    if not entry:
        return []
    return [canonical(link_target(c), concepts) for c in as_list(entry[1].get("requires"))]


def course_folders(args):
    """The folders named in `args`, or every core and group folder in the vault (cores first)."""
    if args:
        return [os.path.relpath(a, VAULT) if os.path.isabs(a) else a.rstrip("/") for a in args]
    places = layout()
    found = set(p for p in places["mapped"] if os.path.isdir(os.path.join(VAULT, p)))
    for parent in places["curriculums"] + places["groups"]:
        found.update(_subfolders(parent))
    return sorted(found, key=lambda f: (is_group(f), f))


class Course:
    def __init__(self, folder, lessons, concepts, through_lines):
        self.folder, self.lessons = folder, lessons
        self.name = course_name(folder)
        self.concepts, self.through_lines = concepts, through_lines
        self.by_stem = {l.stem: l for l in lessons}
        self.warnings = []
        self.arcs = []
        for lesson in lessons:
            if lesson.arc not in self.arcs:
                self.arcs.append(lesson.arc)
        # concept names as their notes spell them (links may use an alias)
        seen = set()
        for lesson in lessons:
            if lesson.legacy:
                listed = [canonical(c, concepts) for c in lesson.listed]
                lesson.introduces = [c for c in listed if c not in seen]
                lesson.uses = [c for c in listed if c in seen]
                seen.update(listed)
            else:
                lesson.introduces = [canonical(c, concepts) for c in lesson.introduces]
                lesson.uses = [canonical(c, concepts) for c in lesson.uses]
            lesson.concepts = list(dict.fromkeys(lesson.introduces + lesson.uses))
        # the lesson that introduces each concept first, every lesson introducing it, and every
        # lesson that introduces or uses it, in lesson order
        self.first, self.introducers, self.users = {}, defaultdict(list), defaultdict(list)
        for lesson in lessons:
            for concept in lesson.introduces:
                self.first.setdefault(concept, lesson)
                self.introducers[concept].append(lesson)
            for concept in lesson.concepts:
                self.users[concept].append(lesson)
        for lesson in lessons:
            for target in lesson.requires:
                if target not in self.by_stem:
                    self.warnings.append(f"{lesson.stem}: requires [[{target}]], not a lesson here")
            if lesson.arc is None and len(self.arcs) > 1:
                self.warnings.append(f"{lesson.stem}: no arc")
        self.missing_concepts = sorted(c for c in self.users if c not in concepts)

    def arc_label(self, arc):
        return arc or ("Lessons" if len(self.arcs) == 1 else "No arc")

    def arc_lessons(self, arc):
        return [l for l in self.lessons if l.arc == arc]

    def through_line(self):
        names = [l.builds for l in self.lessons if l.builds]
        return max(set(names), key=names.count) if names else None

    def status_counts(self):
        counts = defaultdict(int)
        for lesson in self.lessons:
            counts[lesson.status or "no status"] += 1
        return " · ".join(f"{n} {s}" for s, n in sorted(counts.items()))


ITEM_LINE = re.compile(r"^\s*[-*]\s+\[(.)\]\s+(.*?)%%task:([A-Za-z0-9_-]+)%%")
PLAN_LINE = re.compile(r"^#{1,6}\s+Plan\b.*%%plan:([A-Za-z0-9_-]+)(?::[0-9a-f]*)?%%\s*$")


def load_feedback(folder):
    """Every item in a folder's feedback notes, read the way the plugin writes them."""
    items = []
    for sub in ("_feedback", "_feedback-dev"):
        full = os.path.join(VAULT, folder, sub)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if not name.endswith(".md"):
                continue
            path = f"{folder}/{sub}/{name}"
            fm, body = read_note(path)
            lesson = link_target(fm["lesson"]) if fm.get("lesson") else re.sub(r"^Feedback - ", "", name[:-3])
            note_items, plans, plan_id = [], defaultdict(list), None
            for line in body.splitlines():
                item = ITEM_LINE.match(line)
                if item:
                    title = re.search(r"\*\*(.+?)\*\*", item.group(2))
                    note_items.append({
                        "task": item.group(3), "state": item.group(1),
                        "title": title.group(1) if title else item.group(2).strip(),
                        "ai": "#ai/ready" in line, "note": path, "lesson": lesson,
                        "folder": folder, "dev": sub.endswith("-dev")})
                    plan_id = None
                    continue
                plan = PLAN_LINE.match(line)
                if plan:
                    plan_id = plan.group(1)
                elif re.match(r"^#{1,2}\s", line):
                    plan_id = None
                elif plan_id:
                    plans[plan_id].append(line)
            for item in note_items:
                item["plan"] = "\n".join(plans.get(item["task"], [])).strip()
                scope = re.search(r"Scope:\s*(group and core|group only)", item["plan"], re.I)
                item["scope"] = scope.group(1).lower() if scope else None
            items += note_items
    return items


def similarity(a, b):
    return difflib.SequenceMatcher(None, a.splitlines(), b.splitlines(), autojunk=False).ratio()


def line_changes(a, b):
    added = removed = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a.splitlines(), b.splitlines(),
                                                      autojunk=False).get_opcodes():
        if op in ("replace", "delete"):
            removed += i2 - i1
        if op in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def sections(body):
    """`## heading` -> text; the part before the first heading is "(start)"."""
    parts, name = {"(start)": []}, "(start)"
    for line in body.splitlines():
        heading = re.match(r"^##\s+(.+?)\s*$", line)
        if heading:
            name = re.sub(r"\s*\(.*?\)\s*$", "", heading.group(1))  # "Part 2 — X (15 min)" -> "Part 2 — X"
            parts.setdefault(name, [])
        else:
            parts[name].append(line)
    return {k: "\n".join(v).strip() for k, v in parts.items()}


def match_core(group, cores):
    """The core course a group copies, and group lesson -> core lesson."""
    def candidates(lesson, course):
        link = lesson.fm.get("coreLesson") or lesson.fm.get("devCoreLesson")
        if link:
            hit = course.by_stem.get(link_target(link))
            if hit:
                return hit
        slug_ = lesson.fm.get("slug") or lesson.fm.get("devSlug")
        for core in course.lessons:
            if slug_ and slug_ in (core.fm.get("slug"), core.fm.get("devSlug")):
                return core
        return course.by_stem.get(lesson.stem)

    best, best_pairs = None, {}
    for course in cores:
        pairs = {l.stem: c for l in group.lessons if (c := candidates(l, course))}
        if len(pairs) > len(best_pairs):
            best, best_pairs = course, pairs
    return best, best_pairs
