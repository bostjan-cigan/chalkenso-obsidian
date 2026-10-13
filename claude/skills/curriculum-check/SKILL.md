---
name: curriculum-check
description: Check a lesson, a concept, a change or a course for the ways curricula usually fail (used before taught, missing prerequisites, overload, objectives never practised, change ripples…), using the knowledge graph to decide what to read. Use when the user asks to check, review or sanity-check a lesson or concept, asks what an edit breaks or affects, or asks what is wrong with a course. Reports in chat; writes nothing.
---

# Curriculum check

Find the known failure modes (`checks.md`) in one part of a curriculum. The graph is your index:
ask it first, then read only the lesson sections it points to. Never read a whole course to answer a
question about one lesson or concept.

## 1. Pick the entry point

| The user says… | Entry point | First query |
|---|---|---|
| "check lesson 7", "is L3 OK?" | lesson | `graph.py lesson "L7 <course>"` |
| "is CSRF taught right?", "where do we cover Docker?" | concept | `graph.py concept "CSRF"` |
| "I rewrote L3, what breaks?", "what did my edits affect?" | change | `graph.py impact "L3 <course>"`; with no lesson named, `graph.py pending` first, then `impact` for each |
| "what's wrong with Web Dev II?" | course | `graph.py course "web dev"` |

All queries: `python3 .claude/scripts/graph.py <command> "<name>"`. A lesson is `L<n> <part of course
name>` or part of its file name; if several match, the tool lists them: pick one or ask.

## 2. Read the query as the scope

- Lines starting with `!` are problems the graph shows on its own. Each maps to a check in `checks.md`.
- `mentioned in:` names the `##` sections that talk about a concept. These are the only sections you
  read for that concept (`Read` the lesson with an offset, or `Grep` the heading and read on from it).
- `named but not linked` means the text names a concept that the lesson's `introduces` / `uses` don't
  list. Treat it as a gap in the graph first: until it is linked, graph checks can't see that use.
- If lessons still use the old `concepts` property (the `course` query says so), "introduced" means
  "first listed". Say so when a finding depends on it.

## 3. Run the checks that fit

Open `checks.md` and run the checks listed for your entry point:

- **lesson**: 1, 2, 3, 4, 6, 7, 8, 9, 10 (for the concepts it introduces)
- **concept**: 1, 2, 5, 6, 10
- **change**: 11 first, then 1–3 for every lesson `impact` lists
- **course**: all graph checks (1–6, 9) from the `course` query, then body checks (7, 8, 10) only
  for lessons the query flagged, and check 12 if the course has group copies

For each check, do what its *Read* line says and nothing more. When the graph and the text
disagree (a concept the graph says is untaught but the text explains well), the text wins. Report
the graph as out of date.

## 4. Report in chat

Write nothing to the vault. In the report:

1. **Findings**, most serious first (what would confuse or block a learner comes first). Each finding:
   - the check's name, and `[[links]]` to the lesson(s) and concept(s);
   - the evidence: the heading and a short quote (under 15 words) or the graph line;
   - the fix, concretely: which lesson, which section, what to add or move.
2. **Graph gaps**: missing `uses` / `introduces`, missing concept `requires`. Say which notes to
   update (the `enrich-lessons` skill does this).
3. **Checked and fine**: one line listing the checks that passed.

Then offer the next step: `plan-feedback` for a lesson with a feedback note, or edits the human asks
for. Don't edit lessons from this skill, not even for an obvious fix.

## Rules

- Follow `AGENTS.md`. Read-only: no lesson, concept, canvas or property changes.
- Keep the lesson's language: quote Slovenian lessons in Slovenian.
- Don't pad the report. If a check can't be run (e.g. no concept `requires` yet), say so in one line.
