import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import _board


class TestLoadConfig(unittest.TestCase):
    def test_reads_ids_from_reference_file(self):
        cfg = _board.load_config()
        self.assertEqual(cfg["owner"], "TDHydra")
        self.assertEqual(cfg["project_number"], 2)
        self.assertEqual(cfg["repo_id"], "R_kgDOTHELWA")
        self.assertEqual(cfg["status_options"]["Done"], "98236657")

    def test_missing_file_raises_boarderror(self):
        with self.assertRaises(_board.BoardError):
            _board.load_config("/nonexistent/board.md")


class FakeCompleted:
    def __init__(self, returncode=0, stdout="{}", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestGql(unittest.TestCase):
    def test_never_uses_dash_F(self):
        """-F coerces numeric option ids to Int and breaks String! variables."""
        seen = {}

        def runner(cmd, **kwargs):
            seen["cmd"] = cmd
            return FakeCompleted(stdout='{"data":{"ok":true}}')

        _board.gql("mutation($opt:String!){x}", {"opt": "98236657"}, runner=runner)
        self.assertNotIn("-F", seen["cmd"])
        self.assertIn("-f", seen["cmd"])
        self.assertIn("opt=98236657", seen["cmd"])

    def test_graphql_errors_raise(self):
        def runner(cmd, **kwargs):
            return FakeCompleted(stdout='{"errors":[{"message":"boom"}]}')

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        self.assertIn("boom", str(ctx.exception))

    def test_nonzero_exit_with_missing_scope_emits_remediation(self):
        """Scope-detection branch: stderr mentions 'project' + 'scope' -> remediation hint."""
        def runner(cmd, **kwargs):
            return FakeCompleted(returncode=1, stdout="", stderr="missing scope: project")

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        self.assertIn("gh auth refresh -s project,read:project", str(ctx.exception))

    def test_nonzero_exit_generic_failure_has_no_remediation_hint(self):
        """Generic (non-scope) failures should surface stderr but not the scope remediation text."""
        def runner(cmd, **kwargs):
            return FakeCompleted(returncode=1, stdout="", stderr="some other gh failure: rate limited")

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        message = str(ctx.exception)
        self.assertIn("rate limited", message)
        self.assertNotIn("gh auth refresh -s project,read:project", message)

    def test_missing_gh_binary_raises_boarderror(self):
        """A runner that can't find the gh binary must surface as BoardError, not a raw traceback."""
        def runner(cmd, **kwargs):
            raise FileNotFoundError(2, "No such file or directory", "gh")

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        message = str(ctx.exception).lower()
        self.assertIn("gh", message)
        self.assertTrue("not installed" in message or "not found" in message or "not on path" in message)


CFG = {
    "owner": "TDHydra",
    "project_number": 2,
    "status_options": {
        "Backlog": "f75ad846",
        "In progress": "47fc9ee4",
        "Done": "98236657",
        "Rejected": "5da22600",
    },
}

ITEMS = [
    {"id": "PVTI_aaa", "title": "Pin MinIO to the RUNNING version",
     "status": "Ready", "content": {"type": "DraftIssue"}},
    {"id": "PVTI_bbb", "title": "Componentization Wave 2",
     "status": "Backlog", "content": {"type": "Issue", "number": 42}},
    {"id": "PVTI_ccc", "title": "Componentize the app",
     "status": "Backlog", "content": {"type": "DraftIssue"}},
]


class TestResolveStatus(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(_board.resolve_status(CFG, "Done"), ("Done", "98236657"))

    def test_case_insensitive(self):
        self.assertEqual(_board.resolve_status(CFG, "in progress"),
                         ("In progress", "47fc9ee4"))

    def test_unknown_lists_valid_columns(self):
        with self.assertRaises(_board.BoardError) as ctx:
            _board.resolve_status(CFG, "Finished")
        self.assertIn("Backlog", str(ctx.exception))
        self.assertIn("Finished", str(ctx.exception))


class TestSelectItem(unittest.TestCase):
    def test_by_item_id(self):
        self.assertEqual(_board.select_item(ITEMS, "PVTI_bbb")["title"],
                         "Componentization Wave 2")

    def test_by_issue_number(self):
        self.assertEqual(_board.select_item(ITEMS, "#42")["id"], "PVTI_bbb")
        self.assertEqual(_board.select_item(ITEMS, "42")["id"], "PVTI_bbb")

    def test_by_unique_title_substring(self):
        self.assertEqual(_board.select_item(ITEMS, "minio")["id"], "PVTI_aaa")

    def test_ambiguous_substring_raises_and_lists_matches(self):
        with self.assertRaises(_board.BoardError) as ctx:
            _board.select_item(ITEMS, "componentiz")
        msg = str(ctx.exception)
        self.assertIn("Componentization Wave 2", msg)
        self.assertIn("Componentize the app", msg)

    def test_no_match_raises(self):
        with self.assertRaises(_board.BoardError):
            _board.select_item(ITEMS, "nonexistent thing")


if __name__ == "__main__":
    unittest.main()
