#!/usr/bin/env python3
"""Build the course canvases in `Curriculum Knowledge/Canvases/` from lesson frontmatter.

  python3 .claude/scripts/build_canvases.py                  every course and group folder
  python3 .claude/scripts/build_canvases.py "<folder>"...    only these (course or group folders)
  python3 .claude/scripts/build_canvases.py --relayout ...   lay generated cards out afresh

Three canvases per course or group folder:

  <Name> – Map.canvas          arcs as columns, each lesson's "Learning objectives", requires arrows,
                               colour = status; a red arrow points at a lesson that requires a later one
  <Name> – Concepts.canvas     one column per lesson with the concepts it brings in first, reuse
                               marked on each card, and what it builds on from earlier lessons
  <Name> – At a glance.canvas  the through-line, then one row per arc: each lesson's goal and diagram

Plus, whatever folders you pass:

  <Group> – Drift.canvas       per group folder: each lesson's core note, how much the group's copy
                               differs (and in which sections), the group's copy, open feedback
  All courses.canvas           every core course with its stats, groups and canvases, and the
                               concepts different courses share
  Feedback board.canvas        open feedback items in three columns: needs a plan / planned, yours
                               to apply / ready for the agent (#ai/ready)

Reads only; never writes inside course or group folders. On a re-run, cards keep the position
and size you gave them as long as they stay inside their group (arc or lesson column), and nodes
and edges you added yourself are kept. Generated ids start with "auto-": don't reuse that prefix.
"""

import json
import math
import os
import re
import struct
import sys
from collections import defaultdict

from vault import (
    KNOWLEDGE, THROUGH_LINES, CONCEPTS, VAULT, Course, concept_requires, course_folders, hours, is_group,
    load_course, load_feedback, load_notes, match_core, line_changes, plural, sections, short_title,
    similarity,
)

OUT = f"{KNOWLEDGE}/Canvases"

# Canvas preset colours
RED, ORANGE, YELLOW, GREEN, CYAN, PURPLE = "1", "2", "3", "4", "5", "6"
GAP = 40
PAD = 40
GROUP_TOP = 60  # room for the group label


# --- Layout helpers ----------------------------------------------------------------------------

def text_height(text, width):
    chars = max(20, (width - 40) // 8)
    lines = 0.0
    for line in text.split("\n"):
        plain = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", line)
        plain = re.sub(r"[*_`>]", "", plain)
        scale = 1.8 if line.startswith("# ") else 1.4 if line.startswith("## ") else 1.0
        lines += scale * max(1, math.ceil(len(plain) / chars))
    return int(lines * 26 + 50)


def image_ratio(path):
    """height / width of an SVG or PNG, 0.6 when unknown."""
    full = os.path.join(VAULT, path)
    try:
        if path.lower().endswith(".png"):
            with open(full, "rb") as handle:
                head = handle.read(24)
            width, height = struct.unpack(">II", head[16:24])
            return height / width
        if path.lower().endswith(".svg"):
            with open(full, encoding="utf-8", errors="ignore") as handle:
                head = handle.read(2000)
            box = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', head)
            if box:
                return float(box.group(2)) / float(box.group(1))
    except (OSError, ValueError, struct.error):
        pass
    return 0.6


def text_node(node_id, text, x, y, width, height=None, color=None, group=None):
    node = {"id": node_id, "type": "text", "text": text, "x": x, "y": y, "width": width,
            "height": height or text_height(text, width)}
    if color:
        node["color"] = color
    if group:
        node["_group"] = group
    return node


def file_node(node_id, path, x, y, width, height, subpath=None, color=None, group=None):
    node = {"id": node_id, "type": "file", "file": path, "x": x, "y": y, "width": width,
            "height": height}
    if subpath:
        node["subpath"] = subpath
    if color:
        node["color"] = color
    if group:
        node["_group"] = group
    return node


def group_node(node_id, label, x, y, width, height, color=None):
    node = {"id": node_id, "type": "group", "label": label, "x": x, "y": y, "width": width,
            "height": height}
    if color:
        node["color"] = color
    return node


def fit_group(group, children):
    if children:
        group["height"] = max(c["y"] + c["height"] for c in children) + PAD - group["y"]
        group["width"] = max(group["width"], max(c["x"] + c["width"] for c in children) + PAD - group["x"])


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-") or "none"


def overlaps(a, b):
    return (a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"]
            and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"])


def inside(node, box):
    cx, cy = node["x"] + node["width"] / 2, node["y"] + node["height"] / 2
    return box["x"] <= cx <= box["x"] + box["width"] and box["y"] <= cy <= box["y"] + box["height"]


# --- Writing, keeping hand-made layout ---------------------------------------------------------

def read_canvas(path):
    try:
        with open(os.path.join(VAULT, path), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def merge(previous, nodes, edges):
    """Keep positions and sizes from the previous canvas, and everything not generated."""
    prev = {n["id"]: n for n in previous.get("nodes", [])}
    groups = {n["id"]: n for n in nodes if n["type"] == "group"}
    auto = {gid: dict(g) for gid, g in groups.items()}

    right = 0
    for gid, g in groups.items():
        if gid in prev:
            g.update({k: prev[gid][k] for k in ("x", "y", "width", "height")})
            right = max(right, g["x"] + g["width"])
    for gid, g in groups.items():
        if gid not in prev and any(p in prev for p in groups):
            g["x"] = right + GAP * 2  # a new arc or lesson goes after everything kept
            right = g["x"] + g["width"]

    placed = defaultdict(list)
    for node in nodes:
        gid = node.get("_group")
        old = prev.get(node["id"])
        if node["type"] == "group":
            continue
        if gid is None:
            if old:
                node.update(x=old["x"], y=old["y"], width=old["width"],
                            height=max(old["height"], node["height"]) if node["type"] == "text"
                            else old["height"])
            continue
        g = groups[gid]
        if old and inside(old, g):
            node.update(x=old["x"], y=old["y"], width=old["width"],
                        height=max(old["height"], node["height"]) if node["type"] == "text"
                        else old["height"])
        else:
            node["x"] += g["x"] - auto[gid]["x"]
            node["y"] += g["y"] - auto[gid]["y"]
            if any(overlaps(node, other) for other in placed[gid]):
                node["x"] = g["x"] + PAD
                node["y"] = max(o["y"] + o["height"] for o in placed[gid]) + GAP
        placed[gid].append(node)
    for gid, g in groups.items():
        fit_group(g, placed[gid])

    ids = {n["id"] for n in nodes}
    for old in previous.get("nodes", []):
        if not old["id"].startswith("auto-") and old["id"] not in ids:
            nodes.append(old)
            ids.add(old["id"])
    for old in previous.get("edges", []):
        if (not old["id"].startswith("auto-") and old.get("fromNode") in ids
                and old.get("toNode") in ids):
            edges.append(old)
    return nodes, edges


def set_sides(nodes, edges):
    """Attach each generated edge to the sides that face each other."""
    by_id = {n["id"]: n for n in nodes}
    cards = [n for n in nodes if n["type"] != "group"]
    for edge in edges:
        if not edge["id"].startswith("auto-"):
            continue
        a, b = by_id[edge["fromNode"]], by_id[edge["toNode"]]
        acx, bcx = a["x"] + a["width"] / 2, b["x"] + b["width"] / 2
        if abs(acx - bcx) < min(a["width"], b["width"]) / 2:
            top, bottom = (a, b) if a["y"] < b["y"] else (b, a)
            between = any(n is not a and n is not b and abs(n["x"] + n["width"] / 2 - acx) < n["width"] / 2
                          and top["y"] + top["height"] <= n["y"] and n["y"] + n["height"] <= bottom["y"]
                          for n in cards)
            if between:
                edge["fromSide"], edge["toSide"] = "right", "right"
            elif a is top:
                edge["fromSide"], edge["toSide"] = "bottom", "top"
            else:
                edge["fromSide"], edge["toSide"] = "top", "bottom"
        elif acx < bcx:
            edge["fromSide"], edge["toSide"] = "right", "left"
        else:
            edge["fromSide"], edge["toSide"] = "left", "right"


def write_canvas(path, nodes, edges, relayout):
    previous = read_canvas(path)
    if previous and relayout:  # drop the generated layout, keep what you added yourself
        previous = {key: [i for i in previous.get(key, []) if not i["id"].startswith("auto-")]
                    for key in ("nodes", "edges")}
    if previous:
        nodes, edges = merge(previous, nodes, edges)
    set_sides(nodes, edges)
    for node in nodes:
        node.pop("_group", None)
        for key in ("x", "y", "width", "height"):
            node[key] = int(round(node[key]))
    nodes.sort(key=lambda n: n["type"] != "group")  # groups first, so they sit behind their cards
    line = lambda item: "\t\t" + json.dumps(item, ensure_ascii=False, separators=(",", ":"))
    text = ('{\n\t"nodes":[\n' + ",\n".join(line(n) for n in nodes) + '\n\t],\n\t"edges":[\n'
            + ",\n".join(line(e) for e in edges) + "\n\t]\n}\n")
    full = os.path.join(VAULT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    if os.path.exists(full):
        with open(full, encoding="utf-8") as handle:
            if handle.read() == text:
                return "unchanged"
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(text)
    return "written"


# --- Course canvases ------------------------------------------------------------------------------


def lesson_color(lesson):
    return GREEN if lesson.status == "published" else None


def map_canvas(course):
    nodes, edges = [], []
    col_w, card_w, card_h = 480, 400, 300
    for i, arc in enumerate(course.arcs):
        lessons = course.arc_lessons(arc)
        gid = f"auto-arc-{slug(course.arc_label(arc))}"
        minutes = sum(l.duration for l in lessons)
        label = f"{course.arc_label(arc)} · {plural(len(lessons), 'lesson')} · {hours(minutes)}"
        group = group_node(gid, label, i * (col_w + GAP * 2), 0, col_w, 0)
        children = []
        for j, lesson in enumerate(lessons):
            y = GROUP_TOP + j * (card_h + GAP)
            children.append(file_node(
                f"auto-lesson-{lesson.id}", lesson.path, group["x"] + PAD, y, card_w, card_h,
                subpath="#Learning objectives" if lesson.has_objectives else None,
                color=lesson_color(lesson), group=gid))
        fit_group(group, children)
        nodes += [group] + children

    through = course.through_line()
    lines = [f"# {course.name}",
             f"{len(course.lessons)} lessons · {hours(sum(l.duration for l in course.lessons))}"
             f" · {len(course.arcs)} arcs · {len(course.users)} concepts",
             f"Status: {course.status_counts()}"]
    if through:
        lines.append(f"Through-line: [[{through}]]")
    lines += ["", "**Reading this map:** each card is a lesson's learning objectives. Green = published. "
              "Arrows run from a lesson to the lessons that require it; a red arrow means a lesson "
              "requires a later one."]
    header = "\n".join(lines)
    width = max(col_w, len(course.arcs) * (col_w + GAP * 2) - GAP * 2)
    height = text_height(header, width)
    nodes.insert(0, text_node("auto-header", header, 0, -height - GAP, width, height))

    for lesson in course.lessons:
        for target in lesson.requires:
            source = course.by_stem.get(target)
            if not source:
                continue
            edge = {"id": f"auto-req-{source.id}-{lesson.id}", "fromNode": f"auto-lesson-{source.id}",
                    "toNode": f"auto-lesson-{lesson.id}"}
            if source.number is not None and lesson.number is not None and source.number > lesson.number:
                edge.update(color=RED, label="requires a later lesson")
                course.warnings.append(f"{lesson.stem}: requires later [[{target}]]")
            edges.append(edge)
    return nodes, edges


def taught_before(course, concept, lesson):
    first = course.first.get(concept)
    return first is not None and (first is lesson or (first.number or 0) < (lesson.number or 0))


def concept_card(course, concept, lesson, others):
    later = [l.label() for l in course.users[concept] if (l.number or 0) > (lesson.number or 0)]
    entry = course.concepts.get(concept)
    lines = [f"**[[{concept}]]**"]
    if entry and entry[1].get("definition"):
        lines.append(str(entry[1]["definition"]))
    elif not entry:
        lines.append("*No concept note yet.*")
    missing = [r for r in concept_requires(concept, course.concepts) if not taught_before(course, r, lesson)]
    if missing:
        lines.append("⚠ needs " + ", ".join(f"[[{r}]]" for r in missing) + ", not taught before this")
    if later:
        lines.append(f"↻ again in {', '.join(later)}")
    if others.get(concept):
        lines.append(f"Also in: {', '.join(sorted(others[concept]))}")
    color = (RED if not entry else ORANGE if missing else CYAN if len(later) >= 2
             else PURPLE if others.get(concept) else None)
    return "\n".join(lines), color


def builds_on_line(course, concept, lesson):
    """`- [[X]] (L2)` for a concept a lesson relies on; warns when it isn't taught before."""
    first = course.first.get(concept)
    if first is None:
        return f"- [[{concept}]] ⚠ not taught in this course", True
    if first is lesson:
        return None, False
    if not taught_before(course, concept, lesson):
        return f"- [[{concept}]] ⚠ taught later, in {first.label()}", True
    again = " (taught again here)" if concept in lesson.introduces else ""
    return f"- [[{concept}]] ({first.label()}){again}", bool(again)


def concepts_canvas(course, others):
    nodes, edges = [], []
    col_w, card_w = 320, 280
    for i, lesson in enumerate(course.lessons):
        gid = f"auto-col-{lesson.id}"
        group = group_node(gid, f"{lesson.label()} · {short_title(lesson.stem)}",
                           i * (col_w + GAP), 0, col_w, 0, color=lesson_color(lesson))
        new = [c for c in lesson.introduces if course.first.get(c) is lesson]
        old = [c for c in lesson.concepts if course.first.get(c) is not lesson]
        head = (f"[[{lesson.stem}|Open {lesson.label()}]] · {lesson.duration} min\n"
                f"**{len(new)} new · {len(old)} from earlier**")
        children = [text_node(f"auto-head-{lesson.id}", head, group["x"] + 20, GROUP_TOP, card_w,
                              group=gid)]
        y = GROUP_TOP + children[0]["height"] + GAP / 2
        for concept in new:
            text, color = concept_card(course, concept, lesson, others)
            card = text_node(f"auto-concept-{slug(concept)}", text, group["x"] + 20, y, card_w,
                             color=color, group=gid)
            children.append(card)
            y += card["height"] + 20
        if old:
            lines = [builds_on_line(course, c, lesson) for c in old]
            text = "Builds on:\n" + "\n".join(line for line, _ in lines if line)
            children.append(text_node(f"auto-uses-{lesson.id}", text, group["x"] + 20, y + 20, card_w,
                                      color=RED if any(bad for _, bad in lines) else None, group=gid))
        fit_group(group, children)
        nodes += [group] + children

    def n_new(lesson):
        return sum(course.first.get(c) is lesson for c in lesson.introduces)

    busiest = max(course.lessons, key=n_new, default=None)
    lines = [f"# {course.name}: concepts by lesson",
             f"{len(course.users)} concepts, each under the lesson that introduces it.",
             "",
             "**Colours:** cyan = comes back in 2 or more later lessons (a thread of the course) · "
             "purple = also used by another course · orange = needs a concept not taught before it · "
             "red = no concept note yet, or a *Builds on* list with a concept taught later, twice or not at all."]
    if busiest:
        n = n_new(busiest)
        lines.append(f"Most new concepts in one lesson: {busiest.label()} ({n}).")
    header = "\n".join(lines)
    width = min(1400, max(col_w, len(course.lessons) * (col_w + GAP) - GAP))
    height = text_height(header, width)
    nodes.insert(0, text_node("auto-header", header, 0, -height - GAP, width, height))
    return nodes, edges


def glance_canvas(course):
    nodes, edges = [], []
    col_w, card_w, img_h_max = 400, 360, 260
    through = course.through_line()
    lines = [f"# {course.name} at a glance",
             f"{len(course.lessons)} lessons · {hours(sum(l.duration for l in course.lessons))}"]
    if through:
        entry = course.through_lines.get(through)
        summary = ""
        if entry:
            paragraphs = [p.strip() for p in re.split(r"\n\s*\n", entry[2])
                          if p.strip() and not p.lstrip().startswith(("#", "```", "-", "|"))]
            summary = paragraphs[0].replace("\n", " ") if paragraphs else ""
        lines += ["", f"**You build: [[{through}]]**" + (f" — {summary}" if summary else "")]
    header = "\n".join(lines)
    widest = max((len(course.arc_lessons(a)) for a in course.arcs), default=1)
    width = max(col_w, widest * (col_w + GAP) + PAD)
    height = text_height(header, min(width, 1200))
    nodes.append(text_node("auto-header", header, 0, 0, min(width, 1200), height))

    y = height + GAP * 2
    for arc in course.arcs:
        lessons = course.arc_lessons(arc)
        gid = f"auto-row-{slug(course.arc_label(arc))}"
        group = group_node(gid, f"{course.arc_label(arc)} · {hours(sum(l.duration for l in lessons))}",
                           0, y, width, 0)
        texts = []
        for j, lesson in enumerate(lessons):
            text = f"### [[{lesson.stem}|{lesson.label()} · {short_title(lesson.stem)}]]\n{lesson.duration} min"
            if lesson.goal:
                text += f"\n\n{lesson.goal}"
            texts.append(text)
        text_h = max(text_height(t, card_w) for t in texts) if texts else 0
        children = []
        for j, (lesson, text) in enumerate(zip(lessons, texts)):
            x = PAD + j * (col_w + GAP)
            children.append(text_node(f"auto-card-{lesson.id}", text, x, y + GROUP_TOP, card_w, text_h,
                                      color=lesson_color(lesson), group=gid))
            if lesson.image:
                img_h = min(img_h_max, int(card_w * image_ratio(lesson.image)))
                children.append(file_node(f"auto-img-{lesson.id}", lesson.image, x,
                                          y + GROUP_TOP + text_h + 20, card_w, img_h, group=gid))
        fit_group(group, children)
        nodes += [group] + children
        y += group["height"] + GAP
    return nodes, edges


# --- Feedback board ----------------------------------------------------------------------------


def feedback_canvas(courses, feedback):
    """A board of open feedback items: needs a plan / planned, yours to apply / ready for the agent."""
    open_items = [i for i in feedback if i["state"] == " "]
    columns = (("needs-plan", "Needs a plan", ORANGE),
               ("yours", "Planned · yours to apply", None),
               ("agent", "Ready for the agent (#ai/ready)", PURPLE))

    def column(item):
        if not item["plan"]:
            return "needs-plan"
        return "agent" if item["ai"] else "yours"

    nodes, edges = [], []
    col_w, card_w = 400, 360
    lessons = {(i["folder"], i["lesson"]) for i in open_items}
    lines = ["# Feedback board",
             f"{plural(len(open_items), 'open item')} across {plural(len(lessons), 'lesson')} · "
             f"{sum(column(i) == 'agent' for i in open_items)} ready for the agent",
             "",
             "Built from the `_feedback` notes: plan and tick items there, then rebuild. "
             "Orange cards change core too (`Scope: group and core`)."]
    if not open_items:
        lines.append("\n**Nothing open.**")
    header = "\n".join(lines)
    width = len(columns) * (col_w + GAP) - GAP
    height = text_height(header, width)
    nodes.append(text_node("auto-header", header, 0, -height - GAP, width, height))
    for i, (key, label, color) in enumerate(columns):
        items = sorted((it for it in open_items if column(it) == key),
                       key=lambda it: (courses[it["folder"]].name, it["lesson"], it["title"]))
        gid = f"auto-col-{key}"
        group = group_node(gid, f"{label} · {len(items)}", i * (col_w + GAP), 0, col_w, 200, color=color)
        children, y = [], GROUP_TOP
        for item in items:
            note = os.path.splitext(os.path.basename(item["note"]))[0]
            where = courses[item["folder"]].name + (" (dev)" if item["dev"] else "")
            text = f"**{item['title']}**\n[[{note}|{item['lesson']}]] · {where}"
            if item["ai"] and key != "agent":
                text += "\nCleared for the agent once it has a plan."
            if item["plan"]:
                first = next((l.strip("-*# ") for l in item["plan"].splitlines() if l.strip()), "")
                text += f"\n\n*Plan:* {first[:160]}{'…' if len(first) > 160 else ''}"
            card = text_node(f"auto-task-{item['task']}", text, group["x"] + 20, y, card_w,
                             color=ORANGE if item["scope"] == "group and core" else None, group=gid)
            children.append(card)
            y += card["height"] + 20
        fit_group(group, children)
        group["height"] = max(group["height"], 200)
        nodes += [group] + children
    return nodes, edges


# --- Groups against core -------------------------------------------------------------------------


def drift_canvas(group, core, pairs, feedback):
    nodes, edges = [], []
    card_w, card_h, diff_w = 380, 220, 320
    open_by_lesson = defaultdict(int)
    for item in feedback:
        if item["folder"] == group.folder and item["state"] == " ":
            open_by_lesson[item["lesson"]] += 1
    counts = defaultdict(int)
    y = 0
    for lesson in group.lessons:
        core_lesson = pairs.get(lesson.stem)
        rid = lesson.id
        gid = f"auto-row-{rid}"
        row = group_node(gid, f"{lesson.label()} · {short_title(lesson.stem)}", 0, y,
                         card_w * 2 + diff_w + PAD * 2 + GAP * 2, 0)
        children = []
        if core_lesson:
            ratio = similarity(core_lesson.body, lesson.body)
            added, removed = line_changes(core_lesson.body, lesson.body)
            core_parts, group_parts = sections(core_lesson.body), sections(lesson.body)
            changed = [h for h in list(group_parts) + [h for h in core_parts if h not in group_parts]
                       if core_parts.get(h) != group_parts.get(h)]
            if ratio == 1:
                state, color, text = "same", GREEN, "**Same as core**"
            else:
                state = "changed"
                color = YELLOW if ratio >= 0.9 else ORANGE
                text = f"**{min(99, round(ratio * 100))}% same as core** · +{added} / −{removed} lines"
                if changed:
                    text += "\nChanged: " + "; ".join(
                        f"{h}{' (only in group)' if h not in core_parts else ' (only in core)' if h not in group_parts else ''}"
                        for h in changed[:6]) + ("; …" if len(changed) > 6 else "")
            children.append(file_node(f"auto-core-{rid}", core_lesson.path, PAD, y + GROUP_TOP,
                                      card_w, card_h, group=gid))
        else:
            state, color, text = "group only", RED, "**Not in core.** No `coreLesson`, slug or title match."
        counts[state] += 1
        if open_by_lesson.get(lesson.stem):
            text += f"\n{plural(open_by_lesson[lesson.stem], 'open feedback item')}"
        diff = text_node(f"auto-diff-{rid}", text, PAD + card_w + GAP, y + GROUP_TOP, diff_w,
                         max(card_h, text_height(text, diff_w)), color=color, group=gid)
        children.append(diff)
        children.append(file_node(f"auto-group-{rid}", lesson.path, PAD + card_w + GAP * 2 + diff_w,
                                  y + GROUP_TOP, card_w, card_h, group=gid))
        if core_lesson:
            edges.append({"id": f"auto-e1-{rid}", "fromNode": f"auto-core-{rid}", "toNode": f"auto-diff-{rid}"})
        edges.append({"id": f"auto-e2-{rid}", "fromNode": f"auto-diff-{rid}", "toNode": f"auto-group-{rid}"})
        fit_group(row, children)
        nodes += [row] + children
        y += row["height"] + GAP

    missing = [l for l in core.lessons if l not in pairs.values()] if core else []
    lines = [f"# {group.name}: drift from core",
             f"Core: {core.name if core else 'not found'} · left = core, right = this group's copy",
             " · ".join(f"{n} {s}" for s, n in sorted(counts.items())),
             "",
             "Green = same as core · yellow = small changes (≥ 90% same) · orange = larger changes · "
             "red = only in the group. Differences that look like fixes may belong in core too."]
    if missing:
        lines.append("\n**In core but not in this group:** " + ", ".join(f"[[{l.stem}]]" for l in missing))
    header = "\n".join(lines)
    width = card_w * 2 + diff_w + PAD * 2 + GAP * 2
    height = text_height(header, width)
    nodes.insert(0, text_node("auto-header", header, 0, -height - GAP, width, height))
    return nodes, edges, counts


# --- All courses on one canvas ---------------------------------------------------------------

def programme_canvas(cores, groups_of, canvases):
    nodes, edges = [], []
    col_w, card_w = 440, 400

    def base(course):
        return os.path.basename(course.folder).partition(" – ")[0]

    shared = defaultdict(list)
    for course in cores:
        for concept in course.users:
            shared[concept].append(course)
    shared = {c: cs for c, cs in shared.items() if len({base(x) for x in cs}) > 1}

    for i, course in enumerate(cores):
        gid = f"auto-course-{slug(course.folder)}"
        group = group_node(gid, course.name, i * (col_w + GAP * 2), 0, col_w, 0)
        through = course.through_line()
        readme = f"{course.folder}/README.md"
        title = (f"## [[{readme}|{course.name}]]" if os.path.exists(os.path.join(VAULT, readme))
                 else f"## {course.name}")
        lines = [title,
                 f"{plural(len(course.lessons), 'lesson')} · {hours(sum(l.duration for l in course.lessons))}"
                 f" · {plural(len(course.users), 'concept')}",
                 f"Status: {course.status_counts()}"]
        if through:
            lines.append(f"Builds: [[{through}]]")
        if any(course.arcs):
            lines += ["", "**Arcs**"] + [f"- {course.arc_label(a)} ({len(course.arc_lessons(a))})"
                                         for a in course.arcs]
        links = [f"[[{p}|{kind}]]" for kind, p in canvases.get(course.folder, [])]
        if links:
            lines += ["", "Canvases: " + " · ".join(links)]
        n_shared = sum(course in cs for cs in shared.values())
        lines.append(f"Shares {plural(n_shared, 'concept')} with other courses")
        card = text_node(f"auto-stats-{slug(course.folder)}", "\n".join(lines), group["x"] + 20, GROUP_TOP,
                         card_w, group=gid)
        children = [card]
        y = card["y"] + card["height"] + 20
        for grp, counts in groups_of.get(course.folder, []):
            text = (f"**Group: {grp.name}**\n{plural(len(grp.lessons), 'lesson')} · "
                    + " · ".join(f"{n} {s}" for s, n in sorted(counts.items())))
            links = [f"[[{p}|{kind}]]" for kind, p in canvases.get(grp.folder, [])]
            if links:
                text += "\n" + " · ".join(links)
            node = text_node(f"auto-grp-{slug(grp.folder)}", text, group["x"] + 20, y, card_w,
                             color=YELLOW if counts.get("changed") or counts.get("group only") else None,
                             group=gid)
            children.append(node)
            y += node["height"] + 20
        fit_group(group, children)
        nodes += [group] + children

    top = max((n["y"] + n["height"] for n in nodes), default=0) + GAP * 4
    ordered = sorted(shared.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    per_row = max(1, len(cores) * 2)
    for k, (concept, users) in enumerate(ordered):
        text = f"**[[{concept}]]**\n" + ", ".join(sorted({c.name for c in users}))
        x = (k % per_row) * (240 + GAP)
        y = top + (k // per_row) * 160
        node = text_node(f"auto-shared-{slug(concept)}", text, x, y, 240, color=CYAN)
        nodes.append(node)
        for course in users:
            edges.append({"id": f"auto-uses-{slug(course.folder)}-{slug(concept)}",
                          "fromNode": f"auto-course-{slug(course.folder)}", "toNode": node["id"]})

    lines = ["# All courses",
             f"{plural(len(cores), 'course folder')} · {plural(len(shared), 'concept')} shared between courses "
             "(different versions of one course don't count)",
             "",
             "Each course links to its canvases. Cyan cards below are the shared concepts, with an "
             "arrow from every course that uses them: change one and check all of them."]
    header = "\n".join(lines)
    width = max(col_w, len(cores) * (col_w + GAP * 2) - GAP * 2)
    height = text_height(header, width)
    nodes.insert(0, text_node("auto-header", header, 0, -height - GAP, width, height))
    return nodes, edges


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    relayout = "--relayout" in sys.argv
    if any(a in ("-h", "--help") for a in sys.argv[1:]):
        print(__doc__)
        return
    concepts = load_notes(CONCEPTS)
    through_lines = load_notes(THROUGH_LINES)

    courses = {}
    for folder in course_folders([]):
        lessons = load_course(folder)
        if lessons:
            courses[folder] = Course(folder, lessons, concepts, through_lines)
    cores = [c for f, c in courses.items() if not is_group(f)]
    groups = [c for f, c in courses.items() if is_group(f)]
    feedback = [item for folder in courses for item in load_feedback(folder)]

    def base(folder):
        return os.path.basename(folder).partition(" – ")[0]

    # which other core courses use each concept (versions of the same course don't count)
    usage = defaultdict(set)
    for course in cores:
        for concept in course.users:
            usage[concept].add(course.folder)

    def write(path, nodes, edges):
        print(f"{write_canvas(path, nodes, edges, relayout)}\t{path}")

    canvases = defaultdict(list)
    for folder, course in courses.items():
        for kind in ("Map", "Concepts", "At a glance"):
            canvases[folder].append((kind, f"{OUT}/{course.name} – {kind}.canvas"))

    targets = course_folders(args)
    for folder in targets:
        if folder not in courses:
            print(f"no lessons: {folder}")
    for folder in targets:
        course = courses.get(folder)
        if not course:
            continue
        others = {c: {courses[f].name for f in fs if base(f) != base(folder)} for c, fs in usage.items()}
        for kind, build in (("Map", lambda: map_canvas(course)),
                            ("Concepts", lambda: concepts_canvas(course, others)),
                            ("At a glance", lambda: glance_canvas(course))):
            write(f"{OUT}/{course.name} – {kind}.canvas", *build())
        for concept in course.missing_concepts:
            course.warnings.append(f"no concept note for [[{concept}]]")
        for lesson in course.lessons:
            if not lesson.has_objectives:
                course.warnings.append(f"{lesson.stem}: no '## Learning objectives' heading, map shows the whole note")

    # groups against their core course; the programme map needs every group's counts
    groups_of = defaultdict(list)
    for group in groups:
        core, pairs = match_core(group, cores)
        nodes, edges, counts = drift_canvas(group, core, pairs, feedback)
        path = f"{OUT}/{group.name} – Drift.canvas"
        canvases[group.folder].append(("Drift", path))
        if group.folder in targets:
            write(path, nodes, edges)
            if counts.get("changed"):
                group.warnings.append(f"{counts['changed']} lessons differ from core ({core.name})")
            if not core:
                group.warnings.append("no core course matches this group")
        if core:
            groups_of[core.folder].append((group, counts))

    write(f"{OUT}/All courses.canvas", *programme_canvas(cores, groups_of, canvases))
    write(f"{OUT}/Feedback board.canvas", *feedback_canvas(courses, feedback))

    for folder in targets:
        if folder in courses:
            for warning in courses[folder].warnings:
                print(f"  ! {courses[folder].name}: {warning}")


if __name__ == "__main__":
    main()
