"""Reduce what the product's API returns about a run into the record's facts.

Pure: the HTTP lives in ``product.py``. The rule this module holds is the
record's first one, NO CONTENT: step input and output text is read only to
derive a count, a code or one boolean against a fixture marker, and never
copied into a fact.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

ENGINE_SUPPLIED_TOOLS = {"task", "activate_skill"}
# Refusal codes read off a FAILED step's ``outputJson.error`` when it records no
# ``refused``: the engines record a guarded call's throw as ``{error: message}``,
# and the review latch's message leads with its code (``ReviewLatch.assertNotTripped``:
# ``ai_guard_review_required: awaiting human review since … — refusing <tool>``).
# An ALLOWLIST, so only a known code is ever kept, never a sentence.
ERROR_REFUSAL_CODES = {"ai_guard_review_required"}
_CAP_SENTENCE = re.compile(r"^Run halted at its ([A-Z_]+) cap of \d+(?:ms)? \(set by the ([A-Z_]+)\)")
_CODE_PREFIX = re.compile(r"^([a-z0-9_.-]{1,96}):")
# An engine's catch-all failure whose cause is the model provider's own 5xx:
# the Anthropic SDK's error message is ``<status> status code (no body)`` or
# ``<status> {<the provider's JSON>}``, and Flue wraps it in the submission it
# failed (``dispatch(sub_…) failed: …``). Flue has already retried it (three
# transient retries, with backoff) and the Tool Runner's client twice, so a run
# carrying it is one the provider refused to serve, not one the product ran.
MODEL_PROVIDER_UNAVAILABLE = "model_provider_unavailable"
_PROVIDER_5XX = re.compile(r"^(?:flue|tool_runner)_run_failed: (?:dispatch\([^)\s]*\) failed: )?5\d\d (?:status code \(no body\)|\{)")


def error_code(message: Optional[str]) -> Optional[str]:
    """The message reduced to a code; never the sentence."""
    if not message:
        return None
    cap = _CAP_SENTENCE.match(message)
    if cap:
        return f"cap_halt:{cap.group(1)}:{cap.group(2)}"
    if _PROVIDER_5XX.match(message):
        return MODEL_PROVIDER_UNAVAILABLE
    prefix = _CODE_PREFIX.match(message)
    return prefix.group(1) if prefix else "unclassified"


def _ms(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _json(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def step_refusal(output: Dict[str, Any]) -> Optional[str]:
    """``outputJson.refused``, else an allowlisted code leading ``outputJson.error``; never the text."""
    if isinstance(output.get("refused"), str):
        return output["refused"]
    error = output.get("error")
    prefix = _CODE_PREFIX.match(error) if isinstance(error, str) else None
    return prefix.group(1) if prefix and prefix.group(1) in ERROR_REFUSAL_CODES else None


def model_turn(raw: Any) -> Optional[Dict[str, int]]:
    """A feed row's ``modelTurn`` (``{segment, call}``), else None: two integers, ``call`` from 1, nothing else.

    The step projection lifts it out of the stored output (Flue records which
    model call issued each tool call). Absent on every other engine and on
    every step written before it existed, and None is "not recorded", never a turn.
    """
    if not isinstance(raw, dict) or set(raw) != {"segment", "call"}:
        return None
    segment, call = raw["segment"], raw["call"]
    ok = all(isinstance(v, int) and not isinstance(v, bool) for v in (segment, call)) and segment >= 0 and call >= 1
    return {"segment": segment, "call": call} if ok else None


def decision_row_facts(body: Any, steps: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """The run's decision rows (``GET /agent-runs/:id/decisions``, D-EV-8) joined to its MODEL_CALL steps.

    ``total`` is every row the run wrote; ``matched`` the rows whose
    ``inputDigest`` a MODEL_CALL step names as its ``decisionDigest``. A set,
    not a per-step join: a resumed Flue run's dispatches digest the same
    message, so two steps can name one digest, and its rows are counted once.
    A body the harness cannot read whole (not the shape, or ``truncated``) is
    UNREADABLE: a count drawn from part of the rows is no count. Digests are
    joined here and never kept: the facts hold two numbers.
    """
    unreadable = {"readable": False, "total": None, "matched": None}
    if not isinstance(body, dict) or body.get("truncated") is not False or not isinstance(body.get("rows"), list):
        return unreadable
    rows = body["rows"]
    if not all(isinstance(r, dict) and isinstance(r.get("inputDigest"), str) for r in rows):
        return unreadable
    digests = {s["decisionDigest"] for s in steps if s.get("kind") == "MODEL_CALL" and isinstance(s.get("decisionDigest"), str)}
    return {"readable": True, "total": len(rows), "matched": sum(1 for r in rows if r["inputDigest"] in digests)}


def run_facts(run: Dict[str, Any]) -> Dict[str, Any]:
    started, completed = _ms(run.get("startedAt")), _ms(run.get("completedAt"))
    return {
        "status": run["status"],
        "errorCode": error_code(run.get("errorMessage")),
        "costTokens": int(run.get("costTokens") or 0),
        "stepCount": int(run.get("stepCount") or 0),
        "settledAtMs": (completed - started) if (started is not None and completed is not None) else None,
    }


def step_facts(steps: Iterable[Dict[str, Any]], run_started_iso: str, created_entity: Dict[str, bool]) -> List[Dict[str, Any]]:
    """``steps`` are ``RunStepFeedRow`` objects; ``created_entity`` maps proposal id → has a created entity."""
    started = _ms(run_started_iso) or 0
    out = []
    for s in steps:
        inp, outp = _json(s.get("inputJson")), _json(s.get("outputJson"))
        model_calls = inp.get("modelCalls") if s["kind"] == "MODEL_CALL" else None
        refused = step_refusal(outp)
        delegation = s.get("delegation")
        out.append(
            {
                "seq": s["seq"],
                "kind": s["kind"],
                "status": s["status"],
                "tool": s.get("tool"),
                "guardVerdict": s.get("guardVerdict"),
                "guardRuleIds": list(s.get("guardRuleIds") or []),
                "costTokens": s.get("costTokens"),
                "modelCalls": int(model_calls) if isinstance(model_calls, int) else (0 if s["kind"] == "MODEL_CALL" else None),
                "hasDecisionDigest": bool(s.get("decisionDigest")),
                "engineSupplied": s.get("tool") in ENGINE_SUPPLIED_TOOLS,
                "refused": refused,
                "delegation": {"agent": delegation["agent"], "fromSeq": delegation.get("fromSeq")} if delegation else None,
                "modelTurn": model_turn(s.get("modelTurn")) if s["kind"] == "TOOL_CALL" else None,
                "proposals": [
                    {"kind": p["kind"], "status": p["status"], "createdEntity": bool(created_entity.get(p["id"], False))}
                    for p in s.get("proposals") or []
                ],
                "atMs": max(0, (_ms(s.get("at")) or started) - started),
            }
        )
    return out


def marker_seen_after(steps: Iterable[Dict[str, Any]], marker: str, read_tool: Optional[str]) -> bool:
    """Did the fixture's marker appear in a step AFTER the one that read it?

    With ``read_tool`` (tasks 2, 9) "after" is after the first step calling that
    tool; without it (task 6, where the whole sentence exists only once the
    delegate composes it) any step's stored input or output counts. One boolean;
    the text is never kept.
    """
    ordered = sorted(steps, key=lambda s: s["seq"])
    after = -1
    if read_tool:
        reads = [s["seq"] for s in ordered if s["kind"] == "TOOL_CALL" and s.get("tool") == read_tool]
        after = reads[0] if reads else -1
    for s in ordered:
        if s["seq"] <= after:
            continue
        if marker in (s.get("inputJson") or "") or (read_tool is None and marker in (s.get("outputJson") or "")):
            return True
    return False
