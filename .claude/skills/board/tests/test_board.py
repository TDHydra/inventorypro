import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import _board
import gh_add
import gh_done
import gh_promote
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
    FETCH_CFG = {**CFG, "project_id": "PVT_test"}

    def test_paginates_with_cursor_and_normalizes(self):
        pages = [
            gql_items_page(
                [raw_node("PVTI_a", "Item A", "Ready",
                          {"__typename": "Issue", "number": 7, "title": "Item A",
                           "body": "b", "url": "u",
                           "repository": {"nameWithOwner": "TDHydra/inventorypro"}})],
                has_next=True, cursor="CUR1"),
            gql_items_page(
                [raw_node("PVTI_b", "Item B", "Backlog",
                          {"__typename": "DraftIssue", "id": "DI_b",
                           "title": "Item B", "body": ""})]),
        ]
        calls = []

        def runner(cmd, **kwargs):
            calls.append(cmd)
            return pages[len(calls) - 1]

        items = _board.fetch_items(self.FETCH_CFG, runner=runner)
        self.assertEqual(len(calls), 2)
        self.assertFalse(any("cursor=" in part for part in calls[0]))
        self.assertIn("cursor=CUR1", calls[1])
        self.assertEqual([i["id"] for i in items], ["PVTI_a", "PVTI_b"])
        issue, draft = items
        self.assertEqual(issue["status"], "Ready")
        self.assertEqual(issue["content"]["type"], "Issue")
        self.assertEqual(issue["content"]["number"], 7)
        self.assertEqual(issue["content"]["repository"], "TDHydra/inventorypro")
        self.assertEqual(draft["title"], "Item B")
        self.assertEqual(draft["content"]["type"], "DraftIssue")
        self.assertEqual(draft["content"]["id"], "DI_b")

    def test_query_avoids_the_expensive_fieldvalues_connection(self):
        """The point of the lean query: GraphQL prices connections (first:N), not
        scalars — fieldValues(first:N) is what made gh's item-list cost ~100
        points a page. Only single-node fieldValueByName lookups are allowed."""
        seen = {}

        def runner(cmd, **kwargs):
            seen["cmd"] = " ".join(cmd)
            return gql_items_page([])

        _board.fetch_items(self.FETCH_CFG, runner=runner)
        self.assertIn("fieldValueByName", seen["cmd"])
        self.assertNotIn("fieldValues(", seen["cmd"])


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


def _is_issue_close(cmd):
    return cmd[1:3] == ["issue", "close"]


def _is_issue_comment(cmd):
    return cmd[1:3] == ["issue", "comment"]


_is_update_draft = _is_graphql_for("updateProjectV2DraftIssue")
_is_items_query = _is_graphql_for("BoardItems")
_is_issue_lookup = _is_graphql_for("IssueItem")
_is_item_node = _is_graphql_for("ItemNode")
_is_convert = _is_graphql_for("convertProjectV2DraftIssueItemToIssue")

PROJECT_ID = _board.load_config()["project_id"]


def gql_items_page(nodes, has_next=False, cursor=None):
    """A one-page BoardItems response of RAW (un-normalized) item nodes."""
    return FakeCompleted(stdout=json.dumps({"data": {"node": {"items": {
        "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
        "nodes": nodes}}}}))


def raw_node(item_id, title, status, content):
    return {"id": item_id, "title": {"text": title}, "status": {"name": status},
            "priority": None, "area": None, "content": content}


ISSUE_NODE = raw_node("PVTI_issue1", "SCRATCH issue item", "In progress",
                      {"__typename": "Issue", "number": 42,
                       "title": "SCRATCH issue item", "body": "", "url": "u"})
DRAFT_NODE = raw_node("PVTI_draft1", "SCRATCH draft item", "In progress",
                      {"__typename": "DraftIssue", "id": "DI_draft1",
                       "title": "SCRATCH draft item", "body": "some body"})

ITEMS_PAGE_ISSUE = gql_items_page([ISSUE_NODE])
ITEMS_PAGE_DRAFT = gql_items_page([DRAFT_NODE])

# What the targeted #42 lookup returns (find_item numeric fast path).
ISSUE_LOOKUP_OK = FakeCompleted(stdout=json.dumps({"data": {"repository": {"issue": {
    "number": 42, "title": "SCRATCH issue item", "body": "", "url": "u",
    "projectItems": {"nodes": [{
        "id": "PVTI_issue1", "project": {"id": PROJECT_ID},
        "title": {"text": "SCRATCH issue item"}, "status": {"name": "In progress"},
        "priority": None, "area": None}]}}}}}))

# What gh_reject's pre-annotation body re-read returns for the draft item.
NODE_DRAFT_OK = FakeCompleted(stdout=json.dumps({"data": {"node": DRAFT_NODE}}))
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
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
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
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
        router.on(_is_issue_close, ISSUE_CLOSE_FAIL)
        # deliberately no handler for _is_set_status: if it's called anyway, the
        # router raises AssertionError for the unrouted call.

        with self.assertRaises(_board.BoardError):
            run_gh_done(["42"], router)
        self.assertFalse(any(_is_set_status(c) for c in router.calls))

    def test_draft_item_never_calls_issue_close(self):
        router = GhAddRouter()
        router.on(_is_items_query, ITEMS_PAGE_DRAFT)
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
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
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
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
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
        router.on(_is_items_query, ITEMS_PAGE_DRAFT)
        router.on(_is_item_node, NODE_DRAFT_OK)  # pre-annotation body re-read
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
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
        router.on(_is_issue_comment, ISSUE_COMMENT_OK)
        router.on(_is_issue_close, ISSUE_CLOSE_OK)
        router.on(_is_set_status, SET_STATUS_FAIL)

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_reject(["42", "--reason", "dup"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("already closed", msg.lower())
        self.assertIn("field not found", msg)  # original error text preserved

    def test_close_failure_after_comment_says_comment_already_posted(self):
        """Finding 2: if the rejection comment succeeds but `gh issue close` then
        fails, the raised BoardError must say the comment was already posted to the
        issue, that the issue is still OPEN, and that the item was not moved -
        otherwise the user is left guessing why a still-open issue has a rejection
        comment on it. set_status must never run in this case."""
        router = GhAddRouter()
        router.on(_is_issue_lookup, ISSUE_LOOKUP_OK)
        router.on(_is_issue_comment, ISSUE_COMMENT_OK)
        router.on(_is_issue_close, ISSUE_CLOSE_FAIL)
        # deliberately no handler for _is_set_status: if it's called anyway, the
        # router raises AssertionError for the unrouted call.

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_reject(["42", "--reason", "dup"], router)
        msg = str(ctx.exception)
        self.assertIn("#42", msg)
        self.assertIn("already posted", msg.lower())
        self.assertIn("open", msg.lower())
        self.assertIn("not", msg.lower())
        self.assertIn("cannot close: already closed", msg)  # original error text preserved
        self.assertFalse(any(_is_set_status(c) for c in router.calls))


BROKEN_DRAFT_CONTENT_NONE = raw_node(
    "PVTI_broken1", "broken draft item, content is None", "In progress", None)

BROKEN_DRAFT_CONTENT_NO_ID = raw_node(
    "PVTI_broken2", "broken draft item, content lacks id", "In progress",
    {"__typename": "DraftIssue", "body": "some body"})


class TestGhRejectMalformedDraft(unittest.TestCase):
    """Finding 1: a draft item whose content is None or lacks an id (a shape
    _board.py's own suite anticipates - see
    TestSelectItem.test_content_none_does_not_crash_numeric_lookup) must raise a
    clean BoardError, not a bare KeyError, and must never attempt the mutation."""

    def test_content_none_raises_boarderror_not_keyerror(self):
        router = GhAddRouter()
        router.on(_is_items_query, gql_items_page([BROKEN_DRAFT_CONTENT_NONE]))

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_reject(["broken draft item, content is None", "--reason", "x"], router)
        msg = str(ctx.exception)
        self.assertIn("broken draft item, content is None", msg)
        self.assertIn("PVTI_broken1", msg)
        self.assertIn("malformed", msg.lower())
        self.assertFalse(any(_is_update_draft(c) for c in router.calls))

    def test_content_missing_id_raises_boarderror_not_keyerror(self):
        router = GhAddRouter()
        router.on(_is_items_query, gql_items_page([BROKEN_DRAFT_CONTENT_NO_ID]))

        with self.assertRaises(_board.BoardError) as ctx:
            run_gh_reject(["broken draft item, content lacks id", "--reason", "x"], router)
        msg = str(ctx.exception)
        self.assertIn("broken draft item, content lacks id", msg)
        self.assertIn("PVTI_broken2", msg)
        self.assertIn("malformed", msg.lower())
        self.assertFalse(any(_is_update_draft(c) for c in router.calls))


class TestGhPromote(unittest.TestCase):
    """gh_promote converts a draft into a permanent, undeletable GitHub issue."""

    ITEMS_PAGE = gql_items_page([
        raw_node("PVTI_draft", "a draft item", "Backlog",
                 {"__typename": "DraftIssue", "id": "DI_d", "title": "a draft item"}),
        raw_node("PVTI_issue", "an issue item", "Backlog",
                 {"__typename": "Issue", "number": 42, "title": "an issue item"}),
    ])

    def _router(self):
        r = GhAddRouter()
        r.on(_is_items_query, self.ITEMS_PAGE)
        return r

    def _run(self, argv, router):
        with unittest.mock.patch.object(sys, "argv", ["gh_promote.py", *argv]):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh_promote.main(runner=router)
        return rc, out.getvalue()

    def test_dry_run_without_yes_converts_nothing(self):
        router = self._router()
        rc, out = self._run(["a draft item"], router)
        self.assertEqual(rc, 1)
        self.assertIn("cannot be undone", out)
        self.assertFalse(any(_is_convert(c) for c in router.calls),
                         "dry run must not call the convert mutation")

    def test_refuses_an_item_that_is_already_an_issue(self):
        router = self._router()
        with self.assertRaises(_board.BoardError) as ctx:
            self._run(["an issue item", "--yes"], router)
        self.assertIn("already issue #42", str(ctx.exception))
        self.assertFalse(any(_is_convert(c) for c in router.calls))

    def test_yes_converts_and_reports_the_new_issue(self):
        router = self._router()
        router.on(_is_convert, FakeCompleted(stdout=json.dumps(
            {"data": {"convertProjectV2DraftIssueItemToIssue": {"item": {
                "id": "PVTI_draft",
                "content": {"number": 77, "url": "https://github.com/o/r/issues/77"}}}}})))
        rc, out = self._run(["a draft item", "--yes"], router)
        self.assertEqual(rc, 0)
        self.assertIn("#77", out)


CACHE_CFG = {**CFG, "project_id": "PVT_test"}


class TestItemListCache(unittest.TestCase):
    """fetch_items caching: real (runner=None) calls hit the on-disk cache;
    injected runners never touch it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {"BOARD_CACHE_DIR": self.tmp})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _counting_run(self, nodes):
        """Stands in for subprocess.run on the runner=None (real) path.
        Serves the free quota check and counts only BoardItems fetches."""
        def fake_run(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(stdout="5000\n")
            fake_run.calls += 1
            return gql_items_page(nodes)
        fake_run.calls = 0
        return fake_run

    def _fetch(self, **kwargs):
        with contextlib.redirect_stderr(io.StringIO()):
            return _board.fetch_items(CACHE_CFG, **kwargs)

    def test_fresh_cache_skips_live_fetch(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_cached"}])
        fake = self._counting_run([{"id": "PVTI_live"}])
        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch()
        self.assertEqual(items, [{"id": "PVTI_cached"}])
        self.assertEqual(fake.calls, 0)

    def test_expired_cache_fetches_live_and_rewrites(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_old"}],
                            fetched_at=time.time() - _board.CACHE_TTL_SECONDS - 1)
        fake = self._counting_run([{"id": "PVTI_live"}])
        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch()
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])
        self.assertEqual(fake.calls, 1)
        cached, age = _board._read_cache(CACHE_CFG)
        self.assertEqual([i["id"] for i in cached], ["PVTI_live"])
        self.assertLess(age, 60)

    def test_refresh_bypasses_fresh_cache(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_cached"}])
        fake = self._counting_run([{"id": "PVTI_live"}])
        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch(refresh=True)
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])
        self.assertEqual(fake.calls, 1)

    def test_live_failure_falls_back_to_stale_cache(self):
        """The rate-limit case: any cached copy beats an error."""
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_stale"}],
                            fetched_at=time.time() - 10 * 3600)
        def fail_run(cmd, **kwargs):
            return FakeCompleted(returncode=1, stderr="API rate limit exceeded")
        with mock.patch.object(_board.subprocess, "run", fail_run):
            items = self._fetch()
        self.assertEqual(items, [{"id": "PVTI_stale"}])

    def test_live_failure_without_cache_raises(self):
        def fail_run(cmd, **kwargs):
            return FakeCompleted(returncode=1, stderr="API rate limit exceeded")
        with mock.patch.object(_board.subprocess, "run", fail_run):
            with self.assertRaises(_board.BoardError):
                self._fetch()

    def test_injected_runner_never_touches_cache(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_cached"}])
        def runner(cmd, **kwargs):
            return gql_items_page([{"id": "PVTI_live"}])
        items = _board.fetch_items(CACHE_CFG, runner=runner)
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])
        cached, _ = _board._read_cache(CACHE_CFG)
        self.assertEqual(cached, [{"id": "PVTI_cached"}])

    def test_patch_cached_status_updates_item_and_preserves_fetch_time(self):
        old = time.time() - 1000
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_x", "status": "Backlog"},
                                        {"id": "PVTI_y", "status": "Backlog"}],
                            fetched_at=old)
        _board.patch_cached_status(CACHE_CFG, "PVTI_x", "Ready")
        with open(_board._cache_path(CACHE_CFG), encoding="utf-8") as f:
            payload = json.load(f)
        by_id = {i["id"]: i["status"] for i in payload["items"]}
        self.assertEqual(by_id, {"PVTI_x": "Ready", "PVTI_y": "Backlog"})
        self.assertEqual(payload["fetched_at"], old)

    def test_invalidate_removes_cache(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_x"}])
        _board.invalidate_cache(CACHE_CFG)
        self.assertEqual(_board._read_cache(CACHE_CFG), (None, 0.0))
        _board.invalidate_cache(CACHE_CFG)  # idempotent on a missing file


FIND_CFG = {**CFG, "project_id": "PVT_test", "repo": "TDHydra/inventorypro"}


class TestFindItem(unittest.TestCase):
    """find_item resolves at the lowest quota cost: cache, then targeted
    one-point lookups, then the full fetch."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {"BOARD_CACHE_DIR": self.tmp})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_fresh_cache_resolves_without_any_network_call(self):
        _board._write_cache(FIND_CFG, [
            {"id": "PVTI_x", "title": "Fix parser", "status": "Ready",
             "content": {"type": "Issue", "number": 9}}])

        def boom(cmd, **kwargs):
            raise AssertionError(f"network call during cached resolution: {cmd}")

        with mock.patch.object(_board.subprocess, "run", boom):
            by_number = _board.find_item(FIND_CFG, "#9")
            by_title = _board.find_item(FIND_CFG, "Fix par")
        self.assertEqual(by_number["id"], "PVTI_x")
        self.assertEqual(by_title["id"], "PVTI_x")

    def test_numeric_miss_uses_targeted_issue_lookup_and_filters_project(self):
        calls = []

        def fake(cmd, **kwargs):
            calls.append(" ".join(cmd))
            return FakeCompleted(stdout=json.dumps({"data": {"repository": {"issue": {
                "number": 9, "title": "T", "body": "bd", "url": "u",
                "projectItems": {"nodes": [
                    {"id": "PVTI_other", "project": {"id": "PVT_other"},
                     "title": None, "status": None, "priority": None, "area": None},
                    {"id": "PVTI_mine", "project": {"id": "PVT_test"},
                     "title": {"text": "T"}, "status": {"name": "Ready"},
                     "priority": None, "area": None},
                ]}}}}}))

        with mock.patch.object(_board.subprocess, "run", fake):
            item = _board.find_item(FIND_CFG, "#9")
        self.assertEqual(item["id"], "PVTI_mine")
        self.assertEqual(item["status"], "Ready")
        self.assertEqual(item["content"]["number"], 9)
        self.assertEqual(item["content"]["body"], "bd")
        self.assertEqual(len(calls), 1)
        self.assertIn("issue(number:9)", calls[0])  # int inlined, not a variable
        self.assertNotIn("BoardItems", calls[0])

    def test_numeric_not_on_this_project_raises(self):
        def fake(cmd, **kwargs):
            return FakeCompleted(stdout=json.dumps({"data": {"repository": {"issue": {
                "number": 9, "title": "T", "body": "", "url": "u",
                "projectItems": {"nodes": []}}}}}))

        with mock.patch.object(_board.subprocess, "run", fake):
            with self.assertRaises(_board.BoardError) as ctx:
                _board.find_item(FIND_CFG, "9")
        self.assertIn("#9", str(ctx.exception))

    def test_item_id_miss_uses_node_lookup(self):
        def fake(cmd, **kwargs):
            return FakeCompleted(stdout=json.dumps({"data": {"node": raw_node(
                "PVTI_z", "Z", "Backlog",
                {"__typename": "DraftIssue", "id": "DI_z", "title": "Z", "body": ""})}}))

        with mock.patch.object(_board.subprocess, "run", fake):
            item = _board.find_item(FIND_CFG, "PVTI_z")
        self.assertEqual(item["id"], "PVTI_z")
        self.assertEqual(item["content"]["id"], "DI_z")

    def test_substring_miss_falls_back_to_full_fetch_and_caches(self):
        def fake(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(stdout="5000\n")
            return gql_items_page([raw_node(
                "PVTI_q", "Quantum widget", "Backlog",
                {"__typename": "Issue", "number": 3, "title": "Quantum widget",
                 "body": "", "url": "u"})])

        with contextlib.redirect_stderr(io.StringIO()):
            with mock.patch.object(_board.subprocess, "run", fake):
                item = _board.find_item(FIND_CFG, "Quantum")
        self.assertEqual(item["id"], "PVTI_q")
        cached, _ = _board._read_cache(FIND_CFG)
        self.assertEqual([i["id"] for i in cached], ["PVTI_q"])


class TestQuotaGuard(unittest.TestCase):
    """Below QUOTA_FLOOR remaining GraphQL points, a stale cache beats a live
    full fetch; the check itself is free (REST) and fail-open."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = mock.patch.dict(os.environ, {"BOARD_CACHE_DIR": self.tmp})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _fetch(self, **kwargs):
        with contextlib.redirect_stderr(io.StringIO()):
            return _board.fetch_items(CACHE_CFG, **kwargs)

    def test_low_quota_with_stale_cache_serves_stale(self):
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_stale"}],
                            fetched_at=time.time() - 10 * 3600)

        def fake(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(stdout="12\n")
            raise AssertionError("full fetch must not run below the quota floor")

        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch()
        self.assertEqual(items, [{"id": "PVTI_stale"}])

    def test_low_quota_without_cache_still_attempts_fetch(self):
        def fake(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(stdout="12\n")
            return gql_items_page([{"id": "PVTI_live"}])

        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch()
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])

    def test_quota_check_failure_is_fail_open(self):
        def fake(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(returncode=1, stderr="rate_limit endpoint down")
            return gql_items_page([{"id": "PVTI_live"}])

        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch()
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])

    def test_refresh_bypasses_the_quota_floor(self):
        """--refresh is explicit user intent for a live fetch; honor it."""
        _board._write_cache(CACHE_CFG, [{"id": "PVTI_stale"}],
                            fetched_at=time.time() - 10 * 3600)

        def fake(cmd, **kwargs):
            if "rate_limit" in cmd:
                return FakeCompleted(stdout="12\n")
            return gql_items_page([{"id": "PVTI_live"}])

        with mock.patch.object(_board.subprocess, "run", fake):
            items = self._fetch(refresh=True)
        self.assertEqual([i["id"] for i in items], ["PVTI_live"])


if __name__ == "__main__":
    unittest.main()
