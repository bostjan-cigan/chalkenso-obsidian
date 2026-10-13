# Curriculum Knowledge

How the lessons in each organisation's `Curriculums/` and `Groups/` folders (under the Chalkenso
plugin's root folder, `Chalkenso` by default) connect. Everything here stays in the vault: the
plugin never uploads frontmatter, and this folder is outside its root folder, so nothing here is
ever treated as a lesson.

## Where things are

| Path | What it holds |
|---|---|
| `Concepts/` | One note per concept (Docker, REST, migrations…), shared by all courses |
| `Through-lines/` | The project a course builds end to end (e.g. [[Recipe Keeper]]) |
| `_Templates/` | Templates for new lessons and concepts (core Templates plugin) |
| `_Audits/` | Audit notes written by Claude (`curriculum-audit` skill) |
| `Canvases/` | Three canvases per course, generated from lesson properties (see below) |

## Lesson properties

Add these to any lesson note. They are yours; the plugin leaves them alone.

```yaml
objectives:              # what a learner can do after the lesson
  - Run a Flask app in Docker
introduces: ["[[Docker]]"]                 # concepts this lesson teaches first
uses: ["[[Environment variables]]"]        # concepts it relies on, taught elsewhere
requires: ["[[Lesson 1 - Course intro, Docker setup and your first page]]"]
builds: "[[Recipe Keeper]]"
duration: 90             # minutes
```

The plugin also writes `coreLesson` in group folders: a link to the core lesson that the group copy
comes from.

Concept notes have `definition`, `aliases` and `requires` (the concepts a learner must know first,
e.g. CSRF requires Session cookies). Lessons that still have the older `concepts` list work: the
first lesson in a course to list a concept counts as introducing it.

If you change the plugin's root folder (Settings → Chalkenso → Root folder), run the installer
again with `--update-bases`, or change `"Chalkenso"` in `Curriculum.base` and `Feedback.base`
yourself. The scripts follow the plugin's settings on their own.

## Views

- ![[Curriculum.base#By course]]
- ![[Feedback.base#Open feedback]]
- ![[Feedback.base#Ready for agent]]
- ![[Concepts.base#Orphans]]

## Canvases

Start with [[Canvases/All courses.canvas|All courses]]. `Canvases/` holds three canvases per course
and group folder, built from the lesson properties, and a few that span every course:

| Canvas | Shows |
|---|---|
| `<Course> – Map` | Arcs with lesson count and hours. Each card is the lesson's *Learning objectives*. Green = published. Arrows follow `requires`; a red one means a lesson requires a later lesson |
| `<Course> – Concepts` | One column per lesson with the concepts it introduces. Cyan = comes back in 2+ later lessons, purple = another course uses it too, orange = needs a concept not taught before it, red = no concept note, or a *Builds on* list with a concept taught later, twice or not at all |
| `<Course> – At a glance` | What the course builds, then one row per arc: each lesson's goal and its first diagram. Good for showing a course to someone |
| `<Group> – Drift` | Per group folder: each lesson's core note on the left, the group's copy on the right, and between them how much it differs, in which sections, and its open feedback. Green = same, yellow = small changes, orange = larger, red = only in the group |
| `All courses` | Start here. Every course with its lessons, hours, arcs, groups and links to its canvases; cyan cards are concepts that more than one course uses |
| `Feedback board` | Every open feedback item in three columns: *Needs a plan*, *Planned · yours to apply*, *Ready for the agent*. Orange cards change core too |

Rebuild them after changing lessons or properties (the `curriculum-audit` skill does it too):

```
python3 .claude/scripts/build_canvases.py
```

Move and resize cards freely: they keep their place as long as they stay inside their arc or
lesson column, and cards, notes and arrows you add yourself are kept. Colours and texts come from
the notes and are redrawn each time. `--relayout` lays the generated cards out afresh.

## Working with Claude

Open Claude Code in the vault folder. It follows `AGENTS.md` and has these skills:

| Skill | Use it to |
|---|---|
| `plan-feedback` | Write the plans in a feedback note (they sync to the task in Chalkenso) |
| `apply-plan` | Carry out the approved plans in the lesson notes |
| `curriculum-check` | Check a lesson, a concept, a change ("I rewrote L3, what breaks?") or a course for the usual curriculum failures. Answers in chat |
| `curriculum-audit` | Audit a whole course into a dated note in `_Audits/`, and rebuild its canvases |
| `enrich-lessons` | Fill in or repair `objectives`, `introduces`, `uses`, `requires`, and concept prerequisites |

Claude never uploads. You run the plugin's upload and pull commands.

**Handing an item over.** In Chalkenso, tick *Ready for the AI agent* on a feedback item (or a
lesson's brief) and start it. The item arrives here tagged `#ai/ready`, and Claude may then carry
out its plan end to end — edit the lesson and tick the item — without asking each time. Items
without the tag stay assist-only: Claude plans and proposes, you edit. *Ready for agent* above lists
what is waiting.
