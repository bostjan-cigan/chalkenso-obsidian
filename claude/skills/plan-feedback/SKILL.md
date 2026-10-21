---
name: plan-feedback
description: Draft the plans in a curriculum feedback note (_feedback/Feedback - <lesson>.md). Use when the user asks to plan, triage or answer reviewer feedback on a lesson, core or group.
---

# Plan feedback

Write the lesson's plan in one feedback note: one plan that answers the open feedback (the
**Open** section) and the improvement's own feedback (**Improvement**). Plans sync to Chalkenso on
the next feedback pull or lesson upload, and they are the source of truth for the revision. A plan
sent uses the open feedback that isn't ticked, so it joins the lesson's improvement.

## Input

A feedback note path, a lesson name, or "all open feedback". For "all", list notes from
`Curriculum Knowledge/Feedback.base` (view *Open feedback*): feedback notes with `open > 0`. Then
ask which to do, or do them one by one. The view *Ready for agent* (`aiReady > 0`) narrows that to
notes holding items cleared for you to carry out.

## Steps

1. **Read the feedback note.** Note each unticked piece of feedback under **Open** (`- [ ]` with
   `%%feedback:…%%`: the quote, the comment, any reply) and each unticked improvement or brief under
   **Improvement** (`%%task:…%%`) with the feedback it uses. Skip `[x]` and `[-]` items, anything
   marked *worked on in Chalkenso*, and the **Done** section (read it only for history: what was
   tried before).
2. **Gather context**:
   - the lesson note (the note's `lesson` property links to it);
   - the course `README.md` (idea, arcs, spine) of the folder the lesson is in;
   - `python3 .claude/scripts/graph.py lesson "<lesson>"`: its `requires`, the concepts it introduces
     and uses, and which later lessons rely on it. Read the linked notes and sections the plan touches;
   - for a group lesson: its core note (`coreLesson`, or the same `slug` in the core folder).
     Compare the two. If the problem exists in core too, core probably needs the change as well.
3. **Draft the plan** under the improvement's `#### Plan %%plan:…%%` heading (with no improvement
   yet, under the `%%plan:new:…%%` heading: sending it starts one), replacing only the text under it
   (up to the next heading or item). A brief keeps its own plan. Feedback that only needs an answer,
   not a lesson change, gets no place in the plan: suggest a reply for it in your report. A plan:
   - says what changes, where (section heading), and why, in 3–8 bullets;
   - quotes the sentences to replace when that is shorter than describing them;
   - names new or changed `objectives` / `introduces` / `uses` / `requires` if any;
   - if it changes something later lessons rely on (`graph.py impact`), names those lessons too;
   - ends with `Scope: group only` or `Scope: group and core` (core lessons: `Scope: core`).
   If a plan already has text the human wrote, don't overwrite it: add your suggestion below, headed
   `Suggestion:`.
   An item tagged `#ai/ready` is carried out from its plan without another review, so write that
   plan to be executed: name the section, the exact wording to change, and stop where the change
   stops. Unsure what the reviewer wants? Say so in the plan instead of guessing — a vague plan on a
   cleared item becomes a vague edit.
4. **Don't touch anything else**: no checkboxes, no `Reply:` lines, no markers, no quotes, and no
   lesson edits.
5. **Report**: a short list with one line per item (lesson, plan in one sentence, scope), plus any
   item you could not plan and why.

## Rules

- Follow `AGENTS.md` (plugin-owned keys, markers, sync safety).
- A plan is a proposal. The human edits or approves it, then runs `apply-plan` or does it by hand.
- Feedback that is wrong or already addressed: say so in the report and suggest a reply (the human
  ticks it with that reply). Don't tick it yourself.
