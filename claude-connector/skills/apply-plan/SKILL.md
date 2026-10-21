---
name: apply-plan
description: Carry out an improvement's approved plan by editing the lesson notes in the vault (group copy and, when scoped, core), then send the revision to Chalkenso through the connector. Use when the user asks to apply, execute or implement a plan.
---

# Apply a plan

Edit lesson notes so they match an improvement's approved plan, then send them for review. The plan
is the source of truth: do what it says, no more.

## Steps

1. **The plan**: `get_task` for the improvement (or `get_revision_brief` for a lesson: its
   `open_tasks`). Use the plan as it is in Chalkenso, the approved one. Its `notes_for_ai` are the
   instructor's words: follow them. No plan yet: offer `plan-feedback` instead.
2. **The notes**: pull the lesson if it isn't in the vault, or if Chalkenso's `revision` is newer
   than the note's (`pull-course` for that lesson). Run
   `python3 .claude/scripts/lessons.py check "<note>"`: `pending` means it already has unsent
   changes, so say so in the report.
3. **Edit the lesson body** as the plan says. Keep the course README's style and lesson length. Keep
   headings stable unless the plan changes them, since other lessons may link to `[[Lesson#Heading]]`.
4. **Core too**, when the plan's scope is `group and core`: make the same change in the core lesson
   (same title or slug in the core folder; pull it if needed). If the texts differ too much, adapt
   the edit and say so.
5. **Properties**: update `objectives`, `introduces`, `uses`, `requires` if the plan says so, or if
   the edit clearly adds or removes a concept. Create a missing concept note from
   `Curriculum Knowledge/_Templates/Concept.md` in `Curriculum Knowledge/Concepts/`.
6. **Send it**: run `send-revisions` for the lessons you changed, with this improvement's `task_id`.
7. **Report**: per lesson, a one-line summary of the change and its review link. The improvement
   finishes when the person saves the reviewed revision in Chalkenso.

## Rules

- Follow `AGENTS.md`. If a plan is unclear or conflicts with the course README, don't guess: skip it
  and say why.
- Only what the person asked for: a plan they named, or the plans of a lesson they named.
