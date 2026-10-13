# Chalkenso for Obsidian

Write your course curricula in Obsidian and keep them in sync with [Chalkenso](https://chalkenso.com):

- **Lessons, both ways.** Each course version (a *workspace*) and each group curriculum syncs with its
  own folder. Upload your edits; download changes made in Chalkenso. A lesson changed on both sides
  becomes a conflict you settle yourself, never a silent overwrite.
- **Arcs and images.** A lesson's `arc` property places it in its arc (missing arcs are created when
  you upload). Images in the body are uploaded once and fetched back into the vault when missing.
- **Feedback with revision plans.** Reviewer comments arrive as one checklist note per lesson, where
  you (or an assistant) write the plan for each item. Plans and ticks go back to Chalkenso.

A **sync token** (`usr_…`) acts as you in one organisation: what it may sync follows your account
there. If you belong to several organisations, add each with its own token; each gets its own folder.

> [!WARNING]
> **One plugin per folder.** If you also use another sync plugin in this vault, never let both map
> the same folder. Two plugins writing `lessonId`, `revision` and `lastSynced` into the same notes will
> overwrite each other's ids and connect the notes to the wrong server. Remove a folder's mapping in
> one plugin before mapping it in the other (see [Moving from another server](#moving-from-another-server)).

The plugin is a single `main.js` with no build step, plus `manifest.json` and `styles.css`.

## Install

The plugin lives in the `obsidian-plugin/` folder of the Chalkenso repository.

1. Create the folder `<vault>/.obsidian/plugins/chalkenso/`.
2. Copy `main.js`, `manifest.json` and `styles.css` into it (or make that folder a symbolic link to
   `obsidian-plugin/`, so updates arrive with the repository; Obsidian then keeps the plugin's
   settings, `data.json`, next to the code, and `.gitignore` keeps it out of git).
3. In Obsidian, open **Settings → Community plugins**, reload the list and enable **Chalkenso**.

## Connect

1. In Chalkenso, switch to the organisation you want (the card at the top of the sidebar), open
   **Tokens** at the bottom of the admin sidebar (`/admin/api-tokens`), give the token a name (for
   example the device it is for) and click **Create token**. Copy it: it is shown only once. A token
   works in the organisation it was made in.
2. In Obsidian, open **Settings → Chalkenso**:
   - **Connection → Server URL**: `https://chalkenso.com`, or the address of your own Chalkenso server
     (a local installation: `http://localhost:3000`, or its `NEXT_PUBLIC_APP_URL`).
   - **Organisations → Add your organisation**: paste the `usr_…` token and click **Add**.
3. Each organisation shows who its token signs in as and its folder. **Refresh** reloads it, the bin
   removes it (its folders stop syncing and stay in your vault), and pasting a new token into its
   field replaces the token. A token of another organisation is refused there: add it as another
   organisation instead. Repeat step 1–2 for every organisation you belong to.

## Folders

Everything the plugin keeps lives in one **root folder** (default `Chalkenso`; change it under
**Settings → Chalkenso → Root folder**), with one folder per organisation. Nothing outside it syncs.

```
Chalkenso/                                   [Chalkenso]
├── Northwind Academy/                       [Northwind Academy]  one folder per organisation
│   ├── Curriculums/                         [Curriculums]
│   │   └── Web Development – v3/            one folder per course version
│   │       ├── README.md                    the folder's own notes, never a lesson
│   │       ├── 01 Setup.md                  lessons (subfolders are fine)
│   │       ├── _feedback/                   feedback checklists (_feedback-dev/ in developer mode)
│   │       ├── _conflicts/                  Chalkenso's copy of lessons changed on both sides
│   │       └── _attachments/                images fetched for ![[embeds]]
│   └── Groups/                              [Groups]
│       └── Web Development – Spring 2026/   one folder per group curriculum
└── SmartNinja School/                       [SmartNinja School]
    ├── Curriculums/
    └── Groups/
```

**What to sync** in the settings lists, under each organisation's name, every course version and
group curriculum your account can reach there. Tick what you want in this vault and click **Save**:
each ticked item gets its folder in its organisation's folder (`Curriculums/<course> – <version>` or
`Groups/<course> – <group>`) and is downloaded right away, with that organisation's token. A folder
with that name that already exists is used as it is. Unticking stops syncing the folder; the folder
and its notes stay in your vault and nothing is deleted in Chalkenso.

To sync a folder you already have under a different name, run **Map folder to a curriculum
version** (or right-click the folder): pick the folder, then the version.

The tag in brackets is shown next to the folder in the file explorer. Rename or move folders in
Obsidian as you like: the plugin follows, and the tag still says what each folder is. When something
new becomes available to your account (a course version or a group), a notice says so once.

## Lesson notes and properties

Every Markdown note inside a curriculum or group folder is a lesson, except the folder's own
`README.md` and the plugin folders `_feedback/`, `_feedback-dev/`, `_conflicts/` and `_attachments/`.
The note body is the lesson text; frontmatter is never uploaded.

**Yours to write:**

| Property | Meaning |
|---|---|
| `title` | Lesson title; defaults to the file name |
| `arc` | Title of the arc the lesson belongs to (missing arcs are offered for creation on upload) |
| `slug` | Optional; set by Chalkenso on the first upload |
| `shortDescription` | Optional summary |
| `status` | `draft` or `published` (default: the **Default lesson status** setting) |
| `sync` | `false` excludes the note: it is never uploaded, overwritten or trashed |

Any other property (`objectives`, `requires`, …) is yours and stays in the vault.

**Plugin-owned, don't edit:** `lessonId`, `lessonStatus`, `revision`, `lastSynced`, `syncStatus`,
`feedback` (link to the lesson's feedback note) and, in group folders, `coreLesson` (link to the core
lesson the copy came from). In developer mode they are `devLessonId`, `devLessonStatus`,
`devRevision`, `devLastSynced`, `devSyncStatus`, `devFeedback` and `devCoreLesson`, so a dev server
never touches production ids. Downloads also keep `title`, `arc`, `slug`, `shortDescription` and
`status` in line with Chalkenso.

Feedback notes carry `lessonId` (or `devLessonId`), `lesson`, `open` and `aiReady`. Conflict copies
carry `conflictOf`, `serverRevision`, `serverUpdatedAt`, `serverTitle`, `serverArc` and
`serverStatus`.

**Links and callouts.** `[[Other lesson]]` becomes a link in Chalkenso when a lesson in the same
version has that title or slug; links to other notes show as plain text. `> [!type]` callouts,
`[!columns]`/`[!column|58]` layouts and image rows render like in Obsidian.

**What `status` means for learners.** Learners read a lesson's last *published* text. Uploading with
`status: published` publishes the note right away; with `status: draft` only the draft changes until
the lesson (or the whole version) is published in Chalkenso.

## Commands

| Command | What it does |
|---|---|
| Sync current folder / Sync all curriculum folders | Upload, then download, then pull feedback |
| Upload current folder / Upload all curriculum folders | Sends new notes and notes edited since their last sync |
| Download current folder / Download all curriculum folders | Brings Chalkenso's changes into the folder |
| Download all group curricula / Sync all group curricula | The same for every group folder (also on the `Groups` folder's right-click) |
| Upload current note | Uploads just this note |
| Show changes in current note | What an upload would change: fields and a line diff of the body, with an Upload button |
| Set arc for current note | Pick one of the version's arcs |
| Delete lesson on server | After confirming, deletes the lesson in Chalkenso; the note is kept, disconnected |
| Resolve conflict: keep my version / use server version | See [Conflicts](#conflicts) |
| Pull feedback, Upload feedback plan, Mark lesson feedback done | See [Feedback and plans](#feedback-and-plans) |
| Map folder to a curriculum version | Syncs an existing folder with one of your versions |
| Disconnect folder from its previous server | See [Moving from another server](#moving-from-another-server) |
| Toggle sync for current note, Show sync status for current note, Show recent sync problems | |

**Status bar = actions.** The item at the bottom right shows the open note's state (where it syncs,
published or draft, sync state; *Curriculum Updates · Plan* in a feedback note). Click it for every
action, grouped by what it acts on. Right-clicking a note or a folder shows the same actions. The arc
item next to it sets the lesson's arc; **Show changes** appears while the note has unsent edits.

**Explorer dots.** Green: synced. Orange: edited since the last sync. Grey: not in Chalkenso yet.
Hollow ring: sync off. Spinning ring: uploading. Red: conflict (Chalkenso's copy is in
`_conflicts/`). Hollow red ring: deleted in Chalkenso, kept because of local edits. Hollow orange
ring: edited in a read-only folder. A ring around the dot means published. A collapsed folder shows
its most urgent dot; a lock after a folder's name means read-only.

## How syncing works

Every lesson has a `revision` that goes up with each change, from the plugin or the Chalkenso
editor. A note stores the revision it was last synced at, and counts as **edited** when it changed
after its `lastSynced` time.

**Upload** sends notes without a `lessonId` (they become new lessons) and edited notes (updates,
checked against the note's `revision`). A note without a `revision` isn't uploaded; download the
folder first.

- **Lesson order.** Chalkenso adds each new lesson after the version's last one, and the plugin
  uploads a folder's notes sorted by their path, naturally: `Lesson 2/…` before `Lesson 10/…`,
  `02 Setup.md` before `10 Deploy.md`. Number your notes (or their folders) and a first upload puts
  the lessons in that order. Reorder lessons in Chalkenso afterwards.
- **Missing arcs.** When notes name arcs the version doesn't have, one dialog offers to create them,
  in the order the notes are uploaded, before any lesson is sent. Cancel uploads the other notes; the
  ones in a missing arc report "Arc … not found".
- **Changed in Chalkenso meanwhile:** a **conflict**. Chalkenso's copy goes to `_conflicts/`; nothing
  is uploaded.
- **Lesson gone from Chalkenso (404):** you're asked whether to recreate it as a new lesson, since
  someone may have deleted it on purpose.
- An upload never deletes lessons; only **Delete lesson on server** does.

**Download** (`include=content`, only bodies changed since the last download):

- **Note not edited, Chalkenso newer:** the note is replaced (text and lesson properties).
- **Note edited, Chalkenso newer:** a conflict; the note isn't touched.
- **Lesson without a note:** a new note in the folder, named after the lesson.
- **Note whose lesson is gone:** moved to Obsidian's trash if unedited, otherwise kept and marked
  `syncStatus: orphaned`. If that would trash every connected note, or at least half of them, you're
  asked first.
- **A note without a `lessonId` is never deleted or overwritten by a download.**
- **Images** the lessons use that aren't in the vault are fetched: `![[embeds]]` into `_attachments/`,
  `![](path)` links to that path. An existing file is never overwritten.

Every deletion goes to Obsidian's trash (`.trash`), never a hard delete.

## Feedback and plans

**Pull feedback** (also part of every sync) writes one note per lesson with open feedback into the
folder's `_feedback/`. Each item has a checkbox, the reviewer's comment (context only) and a
`#### Plan` section:

- Write what should change under each item's **Plan**. The note is the plan's source of truth: plans
  are sent to the task in Chalkenso on every pull and upload, and with **Upload feedback plan**. The
  status bar shows *Synced*, *Not synced*, *Uploading…* or *No plan yet* as you type.
- Tick `[x]` when an item is done or `[-]` to skip it. Ticks are sent after the lesson itself is
  uploaded, so feedback closes only once the fix is in Chalkenso.
- Hidden `%%task:…%%` and `%%plan:…%%` markers connect items to their tasks; keep them. Everything
  outside the checkboxes and plans is regenerated on each pull.

**`#ai/ready`.** An item cleared in Chalkenso for an AI assistant arrives tagged `#ai/ready` on its
checkbox line, and the note's `aiReady` property counts the open ones. Tagged items may be carried
out end to end (edit the lesson, tick the item); untagged items are assist-only (write the plan, leave
the lesson to a person). Ticking clears the flag in Chalkenso. The plugin only writes the signal;
[Claude Code](#claude-code) knows the contract once its kit is installed, and any other assistant
needs it in its own instructions. To list what is waiting:

````
```dataview
TABLE open, aiReady FROM "" WHERE aiReady > 0 SORT file.name ASC
```
````

## Conflicts

`_conflicts/<note name>.md` holds Chalkenso's version and the note shows a red dot. Then:

- **Resolve conflict: keep my version.** Your note is taken as based on Chalkenso's revision; the
  next upload replaces Chalkenso's text with yours. Merge what you need from the copy first.
- **Resolve conflict: use server version.** After confirming, your note gets Chalkenso's text.

Both move the conflict copy to the trash.

## Group curricula

A feedback-driven group gets its own copy of a course version in Chalkenso. Tick it under **What to
sync → Groups** (of its organisation) and it gets a folder `<Organisation>/Groups/<course> – <group>/`
with a `README.md`, downloaded right away. Right-click an organisation's Groups folder to download or
sync all of its group curricula. When the core version is synced too, each group note's `coreLesson` links to the core note it
came from.

When the group is closed (or you lose access), its folder is cleaned up: unedited lesson copies,
feedback notes, the plugin's README and downloaded images go to Obsidian's trash; anything else
(edited notes, notes without a `lessonId`, conflict copies, your own files) moves to
`<Organisation>/Groups/_detached/<folder>/`. Edited notes are listed for confirmation first. Only a
group's own organisation decides: what another organisation's token lists never removes a folder.

## Read-only workspaces

What you may do in each version comes from your account (`permissions` in `/api/sync/me`). Without
WRITE, a folder is download-only: upload skips it, edited notes stay local (shown as *Local edit
(read-only)*) and a newer Chalkenso copy goes to `_conflicts/`. Feedback needs READ + TASKS to pull
and WRITE + TASKS to send plans and ticks; **Delete lesson on server** needs DELETE.

## Developer mode

**Settings → Chalkenso → Developer mode** syncs with a dev server (default `http://localhost:3100`)
and the organisations added for it (each with a dev sync token). Folders ticked in developer mode get ` (dev)` appended, each mapping remembers
its server, and notes use the `dev*` properties and `_feedback-dev/`, so production ids are never
touched.

## Claude Code

`claude/` is a kit that lets [Claude Code](https://claude.com/claude-code), opened in your vault,
work on the courses with you: check them for the usual curriculum failures, plan feedback, and carry
out plans you approved. It never uploads; you run the plugin's commands. It needs Python 3.8 or later.

```bash
python3 obsidian-plugin/claude/install.py "<path to your vault>"
```

| What | Where it goes |
|---|---|
| Skills: `plan-feedback`, `apply-plan`, `curriculum-check`, `curriculum-audit`, `enrich-lessons` | `.claude/skills/` |
| Scripts that read the vault as a knowledge graph (`graph.py`), draw course canvases (`build_canvases.py`), colour the graph view (`graph_colors.py`) and check a note's sync state (`sync_state.py`) | `.claude/scripts/` |
| The rules Claude follows in the vault: which folders it may touch, plugin-owned properties, sync safety, feedback markers, `#ai/ready` | `AGENTS.md` |
| Its allowed commands | added to `.claude/settings.json` |
| Bases (lessons by course, open feedback, concepts), templates for lessons and concepts, and a README for people | `Curriculum Knowledge/`, only what is missing |

Run the same command again after updating the plugin: skills, scripts and `AGENTS.md` are replaced
(an `AGENTS.md` you changed is kept as `AGENTS.md.bak`); your concept notes, canvases, audits and
Bases stay. `--update-bases` replaces the Bases too, for example after you change the root folder.

The scripts find course folders through the plugin's settings (they read only folder paths from
`data.json`, never tokens), so renamed and moved folders work. Concepts live in
`Curriculum Knowledge/Concepts/`, one note each, and lessons link them in their own properties
(`introduces`, `uses`, `requires`, `objectives`), which never sync. Start with
*"run enrich-lessons on Web Development"* (your course's name): until lessons have those properties, the graph has little to
check. `Curriculum Knowledge/README.md` in the vault explains the rest.

## Moving from another server

Notes synced with another server carry its `lessonId`, `revision` and sync stamps. Chalkenso doesn't
know those lessons, so:

- **Disconnect folder from its previous server** (command, or a folder's right-click) removes the
  plugin-owned sync properties of the active server (`lessonId`, `lessonStatus`, `revision`,
  `lastSynced`, `syncStatus`, `feedback`, `coreLesson`, or their `dev*` names in developer mode) from
  every note in the folder, after a confirmation that says how many notes change. `slug`, `title`,
  `arc`, `shortDescription`, `status`, your own properties and the text stay. The notes then upload as
  new lessons.
- The **first sync** of a folder that never synced finds such notes by itself and offers the same
  disconnect, instead of asking note by note. **Cancel** leaves the folder untouched and unsynced.
- Feedback notes from the old server are moved to Obsidian's trash by the next feedback pull; their
  tasks stay on the old server.

<!-- cloud:start -->
### Moving from Site Sync

1. **In Site Sync**, untick the curriculum and group folders under *What to sync* and save (blog and
   projects stay there). From now on only Chalkenso may map these folders.
2. **In Chalkenso**, create the course with the same slug, its version(s) and its arcs if you like
   (missing arcs are created on upload), and the groups.
3. **In this plugin**, add your organisation with its sync token, and set the root folder to the
   folder that holds your organisation's folder (for example `Website`).
4. **Move the folders into the organisation's folder** in Obsidian: curriculum folders into
   `<root>/<Organisation>/Curriculums/`, group folders into `<root>/<Organisation>/Groups/` (the
   plugin creates both once the organisation's account loads).
5. **Map each folder to its version**: tick the version under *What to sync* (a folder named
   `<course> – <version>` is reused), or run **Map folder to a curriculum version** for a folder with
   another name.
6. **Disconnect**: the first sync offers it; you can also run **Disconnect folder from its previous
   server** yourself.
7. **Upload** the folder. Missing arcs are created first, then the lessons, in the folder's order.
8. **Feedback-driven groups with no revisions yet:** delete the old local group folder and tick the
   group under *What to sync*; the plugin downloads Chalkenso's group copy fresh.
<!-- cloud:end -->

## When something goes wrong

- **Notices say what happened**, for example "Can't reach http://localhost:3100 (connection refused).
  Is the server running?" or "Not authorized (401): … Paste a new sync token (usr_…) in Settings →
  Chalkenso". Chalkenso's own messages (a duplicate slug, a missing permission) are shown as they are.
- **Every problem is recorded** with its time and note under **Settings → Chalkenso → Recent
  problems** and **Show recent sync problems**; clicking an error notice opens the list.
- **Full details** go to the developer console (Cmd+Opt+I / Ctrl+Shift+I).

## Sync API

Every request sends `Authorization: Bearer usr_…`; curriculum requests also send
`X-Curriculum-Version-Id: <version id>`. Bodies are JSON.

| Method | Path | Used for |
|---|---|---|
| GET | `/api/sync/me` | `{ user, workspaces[] }`: each workspace has `id`, `label`, `status`, `kind` (`core` / `group`), `course`, `group`, `baseVersion` and `permissions` (no version header) |
| GET | `/api/sync/curriculum[?include=content][&since=…]` | Version, arcs and lessons with `revision`; with content also `markdownContent`, `arcTitle`, `assets` (bodies only for lessons changed since `since`; `syncedAt` is the next `since`) |
| POST | `/api/sync/arcs` | `{ title }` → 201 `{ arc }`, appended last; 409 `arc_exists` with the existing arc |
| POST | `/api/sync/lessons` | Create a lesson (appended last) |
| POST | `/api/sync/lessons/batch` | `{ lessons: [{ ref, lessonId?, baseRevision?, … }] }` → per-item `results`, matched by `ref` |
| PATCH | `/api/sync/lessons/:id` | Update with `baseRevision`; 409 `{ conflict: true, server }` on a conflict, 404 when gone |
| DELETE | `/api/sync/lessons/:id` | Only from **Delete lesson on server** |
| POST | `/api/sync/assets/presign` | `{ filename, contentType, bytes, checksum, sourcePath }` → `{ reused, assetId, uploadUrl? }`; a known image is reused, a new one is PUT to `uploadUrl` |
| POST | `/api/sync/assets/:id/complete` | `{ checksum, sourcePath }` after the PUT → `{ asset }` |
| GET | `/api/sync/assets/:id/url` | Short-lived download link for an image missing from the vault |
| GET | `/api/sync/tasks` | Open feedback (items and briefs) |
| PATCH | `/api/sync/tasks/:id` | `{ status?, plan?, aiReady? }` |

Any curriculum route answers `410 { reason: "group_curriculum_closed" }` for a closed group
curriculum; the plugin then cleans up that group's folder.

## License

Part of Chalkenso's local edition: [Business Source License 1.1](../LICENSE), with a grant for
personal use. See [LICENSING.md](../LICENSING.md).
