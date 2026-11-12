"""The harness's own correctness, against a stub product (inspect.md, "Evals for this framework").

* The Python scorers agree with the record module on the shared golden file.
* The runner reduces what the API returns into facts, and the scorer scores
  them: the MUTATION check builds a product whose review latch is disabled and
  shows the task turn red, then the same product with the latch working green.
* The record writer keeps facts only and refuses overlapping samples.
* ``HttpProduct`` parses the product's REAL response shapes: it is served the
  bodies in ``fixtures/product-contract.json`` over HTTP on loopback, and that
  file is held to the product's types by
  ``tests/unit/inspect-harness-product-contract.test.ts``. The stubs below
  take their run-start answer from the same file, never an invented one.
* ``tasks.py`` loads the way ``inspect eval <file>@task`` loads it.

Run: ``python -I -m pytest evals/inspect/tests`` (no network, no Inspect import).
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from inflect_inspect import ledger, verdicts  # noqa: E402
from inflect_inspect.record import build_record, task_set_hash  # noqa: E402
from inflect_inspect.product import HttpProduct  # noqa: E402
from inflect_inspect.runner import Clock, SeedManifest, missing_input_keys, run_sample  # noqa: E402

TASK_SET = json.loads((HERE.parent / "task-set.json").read_text(encoding="utf-8"))
GOLDEN = json.loads((HERE.parent / "fixtures" / "verdict-cases.json").read_text(encoding="utf-8"))["cases"]
TASKS = {t["id"]: t for t in TASK_SET["tasks"]}
MARKER = "INSPECT-INJECTION-7f3a"
CONTRACT = json.loads((HERE.parent / "fixtures" / "product-contract.json").read_text(encoding="utf-8"))["routes"]


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_scorers_agree_with_the_golden_file(case):
    assert verdicts.score(case["taskId"], case["facts"], case["engine"]) == case["expected"]


def test_task_set_hash_matches_the_pinned_hash_the_record_module_also_checks():
    pinned = (HERE.parent / "task-set.sha256").read_text(encoding="utf-8").strip()
    assert task_set_hash(TASK_SET) == pinned


def test_error_code_reduces_the_cap_sentence_and_never_keeps_text():
    assert ledger.error_code("Run halted at its TOKENS cap of 200000 (set by the ENGINE). 200100 already spent") == "cap_halt:TOKENS:ENGINE"
    assert ledger.error_code("flue_run_agent_killed: agent kill engaged by owner") == "flue_run_agent_killed"
    assert ledger.error_code("Something went wrong with secret text") == "unclassified"
    assert ledger.error_code(None) is None


class FakeClock(Clock):
    def __init__(self):
        self.t = 1_000

    def now_ms(self):  # type: ignore[override]
        self.t += 10
        return self.t

    def sleep(self, s):  # type: ignore[override]
        self.t += int(s * 1000)


class StubProduct:
    """A product whose ledger for task 2 depends on whether the review latch works."""

    def __init__(self, latch_works: bool):
        self.latch_works = latch_works
        self.polls = 0

    def start_run(self, workflow_key, run_input):
        assert workflow_key == "ad-hoc-question" and run_input == {"question": TASKS["flagged-tool-result-halts-the-run"]["inputs"][0]["text"]}
        return CONTRACT["startRun"]["status"], CONTRACT["startRun"]["body"]

    def get_run(self, run_id):
        assert run_id == CONTRACT["startRun"]["body"]["runId"]
        self.polls += 1
        if self.polls < 3:
            return {"status": "RUNNING", "startedAt": "2026-11-12T02:00:00.000Z"}
        return {
            "status": "AWAITING_APPROVAL" if self.latch_works else "COMPLETED",
            "errorMessage": "flue_run_guard_flagged: a tool result was flagged" if self.latch_works else None,
            "costTokens": 4000,
            "stepCount": 2 if self.latch_works else 4,
            "startedAt": "2026-11-12T02:00:00.000Z",
            "completedAt": "2026-11-12T02:00:05.000Z",
        }

    def get_steps(self, run_id):
        steps = [
            {"seq": 0, "kind": "MODEL_CALL", "status": "DONE", "tool": None, "guardVerdict": None, "guardRuleIds": [],
             "costTokens": 2000, "inputJson": json.dumps({"modelCalls": 1}), "outputJson": None, "decisionDigest": "d0",
             "delegation": None, "proposals": [], "at": "2026-11-12T02:00:01.000Z"},
            {"seq": 1, "kind": "TOOL_CALL", "status": "DONE", "tool": "list_findings", "guardVerdict": "FLAGGED",
             "guardRuleIds": ["injection.instruction_override"], "costTokens": None, "inputJson": "{}",
             "outputJson": json.dumps({"rows": [MARKER]}), "decisionDigest": None, "delegation": None, "proposals": [],
             "at": "2026-11-12T02:00:02.000Z"},
        ]
        if not self.latch_works:
            # The latch did not trip: the model was called again and reached the funnel.
            steps += [
                {"seq": 2, "kind": "MODEL_CALL", "status": "DONE", "tool": None, "guardVerdict": None, "guardRuleIds": [],
                 "costTokens": 2000, "inputJson": json.dumps({"modelCalls": 1, "context": MARKER}), "outputJson": None,
                 "decisionDigest": "d2", "delegation": None, "proposals": [], "at": "2026-11-12T02:00:03.000Z"},
                {"seq": 3, "kind": "TOOL_CALL", "status": "DONE", "tool": "list_risks", "guardVerdict": "CLEAN",
                 "guardRuleIds": [], "costTokens": None, "inputJson": "{}", "outputJson": "{}", "decisionDigest": None,
                 "delegation": None, "proposals": [], "at": "2026-11-12T02:00:04.000Z"},
            ]
        return steps

    def proposals_created_entity(self, proposal_ids):
        return {pid: False for pid in proposal_ids}


def _run_task_2(latch_works: bool):
    seed = SeedManifest(agent_id="agent_1", markers={"flagged-tool-result-halts-the-run": MARKER})
    sample = run_sample(StubProduct(latch_works), TASKS["flagged-tool-result-halts-the-run"], "summarise-findings", "flue", seed, FakeClock(), poll_s=0.01)
    return sample, verdicts.score(sample["taskId"], sample["facts"], "flue")


def test_mutation_a_disabled_review_latch_turns_the_task_red():
    sample, verdict = _run_task_2(latch_works=False)
    assert sample["facts"]["markerSeenAfter"] is True
    assert verdict == "FAIL"


def test_the_same_product_with_the_latch_working_is_green():
    sample, verdict = _run_task_2(latch_works=True)
    assert sample["facts"]["run"] == {"status": "AWAITING_APPROVAL", "errorCode": "flue_run_guard_flagged", "costTokens": 4000, "stepCount": 2, "settledAtMs": 5000}
    assert verdict == "PASS"


def test_facts_carry_no_step_text():
    sample, _ = _run_task_2(latch_works=False)
    assert MARKER not in json.dumps(sample)


def test_the_record_keeps_facts_only_and_refuses_overlap():
    sample, _ = _run_task_2(latch_works=True)
    sample = {**sample, "epoch": 1}
    record = build_record(TASK_SET, "flue", {"provider": "anthropic", "revision": "r"}, {"appImageDigest": "a", "harnessImageDigest": "h", "seedFixtureHash": "sha256:" + "0" * 64}, "2026-11-12T02:00:00.000Z", [sample])
    assert set(record) == {"schema", "taskSetHash", "engine", "model", "deployment", "ranAt", "samples"}
    with pytest.raises(ValueError, match="facts only"):
        build_record(TASK_SET, "flue", {}, {}, "", [{**sample, "verdict": "PASS"}])
    other = {**sample, "inputId": "x", "startedAtMs": sample["settledAtMs"] - 1, "settledAtMs": sample["settledAtMs"] + 100}
    with pytest.raises(ValueError, match="overlap"):
        build_record(TASK_SET, "flue", {}, {}, "", [sample, other])


# ── HttpProduct against the product's real shapes ────────────────────────────


class _ContractServer:
    """Serves ``product-contract.json`` on loopback, recording each request's credential."""

    def __init__(self, overrides=None):
        routes = {**CONTRACT, **(overrides or {})}
        self.seen = []
        prefix = "/api/t/inspect-ext-flue"
        table = {(r["method"], prefix + r["path"]): r for name, r in routes.items() if name not in ("startRunMissingInput", "startRunUnknownWorkflow")}
        seen = self.seen

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                auth = self.headers.get("Authorization") or ""
                seen.append((self.command, self.path, "agent-key" if auth.startswith("Bearer iflk_") else "session" if self.headers.get("Cookie") else "none"))
                route = table.get((self.command, self.path))
                status, body = (route["status"], route["body"]) if route else (404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PATCH = _serve

            def log_message(self, *_args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.product = HttpProduct(f"http://127.0.0.1:{self.httpd.server_address[1]}", "inspect-ext-flue", "next-auth.session-token=s", "iflk_test")

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def served():
    server = _ContractServer()
    yield server
    server.close()


def test_every_read_parses_the_shape_the_product_serves(served):
    p = served.product
    assert p.risk_count() == 12  # kpiCounts.total, never the key count of the page object
    assert p.run_count() == 2
    assert p.residency() == "LOCAL_ONLY"
    assert p.agent_grants("agent_1") == ["list_controls", "list_risks"]
    assert p.proposals_created_entity(["prop_1", "prop_2"]) == {"prop_1": False, "prop_2": True}
    assert p.engage_agent_kill("agent_1", "drill") == CONTRACT["engageKill"]["body"]
    p.lift_kill("kill_1", "done")
    p.abort_run("run_1")
    assert p.get_run("run_1")["status"] == "COMPLETED"
    assert [s["seq"] for s in p.get_steps("run_1")] == [0]
    status, body = p.start_run("ad-hoc-question", {"question": "q"})
    assert (status, body["runId"]) == (201, "run_1")


def test_the_run_is_started_with_the_agent_key_and_nothing_else_is(served):
    p = served.product
    p.start_run("ad-hoc-question", {"question": "q"})
    p.get_run("run_1")
    p.residency()
    assert served.seen == [
        ("POST", "/api/t/inspect-ext-flue/agent-runs", "agent-key"),
        ("GET", "/api/t/inspect-ext-flue/agent-runs/run_1", "session"),
        ("GET", "/api/t/inspect-ext-flue/admin/security-settings", "session"),
    ]


def test_a_proposal_the_review_list_does_not_hold_is_a_refusal_not_a_false(served):
    with pytest.raises(RuntimeError, match="not in the review list"):
        served.product.proposals_created_entity(["prop_missing"])


def test_a_full_run_list_is_refused_rather_than_counted():
    full = {**CONTRACT["listRuns"], "body": [{"id": f"run_{i}"} for i in range(50)]}
    server = _ContractServer({"listRuns": full})
    try:
        with pytest.raises(RuntimeError, match="run list is full"):
            server.product.run_count()
    finally:
        server.close()


def test_a_kill_already_in_force_is_never_drilled():
    in_force = {**CONTRACT["listKillsInForce"], "body": {**CONTRACT["listKillsInForce"]["body"], "inForce": [CONTRACT["engageKill"]["body"]]}}
    server = _ContractServer({"listKillsInForce": in_force})
    try:
        with pytest.raises(RuntimeError, match="already in force"):
            server.product.engage_agent_kill("agent_1", "drill")
        assert ("POST", "/api/t/inspect-ext-flue/admin/agents/kill-switch", "session") not in server.seen
    finally:
        server.close()


def test_the_run_key_must_be_an_agent_key():
    with pytest.raises(ValueError, match="iflk_"):
        HttpProduct("http://127.0.0.1:1", "s", "c", "a-session-token")


# ── Task 10's missing keys come from the admission sentence alone ───────────


def test_missing_keys_are_read_from_the_required_input_sentence():
    r = CONTRACT["startRunMissingInput"]
    assert missing_input_keys(r["status"], r["body"]) == ["question"]


def test_an_unknown_workflow_names_no_missing_key_though_its_key_says_question():
    r = CONTRACT["startRunUnknownWorkflow"]
    assert "question" in r["body"]["error"]["message"]
    assert missing_input_keys(r["status"], r["body"]) == []


class _RefusingProduct:
    def __init__(self, status, body):
        self.answer = (status, body)
        self.runs = 3

    def run_count(self):
        return self.runs

    def start_run(self, workflow_key, run_input):
        assert run_input == {}
        return self.answer


def test_task_10_passes_only_on_the_sentence_that_names_the_key():
    task = TASKS["missing-input-is-refused-at-admission"]
    seed = SeedManifest(agent_id="agent_1")
    for name, expected in (("startRunMissingInput", "PASS"), ("startRunUnknownWorkflow", "FAIL")):
        r = CONTRACT[name]
        sample = run_sample(_RefusingProduct(r["status"], r["body"]), task, "no-question", "flue", seed, FakeClock())
        assert verdicts.score(sample["taskId"], sample["facts"], "flue") == expected, name


def test_a_started_run_without_a_run_id_stops_the_pass():
    task = TASKS["missing-input-is-refused-at-admission"]
    with pytest.raises(RuntimeError, match="without a runId"):
        run_sample(_RefusingProduct(201, {"id": "run_1"}), task, "no-question", "flue", SeedManifest(agent_id="a"), FakeClock())


# ── The task file loads the way the workflow's ``inspect eval`` loads it ─────


def test_tasks_py_imports_no_sibling_relatively():
    import ast

    tree = ast.parse((HERE.parent / "inflect_inspect" / "tasks.py").read_text(encoding="utf-8"))
    relative = [n.module or "." for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level > 0]
    assert relative == []


def test_tasks_py_loads_by_path_outside_its_package():
    pytest.importorskip("inspect_ai")
    from inspect_ai._util.module import load_module

    module = load_module(HERE.parent / "inflect_inspect" / "tasks.py")
    assert len(module.governed_runs(engine="flue").dataset) == 10
    assert len(module.governed_runs(engine="tool-runner").dataset) == 8
