"""The product's own REST API, as the seeded OWNER of an Inspect seed tenant.

Every read and write here is a route the product already serves to a person
with a session; the harness gets no bypass to measure what it measures, and it
never reads the database. One session cookie per tenant, passed in by the
workflow (it is masked there, and Inspect never sees it in a config it would
echo into a log).

The target is the CI test deployment on localhost; nothing here can be pointed
anywhere else (``INSPECT_PRODUCT_URL`` must be a loopback http origin).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Protocol, Tuple

MAX_BODY_BYTES = 4 * 1024 * 1024
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class Product(Protocol):
    """What the runner needs. ``StubProduct`` in the tests implements the same."""

    def start_run(self, workflow_key: str, run_input: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]: ...
    def get_run(self, run_id: str) -> Dict[str, Any]: ...
    def get_steps(self, run_id: str) -> List[Dict[str, Any]]: ...
    def risk_count(self) -> int: ...
    def run_count(self) -> int: ...
    def residency(self) -> str: ...
    def agent_grants(self, agent_id: str) -> List[str]: ...
    def proposal_created_entity(self, proposal_id: str) -> bool: ...
    def engage_agent_kill(self, agent_id: str, reason: str) -> Dict[str, Any]: ...
    def lift_kill(self, switch_id: str, reason: str) -> None: ...
    def kill_engaged_at(self, switch_id: str) -> str: ...


class HttpProduct:
    def __init__(self, base_url: str, tenant_slug: str, session_cookie: str, timeout_s: float = 30.0) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in _LOOPBACK:
            raise ValueError("the harness targets the CI test deployment on loopback only")
        self._base = f"{base_url.rstrip('/')}/api/t/{urllib.parse.quote(tenant_slug)}"
        self._origin = f"{parsed.scheme}://{parsed.netloc}"
        self._cookie = session_cookie
        self._timeout = timeout_s

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self._base + path, data=data, method=method)
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
        status, payload = self._call("POST", "/agent-runs", {"workflowKey": workflow_key, "input": run_input})
        return status, payload if isinstance(payload, dict) else {}

    def get_run(self, run_id: str) -> Dict[str, Any]:
        return self._ok("GET", f"/agent-runs/{urllib.parse.quote(run_id)}")

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
        payload = self._ok("GET", "/risks?limit=1")
        return int(payload.get("total") if isinstance(payload, dict) and "total" in payload else len(payload or []))

    def run_count(self) -> int:
        payload = self._ok("GET", "/agent-runs")
        rows = payload.get("runs", payload.get("items", [])) if isinstance(payload, dict) else payload
        return len(rows or [])

    def residency(self) -> str:
        return str(self._ok("GET", "/admin/ai-settings").get("aiResidency"))

    def agent_grants(self, agent_id: str) -> List[str]:
        payload = self._ok("GET", f"/admin/agents/{urllib.parse.quote(agent_id)}/tools")
        rows = payload.get("tools", payload) if isinstance(payload, dict) else payload
        return sorted({str(r.get("toolName") or r.get("name")) for r in rows or []})

    def proposal_created_entity(self, proposal_id: str) -> bool:
        payload = self._ok("GET", f"/agent-proposals/{urllib.parse.quote(proposal_id)}")
        return bool((payload or {}).get("createdEntityId"))

    def engage_agent_kill(self, agent_id: str, reason: str) -> Dict[str, Any]:
        return self._ok("POST", "/admin/agents/kill-switch", {"agentId": agent_id, "reason": reason})

    def lift_kill(self, switch_id: str, reason: str) -> None:
        self._ok("PATCH", "/admin/agents/kill-switch", {"switchId": switch_id, "liftReason": reason})

    def kill_engaged_at(self, switch_id: str) -> str:
        payload = self._ok("GET", "/admin/agents/kill-switch")
        rows = payload.get("switches", payload) if isinstance(payload, dict) else payload
        for row in rows or []:
            if row.get("id") == switch_id:
                return str(row["engagedAt"])
        raise RuntimeError("the engaged kill is not listed; task 3 cannot be timed on the server clock")
