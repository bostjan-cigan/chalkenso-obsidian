---
name: apply-plan
description: Carry out the approved plans in a curriculum feedback note by editing the lesson notes (group copy and, when scoped, core). Use when the user asks to apply, execute or implement feedback plans.
---

# Apply plans

Edit lesson notes so they match the approved plans in one feedback note. The plan is the source of
truth: do what it says, no more.

## Steps

1. **Read the feedback note** and pick the items to apply: unticked improvements and briefs under
   **Improvement** / **Brief** whose plan has text (one *Started in Chalkenso* too: applying it here
   takes it over). Skip the **Open** feedback (a plan that uses it is sent first: run a feedback pull
   after `plan-feedback`) and the **Done** section.
   - **The user named items or lessons:** do those, tagged or not — the ask is the authorization.
     Note in the report which of them were not cleared with `#ai/ready`.
   - **A broad ask** ("apply all open feedback", "work through the ready ones") **or no one
     watching:** only items tagged `#ai/ready`. Leave the rest untouched and list them as waiting
     for the human.
   Show the list and the scope of each before editing when there are more than three.
2. **Check sync state** of every note you'll edit:
   `python3 .claude/scripts/sync_state.py check "<note>"`.
   - A copy in the course's `_conflicts/` folder: stop for that lesson and report it.
   - `pending`: continue, but report that the note had unuploaded edits before yours.
3. **Edit the lesson body** as the plan says. Keep the course README's style and lesson length. Keep
   headings stable unless the plan changes them, since other lessons may link to `[[Lesson#Heading]]`.
4. **Core too**, when the plan says `Scope: group and core`: make the same change in the core note
   (`coreLesson`, or the same slug in the core folder). If core and group text differ too much to
   apply the same edit, adapt it and say so in the report.
5. **Properties**: update `objectives`, `introduces`, `uses`, `requires` if the plan says so, or if the
   edit clearly adds or removes a concept. A lesson that still has `concepts` gets `introduces` / `uses`
   instead. Create a missing concept note from
   `Curriculum Knowledge/_Templates/Concept.md` in `Curriculum Knowledge/Concepts/`.
6. **Tick the improvement** `[x]` in the feedback note. Change nothing else there: not the
   **Open** feedback, not the `Reply:` lines.
7. **Report**: for each item, the notes changed and a one-line summary of the change. Finish with:
   "Upload the changed notes with the Chalkenso plugin (Sync current folder); ticked items close once their lesson is uploaded."

## Rules

- Follow `AGENTS.md`. Never upload, never edit plugin-owned keys, never `touch` after a body edit.
- `#ai/ready` is Chalkenso's clearance, not yours: never add or remove it, and never treat an
  untagged item as cleared because its plan looks finished.
- If a plan is unclear or conflicts with the course README, don't guess: skip the item and say why.
