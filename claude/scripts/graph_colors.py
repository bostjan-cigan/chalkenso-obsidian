#!/usr/bin/env python3
"""Set the graph view's colour groups from the curriculum folders.

  python3 .claude/scripts/graph_colors.py

Writes `colorGroups` (and turns on arrows) in `.obsidian/graph.json`:

  Concept notes, through-lines, other Curriculum Knowledge notes, group copies (every
  organisation's Groups folder), and one colour per core course (all versions of a course share it).

Colour groups you added yourself are kept, after the generated ones. Re-run after adding a course.
Obsidian reads the file when it starts: reload it afterwards (Command palette → "Reload app
without saving"), and don't change graph settings in between, or Obsidian writes its own copy back.
"""

import json
import os

from vault import VAULT, course_folders, is_group, layout

GRAPH = os.path.join(VAULT, ".obsidian", "graph.json")

FIXED = [
    ('path:"Curriculum Knowledge/Concepts"', 0x2A9D8F),       # teal
    ('path:"Curriculum Knowledge/Through-lines"', 0xE9C46A),  # gold
]
GROUPS = 0xF15BB5                                             # pink: every organisation's Groups folder
OTHER_KNOWLEDGE = ('path:"Curriculum Knowledge"', 0x8D99AE)   # grey: audits, templates, READMEs
COURSES = [0xE76F51, 0x457B9D, 0x9B5DE5, 0x06D6A0, 0xF4A261, 0x3A86FF, 0xD62828, 0x8AC926]


def managed(query, root):
    return query.startswith(('path:"Curriculum Knowledge', f'path:"{root}/'))


def main():
    try:
        with open(GRAPH, encoding="utf-8") as handle:
            graph = json.load(handle)
    except FileNotFoundError:  # the graph view was never opened in this vault
        graph = {}
    places = layout()

    # every version of a course, in each organisation: "<Course> – <Version>"; the trailing " – "
    # keeps "Course 2" out of "Course". All versions of a course share its colour.
    bases, queries = [], []
    for folder in course_folders([]):
        if is_group(folder):
            continue
        base = os.path.basename(folder).partition(" – ")[0]
        if base not in bases:
            bases.append(base)
        query = f'path:"{os.path.dirname(folder)}/{base} – "'
        if (query, base) not in queries:
            queries.append((query, base))

    groups = [{"query": q, "color": {"a": 1, "rgb": c}} for q, c in FIXED]
    groups += [{"query": f'path:"{folder}"', "color": {"a": 1, "rgb": GROUPS}} for folder in places["groups"]]
    for query, base in queries:
        groups.append({"query": query, "color": {"a": 1, "rgb": COURSES[bases.index(base) % len(COURSES)]}})
    groups.append({"query": OTHER_KNOWLEDGE[0], "color": {"a": 1, "rgb": OTHER_KNOWLEDGE[1]}})
    groups += [g for g in graph.get("colorGroups", []) if not managed(g.get("query", ""), places["root"])]

    graph["colorGroups"] = groups
    graph["showArrow"] = True
    with open(GRAPH, "w", encoding="utf-8") as handle:
        json.dump(graph, handle, indent=2, ensure_ascii=False)
    for group in groups:
        print(f"#{group['color']['rgb']:06x}\t{group['query']}")


if __name__ == "__main__":
    main()
