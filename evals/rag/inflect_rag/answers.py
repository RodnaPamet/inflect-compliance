"""The answer stage's seam: what the product answered, as the judge reads it.

Ragas 1.2 measures the PRODUCT's composed pipeline (retrieve through
`search_knowledge`, answer, with every guard in between), never a
reimplementation of it. The product answers IN PROCESS, before the judge runs:
`scripts/rag-eval/answer.ts` asks the assistant each question as a person in
the answer tenant, with `search_knowledge` mounted for that tenant alone by
the evaluation's scoped decision (`src/app-layer/services/rag-evaluation-mount.ts`),
and writes one response per case into an ANSWERS FILE (`rag-answers@1`). This
module reads that file, through one small written contract —
`evals/rag/fixtures/answer-contract.json`, which `tests/unit/` reads too — and
a run with no answers file writes NO record (an empty answer scored by the
judge would be a record about nothing, and a record is what the mount gate
opens on).

One response, per case:

    {"answer": "...",
     "retrieved": [{"sourceModel": "PolicyVersion", "sourceId": "...", "chunkIndex": 0, "text": "..."}],
     "retriever": {"embeddingModel": "...", "k": 20},
     "usage": {"inputTokens": 0, "outputTokens": 0} | null}

`retrieved` is what `search_knowledge` returned to the model, in call order;
`retriever` is what the product says it ran, and must equal the revision the
retrieval stage measured; `usage` is informational.

The answers' SPEND is not reserved here: every answer turn went through the
same metering proxy as the judge, which charged it to the ragas share as it was
sent. So the answers and the judge share one share, and an answer turn that
could pass it was refused by the proxy (402) — the answer stage then stopped,
and its file says BUDGET_EXHAUSTED and names the cases it did not reach, which
this reader reports to the run as the budget stopping it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from .meter import BudgetExhausted


class AnswerContractError(Exception):
    """The product's answers are outside the contract; the run stops rather than guess."""


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
    def answer(self, case_id: str, question: str) -> ProductAnswer: ...


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


ANSWERS_CONTRACT = "rag-answers@1"
ANSWERS_STATUSES = ("COMPLETE", "BUDGET_EXHAUSTED")
MAX_CASES = 200


class FileAnswerTarget:
    """The answer stage's file, held to `rag-answers@1`: bound to the set and the revision, every case once."""

    def __init__(self, path: str, *, set_hash: str, retriever_revision: dict[str, Any]):
        with open(path, encoding="utf-8") as f:
            body = json.load(f)
        if not isinstance(body, dict) or set(body) != {"contract", "setHash", "retrieverRevision", "status", "answers", "unanswered"}:
            raise AnswerContractError("the answers file is not {contract, setHash, retrieverRevision, status, answers, unanswered}")
        if body["contract"] != ANSWERS_CONTRACT:
            raise AnswerContractError(f"the answers file speaks {body['contract']!r}, not {ANSWERS_CONTRACT}")
        if body["setHash"] != set_hash:
            raise AnswerContractError("the answers file answers another set than the retrieval stage measured")
        if body["retrieverRevision"] != retriever_revision:
            raise AnswerContractError("the answers file was retrieved under another revision than the retrieval stage measured")
        if body["status"] not in ANSWERS_STATUSES:
            raise AnswerContractError(f"the answers file's status is {body['status']!r}")
        answers, unanswered = body["answers"], body["unanswered"]
        if not isinstance(answers, list) or not isinstance(unanswered, list) or len(answers) > MAX_CASES or len(unanswered) > MAX_CASES:
            raise AnswerContractError("answers and unanswered are lists of at most 200 cases")
        self.status: str = body["status"]
        self._by_case: dict[str, tuple[str, ProductAnswer]] = {}
        for a in answers:
            if not isinstance(a, dict) or set(a) != {"caseId", "question", "response"}:
                raise AnswerContractError("an answer is not {caseId, question, response}")
            if a["caseId"] in self._by_case:
                raise AnswerContractError(f"case {a['caseId']} is answered twice")
            self._by_case[a["caseId"]] = (a["question"], parse_answer(a["response"]))
        self.unanswered = set(unanswered)
        if self.unanswered & set(self._by_case):
            raise AnswerContractError("a case is both answered and unanswered")
        if self.status == "COMPLETE" and self.unanswered:
            raise AnswerContractError("a COMPLETE file leaves no case unanswered")
        if self.status == "BUDGET_EXHAUSTED" and not self.unanswered:
            raise AnswerContractError("a BUDGET_EXHAUSTED file names the cases it did not answer")

    def answer(self, case_id: str, question: str) -> ProductAnswer:
        found = self._by_case.get(case_id)
        if found is None:
            if case_id in self.unanswered and self.status == "BUDGET_EXHAUSTED":
                raise BudgetExhausted(f"the share ran out before the product answered {case_id}")
            raise AnswerContractError(f"the answers file holds no answer for {case_id}")
        asked, parsed = found
        if asked != question:
            raise AnswerContractError(f"the answers file asked {case_id} another question than the set's")
        return parsed
