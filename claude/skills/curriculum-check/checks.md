# Curriculum failure modes

Each check has the same parts:

- **Signal**: what the graph shows (a `graph.py` line) or what makes the check apply.
- **Read**: the least text that settles it.
- **Judge**: when it is a real problem, and when it isn't.
- **Fix**: what to propose.

Graph checks (1–6, 9) start from `graph.py` output. Body checks (7, 8, 10) need the lesson text, but
only the sections named.

---

## 1. Used before taught

A lesson relies on a concept that is explained later, or never.

- **Signal**: `! uses [[X]] before it is taught (L5)`, `! uses [[X]], never introduced in this course`,
  a concept listed with `! taught later` in a `lesson` query. Also `named but not linked` entries for a
  concept whose first lesson comes later.
- **Read**: the sections `mentioned in:` for X in this lesson (does it lean on X, or just name it?),
  and the introducing lesson's sections for X (is that the real explanation?).
- **Judge**: real if a learner needs to understand X to follow this lesson. Not a problem if X is only
  named in passing ("we'll meet Docker later"), or taught in a course that must come first (say which).
- **Fix**: move the explanation earlier, add a short "just enough" explanation where it is first used,
  or cut the dependency. If the graph is just wrong (the lesson really does teach X), fix the graph.

## 2. Missing concept prerequisite

A lesson introduces X, but X builds on Y, and Y hasn't been taught.

- **Signal**: `! introduces [[X]], which needs [[Y]]: not taught before`; `needs: Y !` in a `lesson` query.
  Only works where concept notes have `requires`. If they don't, say the check was skipped.
- **Read**: the sections that introduce X. Look for whether they explain Y along the way.
- **Judge**: real if the explanation of X assumes Y. Fine if the section teaches enough Y itself. Then
  the lesson should also `introduce` Y (graph gap).
- **Fix**: teach Y before (earlier lesson or an earlier Part), or add Y to this lesson with its own
  explanation.

## 3. Broken prerequisite chain

The lesson order and the `requires` links disagree.

- **Signal**: `! requires Lx, which comes later`; `! requires [[…]], which is not a lesson in this course`;
  `! uses [[X]] from Lk, which is not in its requires chain`.
- **Read**: nothing at first; it's the graph. If a lesson depends on another it doesn't require, read the
  sections that use X to confirm the dependency.
- **Judge**: a forward `requires` is always wrong. An unrequired dependency is real only if a learner could
  skip the earlier lesson (groups, catch-up paths) and get stuck.
- **Fix**: correct `requires` (graph), or reorder lessons, or make the dependency explicit in the lesson
  ("you need L4's upload endpoint").

## 4. Overload / difficulty spike

Too many new ideas in one sitting, or a sudden jump after an easy lesson.

- **Signal**: `! introduces N concepts (course median M): check the load`; in a `course` query, a lesson
  whose `new` count is much higher than the one before.
- **Read**: the timed Part headings of the lesson (the `(N min)` in each `##`): which new concepts
  share a Part, and how long each gets.
- **Judge**: real if several unrelated new concepts share one Part, or a concept central to the objectives
  gets under ~10 minutes. Fine if many of the "concepts" are tools named in passing, or the lesson is an
  intro/tour by design (the course README says so).
- **Fix**: split the lesson, move one concept to the lesson before or after, or mark the lighter ones
  as "just be aware of this" in the text and drop them from `introduces`.

## 5. No reinforcement

A concept is taught once and never practised again, so it won't stick.

- **Signal**: `! introduced once, never used again: [[X]] (…, needed by [[Y]])` in a `course` query;
  `used again: never` in a `lesson` query; a `concept` query with one lesson. Check `named but not
  linked` first: often later lessons do use X and just don't link it.
- **Read**: nothing, unless the concept is central. Then read the homework and later Verify sections
  where X would naturally come back.
- **Judge**: matters for concepts other concepts need, concepts named in objectives or the README's
  spine. A tool mentioned once (a specific service, one library) is fine as a one-off.
- **Fix**: bring X back in a later lesson's Verify step or homework, or a review question. If it is
  already used, link it (`uses`).

## 6. Taught twice

Two lessons both teach the same concept from scratch, wasting time or contradicting each other.

- **Signal**: `! introduces [[X]] again (first taught in Lk)`; a `concept` query saying `(taught twice)`.
- **Read**: the sections that introduce X in both lessons.
- **Judge**: real if the second lesson re-explains from zero, or explains it differently. Fine if the
  second is a deliberate deeper pass: then it should `use` X and build on it, and say so.
- **Fix**: turn the second explanation into a short recap with a `[[link]]` to the first lesson, and
  move X to `uses` there.

## 7. Objectives not practised or verified

An objective promises something the lesson never has the learner do or check.

- **Signal**: always run for a lesson entry point. Use the `objectives` list from the `lesson` query.
- **Read**: the lesson's `##` headings, then the Parts that match each objective, the Verify part and
  the Homework. Map each objective → the Part where learners do it → where they check it.
- **Judge**: real if an objective has no Part where the learner does it, or nothing checks it. Also flag
  a Part that serves no objective (scope creep), and vague objectives ("understand X", "know Y").
- **Fix**: add a step or verify item, rewrite the objective to what the lesson really achieves, or cut
  the Part.

## 8. Spine habit missing

The course README defines habits every lesson practises (its "spine"). A lesson that skips one weakens
the whole course.

- **Signal**: always run for a lesson entry point.
- **Read**: the course README's spine section (once per session), then the lesson's headings and the
  Parts where the habit should show up (e.g. the Verify part for "build → run → verify", the Parts that
  add config for "secrets in the environment").
- **Judge**: real if the lesson has a natural place for the habit and doesn't use it. Not every habit
  fits every lesson: don't flag "TypeScript everywhere" in a backend lesson.
- **Fix**: name the Part and what to add (a verify step with normal/empty/weird input, a sentence tying
  back to the habit).

## 9. Through-line break

The course builds one project, but a lesson doesn't move it forward, or relies on a feature built later.

- **Signal**: `! doesn't build [[Project]]`; `through-line … continues in:` in an `impact` query.
- **Read**: the lesson's Goal line and its "what you'll build" or first build Part.
- **Judge**: fine for intros, outros and pure-concept lessons if the README plans them. Real if the
  lesson builds a side project that never joins the main one, or starts from code the project doesn't
  have yet.
- **Fix**: tie the lesson's build step to the project, or set `builds` if it already does (graph gap).

## 10. Definition drift

The concept note and the lesson that teaches it don't say the same thing.

- **Signal**: run for concepts a lesson introduces, or for the concept entry point.
- **Read**: the concept note's `definition` (in the query output) and the paragraph in the introducing
  section (`mentioned in:`) that first explains it.
- **Judge**: real if they disagree, or the lesson's explanation is wrong or much narrower. Different
  wording is fine.
- **Fix**: correct the lesson, or the concept note's `definition` if the lesson is the better
  explanation (the note is vault-only, so that's the cheaper fix).

## 11. Change ripple

An edit to one lesson breaks something that relied on it.

- **Signal**: the `impact` query: lessons that require it, later lessons that use its concepts (with the
  sections), group copies, other courses sharing its concepts. What changed: ask the human, or compare
  with the group or conflict copy if there is one. Don't guess from the note alone.
- **Read**: the changed sections of the edited lesson, then in each dependent lesson only the sections
  listed under the changed concepts.
- **Judge**: real if a later lesson refers to something that no longer exists or now works differently
  (a renamed endpoint, a removed step, a changed file name), or the edit removed the explanation of a
  concept later lessons use.
- **Fix**: list each dependent section with the line that needs updating. For group copies, say whether
  the change should reach them (the plan's `Scope:` line).

## 12. Group fix not in core

A group's copy fixed a problem that the core lesson (and every other group) still has.

- **Signal**: group copies in a `lesson` or `impact` query; the `<Group> – Drift` canvas shows what differs.
- **Read**: the sections the Drift canvas lists as changed, in both copies.
- **Judge**: a fix (a correction, a clearer explanation, a missing step) belongs in core. A local
  adaptation (the group's pace, examples, language) doesn't.
- **Fix**: propose a feedback plan with `Scope: group and core` for the fix.
