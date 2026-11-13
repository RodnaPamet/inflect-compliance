"""The product's own REST API, as a seed tenant's agent and its OWNER.

Each credential on the route its holder already uses, and no harness route.

A FLUE run is started with the seed agent's bound API key
(``Authorization: Bearer iflk_...``) at ``POST /agent-runs``:
``startWorkflowRun`` refuses any reasoning-engine run whose context carries no
``agentId`` (``flue_requires_registered_agent``), and only an agent-bound key
sets one; a session never does.

A TOOL RUNNER run is an agent profile's, and since #5367 a profile key names
the trigger that starts it; ``POST /agent-runs`` names none, so it starts no
profile. The harness starts one as the AUTOMATION trigger, the way production
starts an unattended run (owner decision, 2026-11-13): the seed gave each
profile an ENABLED ``INVOKE_AGENT`` rule firing on ``TASK_CREATED`` for its
samples' titles, so the OWNER creating a task titled with the sample's input
(``POST /tasks``) fires that rule, and ``agent-invoke-dispatch`` starts the
run as the profile's agent under the rule author's membership, through
``startWorkflowRun``'s ordinary admission. The rule's execution
(``GET /automation/rules/:id/executions``) says whether it acted, and the run
is the one row of the agent's runs (``GET /agent-runs?agentId=``) that was not
there before the task.

Either way the run is bound to the agent task 3's AGENT-scope kill and task
5's grants read refer to. Everything else (the run, its step feed, the
proposals, the counts, the settings, the kill switch, the trigger task) is read
or written as the seed tenant's OWNER with a session cookie, through the routes
the product's own pages call. The harness never reads the database.

Every response shape read here is pinned in ``fixtures/product-contract.json``,
which ``tests/unit/inspect-harness-product-contract.test.ts`` holds to the
product's types and the pytest suite serves to this module over HTTP.

The target is the CI test deployment on localhost; nothing here can be pointed
anywhere else (``INSPECT_PRODUCT_URL`` must be a loopback http origin).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Protocol, Tuple

MAX_BODY_BYTES = 4 * 1024 * 1024
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
# ``listWorkflowRuns`` returns at most this many rows when the route passes no
# ``take``. A list that full cannot say whether a run row was added.
RUN_LIST_PAGE = 50
# How many of a rule's newest executions are read to find the one a trigger task fired.
EXECUTION_PAGE = 25
RESIDENCIES = {"EXTERNAL", "LOCAL_ONLY"}


class Product(Protocol):
    """What the runner needs. The pytest stubs implement the same."""

    def start_run(self, workflow_key: str, run_input: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]: ...
    def get_run(self, run_id: str) -> Dict[str, Any]: ...
    def get_steps(self, run_id: str) -> List[Dict[str, Any]]: ...
    def abort_run(self, run_id: str) -> None: ...
    def risk_count(self) -> int: ...
    def run_count(self) -> int: ...
    def residency(self) -> str: ...
    def agent_grants(self, agent_id: str) -> List[str]: ...
    def proposals_created_entity(self, proposal_ids: Iterable[str]) -> Dict[str, bool]: ...
    def engage_agent_kill(self, agent_id: str, reason: str) -> Dict[str, Any]: ...
    def lift_kill(self, switch_id: str, reason: str) -> None: ...
    def create_task(self, title: str) -> Tuple[int, Dict[str, Any]]: ...
    def rule_executions(self, rule_id: str) -> List[Dict[str, Any]]: ...
    def agent_runs(self, agent_id: str) -> List[Dict[str, Any]]: ...


class HttpProduct:
    def __init__(
        self,
        base_url: str,
        tenant_slug: str,
        session_cookie: str,
        agent_key: Optional[str] = None,
        timeout_s: float = 30.0,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in _LOOPBACK:
            raise ValueError("the harness targets the CI test deployment on loopback only")
        # A Tool Runner tenant holds no agent key: its runs start from its
        # automation rules. Where one is handed over it must be one.
        if agent_key is not None and not agent_key.startswith("iflk_"):
            raise ValueError("a run is started with the seed agent's bound API key (iflk_...)")
        self._base = f"{base_url.rstrip('/')}/api/t/{urllib.parse.quote(tenant_slug)}"
        self._origin = f"{parsed.scheme}://{parsed.netloc}"
        self._cookie = session_cookie
        self._agent_key = agent_key
        self._timeout = timeout_s

    def _call(
        self, method: str, path: str, body: Optional[Dict[str, Any]] = None, as_agent: bool = False
    ) -> Tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self._base + path, data=data, method=method)
        if as_agent:
            # The key alone: the edge lets an iflk_ Bearer through to the
            # handler, which binds the agent. No cookie rides along.
            req.add_header("Authorization", f"Bearer {self._agent_key}")
        else:
            req.add_header("Cookie", self._cookie)
            req.add_header("Origin", self._origin)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:  # noqa: S310 — loopback only, checked above
                status, raw = res.status, res.read(MAX_BODY_BYTES + 1)
        except urllib.error.HTTPError as err:
            status, raw = err.code, err.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            raise RuntimeError(f"{method} {path}: response over {MAX_BODY_BYTES} bytes")
        try:
            return status, json.loads(raw or b"null")
        except ValueError:
            return status, None

    def _ok(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        status, payload = self._call(method, path, body)
        if status >= 400:
            raise RuntimeError(f"{method} {path}: HTTP {status}")
        return payload

    def start_run(self, workflow_key: str, run_input: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        if self._agent_key is None:
            raise ValueError("no agent key was handed over: this tenant's runs start from its automation rules")
        status, payload = self._call(
            "POST", "/agent-runs", {"workflowKey": workflow_key, "input": run_input}, as_agent=True
        )
        return status, payload if isinstance(payload, dict) else {}

    def get_run(self, run_id: str) -> Dict[str, Any]:
        run = self._ok("GET", f"/agent-runs/{urllib.parse.quote(run_id)}")
        if not isinstance(run, dict):
            raise RuntimeError(f"run {run_id} is not readable")
        return run

    def abort_run(self, run_id: str) -> None:
        self._ok("POST", f"/agent-runs/{urllib.parse.quote(run_id)}/abort")

    def get_steps(self, run_id: str) -> List[Dict[str, Any]]:
        steps: List[Dict[str, Any]] = []
        cursor = -1
        for _ in range(50):  # 50 pages of 200 is past any run the caps admit
            page = self._ok("GET", f"/agent-runs/{urllib.parse.quote(run_id)}/steps?sinceSeq={cursor}&take=200")
            steps.extend(page["steps"])
            if not page["hasMore"]:
                return steps
            cursor = page["cursor"]
        raise RuntimeError("step feed did not end within 50 pages")

    def risk_count(self) -> int:
        # The UNPAGINATED list: its kpiCounts.total is an aggregate count of the
        # tenant's whole register. The paginated list (?limit=) carries no total.
        payload = self._ok("GET", "/risks")
        total = payload.get("kpiCounts", {}).get("total") if isinstance(payload, dict) else None
        if not isinstance(total, int) or isinstance(total, bool):
            raise RuntimeError("GET /risks carried no kpiCounts.total; the risk count cannot be read")
        return total

    def run_count(self) -> int:
        rows = self._ok("GET", "/agent-runs")
        if not isinstance(rows, list):
            raise RuntimeError("GET /agent-runs did not return the run list")
        if len(rows) >= RUN_LIST_PAGE:
            raise RuntimeError(
                f"the run list is full ({RUN_LIST_PAGE} rows); a new run row could not be told apart"
            )
        return len(rows)

    def residency(self) -> str:
        payload = self._ok("GET", "/admin/security-settings")
        value = payload.get("aiResidency") if isinstance(payload, dict) else None
        if value not in RESIDENCIES:
            raise RuntimeError("GET /admin/security-settings carried no known aiResidency")
        return str(value)

    def agent_grants(self, agent_id: str) -> List[str]:
        payload = self._ok("GET", f"/admin/agents/{urllib.parse.quote(agent_id)}/tools")
        granted = payload.get("granted") if isinstance(payload, dict) else None
        if not isinstance(granted, list):
            raise RuntimeError("GET /admin/agents/:id/tools carried no granted list")
        return sorted({str(row["toolName"]) for row in granted})

    def proposals_created_entity(self, proposal_ids: Iterable[str]) -> Dict[str, bool]:
        wanted = list(proposal_ids)
        if not wanted:
            return {}
        rows = self._ok("GET", "/agent-proposals")
        if not isinstance(rows, list):
            raise RuntimeError("GET /agent-proposals did not return the proposal list")
        by_id = {row["id"]: bool(row.get("createdEntityId")) for row in rows}
        missing = [pid for pid in wanted if pid not in by_id]
        if missing:
            raise RuntimeError(f"{len(missing)} of the run's proposals are not in the review list; their outcome is unread")
        return {pid: by_id[pid] for pid in wanted}

    def engage_agent_kill(self, agent_id: str, reason: str) -> Dict[str, Any]:
        """Engage an AGENT-scope kill; its record (``id``, ``engagedAt``), or a refusal to drill.

        ``engageKillSwitch`` answers an existing in-force kill's record rather
        than a new one, and lifting that afterwards would lift a kill the
        harness did not engage. So any kill in force (agent or tenant scope)
        stops the drill before it engages.
        """
        listed = self._ok("GET", "/admin/agents/kill-switch?inForceOnly=true")
        in_force = listed.get("inForce") if isinstance(listed, dict) else None
        if not isinstance(in_force, list):
            raise RuntimeError("the kill switch list carried no inForce set")
        if in_force:
            raise RuntimeError("a kill was already in force on the eval tenant; the drill would lift it")
        record = self._ok("POST", "/admin/agents/kill-switch", {"agentId": agent_id, "reason": reason})
        if not isinstance(record, dict) or record.get("agentId") != agent_id or record.get("liftedAt") is not None:
            raise RuntimeError("the kill switch did not answer with an in-force kill on the eval agent")
        return record

    def lift_kill(self, switch_id: str, reason: str) -> None:
        self._ok("PATCH", "/admin/agents/kill-switch", {"switchId": switch_id, "liftReason": reason})

    def create_task(self, title: str) -> Tuple[int, Dict[str, Any]]:
        """Create the task whose ``TASK_CREATED`` fires the sample's rule; (status, the task row)."""
        status, payload = self._call("POST", "/tasks", {"title": title})
        return status, payload if isinstance(payload, dict) else {}

    def rule_executions(self, rule_id: str) -> List[Dict[str, Any]]:
        """The rule's newest executions, newest first, each with its (scrubbed) trigger payload."""
        payload = self._ok("GET", f"/automation/rules/{urllib.parse.quote(rule_id)}/executions?limit={EXECUTION_PAGE}")
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise RuntimeError("GET /automation/rules/:id/executions carried no items")
        return items

    def agent_runs(self, agent_id: str) -> List[Dict[str, Any]]:
        """The runs one agent authorised, newest first. A full page cannot say whether a run was added."""
        rows = self._ok("GET", f"/agent-runs?agentId={urllib.parse.quote(agent_id)}")
        if not isinstance(rows, list):
            raise RuntimeError("GET /agent-runs?agentId= did not return the run list")
        if len(rows) >= RUN_LIST_PAGE:
            raise RuntimeError(
                f"the agent's run list is full ({RUN_LIST_PAGE} rows); a new run row could not be told apart"
            )
        return rows
