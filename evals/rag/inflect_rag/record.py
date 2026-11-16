"""The record, in `src/lib/ai/evals/rag-record.ts`'s shape (Ragas 1.3).

Built from raw values only: the product's answers, what it retrieved, each
case's retrieval probe (from the retrieval stage), the four metric values and
the abstention verdict. No aggregate, rate or floor figure is written — the
TypeScript schema is strict, so one would be an unknown key, and the job
validates every record with it before it is uploaded.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .answers import RetrievedChunk

MAX_RETRIEVED = 50


class ForeignSource(Exception):
    """An answer cited a chunk that is not one of the answer tenant's sources."""


def chunk_refs(retrieved: Sequence[RetrievedChunk], sources: Sequence[Mapping[str, Any]]) -> list[dict]:
    """The product's chunk keys as the set's: a source the manifest does not hold is refused."""
    key_of = {(s["sourceModel"], s["sourceId"]): s["sourceKey"] for s in sources}
    out = []
    for r in retrieved[:MAX_RETRIEVED]:
        key = key_of.get((r.source_model, r.source_id))
        if key is None:
            raise ForeignSource(f"the answer cited {r.source_model} {r.source_id}, which the answer tenant does not hold")
        out.append({"sourceModel": "Policy", "sourceKey": key, "chunkIndex": r.chunk_index})
    return out


def iso_now(now: datetime | None = None) -> str:
    t = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def build_record(
    *,
    retrieval: Mapping[str, Any],
    judge_revision: Mapping[str, str],
    status: str,
    spend_usd: float,
    cases: Sequence[Mapping[str, Any]],
    ran_at: str,
) -> dict:
    if status not in ("COMPLETE", "BUDGET_EXHAUSTED"):
        raise ValueError(f"status {status}")
    probes = {c["caseId"]: c["retrievalProbe"] for c in retrieval["cases"]}
    out_cases = []
    for c in cases:
        if c["caseId"] not in probes:
            raise ValueError(f"the retrieval stage did not probe case {c['caseId']}")
        out_cases.append({**c, "retrievalProbe": probes[c["caseId"]]})
    return {
        "setHash": retrieval["setHash"],
        "corpus": "seed",
        "retrieverRevision": retrieval["retrieverRevision"],
        "judgeRevision": dict(judge_revision),
        "ranAt": ran_at,
        "status": status,
        # The meter's settled sum, rounded to the micro-dollar it counts in.
        "spendUsd": round(float(spend_usd), 6),
        "probeCorpus": retrieval["probeCorpus"],
        "cases": out_cases,
    }
