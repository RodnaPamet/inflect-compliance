"""The answer stage's seam: what the harness asks, and of whom.

Ragas 1.2 measures the PRODUCT's composed pipeline (retrieve through
`search_knowledge`, answer, with every guard in between), never a
reimplementation of it. That pipeline is being built (vector store Phase
3.1-3.5), so the harness speaks to it through one small, written contract —
`evals/rag/fixtures/answer-contract.json`, which `tests/unit/` reads too — and
a run with no answer target configured writes NO record (an empty answer
scored by the judge would be a record about nothing, and a record is what the
mount gate opens on).

The contract, per question:

    POST <answer url>   {"question": "..."}
    200 {"answer": "...",
         "retrieved": [{"sourceModel": "PolicyVersion", "sourceId": "...", "chunkIndex": 0, "text": "..."}],
         "retriever": {"embeddingModel": "...", "k": 10},
         "usage": {"inputTokens": 0, "outputTokens": 0} | null}

`retrieved` is what `search_knowledge` returned to the model, in rank order;
`retriever` is what the product says it ran, and must equal the revision the
retrieval stage measured; `usage` is the model spend the answer cost, settled
against the reservation made before the call (null keeps the worst case).

Every question is reserved at the answer turn's declared worst case through the
metering proxy BEFORE it is asked, so the answers and the judge share the job's
one share and an answer that could pass it is never requested.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from .meter import Meter


class AnswerContractError(Exception):
    """The answer target answered outside the contract; the run stops rather than guess."""


@dataclass(frozen=True)
class RetrievedChunk:
    source_model: str
    source_id: str
    chunk_index: int
    text: str


@dataclass(frozen=True)
class ProductAnswer:
    answer: str
    retrieved: tuple[RetrievedChunk, ...]
    embedding_model: str
    k: int
    usage: dict | None


class AnswerTarget(Protocol):
    def answer(self, question: str) -> ProductAnswer: ...


MAX_ANSWER_CHARS = 8_192
MAX_RETRIEVED = 50


def parse_answer(body: object) -> ProductAnswer:
    """Hold a response to the contract; anything else is refused, never coerced."""
    if not isinstance(body, dict):
        raise AnswerContractError("the response is not an object")
    extra = set(body) - {"answer", "retrieved", "retriever", "usage"}
    if extra:
        raise AnswerContractError(f"unknown member(s): {sorted(extra)}")
    answer = body.get("answer")
    if not isinstance(answer, str) or len(answer) > MAX_ANSWER_CHARS:
        raise AnswerContractError("answer is not a string of at most 8192 characters")
    retrieved = body.get("retrieved")
    if not isinstance(retrieved, list) or len(retrieved) > MAX_RETRIEVED:
        raise AnswerContractError("retrieved is not a list of at most 50 chunks")
    chunks = []
    for r in retrieved:
        if not isinstance(r, dict) or set(r) != {"sourceModel", "sourceId", "chunkIndex", "text"}:
            raise AnswerContractError("a retrieved chunk is not {sourceModel, sourceId, chunkIndex, text}")
        if not (isinstance(r["chunkIndex"], int) and r["chunkIndex"] >= 0 and isinstance(r["text"], str)):
            raise AnswerContractError("a retrieved chunk has a bad index or text")
        chunks.append(RetrievedChunk(str(r["sourceModel"]), str(r["sourceId"]), r["chunkIndex"], r["text"]))
    retriever = body.get("retriever")
    if not isinstance(retriever, dict) or set(retriever) != {"embeddingModel", "k"}:
        raise AnswerContractError("retriever is not {embeddingModel, k}")
    usage = body.get("usage")
    if usage is not None and not (
        isinstance(usage, dict)
        and set(usage) == {"inputTokens", "outputTokens"}
        and all(isinstance(v, int) and v >= 0 for v in usage.values())
    ):
        usage = None  # unreadable: the reservation keeps its worst case
    return ProductAnswer(answer, tuple(chunks), str(retriever["embeddingModel"]), int(retriever["k"]), usage)


class HttpAnswerTarget:
    """The contract over HTTP, metered: reserve the turn's worst case, ask, settle."""

    def __init__(
        self,
        url: str,
        meter: Meter,
        max_input_tokens: int,
        max_output_tokens: int,
        cookie: str | None = None,
        timeout: float = 180.0,
    ):
        if max_input_tokens < 1 or max_output_tokens < 1:
            raise ValueError("the answer turn needs a declared worst case to be metered")
        self.url = url
        self.meter = meter
        self.max_input_tokens = max_input_tokens
        self.max_output_tokens = max_output_tokens
        self.cookie = cookie
        self.timeout = timeout

    def answer(self, question: str) -> ProductAnswer:
        reservation = self.meter.reserve(self.max_input_tokens, self.max_output_tokens)
        usage: dict | None = None
        try:
            headers = {"content-type": "application/json"}
            if self.cookie:
                headers["cookie"] = self.cookie
            req = urllib.request.Request(
                self.url, data=json.dumps({"question": question}).encode(), method="POST", headers=headers
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - a configured test deployment
                if res.status != 200:
                    raise AnswerContractError(f"the answer target answered {res.status}")
                parsed = parse_answer(json.loads(res.read()))
            usage = parsed.usage
            return parsed
        finally:
            self.meter.settle(reservation, usage)
