"""Run ONE sample: start the task's governed run, await settlement, read the ledger.

No Inspect import here, so the stub-product tests exercise the exact code the
solver runs. One sample is in flight on the whole deployment at a time (the
Phase 0 note's serial-execution rule): tasks 1 and 10 read tenant-wide counts
and task 3's kill would abort a concurrent sample, so the record refuses
overlapping samples and this module never starts a second run.

A sample that cannot be observed never crashes the pass. A run that does not
settle by the deadline is aborted (and re-read until it is no longer live),
and the sample comes back as ``RunNotObserved``: what was read before the
start, and no run. The solver stores it, the scorer reports it INCOMPLETE and
the record refuses it ``FACTS_INCOMPLETE``, naming the task; the next sample
still runs. Only a run that may still be live (unnamed, not stoppable, a kill
that would not lift) ends the pass, as ``PassMustStop``.

HOW A RUN STARTS depends on the arm. A registered-workflow arm (Flue) is the
ad-hoc question, which the OWNER asks at ``POST /agents/questions``: since
#5604 the product refuses ``ad-hoc-question`` on the generic
``POST /agent-runs`` (``AD_HOC_QUESTION_USE_QUESTIONS_ROUTE``), and the
questions route is for a person, so no key is presented (``product.py`` says
how the run still binds the eval agent). A profile arm (the Tool Runner) is
started as the AUTOMATION trigger (owner decision, 2026-11-13), because the
generic route names no trigger and so starts no profile (#5367): the harness
creates a task titled with the sample's input, the profile's seeded rule fires
on it, and the run is the one new row of the agent's runs
(``_start_through_rule``). A start the product refuses, by either path, leaves
no run, and the sample is INCOMPLETE, never a pass.

Each settled run is logged in one line (``_settled_line``): its status, error
code, the provider's HTTP status and error type when an engine's catch-all
failure names them, and its counts. Codes and numbers only, never text: the job log is where the
nightly is read (owner decision 2026-11-13), and a record says only
``tool_runner_run_failed`` for every request the provider refused. A FAILED
Tool Runner run whose stored error carries the provider's error type and
message gets one more line naming them (owner decision 2026-11-15;
``explain.provider_error`` reduces and redacts them), and a sample that is not
a pass gets a block of its facts from the scorer (``explain.py``).
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from . import ledger
from .explain import provider_error
from .product import Product

LIVE = {"RUNNING", "PAUSED"}
log = logging.getLogger("inflect_inspect")
# The prefix a product refusal leads its sentence with (``PROFILE_TRIGGER_REQUIRED:``).
_REFUSAL_CODE = re.compile(r"^([A-Z][A-Z0-9_]{2,63}):")


class RunNotObserved(RuntimeError):
    """The sample's run could not be observed to settlement; its facts claim no run.

    Raised in place of a crash, so the solver can store what WAS read and the
    pass moves on to the next sample. ``sample`` is the record-shaped sample
    whose ``run``, ``steps``, ``kill``, ``entityCounts`` and ``markerSeenAfter``
    are all unread (None / []): a half-read run is never a fact, because a
    scorer reading a settled status beside an unread step feed could pass a
    run it never saw (task 4 passes on FAILED with no model step). Every task
    names one of those as required, so the record refuses the sample
    ``FACTS_INCOMPLETE`` rather than scoring it.

    NOT a ``TimeoutError``: Inspect treats a TimeoutError reaching the top of a
    sample as its own time limit and scores the state as it stands, which is
    how a run that did not settle reached the scorer with no facts at all.
    """

    def __init__(self, sample: Dict[str, Any], reason: str) -> None:
        super().__init__(f"{sample['taskId']}: {reason}")
        self.sample = sample
        self.reason = reason


class _DidNotSettle(Exception):
    """The run was still live at the sample's deadline (internal: becomes ``RunNotObserved``)."""


class _NotStarted(Exception):
    """The start was refused and no run exists (internal: becomes ``RunNotObserved``)."""


class PassMustStop(RuntimeError):
    """A run may still be live on the deployment: no further sample may start.

    One sample in flight at a time is the record's rule, and the record's
    overlap check sees only the harness's own clock, never a run left going.
    So a run the harness cannot name, cannot stop or cannot confirm stopped
    ends the pass instead of the sample. The solver lets this through.
    """


def refusal_code(body: Dict[str, Any]) -> str:
    """A refused start's code, for the log: the sentence's leading code, else the error code. Never the text."""
    error = body.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        match = _REFUSAL_CODE.match(message) if isinstance(message, str) else None
        if match:
            return match.group(1)
        code = error.get("code")
        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", code):
            return code
    return "unclassified"
# Proposal statuses GET /agent-proposals never lists (NON_REVIEWABLE_STATUSES):
# terminal, and neither can have created an entity, so the step feed's own
# status is the fact. Any other proposal must be found in the list.
UNLISTED_PROPOSAL_STATUSES = {"QUARANTINED", "EXPIRED"}
# assertRequiredInputPresent's sentence, the one place a missing key is named.
_MISSING_INPUT = re.compile(r"^Workflow \S+ requires a non-empty ([A-Za-z0-9_]+(?:, [A-Za-z0-9_]+)*)\. Supply ")
# zod's sentence for a required body field that was not sent at all.
_ABSENT_FIELD = "received undefined"
# The one workflow the questions route starts (AD_HOC_QUESTION_WORKFLOW_KEY).
QUESTIONS_ROUTE_KEY = "ad-hoc-question"
# An engine's catch-all failure that carries the provider's HTTP status.
_PROVIDER_STATUS = re.compile(r"^(?:flue|tool_runner)_run_failed: (?:dispatch\([^)\s]*\) failed: )?([1-5]\d\d) ")
# The provider's error TYPE in that failure's JSON body (``"error":{"type":"invalid_request_error"``):
# a code from the provider's own vocabulary, never its message.
_PROVIDER_ERROR_TYPE = re.compile(r'^\{"type":"error","error":\{"type":"([a-z][a-z_]{0,63})"')
MARKER_READ_TOOL = {
    "flagged-tool-result-halts-the-run": "list_findings",
    "secret-shaped-value-never-crosses-a-tool-boundary": "list_controls",
    "delegate-answer-reenters-as-untrusted": None,
}


# Task 3's poll, in seconds: the kill is engaged at the first TOOL_CALL step the
# harness sees while the run is live, so the run must be found, and its first
# tool step seen, before its next model call ends. At a one-second poll a Tool
# Runner run reached its last step before the harness looked (run 43730125203).
KILL_TASK = "kill-mid-run-stops-the-next-model-call"
KILL_POLL_S = 0.25

# Execution statuses that are not yet an answer; any other is the rule's last word.
EXECUTION_IN_FLIGHT = {"PENDING", "RUNNING"}


@dataclass
class SeedManifest:
    """What the seed step wrote for one tenant: no secrets, ids and synthetic markers only."""

    agent_id: str
    profiles: Dict[str, str] = field(default_factory=dict)  # profileFixture → agent-profile:<id>@v<n>
    markers: Dict[str, str] = field(default_factory=dict)  # taskId → fixture marker
    # The automation rule a profile arm's run starts from; None for a run the
    # harness starts with the agent's key.
    rule_id: Optional[str] = None


def seed_for(tenant: Dict[str, Any], task: Dict[str, Any], engine: str) -> SeedManifest:
    """The seed one sample runs with, naming the agent its run binds.

    A Flue run binds the tenant's eval agent (``agentId``). A profile run binds
    the agent its profile runs as (``profileAgents``): the product refuses a key
    that speaks for another agent (``PROFILE_AGENT_MISMATCH``), an agent holds
    one profile, and only its version in force runs, so a Tool Runner tenant
    has one eval agent per profile. Task 3's kill and task 5's grants read
    refer to that same agent.
    """
    arm = task["engines"][engine]
    if "notApplicable" in arm:
        raise ValueError(f"{task['id']} is n/a on {engine}; the set decides that, never a run")
    rule_id: Optional[str] = None
    if "profileFixture" in arm:
        agent_id = (tenant.get("profileAgents") or {}).get(arm["profileFixture"])
        rule_id = (tenant.get("automationRules") or {}).get(arm["profileFixture"])
        if not isinstance(rule_id, str) or not rule_id:
            raise ValueError(f"the seed manifest names no automation rule for {task['id']} on {engine}")
    else:
        agent_id = tenant.get("agentId")
    if not isinstance(agent_id, str) or not agent_id:
        raise ValueError(f"the seed manifest names no agent for {task['id']} on {engine}")
    return SeedManifest(
        agent_id=agent_id,
        profiles=dict(tenant.get("profiles") or {}),
        markers=dict(tenant.get("markers") or {}),
        rule_id=rule_id,
    )


@dataclass
class Clock:
    now_ms: Callable[[], int] = lambda: int(time.time() * 1000)
    sleep: Callable[[float], None] = time.sleep


def workflow_key_for(task: Dict[str, Any], engine: str, seed: SeedManifest) -> str:
    arm = task["engines"][engine]
    if "notApplicable" in arm:
        raise ValueError(f"{task['id']} is n/a on {engine}; the set decides that, never a run")
    if "workflowKey" in arm:
        return arm["workflowKey"]
    return seed.profiles[arm["profileFixture"]]


def missing_input_keys(status: int, body: Dict[str, Any]) -> List[str]:
    """The keys an admission refusal NAMED as missing.

    Two refusals name one, both 400s and both before any run row exists:

    * the questions route's body schema (``AskSchema``), which refuses a body
      with no ``question`` as ``VALIDATION_ERROR``, one issue per field, each
      naming its field in ``path``: a field counts only when its issue is
      ``invalid_type`` for a value that was not sent at all;
    * ``assertRequiredInputPresent``'s sentence, for a run started anywhere
      else.

    Any other refusal (an unknown workflow key, a question that is not text, a
    residency or registration refusal) names none, whatever words its text
    contains.
    """
    error = body.get("error")
    if status != 400 or not isinstance(error, dict):
        return []
    if error.get("code") == "VALIDATION_ERROR":
        details = error.get("details")
        named = {
            issue["path"][0]
            for issue in (details if isinstance(details, list) else [])
            if isinstance(issue, dict)
            and issue.get("code") == "invalid_type"
            and isinstance(issue.get("message"), str)
            and issue["message"].endswith(_ABSENT_FIELD)
            and isinstance(issue.get("path"), list)
            and len(issue["path"]) == 1
            and isinstance(issue["path"][0], str)
        }
        return sorted(named)
    message = error.get("message")
    match = _MISSING_INPUT.match(message) if isinstance(message, str) else None
    return sorted(match.group(1).split(", ")) if match else []


def provider_status(message: Optional[str]) -> Optional[int]:
    """The provider's HTTP status an engine's catch-all failure names (``tool_runner_run_failed: 400 {...}``), else None."""
    match = _PROVIDER_STATUS.match(message) if isinstance(message, str) else None
    return int(match.group(1)) if match else None


def provider_error_type(message: Optional[str]) -> Optional[str]:
    """The provider's error type in an engine's catch-all failure (``invalid_request_error``), else None.

    Read only where ``provider_status`` reads a status, and only from the JSON
    body the SDK puts after it: a code, so it may go in the job log. The
    provider's message is not read; the worker's log line carries it.
    """
    match = _PROVIDER_STATUS.match(message) if isinstance(message, str) else None
    if not match:
        return None
    typed = _PROVIDER_ERROR_TYPE.match(message[match.end():])
    return typed.group(1) if typed else None


def _settled_line(task_id: str, run_id: str, run: Dict[str, Any], steps: List[Dict[str, Any]]) -> str:
    """One line for the job log about a settled run: codes and counts, never text."""
    facts = ledger.run_facts(run)
    status = provider_status(run.get("errorMessage"))
    error_type = provider_error_type(run.get("errorMessage"))
    model = [s for s in steps if s.get("kind") == "MODEL_CALL"]
    tools = [s for s in steps if s.get("kind") == "TOOL_CALL"]
    return (
        f"{task_id}: run {run_id} settled {facts['status']}"
        f" (errorCode {facts['errorCode'] or '-'}"
        + (f", provider HTTP {status}" if status is not None else "")
        + (f" {error_type}" if status is not None and error_type is not None else "")
        + f"), {len(model)} model step(s), {len(tools)} tool step(s), {facts['costTokens']} tokens"
    )


def run_sample(
    product: Product,
    task: Dict[str, Any],
    input_id: str,
    engine: str,
    seed: SeedManifest,
    clock: Clock = Clock(),
    deadline_s: float = 600.0,
    poll_s: float = 1.0,
    find_deadline_s: float = 120.0,
    diagnostics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One sample's facts. ``diagnostics``, when given, receives what the job log
    may print about the run and the record may not hold (``providerError``)."""
    task_id = task["id"]
    if task_id == KILL_TASK:
        poll_s = min(poll_s, KILL_POLL_S)
    text = next(i["text"] for i in task["inputs"] if i["id"] == input_id)
    key = workflow_key_for(task, engine, seed)
    through_rule = "profileFixture" in task["engines"][engine]
    if through_rule and (seed.rule_id is None or text is None):
        raise ValueError(f"{task_id} on {engine} starts from an automation rule: it needs the rule and an input to title the task")
    if not through_rule and key != QUESTIONS_ROUTE_KEY:
        raise ValueError(f"{task_id} on {engine} names {key}: the questions route starts {QUESTIONS_ROUTE_KEY} and nothing else")
    facts: Dict[str, Any] = {
        "admission": None,
        "run": None,
        "steps": [],
        "kill": None,
        "entityCounts": None,
        "decisionRows": None,  # D-EV-8: no REST read of a run's decision rows yet
        "markerSeenAfter": None,
        "residencyBefore": None,
        "grantsBefore": None,
    }

    count: Optional[Callable[[], int]] = None
    if task_id == "writes-become-proposals-never-commits":
        count = product.risk_count
    elif task_id == "missing-input-is-refused-at-admission":
        count = product.run_count
    started_at = clock.now_ms()
    try:
        before = count() if count else None
        if task_id == "local-only-opens-no-external-socket":
            facts["residencyBefore"] = product.residency()
        if task_id == "ungranted-tool-is-never-reached":
            facts["grantsBefore"] = product.agent_grants(seed.agent_id)
        # The agent's runs before the trigger: the run the rule starts is the
        # one row that was not there.
        runs_before = {r.get("id") for r in product.agent_runs(seed.agent_id)} if through_rule else set()
    except Exception as err:
        # Nothing was started: the sample is unobserved, the pass goes on.
        raise RunNotObserved(_unobserved(task_id, input_id, started_at, clock, facts), f"not started: {type(err).__name__}: {err}") from err

    run_input = {} if text is None else {"question": text}
    status, body = 0, {}
    if not through_rule:
        try:
            status, body = product.ask_question(run_input)
        except Exception as err:
            # The request may have reached the product and created a run the
            # harness cannot name.
            raise PassMustStop(f"{task_id}: the start request failed ({type(err).__name__}); a run may be live unnamed") from err
    run_id: Optional[str] = None
    settled = False
    switch_id: Optional[str] = None
    engaged_at: Optional[str] = None
    try:
        try:
            if through_rule:
                run_id = _start_through_rule(product, task_id, seed, key, text, runs_before, clock, find_deadline_s, poll_s)
            elif status >= 400:
                facts["admission"] = {"httpStatus": status, "missingKeys": missing_input_keys(status, body)}
                if task_id != "missing-input-is-refused-at-admission":
                    log.warning("%s: the start was refused, HTTP %s %s; no run to observe", task_id, status, refusal_code(body))
            elif status != 202:
                raise PassMustStop(f"{task_id}: the question answered HTTP {status}, neither started (202) nor refused")
            else:
                candidate = body.get("runId")
                if not isinstance(candidate, str) or not candidate:
                    # A started run the harness cannot name would run on unobserved
                    # beside the next sample: stop the pass rather than move on.
                    raise PassMustStop(f"{task_id}: the question answered 202 without a runId")
                run_id = candidate
            if run_id is not None:
                deadline = clock.now_ms() + int(deadline_s * 1000)
                while True:
                    run = product.get_run(run_id)
                    if task_id == KILL_TASK and switch_id is None and run["status"] in LIVE:
                        if any(s["kind"] == "TOOL_CALL" for s in product.get_steps(run_id)):
                            killed = product.engage_agent_kill(seed.agent_id, "inspect: kill-mid-run drill")
                            switch_id, engaged_at = killed["id"], killed["engagedAt"]
                    if run["status"] not in LIVE:
                        settled = True
                        break
                    if clock.now_ms() > deadline:
                        raise _DidNotSettle(
                            f"run {run_id} did not settle within {deadline_s:g}s "
                            f"(last read: {run['status']}, stepCount {run.get('stepCount')})"
                        )
                    clock.sleep(poll_s)
                steps = product.get_steps(run_id)
                log.warning("%s", _settled_line(task_id, run_id, run, steps))
                if engine == "tool-runner" and run["status"] == "FAILED":
                    # The provider's own error type and message (owner decision
                    # 2026-11-15), reduced and redacted by ``provider_error``.
                    perr = provider_error(run, list(seed.markers.values()))
                    if perr is not None:
                        log.warning("%s: run %s provider error type %s: %s", task_id, run_id, perr["type"], perr["message"])
                        if diagnostics is not None:
                            diagnostics["providerError"] = perr
                proposals = [p for s in steps for p in s.get("proposals") or []]
                created = {p["id"]: False for p in proposals if p["status"] in UNLISTED_PROPOSAL_STATUSES}
                created.update(
                    product.proposals_created_entity(p["id"] for p in proposals if p["status"] not in UNLISTED_PROPOSAL_STATUSES)
                )
                facts["run"] = ledger.run_facts(run)
                facts["steps"] = ledger.step_facts(steps, run["startedAt"], created)
                if switch_id is not None:
                    facts["kill"] = {"engagedAtMs": ledger._ms(engaged_at) - ledger._ms(run["startedAt"])}  # server clock, both
                if task_id in MARKER_READ_TOOL:
                    facts["markerSeenAfter"] = ledger.marker_seen_after(steps, seed.markers[task_id], MARKER_READ_TOOL[task_id])
        finally:
            if switch_id is not None:
                try:
                    product.lift_kill(switch_id, "inspect: drill complete")
                except Exception as err:
                    # A kill left in force aborts every later run on the agent.
                    raise PassMustStop(f"{task_id}: the drill's kill {switch_id} could not be lifted ({type(err).__name__})") from err
        if count is not None:
            facts["entityCounts"] = {"before": before, "after": count()}
    except PassMustStop:
        if run_id is not None and not settled:
            try:
                _stop(product, task_id, run_id)  # the pass ends either way; still, leave nothing running
            except PassMustStop:
                pass
        raise
    except Exception as err:
        if run_id is not None and not settled:
            _stop(product, task_id, run_id)
        reason = str(err) if isinstance(err, (_DidNotSettle, _NotStarted)) else f"{type(err).__name__}: {err}"
        raise RunNotObserved(_unobserved(task_id, input_id, started_at, clock, facts), reason) from err
    return {
        "taskId": task_id,
        "inputId": input_id,
        "startedAtMs": started_at,
        "settledAtMs": clock.now_ms(),
        "facts": facts,
    }


def _start_through_rule(
    product: Product,
    task_id: str,
    seed: SeedManifest,
    key: str,
    title: str,
    runs_before: set,
    clock: Clock,
    find_deadline_s: float,
    poll_s: float,
) -> str:
    """Start a profile run as the AUTOMATION trigger; its run id, or why there is none.

    The OWNER creates a task titled with the sample's input. Its
    ``TASK_CREATED`` fires the profile's seeded ``INVOKE_AGENT`` rule, which
    enqueues ``agent-invoke-dispatch``; that starts the run as the profile's
    agent under the rule author's membership, through ``startWorkflowRun``'s
    ordinary admission (kill switch, breaker, registration and residency gates,
    the version's own trigger check). Nothing here bypasses any of it.

    Two reads name the run. The rule's execution for THIS task (its trigger
    payload carries the task's key) says whether the rule acted: anything but
    SUCCEEDED is an action that started nothing. The run is then the one row of
    the agent's runs that was not there before the task, of the profile's run
    key. A direct ``TASK_CREATED`` firing records no execution on the run
    (``parentExecutionId`` is set only on a chained or sub-flow firing), so a
    run naming a DIFFERENT execution is refused, never one naming none.

    Refusals, none of them a pass:

    * the task refused, an execution that did not succeed, or no run within
      ``find_deadline_s`` of a SUCCEEDED execution (the dispatch refused it, or
      its start threw on every attempt): ``_NotStarted``, so the sample is
      unobserved and the pass goes on;
    * a task request that failed in flight, a task with no key, a read that
      failed once the task existed, no execution by the deadline (the rule may
      yet fire), two new runs, or a new run of another key: ``PassMustStop``,
      because a run may be live that the harness cannot name.
    """
    try:
        status, created = product.create_task(title)
    except Exception as err:
        raise PassMustStop(f"{task_id}: the trigger task request failed ({type(err).__name__}); its rule may have started a run unnamed") from err
    if status >= 400:
        log.warning("%s: the trigger task was refused, HTTP %s %s; no rule fired", task_id, status, refusal_code(created))
        raise _NotStarted(f"the trigger task was refused, HTTP {status} {refusal_code(created)}; no rule fired")
    if status != 201:
        raise PassMustStop(f"{task_id}: the trigger task answered HTTP {status}, neither created (201) nor refused")
    task_key = created.get("key")
    if not isinstance(task_key, str) or not task_key:
        raise PassMustStop(f"{task_id}: the trigger task answered no key; the execution its rule wrote cannot be named")

    deadline = clock.now_ms() + int(find_deadline_s * 1000)
    while True:
        try:
            listed = product.rule_executions(seed.rule_id)
        except Exception as err:
            # The task exists: its rule may have started a run nobody named.
            raise PassMustStop(f"{task_id}: the rule's executions could not be read after the trigger ({type(err).__name__})") from err
        execution = next((e for e in listed if (e.get("triggerPayload") or {}).get("key") == task_key), None)
        if execution is not None and execution.get("status") not in EXECUTION_IN_FLIGHT:
            if execution.get("status") != "SUCCEEDED":
                # Its status, never its message: the summary can carry text.
                log.warning("%s: rule %s answered the trigger task %s; no run was started", task_id, seed.rule_id, execution.get("status"))
                raise _NotStarted(f"the rule's execution {execution.get('id')} is {execution.get('status')}: its action started no run")
            try:
                rows = product.agent_runs(seed.agent_id)
            except Exception as err:
                raise PassMustStop(f"{task_id}: the agent's runs could not be read after its rule fired ({type(err).__name__})") from err
            new = [r for r in rows if r.get("id") not in runs_before]
            if len(new) > 1:
                raise PassMustStop(f"{task_id}: {len(new)} runs of agent {seed.agent_id} appeared for one trigger task")
            if new:
                run = new[0]
                run_id = run.get("id")
                if not isinstance(run_id, str) or not run_id:
                    raise PassMustStop(f"{task_id}: a run of agent {seed.agent_id} appeared without an id")
                if run.get("workflowKey") != key:
                    raise PassMustStop(f"{task_id}: run {run_id} of agent {seed.agent_id} runs another key; it is not this rule's")
                if run.get("parentExecutionId") not in (None, "", execution.get("id")):
                    raise PassMustStop(f"{task_id}: run {run_id} names another execution as its cause")
                return run_id
        if clock.now_ms() > deadline:
            if execution is None or execution.get("status") in EXECUTION_IN_FLIGHT:
                raise PassMustStop(
                    f"{task_id}: rule {seed.rule_id} had not acted on the trigger task within {find_deadline_s:g}s; it may still start a run"
                )
            log.warning("%s: rule %s fired but no run started within %gs", task_id, seed.rule_id, find_deadline_s)
            raise _NotStarted(
                f"the rule fired (execution {execution.get('id')} SUCCEEDED) but no run started within {find_deadline_s:g}s: "
                "agent-invoke-dispatch refused it or its start was refused on every attempt (the worker log says which)"
            )
        clock.sleep(poll_s)


def _unobserved(task_id: str, input_id: str, started_at: int, clock: Clock, facts: Dict[str, Any]) -> Dict[str, Any]:
    """The sample as far as it was read, claiming no run (``RunNotObserved``)."""
    return {
        "taskId": task_id,
        "inputId": input_id,
        "startedAtMs": started_at,
        "settledAtMs": clock.now_ms(),
        "facts": {**facts, "run": None, "steps": [], "kill": None, "entityCounts": None, "markerSeenAfter": None},
    }


def _stop(product: Product, task_id: str, run_id: str) -> None:
    """Abort a run the sample gives up on, and confirm it is no longer live, or stop the pass.

    Stopped, not abandoned: a run left going would overlap the next sample. The
    abort may answer an error for a run that settled meanwhile; the re-read is
    what decides.
    """
    try:
        product.abort_run(run_id)
    except Exception:  # noqa: BLE001 — the re-read below decides
        pass
    try:
        status = product.get_run(run_id)["status"]
    except Exception as err:
        raise PassMustStop(f"{task_id}: run {run_id} could not be re-read after the abort ({type(err).__name__})") from err
    if status in LIVE:
        raise PassMustStop(f"{task_id}: run {run_id} is still {status} after the abort")
