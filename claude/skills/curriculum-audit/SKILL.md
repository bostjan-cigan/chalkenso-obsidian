---
name: curriculum-audit
description: Audit a whole course and write the findings as a dated audit note in the vault, then rebuild the course canvases. Use when the user asks for an audit, an audit note, or to map a curriculum. For a quick check of one lesson, concept or change (answered in chat), use curriculum-check instead.
---

# Curriculum audit

Check how a course's lessons fit together and write the findings as an Obsidian note with links.

## Input

A course folder (`<root>/<Organisation>/Curriculums/<Course> – <Version>`), or a group folder
(`<root>/<Organisation>/Groups/<Course> – <Group>`). `graph.py course "<name>"` finds it from part of
its name. Ask if unclear.

## Steps

1. **Ask the graph**: `python3 .claude/scripts/graph.py course "<course>"`, and read the course
   README (arcs, spine).
2. **Check** at course scope, as the `curriculum-check` skill describes (its `checks.md` defines
   every check once): the graph checks for every lesson, and the body checks only for lessons the
   graph flags. Add the checks that only make sense for a whole course:
   - **Missing metadata**: lessons with no `objectives`, or neither `introduces` nor `uses`.
   - **Orphan concepts**: `Curriculum Knowledge/Concepts.base`, view *Orphans*.
   - **Arc fit**: lessons whose Goal doesn't match their arc's description in the README (read
     only the Goal lines).
   - **Group drift** (check 12) when the course has group copies.
3. **Write** `Curriculum Knowledge/_Audits/<Course> <YYYY-MM-DD>.md`:
   - frontmatter `type: audit`, `course: "[[<Course README link>]]"`, `date`;
   - a summary (3–5 bullets, most important first);
   - one section per check, one bullet per finding, with `[[links]]` to the lessons and concepts;
   - "Suggested next steps": concrete edits, each with the lesson it touches.
4. **Rebuild the canvases**: `python3 .claude/scripts/build_canvases.py "<course folder>"`. It
   writes the course's Map, Concepts and At a glance canvases (and, for a group folder, its Drift
   canvas; `All courses` and `Feedback board` every time) to `Curriculum Knowledge/Canvases/`,
   keeps positions the human set by hand, and prints warnings (unknown `requires`, a lesson that
   requires a later one, concepts without a note). Put those warnings in the audit. Don't draw
   canvases by hand, and don't pass `--relayout` unless the human asks for it.
5. **Report**: the summary bullets and the paths of the audit note and the canvases.

## Rules

- Read-only for lessons: an audit never edits lesson notes. Fixes go through `plan-feedback` /
  `apply-plan`, or `enrich-lessons` for metadata.
- Follow `AGENTS.md`.
