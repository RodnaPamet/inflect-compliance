"""Run ONE sample: start the task's governed run, await settlement, read the ledger.

No Inspect import here, so the stub-product tests exercise the exact code the
solver runs. One sample is in flight on the whole deployment at a time (the
Phase 0 note's serial-execution rule): tasks 1 and 10 read tenant-wide counts
and task 3's kill would abort a concurrent sample, so the record refuses
overlapping samples and this module never starts a second run.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from . import ledger
from .product import Product

LIVE = {"RUNNING", "PAUSED"}
# Proposal statuses GET /agent-proposals never lists (NON_REVIEWABLE_STATUSES):
# terminal, and neither can have created an entity, so the step feed's own
# status is the fact. Any other proposal must be found in the list.
UNLISTED_PROPOSAL_STATUSES = {"QUARANTINED", "EXPIRED"}
# assertRequiredInputPresent's sentence, the one place a missing key is named.
_MISSING_INPUT = re.compile(r"^Workflow \S+ requires a non-empty ([A-Za-z0-9_]+(?:, [A-Za-z0-9_]+)*)\. Supply ")
MARKER_READ_TOOL = {
    "flagged-tool-result-halts-the-run": "list_findings",
    "secret-shaped-value-never-crosses-a-tool-boundary": "list_controls",
    "delegate-answer-reenters-as-untrusted": None,
}


@dataclass
class SeedManifest:
    """What the seed step wrote for one tenant: no secrets, ids and synthetic markers only."""

    agent_id: str
    profiles: Dict[str, str] = field(default_factory=dict)  # profileFixture → agent-profile:<id>@v<n>
    markers: Dict[str, str] = field(default_factory=dict)  # taskId → fixture marker


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
    """The keys an admission refusal NAMED as missing, read from its sentence.

    Only a 400 whose message is ``assertRequiredInputPresent``'s sentence
    names any. Any other refusal (an unknown workflow key, a residency or
    registration refusal) names none, whatever words its text contains.
    """
    error = body.get("error")
    message = error.get("message") if isinstance(error, dict) else None
    if status != 400 or not isinstance(message, str):
        return []
    match = _MISSING_INPUT.match(message)
    return sorted(match.group(1).split(", ")) if match else []


def run_sample(
    product: Product,
    task: Dict[str, Any],
    input_id: str,
    engine: str,
    seed: SeedManifest,
    clock: Clock = Clock(),
    deadline_s: float = 600.0,
    poll_s: float = 1.0,
) -> Dict[str, Any]:
    task_id = task["id"]
    text = next(i["text"] for i in task["inputs"] if i["id"] == input_id)
    key = workflow_key_for(task, engine, seed)
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
    before = count() if count else None
    if task_id == "local-only-opens-no-external-socket":
        facts["residencyBefore"] = product.residency()
    if task_id == "ungranted-tool-is-never-reached":
        facts["grantsBefore"] = product.agent_grants(seed.agent_id)

    started_at = clock.now_ms()
    run_input = {} if text is None else {"question": text}
    status, body = product.start_run(key, run_input)
    switch_id: Optional[str] = None
    engaged_at: Optional[str] = None
    try:
        if status >= 400:
            facts["admission"] = {"httpStatus": status, "missingKeys": missing_input_keys(status, body)}
        elif status != 201:
            raise RuntimeError(f"{task_id}: the start answered HTTP {status}, neither started (201) nor refused")
        else:
            run_id = body.get("runId")
            if not isinstance(run_id, str) or not run_id:
                # A started run the harness cannot name would run on unobserved
                # beside the next sample: stop the pass rather than move on.
                raise RuntimeError(f"{task_id}: the start answered 201 without a runId")
            deadline = clock.now_ms() + int(deadline_s * 1000)
            while True:
                run = product.get_run(run_id)
                if task_id == "kill-mid-run-stops-the-next-model-call" and switch_id is None and run["status"] in LIVE:
                    if any(s["kind"] == "TOOL_CALL" for s in product.get_steps(run_id)):
                        killed = product.engage_agent_kill(seed.agent_id, "inspect: kill-mid-run drill")
                        switch_id, engaged_at = killed["id"], killed["engagedAt"]
                if run["status"] not in LIVE:
                    break
                if clock.now_ms() > deadline:
                    # Stopped, not abandoned: a run left going would overlap the
                    # next sample, which the record refuses.
                    product.abort_run(run_id)
                    raise TimeoutError(f"{task_id}: run {run_id} did not settle within {deadline_s}s")
                clock.sleep(poll_s)
            steps = product.get_steps(run_id)
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
            product.lift_kill(switch_id, "inspect: drill complete")
    if count is not None:
        facts["entityCounts"] = {"before": before, "after": count()}
    return {
        "taskId": task_id,
        "inputId": input_id,
        "startedAtMs": started_at,
        "settledAtMs": clock.now_ms(),
        "facts": facts,
    }

