# Curriculum workspace

This Obsidian vault holds courses that sync with Chalkenso through the Chalkenso plugin
(`.obsidian/plugins/chalkenso`). Work **only** in these folders:

- `<root>/<Organisation>/Curriculums/<Course> – <Version>/`: core curricula, one folder per course
  version, one note per lesson (lessons may sit in their own subfolder with their images)
- `<root>/<Organisation>/Groups/<Course> – <Group>/`: a group's own copy of a curriculum
- `Curriculum Knowledge/`: concepts, through-line projects, templates, Bases, canvases, audits
- `.obsidian/graph.json`: only its colour groups and arrows, and only through
  `python3 .claude/scripts/graph_colors.py` (one colour per course, concepts, through-lines, groups).
  Run it after a course folder is added or renamed, and remind the human to reload Obsidian.

`<root>` is the plugin's root folder (Settings → Chalkenso → Root folder, `Chalkenso` by default),
with one folder per organisation. Folders may have been renamed or moved: the scripts find them
through the plugin's settings, so ask them (`graph.py course "<name>"`) instead of guessing paths.
Folders ending in ` (dev)` sync with a development server. Leave `Groups/_detached/` alone: it
holds what was left of closed groups.

Don't read, list or change anything else in the vault, and never read the plugin's `data.json`
yourself (it holds sync tokens; the scripts read only its folder paths).

The plugin's README (`obsidian-plugin/README.md` in the Chalkenso repository) explains every
property and folder below.

## How the curriculum is stored

- Every `.md` file inside a course or group folder is a lesson, except that folder's `README.md` and
  the plugin's folders `_feedback/`, `_feedback-dev/`, `_conflicts/` and `_attachments/`. **Never
  create other notes inside course or group folders**: they would be uploaded as lessons. Put them
  in `Curriculum Knowledge/`.
- The lesson body is what learners read. Frontmatter is never uploaded.
- A core folder's `README.md`, when there is one, holds the course's idea, arcs and "spine" (habits
  every lesson practises). Read it before changing a lesson and follow its style and lesson length.
  A group folder's `README.md` is written by the plugin: never edit it, and read the core folder's
  README instead.
- In Chalkenso, `[[Other lesson]]` in a lesson body becomes a link to that lesson (same version, by
  title or slug). Links to concept notes show as plain text, so they are safe to use in a body.
  `> [!note]`-style callouts render as in Obsidian.

## Properties

**Yours to edit** (vault-only):

| Property | Meaning |
|---|---|
| `objectives` | List: what a learner can do after the lesson. Start with a verb. 2–5 items |
| `introduces` | List of links to `Curriculum Knowledge/Concepts/` notes this lesson teaches (explains for the first time) |
| `uses` | List of links to concept notes this lesson relies on but doesn't teach (taught earlier, or in another course) |
| `requires` | List of links to lessons that must come before this one |
| `builds` | Link to the through-line project (e.g. `[[Recipe Keeper]]`) |
| `duration` | Minutes |
| `arc`, `title`, `shortDescription`, `status` | Uploaded as lesson settings; change only when a plan says so. `arc` must match an arc in Chalkenso |

**Plugin-owned, never edit:** `lessonId`, `slug` (once set), `lessonStatus`, `revision`,
`lastSynced`, `syncStatus`, `feedback`, `coreLesson`, every `dev*` variant of these, and
`conflictOf` / `server*` in `_conflicts/` notes. The only exception is the `touch` step below.
`sync: false` (the note never syncs) is the human's switch: leave it as it is.

Lessons that still have the older `concepts` list are read as: the first lesson in the course to list a
concept introduces it. Replace `concepts` with `introduces` / `uses` when you next touch a lesson's properties.

Concept notes (`Curriculum Knowledge/Concepts/`) have `definition`, `aliases` and `requires`: the concepts
a learner must know first (CSRF requires Session cookies). Only real prerequisites, not related topics.

## Sync safety

- **You never upload, download or pull.** The human runs the plugin's commands.
- Before changing a lesson, run `python3 .claude/scripts/sync_state.py check "<note>"`.
  - `pending` means the human has local edits that are not uploaded yet. That's fine for body edits
    they asked for, but say so in your summary.
  - If the lesson has a copy in `_conflicts/`, stop and tell the human. Don't resolve conflicts.
- **Property-only edits** (you changed only your own properties, not the body): if the note was
  `synced` before your edit, run `python3 .claude/scripts/sync_state.py touch "<note>"` afterwards,
  so the note doesn't show as edited. Never `touch` after a body edit, and never `touch` a note that
  was `pending` before.

## Feedback and plans

All of a lesson's feedback reaches the vault as one feedback note: `_feedback/Feedback - <lesson>.md`
(or `_feedback-dev/`), in three sections:

- **Open**: feedback nobody has used yet, each with a hidden `%%feedback:<id>%%` marker and a
  `Reply:` line. Ticked `[x]`, it's answered with that reply and done in Chalkenso.
- **Improvement**: the lesson's open improvement (and a revision brief), each with a hidden
  `%%task:<id>%%` marker and a `#### Plan %%plan:<id>:<hash>%%` heading. The plan under that heading
  is sent to Chalkenso and is **the source of truth** for what changes, in the group copy and in
  core. A plan sent also uses the open feedback that isn't ticked: it joins the improvement. With no
  improvement yet, the heading is `%%plan:new:…%%`, and a plan there starts one. One started in the app says
  *Started in Chalkenso*: working on it here takes it over, so plan and apply it like any other.
- **Done**: what's finished, folded. Read it for history; never edit it.

- Write only the text under `#### Plan` headings, after `Reply:`, and the checkboxes (`[x]` done,
  `[-]` skip, for improvements).
- Never change or remove `%%feedback:…%%`, `%%task:…%%` or `%%plan:…%%` markers, the quotes, or
  anything else in the note. The plugin rewrites the rest on every pull.
- Each plan ends with one scope line: `Scope: group only` or `Scope: group and core` (`Scope: core`
  for a core lesson).

### Items cleared for you (`#ai/ready`)

An item's checkbox line may carry `#ai/ready`, and the note's frontmatter counts the open ones as
`aiReady`. The tag comes from Chalkenso: someone there ticked *Ready for the AI agent*, so that item
may be carried out by you end to end.

- **Tagged:** apply the plan yourself — edit the lesson, then tick `[x]`. No need to ask first.
- **Untagged (the default):** assist only. Write or refine the plan, and leave the lesson body to
  the human unless they ask for that item by name.
- A lesson can hold both kinds at once. Working on your own, edit the lesson for the tagged items
  only and list the rest for the human.
- Never add, move or remove the tag: Chalkenso owns it, and the plugin rewrites that line on every
  pull. Ticking an item clears the flag in Chalkenso, so a reopened task has to be cleared again.

## Core and group copies

- A group folder's lessons are copies of core lessons. `coreLesson` links a group note to its core
  note (when the core folder is synced too). Without it, match by `slug`, then by title.
- Feedback from a group changes the group copy. Change the core note too only when the plan's scope
  says `group and core`.

## Writing style

- Lessons follow their course README. Keep headings, lesson length and the "build → run → verify"
  habit.
- Keep the lesson's language as it is. Never translate.

## Skills

`plan-feedback`, `apply-plan`, `curriculum-check`, `curriculum-audit` and `enrich-lessons` are in
`.claude/skills/`.

The knowledge graph is your index: before reading lessons to answer a question about one lesson, concept
or change, ask `python3 .claude/scripts/graph.py` (`lesson`, `concept`, `course`, `impact`, `pending`)
and read only the sections it points to. Until lessons have `introduces` / `uses`, the graph knows
little: offer `enrich-lessons` first.

After changing lessons, their properties or feedback plans, rebuild the canvases with
`python3 .claude/scripts/build_canvases.py` (read-only for lessons; writes `Curriculum Knowledge/Canvases/`).
`Curriculum Knowledge/README.md` explains the vault layout to humans.
