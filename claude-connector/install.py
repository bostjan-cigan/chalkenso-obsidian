#!/usr/bin/env python3
"""Install the Claude Code kit for working with Chalkenso through the connector into an Obsidian vault.

  python3 install.py "<vault>"                   install, or update after pulling a new version
  python3 install.py "<vault>" --update-bases    also replace the Bases in Curriculum Knowledge/

For the cloud (chalkenso.com), where Claude Code reaches Chalkenso through the connector and every
change goes back as a draft to review. A vault that uses the Chalkenso plugin's sync uses the plugin
kit instead (`claude/install.py`).

What goes where (the plugin kit's skills, scripts and knowledge, with this kit's on top):

  skills/*                  -> <vault>/.claude/skills/        replaced (they are the kit's)
  scripts/*.py              -> <vault>/.claude/scripts/       replaced
  settings.json             -> <vault>/.claude/settings.json  its allow rules and Stop hook are added to yours
  vault-instructions.md     -> <vault>/AGENTS.md              replaced; a changed one is kept as AGENTS.md.bak
  knowledge/*               -> <vault>/Curriculum Knowledge/  only what is missing (Bases with --update-bases)

Nothing else in the vault is touched, and no lesson is read or changed.
"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_KIT = os.path.join(HERE, "..", "claude")
KNOWLEDGE = "Curriculum Knowledge"
ROOT = "Chalkenso"
# The plugin kit's sync_state.py reads the plugin's sync state; this kit has its own.
REPLACED_SCRIPTS = {"sync_state.py"}


def copy_skills(claude):
    names = []
    for kit in (PLUGIN_KIT, HERE):
        for name in sorted(d for d in os.listdir(os.path.join(kit, "skills")) if not d.startswith(".")):
            target = os.path.join(claude, "skills", name)
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(os.path.join(kit, "skills", name), target, ignore=shutil.ignore_patterns(".*"))
            if name not in names:
                names.append(name)
    return sorted(names)


def copy_scripts(claude):
    names = []
    for kit, skip in ((PLUGIN_KIT, REPLACED_SCRIPTS), (HERE, set())):
        for name in sorted(f for f in os.listdir(os.path.join(kit, "scripts")) if f.endswith(".py") and f not in skip):
            shutil.copy2(os.path.join(kit, "scripts", name), os.path.join(claude, "scripts", name))
            names.append(name)
    return sorted(set(names))


def merge_settings(path, ours):
    """Adds our allow rules and our Stop hook to the vault's settings, keeping everything else."""
    try:
        with open(path, encoding="utf-8") as handle:
            settings = json.load(handle)
    except FileNotFoundError:
        settings = {}
    allow = settings.setdefault("permissions", {}).setdefault("allow", [])
    added = [rule for rule in ours["permissions"]["allow"] if rule not in allow]
    allow += added
    stops = settings.setdefault("hooks", {}).setdefault("Stop", [])
    ours_stop = ours["hooks"]["Stop"][0]
    command = ours_stop["hooks"][0]["command"]
    has_hook = any(hook.get("command") == command for group in stops for hook in group.get("hooks", []))
    if not has_hook:
        stops.append(ours_stop)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return added, not has_hook


def write_agents(vault):
    with open(os.path.join(HERE, "vault-instructions.md"), encoding="utf-8") as handle:
        instructions = handle.read()
    agents = os.path.join(vault, "AGENTS.md")
    if os.path.exists(agents):
        with open(agents, encoding="utf-8") as handle:
            current = handle.read()
        if current != instructions:
            shutil.copy2(agents, agents + ".bak")
            print("          AGENTS.md had other text: kept as AGENTS.md.bak")
    with open(agents, "w", encoding="utf-8") as handle:
        handle.write(instructions)


def copy_knowledge(vault, update_bases):
    written, kept = [], 0
    source = os.path.join(PLUGIN_KIT, "knowledge")
    for folder, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            rel = os.path.relpath(os.path.join(folder, name), source)
            target = os.path.join(vault, KNOWLEDGE, rel)
            if os.path.exists(target) and not (name.endswith(".base") and update_bases):
                kept += 1
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(folder, name), target)
            written.append(rel)
    for sub in ("Concepts", "Through-lines", "_Audits", "Canvases"):
        os.makedirs(os.path.join(vault, KNOWLEDGE, sub), exist_ok=True)
    return written, kept


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    update_bases = "--update-bases" in sys.argv[1:]
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    vault = os.path.abspath(os.path.expanduser(args[0]))
    if not os.path.isdir(os.path.join(vault, ".obsidian")):
        sys.exit(f"{vault} is not an Obsidian vault (no .obsidian folder). Open it in Obsidian once first.")
    if os.path.isdir(os.path.join(vault, ".obsidian", "plugins", "chalkenso")):
        sys.exit("This vault has the Chalkenso plugin: it syncs lessons itself. Use the plugin kit instead"
                 " (claude/install.py), or remove the plugin to work through the connector.")
    claude = os.path.join(vault, ".claude")
    os.makedirs(os.path.join(claude, "skills"), exist_ok=True)
    os.makedirs(os.path.join(claude, "scripts"), exist_ok=True)
    os.makedirs(os.path.join(vault, ROOT), exist_ok=True)

    print(f"skills    .claude/skills/: {', '.join(copy_skills(claude))}")
    print(f"scripts   .claude/scripts/: {', '.join(copy_scripts(claude))}")
    with open(os.path.join(HERE, "settings.json"), encoding="utf-8") as handle:
        added, hooked = merge_settings(os.path.join(claude, "settings.json"), json.load(handle))
    print(f"settings  .claude/settings.json: {len(added)} allow rule(s) added"
          f"{', the Stop hook added' if hooked else ''}")
    write_agents(vault)
    print("agents    AGENTS.md")
    written, kept = copy_knowledge(vault, update_bases)
    print(f"knowledge {KNOWLEDGE}/: {len(written)} written, {kept} already there (kept)")

    if os.path.exists(os.path.join(vault, "CLAUDE.md")):
        print("\nThis vault also has a CLAUDE.md. If it holds older instructions for these courses, remove it"
              " so it can't contradict AGENTS.md.")
    print(f"\nDone. Next, in {vault}:\n"
          "  1. Connect Claude Code to Chalkenso once: claude mcp add --transport http chalkenso https://chalkenso.com/mcp,"
          " then /mcp to sign in.\n"
          "  2. Open Claude Code here and trust the folder (that turns on the Stop hook, which runs"
          " .claude/scripts/lessons.py stop: it only reads what changed).\n"
          "  3. Ask it to pull a course (pull-course).")


if __name__ == "__main__":
    main()
