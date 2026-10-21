"""lessons.py: what changed since a pull, sent once, sent again after a new change, and the Stop hook.

  python3 -m unittest discover -s obsidian-plugin/claude-connector/tests
"""

import importlib
import json
import os
import sys
import tempfile
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts")
LESSON = "Chalkenso/My courses/Curriculums/Web – 2026/Lesson 1 - Sessions.md"


class LessonsTest(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp()
        os.environ["CHALKENSO_VAULT"] = self.vault
        sys.path.insert(0, SCRIPTS)
        import lessons
        self.lessons = importlib.reload(lessons)
        self.write("lesson-1", 3, "## Sessions\n\nA cookie names the session.\n")
        self.lessons.record(LESSON, "lesson-1", 3)

    def tearDown(self):
        sys.path.remove(SCRIPTS)
        del os.environ["CHALKENSO_VAULT"]

    def write(self, lesson_id, revision, body, extra=""):
        path = os.path.join(self.vault, LESSON)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"---\nlessonId: {lesson_id}\nrevision: {revision}\ntitle: Sessions\n{extra}---\n\n{body}")

    def test_as_pulled_nothing_to_send(self):
        self.assertEqual(self.lessons.changed(), [])
        self.assertTrue(self.lessons.check(LESSON).startswith("synced"))
        with open(os.path.join(self.vault, ".chalkenso", "base", "lesson-1.md"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "## Sessions\n\nA cookie names the session.\n")

    def test_a_property_change_is_not_a_revision(self):
        self.write("lesson-1", 3, "## Sessions\n\nA cookie names the session.\n", "objectives:\n  - Explain sessions\n")
        self.assertEqual(self.lessons.changed(), [])

    def test_changed_sent_once_then_again_after_a_new_change(self):
        self.write("lesson-1", 3, "## Sessions\n\nA cookie names the session; the server keeps the rest.\n")
        waiting = self.lessons.changed()
        self.assertEqual([(e["lesson_id"], e["based_on_revision"]) for e in waiting], [("lesson-1", 3)])
        self.assertEqual(waiting[0]["base"], ".chalkenso/base/lesson-1.md")
        self.assertTrue(self.lessons.check(LESSON).startswith("pending"))
        self.lessons.sent("lesson-1")
        self.assertEqual(self.lessons.changed(), [])
        self.write("lesson-1", 3, "## Sessions\n\nA cookie names the session. Check it in DevTools.\n")
        self.assertEqual(len(self.lessons.changed()), 1)

    def test_sync_state_answers_like_the_plugin_kit(self):
        import sync_state
        sync_state = importlib.reload(sync_state)
        self.assertEqual(sync_state.state(os.path.join(self.vault, LESSON)), "synced")
        self.write("lesson-1", 3, "## Sessions\n\nChanged.\n")
        self.assertEqual(sync_state.state(os.path.join(self.vault, LESSON)), "pending")
        other = os.path.join(self.vault, "Chalkenso/My courses/Curriculums/Web – 2026/Lesson 2 - New.md")
        with open(other, "w", encoding="utf-8") as handle:
            handle.write("## New\n")
        self.assertEqual(sync_state.state(other), "not-synced")

    def test_a_moved_note_is_found_by_its_lesson_id(self):
        self.write("lesson-1", 3, "## Sessions\n\nChanged.\n")
        moved = os.path.join(self.vault, "Chalkenso/My courses/Curriculums/Web – 2026/Lesson 1 - Session cookies.md")
        os.rename(os.path.join(self.vault, LESSON), moved)
        self.assertEqual(self.lessons.changed()[0]["note"], os.path.relpath(moved, self.vault))

    def test_stop_hook_asks_once(self):
        self.assertIsNone(self.lessons.stop("{}"))
        self.write("lesson-1", 3, "## Sessions\n\nChanged.\n")
        decision = self.lessons.stop(json.dumps({"stop_hook_active": False}))
        self.assertEqual(decision["decision"], "block")
        self.assertIn("send-revisions", decision["reason"])
        self.assertIn(LESSON, decision["reason"])
        self.assertIsNone(self.lessons.stop(json.dumps({"stop_hook_active": True})))
        # Input it can't read counts as a first stop: it still asks.
        self.assertEqual(self.lessons.stop("not json")["decision"], "block")


if __name__ == "__main__":
    unittest.main()
