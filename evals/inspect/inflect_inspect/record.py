"""Write the evaluation record in the house shape: facts only.

The record names the set by hash, the engine, the model revision the decision
rows reported and the deployment, then one entry per sample with its raw facts.
It never carries a verdict, a score or a rate: those are recomputed by
``src/lib/ai/evals/inspect-record.ts`` (``scripts/inspect-record-check.ts``),
which refuses a record that states one. This writer refuses the two mistakes
it can see locally: an overlapping sample and a stated figure.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List

SCHEMA_ID = "inflect-inspect-record/1"
SAMPLE_KEYS = {"taskId", "inputId", "epoch", "startedAtMs", "settledAtMs", "facts"}


def canonical_json(value: Any) -> str:
    """``src/lib/canonical-json.ts``: sorted keys, no whitespace."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def task_set_hash(task_set: Dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(task_set).encode("utf-8")).hexdigest()


def build_record(
    task_set: Dict[str, Any],
    engine: str,
    model: Dict[str, str],
    deployment: Dict[str, str],
    ran_at: str,
    samples: List[Dict[str, Any]],
) -> Dict[str, Any]:
    for s in samples:
        extra = set(s) - SAMPLE_KEYS
        if extra:
            raise ValueError(f"a sample carries {sorted(extra)}; a record states facts only")
    ordered = sorted(samples, key=lambda s: s["startedAtMs"])
    for a, b in zip(ordered, ordered[1:]):
        if b["startedAtMs"] < a["settledAtMs"]:
            raise ValueError(f"samples overlap ({a['taskId']} and {b['taskId']}): one sample in flight at a time")
    return {
        "schema": SCHEMA_ID,
        "taskSetHash": task_set_hash(task_set),
        "engine": engine,
        "model": model,
        "deployment": deployment,
        "ranAt": ran_at,
        "samples": samples,
    }
