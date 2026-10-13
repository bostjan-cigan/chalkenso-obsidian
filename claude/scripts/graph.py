#!/usr/bin/env python3
"""Ask the curriculum's knowledge graph a question. Reads frontmatter and links; prints short text.

  python3 .claude/scripts/graph.py lesson "<lesson>"     one lesson: its place, prerequisites, concepts
  python3 .claude/scripts/graph.py concept "<concept>"   one concept: prerequisites, where taught and used
  python3 .claude/scripts/graph.py course "<course>"     every lesson in one line, then the course's flags
  python3 .claude/scripts/graph.py impact "<lesson>"     what a change to this lesson can reach
  python3 .claude/scripts/graph.py pending               lessons with edits not uploaded yet, conflicts

A lesson is found by file name (or part of it); "L3" works together with a course: `L3 web dev`.
A course is found by part of its folder name. A concept by its note name or an alias.

"mentioned in" lists the lesson sections (## headings) that name the concept or one of its aliases:
read those, not the whole lesson. Lines starting with "!" are problems the graph can see.
"""

import os
import re
import statistics
import sys
from collections import defaultdict

from vault import (
    CONCEPTS, THROUGH_LINES, VAULT, Course, as_list, canonical, concept_requires,
    course_folders, is_group, load_course, load_notes, match_core, sections, short_title,
)
from sync_state import state as sync_state


# --- Loading -------------------------------------------------------------------------------------

def load():
    concepts = load_notes(CONCEPTS)
    through_lines = load_notes(THROUGH_LINES)
    courses = {}
    for folder in course_folders([]):
        lessons = load_course(folder)
        if lessons:
            courses[folder] = Course(folder, lessons, concepts, through_lines)
    return concepts, courses


def base(folder):
    return os.path.basename(folder).partition(" – ")[0]


def find_course(courses, text):
    text = text.lower()
    hits = [c for f, c in courses.items() if text in f.lower() or text in c.name.lower()]
    return hits


def find_lesson(courses, text):
    """(course, lesson) pairs matching a file name, a path, or "L3 <course>"."""
    short = re.match(r"^[Ll](\d+)\s+(.+)$", text.strip())
    if short:
        number, course_text = int(short.group(1)), short.group(2)
        return [(c, l) for c in find_course(courses, course_text) for l in c.lessons if l.number == number]
    text = text.strip().removesuffix(".md").lower()
    exact = [(c, l) for c in courses.values() for l in c.lessons
             if l.stem.lower() == text or l.path.lower().removesuffix(".md") == text]
    if exact:
        return exact
    return [(c, l) for c in courses.values() for l in c.lessons if text in l.path.lower()]


def one(hits, what, text, show):
    if len(hits) == 1:
        return hits[0]
    if not hits:
        print(f"No {what} matches {text!r}.")
    else:
        print(f"{len(hits)} {what}s match {text!r}; be more specific:")
        for hit in hits:
            print(f"  {show(hit)}")
    sys.exit(1)


# --- Graph facts ----------------------------------------------------------------------------------

def aliases(concept, concepts):
    entry = concepts.get(concept)
    return [concept] + ([str(a) for a in as_list(entry[1].get("aliases"))] if entry else [])


def mentions(lesson, concept, concepts, limit=4):
    """The sections of a lesson whose text names the concept (or an alias). Acronyms (REST, CI) match
    in capitals only, so "the rest" isn't REST."""
    pattern = re.compile("|".join(
        rf"(?<![\w-]){re.escape(n)}(?![\w-])" if n.isupper() else rf"(?i:(?<![\w-]){re.escape(n)}(?![\w-]))"
        for n in aliases(concept, concepts)))
    found = [name for name, text in sections(lesson.body).items() if pattern.search(name) or pattern.search(text)]
    if len(found) > limit:
        return found[:limit] + [f"+{len(found) - limit} more"]
    return found


def unlinked(lesson, concepts):
    """Concepts with a note that the lesson's text names but its `introduces` / `uses` don't list."""
    names = sorted({canonical(n, concepts) for n in concepts})
    return [c for c in names if c not in lesson.concepts and mentions(lesson, c, concepts)]


def before(a, b):
    return (a.number or 0) < (b.number or 0)


def requires_closure(course, lesson):
    """Every lesson this one requires, directly or through others."""
    seen, stack = [], list(lesson.requires)
    while stack:
        target = course.by_stem.get(stack.pop())
        if target and target not in seen:
            seen.append(target)
            stack += target.requires
    return sorted(seen, key=lambda l: l.number or 0)


def required_by(course, lesson):
    """(direct, all) lessons that require this one."""
    direct = [l for l in course.lessons if lesson.stem in l.requires]
    all_ = [l for l in course.lessons if lesson in requires_closure(course, l)]
    return direct, all_


def taught_elsewhere(courses, course, concept):
    """Where other courses introduce a concept: ["Command Line Basics v1 L1", ...]."""
    return [f"{c.name} {c.first[concept].label()}" for c in courses.values()
            if c is not course and concept in c.first]


def introduced_before(course, concept, lesson):
    first = course.first.get(concept)
    return first is not None and (first is lesson or before(first, lesson))


def new_counts(course):
    return {l.stem: sum(course.first.get(c) is l for c in l.introduces) for l in course.lessons}


def lesson_flags(course, lesson, courses, concepts):
    flags = []
    chain = requires_closure(course, lesson)
    for target in lesson.requires:
        other = course.by_stem.get(target)
        if not other:
            flags.append(f"requires [[{target}]], which is not a lesson in this course")
        elif not before(other, lesson):
            flags.append(f"requires {other.label()}, which comes later")
    for concept in lesson.uses:
        first = course.first.get(concept)
        if first is None:
            where = taught_elsewhere(courses, course, concept)
            flags.append(f"uses [[{concept}]], never introduced in this course"
                         + (f" (introduced in {', '.join(where)})" if where else ""))
        elif not before(first, lesson) and first is not lesson:
            flags.append(f"uses [[{concept}]] before it is taught ({first.label()})")
        elif chain and first not in chain and first is not lesson:
            flags.append(f"uses [[{concept}]] from {first.label()}, which is not in its requires chain")
    for concept in lesson.introduces:
        first = course.first.get(concept)
        if first is not lesson:
            flags.append(f"introduces [[{concept}]] again (first taught in {first.label()})")
        for need in concept_requires(concept, concepts):
            if not introduced_before(course, need, lesson) and need not in lesson.introduces:
                flags.append(f"introduces [[{concept}]], which needs [[{need}]]: not taught before")
        if concept not in concepts:
            flags.append(f"[[{concept}]] has no concept note")
    counts = new_counts(course)
    median = statistics.median(counts.values()) if counts else 0
    mine = counts.get(lesson.stem, 0)
    if len(counts) >= 4 and mine >= max(median * 1.5, median + 3):
        flags.append(f"introduces {mine} concepts (course median {median:g}): check the load")
    if course.through_line() and not lesson.builds:
        flags.append(f"doesn't build [[{course.through_line()}]] (the course's through-line)")
    return flags


def one_offs(course, concepts):
    """Concepts introduced and never used again: the ones another concept needs, and the rest."""
    needed = defaultdict(list)
    for concept in course.users:
        for need in concept_requires(concept, concepts):
            needed[need].append(concept)
    matter, rest = [], []
    for concept, users in course.users.items():
        if len(users) != 1 or concept not in course.first:
            continue
        if needed.get(concept):
            matter.append(f"[[{concept}]] ({users[0].label()}, needed by "
                          + ", ".join(f"[[{c}]]" for c in needed[concept]) + ")")
        else:
            rest.append(concept)
    return matter, rest


# --- Commands -------------------------------------------------------------------------------------

def label(lesson):
    return f"{lesson.label()} {short_title(lesson.stem)}"


def cmd_lesson(concepts, courses, text):
    course, lesson = one(find_lesson(courses, text), "lesson", text, lambda h: f"{h[0].name}: {h[1].stem}")
    counts = new_counts(course)
    median = statistics.median(counts.values()) if counts else 0
    print(lesson.stem)
    print(f"  file: {lesson.path}")
    parts = [course.name, f"{lesson.label()} of {len(course.lessons)}"]
    if lesson.arc:
        parts.append(f"arc: {lesson.arc}")
    if lesson.duration:
        parts.append(f"{lesson.duration} min")
    if lesson.builds:
        parts.append(f"builds [[{lesson.builds}]]")
    parts += [f"status: {lesson.status or '-'}", f"sync: {sync_state(os.path.join(VAULT, lesson.path))}"]
    print("  " + " · ".join(parts))

    chain = requires_closure(course, lesson)
    direct, all_ = required_by(course, lesson)
    print(f"  requires: {', '.join(label(course.by_stem[t]) if t in course.by_stem else '[[' + t + ']] (missing)' for t in lesson.requires) or '-'}"
          + (f"  (whole chain: {', '.join(l.label() for l in chain)})" if len(chain) > len(lesson.requires) else ""))
    print(f"  required by: {', '.join(l.label() for l in direct) or '-'}"
          + (f"  (through them: {', '.join(l.label() for l in all_ if l not in direct)})" if len(all_) > len(direct) else ""))

    print(f"  introduces ({len(lesson.introduces)}, course median {median:g}):")
    for concept in lesson.introduces:
        needs = concept_requires(concept, concepts)
        need_text = ", ".join(
            f"{n} {'✓ ' + course.first[n].label() if introduced_before(course, n, lesson) else '✓ here' if n in lesson.introduces else '!'}"
            for n in needs) or "-"
        later = [l.label() for l in course.users[concept] if l is not lesson]
        print(f"    {concept} · needs: {need_text} · used again: {', '.join(later) or 'never'}")
        print(f"      mentioned in: {'; '.join(mentions(lesson, concept, concepts)) or 'no section names it'}")
    print(f"  uses ({len(lesson.uses)}):")
    for concept in lesson.uses:
        first = course.first.get(concept)
        where = (f"taught {first.label()}" if first and before(first, lesson)
                 else f"! taught later ({first.label()})" if first
                 else "! not taught in this course")
        print(f"    {concept} · {where} · mentioned in: {'; '.join(mentions(lesson, concept, concepts)) or 'no section names it'}")
    named = unlinked(lesson, concepts)
    if named:
        print(f"  named but not linked ({len(named)}; add to `uses` or `introduces` if the lesson relies on them):")
        for concept in named:
            print(f"    {concept} · mentioned in: {'; '.join(mentions(lesson, concept, concepts))}")
    if lesson.objectives:
        print(f"  objectives ({len(lesson.objectives)}):")
        for objective in lesson.objectives:
            print(f"    - {objective}")

    core = lesson.fm.get("coreLesson") or lesson.fm.get("devCoreLesson")
    if is_group(course.folder):
        print(f"  group copy of: {core or '? (no coreLesson)'}")
    else:
        copies = [f"{g.name}: {g.by_stem[s].stem}" for g in courses.values() if is_group(g.folder)
                  for s, c in match_core(g, [course])[1].items() if c is lesson]
        print(f"  group copies: {'; '.join(copies) or '-'}")
    flags = lesson_flags(course, lesson, courses, concepts)
    print("  flags:" if flags else "  flags: none")
    for flag in flags:
        print(f"    ! {flag}")


def cmd_concept(concepts, courses, text):
    exact = [n for n in concepts if n.lower() == text.lower()]
    name = canonical(exact[0] if exact else text, concepts)
    if name not in concepts:
        hits = sorted({canonical(n, concepts) for n in concepts if text.lower() in n.lower()})
        name = one(hits, "concept", text, str) if hits else name
    entry = concepts.get(name)
    print(name)
    if entry:
        print(f"  file: {entry[0]}")
        print(f"  definition: {entry[1].get('definition') or '-'}")
        others = aliases(name, concepts)[1:]
        if others:
            print(f"  aliases: {', '.join(others)}")
    else:
        print("  ! no concept note")
    needs = concept_requires(name, concepts)
    needed_by = sorted({canonical(n, concepts) for n in concepts if name in concept_requires(canonical(n, concepts), concepts)})
    print(f"  requires: {', '.join(needs) or '-'}")
    print(f"  required by: {', '.join(needed_by) or '-'}")
    found = False
    for course in courses.values():
        users = course.users.get(name)
        if not users:
            continue
        found = True
        first = course.first.get(name)
        print(f"  {course.name}: " + (f"introduced {first.label()}" if first else "! used but never introduced")
              + (f", again in {', '.join(l.label() for l in course.introducers[name][1:])} (taught twice)"
                 if len(course.introducers[name]) > 1 else ""))
        for lesson in users:
            role = "introduces" if name in lesson.introduces else "uses"
            flag = ""
            if role == "uses" and (not first or before(lesson, first)):
                flag = " ! before it is taught"
            if role == "introduces":
                missing = [n for n in needs if not introduced_before(course, n, lesson) and n not in lesson.introduces]
                if missing:
                    flag = f" ! needs {', '.join(missing)}, not taught before"
            print(f"    {lesson.label()} {role}{flag} · mentioned in: {'; '.join(mentions(lesson, name, concepts)) or 'no section names it'}")
    if not found:
        print("  not linked from any lesson")
    named = [(c, l) for c in courses.values() for l in c.lessons
             if name not in l.concepts and mentions(l, name, concepts)]
    if named:
        print("  named but not linked in:")
        for course, lesson in named:
            print(f"    {course.name} {lesson.label()} · {'; '.join(mentions(lesson, name, concepts))}")


def cmd_course(concepts, courses, text):
    course = one(find_course(courses, text), "course", text, lambda c: c.folder)
    counts = new_counts(course)
    median = statistics.median(counts.values()) if counts else 0
    total = sum(l.duration for l in course.lessons)
    print(f"{course.name} ({course.folder})")
    print(f"  {len(course.lessons)} lessons · {total} min · {len(course.users)} concepts · median {median:g} new per lesson"
          + (f" · through-line [[{course.through_line()}]]" if course.through_line() else ""))
    all_flags = []
    for lesson in course.lessons:
        flags = lesson_flags(course, lesson, courses, concepts)
        all_flags += [(lesson, f) for f in flags]
        print(f"  {lesson.label():>4}  new {counts[lesson.stem]:>2}  uses {len(lesson.uses):>2}  "
              f"{lesson.duration or '?':>3} min  {'!' * min(len(flags), 5):<5} {short_title(lesson.stem)}")
    legacy = sum(l.legacy for l in course.lessons)
    if legacy:
        print(f"  note: {legacy} lessons still use `concepts`; the first lesson listing a concept counts as introducing it")
    untagged = sum(l.untagged for l in course.lessons)
    if untagged:
        print(f"  note: {untagged} lessons have no `introduces` / `uses` yet, so the graph can't see their concepts"
              " (the enrich-lessons skill fills them in)")
    print("  flags:" if all_flags else "  flags: none")
    for lesson, flag in all_flags:
        print(f"    ! {lesson.label()}: {flag}")
    matter, rest = one_offs(course, concepts)
    for item in matter:
        print(f"    ! introduced once, never used again: {item}")
    if rest:
        print(f"  {len(rest)} concepts appear in one lesson only. Either they really are one-offs, or later "
              "lessons rely on them without listing them in `uses`.")


def cmd_impact(concepts, courses, text):
    course, lesson = one(find_lesson(courses, text), "lesson", text, lambda h: f"{h[0].name}: {h[1].stem}")
    print(f"A change to {lesson.label()} {short_title(lesson.stem)} ({course.name}) can reach:")
    direct, all_ = required_by(course, lesson)
    print(f"  lessons that require it: {', '.join(l.label() for l in direct) or '-'}"
          + (f"; through them: {', '.join(l.label() for l in all_ if l not in direct)}" if len(all_) > len(direct) else ""))
    print("  its concepts, where they come back later:")
    any_later = False
    for concept in lesson.concepts:
        later = [l for l in course.users[concept] if before(lesson, l)]
        if not later:
            continue
        any_later = True
        role = "introduced here" if course.first.get(concept) is lesson else "used here"
        print(f"    {concept} ({role}):")
        for other in later:
            print(f"      {other.label()} · {'; '.join(mentions(other, concept, concepts)) or 'no section names it'}")
    if not any_later:
        print("    none")
    if is_group(course.folder):
        core = lesson.fm.get("coreLesson") or lesson.fm.get("devCoreLesson")
        print(f"  this is a group copy; its core lesson: {core or '? (no coreLesson)'} (scope `group and core` changes both)")
    else:
        copies = [(g, g.by_stem[s]) for g in courses.values() if is_group(g.folder)
                  for s, c in match_core(g, [course])[1].items() if c is lesson]
        print(f"  group copies: {', '.join(f'{g.name}: {l.stem}' for g, l in copies) or '-'}")
    shared = []
    for concept in lesson.concepts:
        for other in courses.values():
            if other is course or base(other.folder) == base(course.folder) or is_group(other.folder):
                continue
            if concept in other.users:
                shared.append(f"{concept} → {other.name} {', '.join(l.label() for l in other.users[concept])}")
    print(f"  other courses with the same concepts: {'; '.join(shared) or '-'}")
    if lesson.builds:
        later = [l.label() for l in course.lessons if l.builds == lesson.builds and before(lesson, l)]
        print(f"  through-line [[{lesson.builds}]] continues in: {', '.join(later) or '-'}")


def cmd_pending(concepts, courses, text):
    any_ = False
    for course in courses.values():
        rows = []
        for lesson in course.lessons:
            state = sync_state(os.path.join(VAULT, lesson.path))
            if state in ("pending", "not-synced"):
                rows.append(f"{lesson.label()} {short_title(lesson.stem)}: {state}")
        conflicts_dir = os.path.join(VAULT, course.folder, "_conflicts")
        conflicts = sorted(os.listdir(conflicts_dir)) if os.path.isdir(conflicts_dir) else []
        rows += [f"! conflict copy: _conflicts/{name}" for name in conflicts if name.endswith(".md")]
        if rows:
            any_ = True
            print(course.name)
            for row in rows:
                print(f"  {row}")
    if not any_:
        print("Nothing pending: every lesson is uploaded and there are no conflicts.")


COMMANDS = {"lesson": cmd_lesson, "concept": cmd_concept, "course": cmd_course,
            "impact": cmd_impact, "pending": cmd_pending}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS or (sys.argv[1] != "pending" and len(sys.argv) < 3):
        print(__doc__)
        sys.exit(2)
    concepts, courses = load()
    COMMANDS[sys.argv[1]](concepts, courses, " ".join(sys.argv[2:]))


if __name__ == "__main__":
    main()
