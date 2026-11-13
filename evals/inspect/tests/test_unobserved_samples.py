"""A sample the harness cannot observe never crashes the pass and is never a verdict.

Run 43380027909 (the nightly on main, 2026-11-13) produced no record on either
engine, and the harness turned two product problems into two crashes:

* Flue: two runs did not settle within the runner's 600 s deadline. The runner
  raised the built-in ``TimeoutError``, which Inspect treats as its own time
  limit: it logged "Unexpected timeout error reached top of sample stack" and
  SCORED the state as it stood, with no ``sample`` stored, so the scorer died
  on ``KeyError: 'sample'`` and the task was interrupted before any sample
  completed (record: MALFORMED, no samples).
* Tool Runner: every profile start was refused at admission (POST /agent-runs
  starts no profile since #5367: PROFILE_TRIGGER_REQUIRED), so ``run`` was
  None, and task 4's scorer subscripted it: ``TypeError`` interrupted the pass
  after 3 of 8 samples (record: FACTS_INCOMPLETE).

The Tool Runner now starts its runs as the AUTOMATION trigger, through the
profile's seeded rule (owner decision, 2026-11-13). The stub product below
refuses a profile key at ``POST /agent-runs`` exactly as the product does, so
a runner that went back to that route would have every sample refused; and a
start the rule path does not complete (the dispatch refused it, the action
failed, the trigger task was refused) is held to the same contract.

These tests replay both through the real solver and scorer, and through
Inspect itself, and hold the contract: every sample runs, a missing fact is
INCOMPLETE (NOANSWER) in Inspect's log and FACTS_INCOMPLETE in the record, and
nothing missing is ever a PASS.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from inflect_inspect import verdicts  # noqa: E402
from inflect_inspect.record import build_record  # noqa: E402
from inflect_inspect.runner import Clock, PassMustStop, RunNotObserved, SeedManifest, run_sample  # noqa: E402

TASK_SET = json.loads((HERE.parent / "task-set.json").read_text(encoding="utf-8"))
TASKS = {t["id"]: t for t in TASK_SET["tasks"]}
GOLDEN = json.loads((HERE.parent / "fixtures" / "verdict-cases.json").read_text(encoding="utf-8"))
CONTRACT = json.loads((HERE.parent / "fixtures" / "product-contract.json").read_text(encoding="utf-8"))["routes"]
PROFILE_REFUSAL = {
    "error": {
        "code": "BAD_REQUEST",
        "message": "PROFILE_TRIGGER_REQUIRED: An agent profile runs from the Ask page, an automation rule or the "
        "Behaviour tab's Test run, as its version allows. This start is none of them.",
        "requestId": "req_9",
    }
}
PROFILES = {}
for t in TASK_SET["tasks"]:
    arm = t["engines"]["tool-runner"]
    if "profileFixture" in arm:
        PROFILES.setdefault(arm["profileFixture"], f"agent-profile:p{len(PROFILES)}@v1")
SEED = SeedManifest(
    agent_id="agent_1",
    profiles=PROFILES,
    markers={"flagged-tool-result-halts-the-run": "M2", "secret-shaped-value-never-crosses-a-tool-boundary": "M9", "delegate-answer-reenters-as-untrusted": "M6"},
    rule_id="rule_1",
)
# The run key a trigger task's title fires, as the seeded rule's filter and config say.
KEY_FOR_TITLE = {
    i["text"]: PROFILES[t["engines"]["tool-runner"]["profileFixture"]]
    for t in TASK_SET["tasks"]
    if "profileFixture" in t["engines"]["tool-runner"]
    for i in t["inputs"]
}


class FakeClock(Clock):
    def __init__(self):
        self.t = 1_000

    def now_ms(self):  # type: ignore[override]
        self.t += 10
        return self.t

    def sleep(self, s):  # type: ignore[override]
        self.t += int(s * 1000)


class Product:
    """A product whose runs never settle (``hang``), whose starts are refused (``refuse``),
    or whose abort does not take (``stuck``).

    A profile run starts only through the rule (``create_task``), as in the
    product: ``start_run`` refuses a profile key PROFILE_TRIGGER_REQUIRED. On
    the rule path ``refuse`` is the dispatch refusing the start (the execution
    SUCCEEDED, no run appears), ``action-failed`` an execution that FAILED and
    ``task-refused`` a trigger task the product refused.
    """

    def __init__(self, mode: str):
        self.mode = mode
        self.aborted = []
        self.started = 0
        self.tasks = []
        self.executions = []
        self.runs = []

    def start_run(self, workflow_key, run_input):
        if workflow_key.startswith("agent-profile:"):
            return 400, PROFILE_REFUSAL  # #5367: the generic route names no trigger
        self.started += 1
        if not run_input:  # the product's own answer to task 10's absent question
            r = CONTRACT["startRunMissingInput"]
            return r["status"], r["body"]
        if self.mode == "refuse":
            return 400, PROFILE_REFUSAL
        return 201, {"runId": f"run_{self.started}", "status": "RUNNING"}

    def create_task(self, title):
        if self.mode == "task-refused":
            return 403, {"error": {"code": "FORBIDDEN", "message": "You lack tasks.create in this workspace", "requestId": "r"}}
        self.tasks.append(title)
        key = f"TSK-{len(self.tasks)}"
        execution = {"id": f"exec_{len(self.tasks)}", "status": "FAILED" if self.mode == "action-failed" else "SUCCEEDED",
                     "errorMessage": "Action INVOKE_AGENT failed: secret text" if self.mode == "action-failed" else None,
                     "triggerPayload": {"key": key, "title": title}}
        self.executions.insert(0, execution)
        if self.mode not in ("refuse", "action-failed"):
            self.started += 1
            self.runs.insert(0, {"id": f"run_{self.started}", "workflowKey": KEY_FOR_TITLE[title], "agentId": "agent_1", "parentExecutionId": ""})
        return 201, {"id": f"task_{len(self.tasks)}", "key": key, "title": title}

    def rule_executions(self, rule_id):
        assert rule_id == SEED.rule_id
        return list(self.executions)

    def agent_runs(self, agent_id):
        assert agent_id == SEED.agent_id
        return list(self.runs)

    def get_run(self, run_id):
        status = "ABORTED" if run_id in self.aborted and self.mode != "stuck" else "RUNNING"
        return {"status": status, "stepCount": 0, "startedAt": "2026-11-13T06:45:53.000Z", "completedAt": None}

    def abort_run(self, run_id):
        self.aborted.append(run_id)

    def get_steps(self, run_id):
        return []

    def risk_count(self):
        return 120

    def run_count(self):
        return 3

    def residency(self):
        return "LOCAL_ONLY"

    def agent_grants(self, agent_id):
        return ["list_findings"]

    def proposals_created_entity(self, ids):
        return {i: False for i in ids}

    def engage_agent_kill(self, agent_id, reason):
        return {"id": "ks_1", "engagedAt": "2026-11-13T06:45:54.000Z"}

    def lift_kill(self, switch_id, reason):
        pass


def _applicable(engine):
    return [(t, i["id"]) for t in TASK_SET["tasks"] if "notApplicable" not in t["engines"][engine] for i in t["inputs"]]


# ── The record contract: a missing fact is never a verdict ───────────────────


def test_required_facts_are_the_record_modules():
    # tests/unit/inspect-evaluation-record.test.ts holds missingFacts() to the same table.
    assert verdicts.REQUIRED_FACTS == GOLDEN["requiredFacts"]
    assert set(verdicts.REQUIRED_FACTS) == set(verdicts.SCORERS) == set(TASKS)


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=[c["name"] for c in GOLDEN["cases"]])
def test_any_required_fact_unread_is_incomplete_never_a_verdict(case):
    for key in GOLDEN["requiredFacts"][case["taskId"]]:
        facts = {**case["facts"], key: None}
        answer, explanation = verdicts.inspect_outcome({"taskId": case["taskId"], "facts": facts}, case["engine"])
        assert answer == verdicts.INCOMPLETE, (case["name"], key)
        assert key in explanation


def test_the_scorer_never_raises():
    assert verdicts.inspect_outcome(None, "flue")[0] == verdicts.NOT_RUN
    assert verdicts.inspect_outcome({"taskId": "no-such-task", "facts": {}}, "flue")[0] == verdicts.NOT_RUN
    assert verdicts.inspect_outcome(None, "flue", "not started: KeyError: 'X'") == (verdicts.NOT_RUN, "NOT_RUN: not started: KeyError: 'X'")
    # Complete facts in a shape the scorer cannot read: reported, not raised.
    broken = {**GOLDEN["cases"][0]["facts"], "steps": [{"kind": "MODEL_CALL"}]}
    answer, _ = verdicts.inspect_outcome({"taskId": GOLDEN["cases"][0]["taskId"], "facts": broken}, "tool-runner")
    assert answer == verdicts.UNSCORABLE
    case = next(c for c in GOLDEN["cases"] if c["expected"] == "PASS")
    assert verdicts.inspect_outcome({"taskId": case["taskId"], "facts": case["facts"]}, case["engine"])[0] == "PASS"


# ── The runner: what the nightly hit, sample by sample ───────────────────────


def test_a_run_that_never_settles_is_aborted_and_comes_back_unobserved():
    product = Product("hang")
    task = TASKS["writes-become-proposals-never-commits"]
    with pytest.raises(RunNotObserved) as caught:
        run_sample(product, task, "add-risk-now", "flue", SEED, FakeClock(), deadline_s=0.05, poll_s=0.01)
    err = caught.value
    assert not isinstance(err, TimeoutError)  # Inspect would treat it as its own limit
    assert product.aborted == ["run_1"]
    assert "did not settle within 0.05s" in err.reason and "RUNNING" in err.reason
    facts = err.sample["facts"]
    assert facts["run"] is None and facts["steps"] == [] and facts["entityCounts"] is None
    assert err.sample["settledAtMs"] >= err.sample["startedAtMs"]
    assert verdicts.inspect_outcome(err.sample, "flue")[0] == verdicts.INCOMPLETE


def test_a_run_the_abort_does_not_stop_ends_the_pass():
    with pytest.raises(PassMustStop, match="still RUNNING after the abort"):
        run_sample(Product("stuck"), TASKS["token-cap-halts-at-the-boundary"], "list-everything", "flue", SEED, FakeClock(), deadline_s=0.05, poll_s=0.01)


def test_a_settled_run_whose_ledger_cannot_be_read_claims_no_run():
    class Unreadable(Product):
        def get_run(self, run_id):
            return {"status": "FAILED", "errorMessage": "tool_runner_local_only_unserved: x", "stepCount": 0,
                    "startedAt": "2026-11-13T06:45:53.000Z", "completedAt": "2026-11-13T06:45:54.000Z"}

        def get_steps(self, run_id):
            raise RuntimeError("GET /agent-runs/run_1/steps: HTTP 500")

    product = Unreadable("hang")
    with pytest.raises(RunNotObserved, match="HTTP 500") as caught:
        run_sample(product, TASKS["local-only-opens-no-external-socket"], "summarise-posture", "tool-runner", SEED, FakeClock())
    # FAILED with no model step would PASS task 4: a run read without its steps is no fact.
    assert caught.value.sample["facts"]["run"] is None
    assert caught.value.sample["facts"]["residencyBefore"] == "LOCAL_ONLY"
    assert product.aborted == []  # it had settled: nothing to stop


def test_a_read_before_the_start_failing_starts_nothing():
    class NoSettings(Product):
        def residency(self):
            raise RuntimeError("GET /admin/security-settings: HTTP 403")

    product = NoSettings("hang")
    with pytest.raises(RunNotObserved, match="not started"):
        run_sample(product, TASKS["local-only-opens-no-external-socket"], "summarise-posture", "flue", SEED, FakeClock())
    assert product.started == 0


def test_a_refused_start_is_logged_by_code_and_scored_incomplete(caplog):
    caplog.set_level(logging.WARNING, logger="inflect_inspect")
    task = TASKS["local-only-opens-no-external-socket"]
    sample = run_sample(Product("refuse"), task, "summarise-posture", "flue", SEED, FakeClock())
    assert sample["facts"]["admission"] == {"httpStatus": 400, "missingKeys": []}
    assert sample["facts"]["run"] is None
    assert verdicts.inspect_outcome(sample, "flue")[0] == verdicts.INCOMPLETE
    assert "HTTP 400 PROFILE_TRIGGER_REQUIRED" in caplog.text
    assert "Behaviour tab" not in caplog.text  # the code, never the sentence


# ── The Tool Runner starts through its rule; a refused start is never a pass ─


def _tool_runner(product, task_id="every-model-call-has-a-decision-row", **kw):
    task = TASKS[task_id]
    return run_sample(product, task, task["inputs"][0]["id"], "tool-runner", SEED, FakeClock(), poll_s=0.01, **kw)


def test_a_tool_runner_sample_starts_through_its_rule_and_never_the_generic_route():
    class Settles(Product):
        def start_run(self, workflow_key, run_input):
            raise AssertionError("a profile run never starts at POST /agent-runs")

        def get_run(self, run_id):
            return {"status": "COMPLETED", "errorMessage": None, "costTokens": 10, "stepCount": 0,
                    "startedAt": "2026-11-13T06:45:53.000Z", "completedAt": "2026-11-13T06:45:54.000Z"}

    product = Settles("hang")
    sample = _tool_runner(product)
    text = TASKS["every-model-call-has-a-decision-row"]["inputs"][0]["text"]
    assert product.tasks == [text]  # one task, titled with the sample's input
    assert sample["facts"]["run"]["status"] == "COMPLETED"


@pytest.mark.parametrize("mode", ["refuse", "action-failed", "task-refused"])
def test_a_refused_tool_runner_start_is_incomplete_and_never_a_pass(mode, caplog):
    caplog.set_level(logging.WARNING, logger="inflect_inspect")
    product = Product(mode)
    with pytest.raises(RunNotObserved) as caught:
        _tool_runner(product, "local-only-opens-no-external-socket", find_deadline_s=0.05)
    sample = caught.value.sample
    assert sample["facts"]["run"] is None and sample["facts"]["steps"] == []
    assert sample["facts"]["residencyBefore"] == "LOCAL_ONLY"  # read before the trigger, kept
    answer, explanation = verdicts.inspect_outcome(sample, "tool-runner", caught.value.reason)
    assert answer == verdicts.INCOMPLETE and "run" in explanation
    assert product.runs == [] and product.aborted == []  # nothing started, nothing to stop
    assert "secret text" not in caplog.text and "tasks.create" not in caplog.text  # statuses and codes, never text
    expected = {
        "refuse": "no run started within 0.05s",
        "action-failed": "is FAILED: its action started no run",
        "task-refused": "HTTP 403 FORBIDDEN; no rule fired",
    }[mode]
    assert expected in caught.value.reason


def test_a_rule_that_has_not_acted_by_the_deadline_ends_the_pass():
    class Silent(Product):
        def create_task(self, title):
            self.tasks.append(title)
            return 201, {"id": "task_1", "key": "TSK-1", "title": title}

    with pytest.raises(PassMustStop, match="had not acted on the trigger task"):
        _tool_runner(Silent("hang"), find_deadline_s=0.05)


@pytest.mark.parametrize("extra", ["second-run", "other-key", "other-cause"])
def test_a_run_the_rule_did_not_start_ends_the_pass(extra):
    class Crowded(Product):
        def create_task(self, title):
            status, body = super().create_task(title)
            if extra == "second-run":
                self.runs.insert(0, {"id": "run_x", "workflowKey": KEY_FOR_TITLE[title], "parentExecutionId": None})
            elif extra == "other-key":
                self.runs[0]["workflowKey"] = "ad-hoc-question"
            else:
                self.runs[0]["parentExecutionId"] = "exec_elsewhere"
            return status, body

    with pytest.raises(PassMustStop):
        _tool_runner(Crowded("hang"))


def test_a_trigger_task_request_lost_in_flight_ends_the_pass():
    class Lost(Product):
        def create_task(self, title):
            raise OSError("connection reset")

    with pytest.raises(PassMustStop, match="trigger task request failed"):
        _tool_runner(Lost("hang"))


@pytest.mark.parametrize("read", ["rule_executions", "agent_runs"])
def test_a_read_that_fails_once_the_task_exists_ends_the_pass(read):
    class Blind(Product):
        def __init__(self, mode):
            super().__init__(mode)
            self.reads = 0

        def agent_runs(self, agent_id):
            self.reads += 1
            if read == "agent_runs" and self.tasks:
                raise RuntimeError("GET /agent-runs?agentId=: HTTP 502")
            return super().agent_runs(agent_id)

        def rule_executions(self, rule_id):
            if read == "rule_executions":
                raise RuntimeError("GET /automation/rules/rule_1/executions: HTTP 502")
            return super().rule_executions(rule_id)

    # The task was created, so its rule may have started a run nobody named.
    with pytest.raises(PassMustStop, match="could not be read"):
        _tool_runner(Blind("hang"))


def test_runs_already_there_are_never_taken_for_the_rules():
    product = Product("refuse")
    product.runs = [{"id": "run_old", "workflowKey": KEY_FOR_TITLE[TASKS["every-model-call-has-a-decision-row"]["inputs"][0]["text"]], "parentExecutionId": ""}]
    with pytest.raises(RunNotObserved, match="no run started"):
        _tool_runner(product, find_deadline_s=0.05)


# ── Through Inspect: every sample runs, none is a pass, the record says why ──


def _tasks_module():
    pytest.importorskip("inspect_ai")
    from inspect_ai._util.module import load_module

    return load_module(HERE.parent / "inflect_inspect" / "tasks.py")


@pytest.mark.parametrize("engine,mode", [("flue", "hang"), ("tool-runner", "refuse"), ("tool-runner", "hang")])
def test_the_nightlys_two_failures_complete_every_sample_through_inspect(engine, mode, monkeypatch, tmp_path):
    from inspect_ai import eval as inspect_eval
    from inspect_ai.log import read_eval_log

    tasks = _tasks_module()
    product = Product(mode)
    monkeypatch.setattr(tasks, "_seed_for", lambda slug, task_def, eng: SEED)
    monkeypatch.setattr(tasks, "_product_for", lambda slug, seed: product)
    monkeypatch.setattr(tasks, "run_sample", functools.partial(run_sample, clock=FakeClock(), deadline_s=0.05, poll_s=0.01, find_deadline_s=0.05))

    [log] = inspect_eval(tasks.governed_runs(engine=engine), model="mockllm/model", max_samples=1, log_dir=str(tmp_path), display="none")
    log = read_eval_log(log.location)
    expected = len(_applicable(engine))
    assert log.status == "success", log.error
    assert len(log.samples) == expected  # nothing interrupted the pass
    answers = {s.id: s.scores["ledger_scorer"].answer for s in log.samples}
    # The missing-input task is answered by its admission alone; every other sample is unread.
    assert all(a == verdicts.INCOMPLETE for sid, a in answers.items() if not sid.startswith("missing-input")), answers
    assert all(s.scores["ledger_scorer"].value != "C" for s in log.samples if not s.id.startswith("missing-input"))

    samples = [s.metadata["sample"] for s in log.samples if "sample" in s.metadata]
    assert len(samples) == expected
    record = build_record(TASK_SET, engine, {"provider": "anthropic", "revision": "r"}, {}, "2026-11-13T00:00:00.000Z", samples)
    unread = [s["taskId"] for s in record["samples"] if verdicts.missing_facts(s["taskId"], s["facts"])]
    assert set(unread) == {t["id"] for t, _ in _applicable(engine)} - {"missing-input-is-refused-at-admission"}


def test_a_sample_the_solver_could_not_configure_is_not_run(monkeypatch):
    tasks = _tasks_module()
    monkeypatch.delenv("INSPECT_SEED_MANIFEST", raising=False)
    state = SimpleNamespace(metadata={"task": TASKS["kill-mid-run-stops-the-next-model-call"], "inputId": "three-reads"}, epoch=1, completed=False)
    state = asyncio.run(tasks.governed_run("flue")(state, None))
    assert "sample" not in state.metadata and state.metadata["harnessError"].startswith("not started: KeyError")
    score = asyncio.run(tasks.ledger_scorer("flue")(state, None))
    assert (score.answer, score.value) == (verdicts.NOT_RUN, "N")


def test_a_pass_that_must_stop_is_not_swallowed(monkeypatch):
    tasks = _tasks_module()
    monkeypatch.setattr(tasks, "_seed_for", lambda slug, task_def, eng: SEED)
    monkeypatch.setattr(tasks, "_product_for", lambda slug, seed: Product("stuck"))
    monkeypatch.setattr(tasks, "run_sample", functools.partial(run_sample, clock=FakeClock(), deadline_s=0.05, poll_s=0.01))
    state = SimpleNamespace(metadata={"task": TASKS["token-cap-halts-at-the-boundary"], "inputId": "list-everything"}, epoch=1, completed=False)
    with pytest.raises(PassMustStop):
        asyncio.run(tasks.governed_run("flue")(state, None))
