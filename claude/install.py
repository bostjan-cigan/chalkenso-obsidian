#!/usr/bin/env python3
"""Install the Claude Code kit for the Chalkenso plugin into an Obsidian vault.

  python3 install.py "<vault>"                   install, or update after pulling a new version
  python3 install.py "<vault>" --update-bases    also replace the Bases in Curriculum Knowledge/

What goes where:

  skills/*                  -> <vault>/.claude/skills/        replaced (they are the kit's)
  scripts/*.py              -> <vault>/.claude/scripts/       replaced
  settings.json             -> <vault>/.claude/settings.json  its allow rules are added to yours
  vault-instructions.md     -> <vault>/AGENTS.md              replaced; a changed one is kept as AGENTS.md.bak
  knowledge/*               -> <vault>/Curriculum Knowledge/  only what is missing (Bases with --update-bases)

The Bases name the plugin's root folder; they get the one set in the plugin (Settings → Chalkenso →
Root folder). Nothing else in the vault is touched, and no lesson is read or changed.
"""

import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KNOWLEDGE = "Curriculum Knowledge"
DEFAULT_ROOT = "Chalkenso"


def plugin_root(vault):
    """The plugin's root folder (only that setting is read: the file also holds sync tokens)."""
    try:
        with open(os.path.join(vault, ".obsidian", "plugins", "chalkenso", "data.json"), encoding="utf-8") as handle:
            root = (json.load(handle).get("general") or {}).get("rootFolder")
    except (OSError, ValueError):
        root = None
    return (root or DEFAULT_ROOT).strip("/")


def adapt_base(text, root):
    """`Chalkenso/<Organisation>/<Curriculums|Groups>/<course>/…` with another root folder."""
    depth = len(root.split("/"))
    text = text.replace('file.inFolder("Chalkenso")', f"file.inFolder({json.dumps(root)})")
    return re.sub(r'file\.path\.split\("/"\)\[(\d)\]',
                  lambda m: f'file.path.split("/")[{int(m.group(1)) - 1 + depth}]', text)


def merge_settings(path, ours):
    try:
        with open(path, encoding="utf-8") as handle:
            settings = json.load(handle)
    except FileNotFoundError:
        settings = {}
    allow = settings.setdefault("permissions", {}).setdefault("allow", [])
    added = [rule for rule in ours["permissions"]["allow"] if rule not in allow]
    allow += added
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return added


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    update_bases = "--update-bases" in sys.argv[1:]
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    vault = os.path.abspath(os.path.expanduser(args[0]))
    if not os.path.isdir(os.path.join(vault, ".obsidian")):
        sys.exit(f"{vault} is not an Obsidian vault (no .obsidian folder). Open it in Obsidian once first.")
    root = plugin_root(vault)
    claude = os.path.join(vault, ".claude")
    os.makedirs(os.path.join(claude, "skills"), exist_ok=True)
    os.makedirs(os.path.join(claude, "scripts"), exist_ok=True)

    skills = sorted(d for d in os.listdir(os.path.join(HERE, "skills")) if not d.startswith("."))
    for name in skills:
        target = os.path.join(claude, "skills", name)
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(os.path.join(HERE, "skills", name), target, ignore=shutil.ignore_patterns(".*"))
    print(f"skills    .claude/skills/: {', '.join(skills)}")

    scripts = sorted(f for f in os.listdir(os.path.join(HERE, "scripts")) if f.endswith(".py"))
    for name in scripts:
        shutil.copy2(os.path.join(HERE, "scripts", name), os.path.join(claude, "scripts", name))
    print(f"scripts   .claude/scripts/: {', '.join(scripts)}")

    with open(os.path.join(HERE, "settings.json"), encoding="utf-8") as handle:
        added = merge_settings(os.path.join(claude, "settings.json"), json.load(handle))
    print(f"settings  .claude/settings.json: {len(added)} allow rule(s) added")

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
    print("agents    AGENTS.md")

    written, kept = [], 0
    source = os.path.join(HERE, "knowledge")
    for folder, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            rel = os.path.relpath(os.path.join(folder, name), source)
            target = os.path.join(vault, KNOWLEDGE, rel)
            is_base = name.endswith(".base")
            if os.path.exists(target) and not (is_base and update_bases):
                kept += 1
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(os.path.join(folder, name), encoding="utf-8") as handle:
                text = handle.read()
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(adapt_base(text, root) if is_base else text)
            written.append(rel)
    for sub in ("Concepts", "Through-lines", "_Audits", "Canvases"):
        os.makedirs(os.path.join(vault, KNOWLEDGE, sub), exist_ok=True)
    print(f"knowledge {KNOWLEDGE}/: {len(written)} written, {kept} already there (kept)")

    if os.path.exists(os.path.join(vault, "CLAUDE.md")):
        print("\nThis vault also has a CLAUDE.md. If it holds older instructions for these courses, remove it"
              " so it can't contradict AGENTS.md.")
    print(f"\nDone (plugin root folder: {root}). Next: open Claude Code in {vault} and ask it to run"
          " enrich-lessons on a course, then python3 .claude/scripts/graph_colors.py and reload Obsidian.")


if __name__ == "__main__":
    main()
