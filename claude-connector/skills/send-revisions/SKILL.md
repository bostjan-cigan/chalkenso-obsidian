---
name: send-revisions
description: Send the lessons changed in the vault to Chalkenso as revisions to review, through the Chalkenso connector. Use when the user asks to send, upload, push or submit lesson changes, when a lesson edit is finished, or when the Stop hook says lessons are waiting to be sent.
---

# Send revisions

Every lesson changed since it was pulled goes to Chalkenso as a draft revision. Nothing reaches
learners until someone reviews it in the lesson's Improve view there.

## Steps

1. **What's waiting**: `python3 .claude/scripts/lessons.py changed`. One line per lesson:
   `lesson_id`, `note`, `based_on_revision` and `base` (the text as pulled). Nothing listed: say so
   and stop.
2. **For each lesson**, call `propose_lesson_revision` with:
   - `lesson_id`;
   - `markdown`: the note's body, without its frontmatter, exactly as it is now;
   - `based_on_revision`, and `base_markdown`: the `base` file's text, exactly;
   - `task_id`: the improvement this change is for, when you know it (the plan you applied, or the
     lesson's evidence note under `_evidence/`). Without it, it goes to the lesson's own improvement;
   - `summary`: one or two sentences a teacher reads first, starting with a verb ("Explained why…;
     added a check after…");
   - a new diagram only as the tool describes (an SVG in `assets`, embedded as
     `![[diagrams/name.svg|what it shows]]`).
3. **When the tool accepts it**: `python3 .claude/scripts/lessons.py sent <lesson_id>`. When it
   refuses, don't mark it sent: report why ("Fix these diagrams…", "The lesson changed since…") and
   fix what it names.
4. **Report**: one line per lesson with its `say_to_the_person` link. Say that it waits for review in
   Chalkenso; never that it's published, applied or saved.

## Rules

- Follow `AGENTS.md`. Send only what the person or an approved plan asked for. If a lesson changed
  but the person is still working on it, ask before sending.
- Properties (frontmatter) are never sent, and a lesson whose only change is a property doesn't show
  up here.
- After the person saves the reviewed revision in Chalkenso, `pull-course` brings the new text in
  (a newer `revision`).
