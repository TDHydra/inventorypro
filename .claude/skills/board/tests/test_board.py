import json
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

    def test_graphql_error_with_null_message_does_not_crash(self):
        """An error object with message: None must not cause join() to crash."""
        def runner(cmd, **kwargs):
            return FakeCompleted(stdout='{"errors":[{"message":null},{"message":"boom"}]}')

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        msg = str(ctx.exception)
        self.assertIn("graphql:", msg)
        self.assertIn("boom", msg)


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

    def test_content_none_does_not_crash_numeric_lookup(self):
        """A board item with content: None (e.g. a broken draft) must not poison
        numeric-selector lookups for every other item on the board."""
        items = ITEMS + [
            {"id": "PVTI_ddd", "title": "redacted item", "content": None},
        ]
        self.assertEqual(_board.select_item(items, "42")["id"], "PVTI_bbb")

    def test_duplicate_issue_number_raises_ambiguous(self):
        """Two items both claiming content.number == 42 must raise, listing both -
        never silently fall through to substring matching and return the wrong one."""
        items = [
            {"id": "PVTI_bbb", "title": "Componentization Wave 2",
             "status": "Backlog", "content": {"type": "Issue", "number": 42}},
            {"id": "PVTI_eee", "title": "Fix bug 42 in parser",
             "status": "Backlog", "content": {"type": "Issue", "number": 42}},
        ]
        with self.assertRaises(_board.BoardError) as ctx:
            _board.select_item(items, "42")
        msg = str(ctx.exception)
        self.assertIn("PVTI_bbb", msg)
        self.assertIn("PVTI_eee", msg)

    def test_title_none_does_not_crash_substring_lookup(self):
        """A board item with title: None must not poison substring lookups with AttributeError."""
        items = [{"id": "PVTI_x", "title": None, "content": {}}]
        with self.assertRaises(_board.BoardError) as ctx:
            _board.select_item(items, "minio")
        # Should raise "no board item matching", not AttributeError
        self.assertIn("no board item matching", str(ctx.exception))

    def test_title_none_does_not_break_numeric_ambiguity_listing(self):
        """When title is None, the numeric ambiguity listing must not crash formatting the None."""
        items = [
            {"id": "PVTI_x", "title": None, "content": {"number": 42}},
            {"id": "PVTI_y", "title": "Fix bug 42", "content": {"number": 42}},
        ]
        with self.assertRaises(_board.BoardError) as ctx:
            _board.select_item(items, "42")
        msg = str(ctx.exception)
        # The ambiguity listing should include both items and not crash on the None
        self.assertIn("PVTI_x", msg)
        self.assertIn("PVTI_y", msg)
        self.assertIn("(untitled)", msg)  # None should render as "(untitled)"


class TestFetchItems(unittest.TestCase):
    def test_builds_expected_argv_and_parses_items(self):
        seen = {}

        def runner(cmd, **kwargs):
            seen["cmd"] = cmd
            return FakeCompleted(stdout=json.dumps({"items": [{"id": "PVTI_x"}]}))

        result = _board.fetch_items(CFG, runner=runner)
        cmd = seen["cmd"]
        self.assertIn("--limit", cmd)
        self.assertIn("500", cmd)
        self.assertIn("--owner", cmd)
        self.assertIn(CFG["owner"], cmd)
        self.assertIn(str(CFG["project_number"]), cmd)
        self.assertIn("--format", cmd)
        self.assertIn("json", cmd)
        self.assertEqual(result, [{"id": "PVTI_x"}])


class TestSetStatus(unittest.TestCase):
    def test_uses_item_field_value_mutation_not_field_mutation(self):
        """set_status must call updateProjectV2ItemFieldValue, never updateProjectV2Field
        (which replaces the whole option list and would wipe every item's status)."""
        seen = {}

        def runner(cmd, **kwargs):
            seen["cmd"] = cmd
            return FakeCompleted(stdout='{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_x"}}}}')

        cfg = {**CFG, "project_id": "PVT_proj", "status_field_id": "PVTSSF_field"}
        _board.set_status(cfg, "PVTI_x", "98236657", runner=runner)
        cmd = seen["cmd"]
        joined = " ".join(cmd)
        self.assertIn("updateProjectV2ItemFieldValue", joined)
        self.assertNotIn("updateProjectV2Field(", joined)
        self.assertNotIn("-F", cmd)
        self.assertIn("-f", cmd)
        self.assertIn("project=PVT_proj", cmd)
        self.assertIn("item=PVTI_x", cmd)
        self.assertIn("field=PVTSSF_field", cmd)
        self.assertIn("opt=98236657", cmd)


if __name__ == "__main__":
    unittest.main()
