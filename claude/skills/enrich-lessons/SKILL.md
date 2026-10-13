---
name: enrich-lessons
description: Fill in vault-only lesson properties (objectives, introduces, uses, requires, builds, duration), concept prerequisites (concept `requires`), and create missing concept notes. Use when the user asks to add metadata, tag lessons with concepts, migrate `concepts` to introduces/uses, or bootstrap or repair the knowledge graph.
---

# Enrich lessons

Add knowledge-graph properties to lessons that lack them, or repair the ones that are wrong. This changes
frontmatter only, never the lesson body. The graph is what `curriculum-check` relies on, so it must
say where each concept is **taught** and where it is only **used**.

## Input

A course folder, a group folder, or specific lessons. Default: the lessons in
`Curriculum Knowledge/Curriculum.base` view *Needs metadata* for the course the user names.

## Steps

1. **Check sync state first** for every note in scope:
   `python3 .claude/scripts/sync_state.py check <notes…>`. Remember which were `synced`.
2. **Read** the course README and the existing concept notes in `Curriculum Knowledge/Concepts/`
   (names, aliases, `requires`), so you reuse concept names instead of making near-duplicates. For
   each lesson, run `python3 .claude/scripts/graph.py lesson "<lesson>"` first: its *named but not
   linked* list is the starting set of candidates for `uses`, and *mentioned in* tells you which
   sections to read to see whether a concept is taught there or only used.
3. **Propose, per lesson**:
   - `objectives`: 2–5 items, each starting with a verb ("Build…", "Explain…", "Deploy…"), each
     backed by the lesson body;
   - `introduces`: concepts this lesson explains for the first time (usually 2–6). Each concept is
     introduced by **one** lesson per course, the one where the explanation actually is;
   - `uses`: concepts the lesson relies on but doesn't teach: taught in an earlier lesson or in another
     course. Only real reliance (the learner must know it here), not every word that appears.
     A `uses` entry that is taught *later* is a finding, not a property: report it (it's
     `curriculum-check` check 1) and don't hide it by moving the concept to `introduces`;
   - one note per concept with `aliases` for other names (e.g. "Docker Compose" as an alias of
     `[[Docker Compose]]`, not of `[[Docker]]`);
   - a lesson that still has `concepts`: replace it with `introduces` / `uses` and remove `concepts`;
   - `requires`: the earlier lessons this one directly builds on (not every earlier lesson);
   - `builds`: the through-line project, when the course README names one;
   - `duration`: only when the README or lesson states it.
   - concept notes: `requires` lists the concepts a learner must understand first (CSRF → Session
     cookies). Only real prerequisites, not "related". Propose it for the concepts in scope.
4. **Show the proposal** as one table per course (lesson | objectives | introduces | uses | requires),
   a table of concept prerequisites (concept | requires), and the list of new concept notes. Wait for
   the user to approve or edit it. Don't write before that.
5. **Write**:
   - add or replace only these properties; keep every other key and the body byte-for-byte;
   - create new concept notes from `Curriculum Knowledge/_Templates/Concept.md` (replace
     `{{title}}`, fill `definition` with one sentence), and set `requires` on concept notes (they are
     outside the course folders, so no sync step);
   - then run `python3 .claude/scripts/sync_state.py touch <notes…>` for the notes that were
     `synced` in step 1, so they don't show as edited. Leave the others alone.
6. **Report** what changed, and list the notes that were already `pending` (they have unuploaded
   edits of the human's own). Run `python3 .claude/scripts/graph.py course "<course>"` and include the
   flags it now shows: with the graph complete, those are real findings.

## Rules

- Follow `AGENTS.md`. Frontmatter only: if you see a body problem, mention it; don't fix it.
- Write lists as YAML lists, links quoted: `introduces: ["[[Docker]]", "[[REST API]]"]`.
