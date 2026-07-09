import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import _board
import gh_add
import gh_done
import gh_reject


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


class GhAddRouter:
    """Routes fake `gh` invocations for gh_add.py by inspecting the argv shape, so
    the --issue and --draft paths can be exercised without ever touching the
    network or creating a real (permanent) GitHub issue."""

    def __init__(self):
        self.calls = []
        self.handlers = []

    def on(self, predicate, response):
        self.handlers.append((predicate, response))
        return self

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        for predicate, response in self.handlers:
            if predicate(cmd):
                return response(cmd) if callable(response) else response
        raise AssertionError(f"unrouted gh invocation: {cmd}")


def _is_issue_create(cmd):
    return cmd[1:3] == ["issue", "create"]


def _is_issue_view(cmd):
    return cmd[1:3] == ["issue", "view"]


def _is_graphql_for(name):
    def predicate(cmd):
        return cmd[1:3] == ["api", "graphql"] and any(name in part for part in cmd)
    return predicate


_is_add_item = _is_graphql_for("addProjectV2ItemById")
_is_add_draft = _is_graphql_for("addProjectV2DraftIssue")
_is_set_status = _is_graphql_for("updateProjectV2ItemFieldValue")


ISSUE_CREATE_OK = FakeCompleted(stdout="https://github.com/TDHydra/inventorypro/issues/42\n")
ISSUE_VIEW_OK = FakeCompleted(stdout=json.dumps({"id": "I_kwDOnode42"}))
ADD_ITEM_OK = FakeCompleted(stdout=json.dumps(
    {"data": {"addProjectV2ItemById": {"item": {"id": "PVTI_added42"}}}}))
ADD_ITEM_FAIL = FakeCompleted(stdout=json.dumps(
    {"errors": [{"message": "addProjectV2ItemById: revoked project scope"}]}))
SET_STATUS_OK = FakeCompleted(stdout=json.dumps(
    {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_added42"}}}}))
SET_STATUS_FAIL = FakeCompleted(stdout=json.dumps(
    {"errors": [{"message": "updateProjectV2ItemFieldValue: field not found"}]}))
ADD_DRAFT_OK = FakeCompleted(stdout=json.dumps(
    {"data": {"addProjectV2DraftIssue": {"projectItem": {"id": "PVTI_draft1"}}}}))


def run_gh_add(argv, router):
    with mock.patch.object(sys, "argv", ["gh_add.py", *argv]):
        return gh_add.main(runner=router)


class TestGhAddIssuePath(unittest.TestCase):
    def test_add_project_item_failure_names_issue_and_says_not_on_board(self):
        """Finding 1a: `gh issue create` permanently creates the issue before
        addProjectV2ItemById ever runs. If that mutation fails, the BoardError must
        name the issue so the user isn't left with an orphan discoverable only via
        `gh issue list`."""
        router = GhAddRouter()
        router.on(_is_issue_create, ISSUE_CREATE_OK)
        router.on(_is_issue_view, ISSUE_VIEW_OK)
        router.on(_is_add_item, ADD_ITEM_FAIL)

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_add(["SCRATCH", "--issue"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("not on the board", msg.lower())
        self.assertIn("revoked project scope", msg)  # original error text preserved

    def test_set_status_failure_names_issue_and_says_status_not_set(self):
        """Finding 1b: a failure that happens AFTER the item is added to the board
        must still name the issue and say its status was never set."""
        router = GhAddRouter()
        router.on(_is_issue_create, ISSUE_CREATE_OK)
        router.on(_is_issue_view, ISSUE_VIEW_OK)
        router.on(_is_add_item, ADD_ITEM_OK)
        router.on(_is_set_status, SET_STATUS_FAIL)

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_add(["SCRATCH", "--issue"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("status", msg.lower())
        self.assertIn("not", msg.lower())
        self.assertIn("field not found", msg)  # original error text preserved

    def test_unparseable_issue_number_raises_before_issue_view_and_includes_raw_stdout(self):
        """Finding 2: the number parsed from `gh issue create`'s stdout must be
        validated as numeric before being handed to `gh issue view`. A future `gh`
        that prints a trailing hint line must not sail into `gh issue view` with
        garbage — and the raw stdout must be surfaced so the user can find whatever
        was actually created."""
        router = GhAddRouter()
        router.on(_is_issue_create, FakeCompleted(
            stdout="https://github.com/TDHydra/inventorypro/issues/42\nsome future hint line\n"))
        router.on(_is_issue_view, ISSUE_VIEW_OK)  # must never be reached

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_add(["SCRATCH", "--issue"], router)
        msg = str(ctx.exception)
        self.assertIn("some future hint line", msg)
        self.assertFalse(any(_is_issue_view(c) for c in router.calls),
                          "gh issue view must not run once the number fails to parse")

    def test_happy_path_returns_zero_and_calls_expected_mutations(self):
        router = GhAddRouter()
        router.on(_is_issue_create, ISSUE_CREATE_OK)
        router.on(_is_issue_view, ISSUE_VIEW_OK)
        router.on(_is_add_item, ADD_ITEM_OK)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = run_gh_add(["SCRATCH", "--issue", "--status", "Backlog"], router)
        self.assertEqual(rc, 0)
        self.assertIn("#42", out.getvalue())
        self.assertTrue(any(_is_issue_create(c) for c in router.calls))
        self.assertTrue(any(_is_issue_view(c) for c in router.calls))
        self.assertTrue(any(_is_add_item(c) for c in router.calls))
        self.assertTrue(any(_is_set_status(c) for c in router.calls))


class TestGhAddDraftPath(unittest.TestCase):
    def test_draft_path_never_calls_issue_create(self):
        router = GhAddRouter()
        router.on(_is_add_draft, ADD_DRAFT_OK)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()):
            rc = run_gh_add(["SCRATCH", "--draft"], router)
        self.assertEqual(rc, 0)
        self.assertFalse(any(_is_issue_create(c) for c in router.calls))


def _is_item_list(cmd):
    return cmd[1:3] == ["project", "item-list"]


def _is_issue_close(cmd):
    return cmd[1:3] == ["issue", "close"]


def _is_issue_comment(cmd):
    return cmd[1:3] == ["issue", "comment"]


_is_update_draft = _is_graphql_for("updateProjectV2DraftIssue")


ISSUE_ITEM = {
    "id": "PVTI_issue1",
    "title": "SCRATCH issue item",
    "status": "In progress",
    "content": {"type": "Issue", "number": 42},
}

DRAFT_ITEM = {
    "id": "PVTI_draft1",
    "title": "SCRATCH draft item",
    "status": "In progress",
    "content": {"type": "DraftIssue", "id": "DI_draft1", "body": "some body"},
}

ITEM_LIST_ISSUE = FakeCompleted(stdout=json.dumps({"items": [ISSUE_ITEM]}))
ITEM_LIST_DRAFT = FakeCompleted(stdout=json.dumps({"items": [DRAFT_ITEM]}))
ISSUE_CLOSE_OK = FakeCompleted(stdout="")
ISSUE_CLOSE_FAIL = FakeCompleted(returncode=1, stdout="", stderr="cannot close: already closed")
ISSUE_COMMENT_OK = FakeCompleted(stdout="")
UPDATE_DRAFT_OK = FakeCompleted(stdout=json.dumps(
    {"data": {"updateProjectV2DraftIssue": {"draftIssue": {"id": "DI_draft1"}}}}))


def run_gh_done(argv, router):
    with mock.patch.object(sys, "argv", ["gh_done.py", *argv]):
        return gh_done.main(runner=router)


def run_gh_reject(argv, router):
    with mock.patch.object(sys, "argv", ["gh_reject.py", *argv]):
        return gh_reject.main(runner=router)


class TestGhDone(unittest.TestCase):
    def test_closes_issue_before_moving_to_done(self):
        """Ordering invariant: the issue must be closed BEFORE set_status runs, so a
        crash between the two never leaves an open issue sitting in Done."""
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_ISSUE)
        router.on(_is_issue_close, ISSUE_CLOSE_OK)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = run_gh_done(["42"], router)
        self.assertEqual(rc, 0)
        close_idx = next(i for i, c in enumerate(router.calls) if _is_issue_close(c))
        status_idx = next(i for i, c in enumerate(router.calls) if _is_set_status(c))
        self.assertLess(close_idx, status_idx)
        self.assertIn("#42 closed", out.getvalue())

    def test_does_not_move_item_when_issue_close_fails(self):
        """The core invariant: if `gh issue close` fails, set_status must never run -
        an open issue must never end up in Done."""
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_ISSUE)
        router.on(_is_issue_close, ISSUE_CLOSE_FAIL)
        # deliberately no handler for _is_set_status: if it's called anyway, the
        # router raises AssertionError for the unrouted call.

        with self.assertRaises(_board.BoardError):
            run_gh_done(["42"], router)
        self.assertFalse(any(_is_set_status(c) for c in router.calls))

    def test_draft_item_never_calls_issue_close(self):
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_DRAFT)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = run_gh_done(["SCRATCH draft"], router)
        self.assertEqual(rc, 0)
        self.assertFalse(any(_is_issue_close(c) for c in router.calls))
        self.assertIn("draft (no issue to close)", out.getvalue())

    def test_post_close_set_status_failure_says_issue_already_closed(self):
        """If set_status fails AFTER the issue is closed, the error must tell the
        user the issue was already closed - otherwise they're left with a closed
        issue outside Done and no clue why."""
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_ISSUE)
        router.on(_is_issue_close, ISSUE_CLOSE_OK)
        router.on(_is_set_status, SET_STATUS_FAIL)

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_done(["42"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("already closed", msg.lower())
        self.assertIn("field not found", msg)  # original error text preserved


class TestGhReject(unittest.TestCase):
    def test_issue_backed_comments_then_closes_not_planned(self):
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_ISSUE)
        router.on(_is_issue_comment, ISSUE_COMMENT_OK)
        router.on(_is_issue_close, ISSUE_CLOSE_OK)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = run_gh_reject(["42", "--reason", "not needed"], router)
        self.assertEqual(rc, 0)
        comment_idx = next(i for i, c in enumerate(router.calls) if _is_issue_comment(c))
        close_idx = next(i for i, c in enumerate(router.calls) if _is_issue_close(c))
        self.assertLess(comment_idx, close_idx)
        close_cmd = router.calls[close_idx]
        self.assertIn("not planned", close_cmd)
        self.assertIn("not needed", out.getvalue())

    def test_draft_updates_body_via_mutation(self):
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_DRAFT)
        router.on(_is_update_draft, UPDATE_DRAFT_OK)
        router.on(_is_set_status, SET_STATUS_OK)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = run_gh_reject(["SCRATCH draft", "--reason", "duplicate of #10"], router)
        self.assertEqual(rc, 0)
        update_call = next(c for c in router.calls if _is_update_draft(c))
        joined = " ".join(update_call)
        self.assertIn("duplicate of #10", joined)
        self.assertFalse(any(_is_issue_close(c) for c in router.calls))

    def test_post_close_set_status_failure_says_issue_already_closed(self):
        router = GhAddRouter()
        router.on(_is_item_list, ITEM_LIST_ISSUE)
        router.on(_is_issue_comment, ISSUE_COMMENT_OK)
        router.on(_is_issue_close, ISSUE_CLOSE_OK)
        router.on(_is_set_status, SET_STATUS_FAIL)

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_reject(["42", "--reason", "dup"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("already closed", msg.lower())
        self.assertIn("field not found", msg)  # original error text preserved


if __name__ == "__main__":
    unittest.main()
