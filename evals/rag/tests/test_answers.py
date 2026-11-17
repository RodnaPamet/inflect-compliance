"""The answer contract: what the answer stage records for each question, and its answers file, held from both sides."""

from __future__ import annotations

import json

import pytest

from inflect_rag.answers import AnswerContractError, FileAnswerTarget, RetrievedChunk, parse_answer
from inflect_rag.meter import BudgetExhausted
from inflect_rag.record import ForeignSource, chunk_refs

from .conftest import FIXTURES

CONTRACT = json.loads((FIXTURES / "answer-contract.json").read_text())


@pytest.mark.parametrize("body", CONTRACT["accepted"])
def test_the_contract_accepts_its_examples(body: dict) -> None:
    parsed = parse_answer(body)
    assert parsed.answer == body["answer"]
    assert len(parsed.retrieved) == len(body["retrieved"])


@pytest.mark.parametrize("case", CONTRACT["refused"], ids=lambda c: c["why"])
def test_the_contract_refuses_what_it_lists(case: dict) -> None:
    with pytest.raises(AnswerContractError):
        parse_answer(case["body"])


def test_an_unreadable_usage_keeps_the_worst_case() -> None:
    body = dict(CONTRACT["accepted"][0], usage={"inputTokens": -1, "outputTokens": 3})
    assert parse_answer(body).usage is None


def test_a_cited_chunk_outside_the_answer_tenant_is_refused() -> None:
    sources = [{"sourceModel": "PolicyVersion", "sourceId": "v1", "sourceKey": "access-management-policy"}]
    assert chunk_refs([RetrievedChunk("PolicyVersion", "v1", 3, "t")], sources) == [
        {"sourceModel": "Policy", "sourceKey": "access-management-policy", "chunkIndex": 3}
    ]
    with pytest.raises(ForeignSource):
        chunk_refs([RetrievedChunk("PolicyVersion", "another-tenants-version", 0, "t")], sources)


FILES = CONTRACT["answersFile"]


def _target(tmp_path, body: dict) -> FileAnswerTarget:
    path = tmp_path / "answers.json"
    path.write_text(json.dumps(body))
    return FileAnswerTarget(str(path), set_hash=body.get("setHash", ""), retriever_revision=body.get("retrieverRevision", {}))


@pytest.mark.parametrize("body", FILES["accepted"], ids=lambda b: b["status"])
def test_the_answers_file_accepts_its_examples(tmp_path, body: dict) -> None:
    target = _target(tmp_path, body)
    for a in body["answers"]:
        assert target.answer(a["caseId"], a["question"]).answer == a["response"]["answer"]


@pytest.mark.parametrize("case", FILES["refused"], ids=lambda c: c["why"])
def test_the_answers_file_refuses_what_it_lists(tmp_path, case: dict) -> None:
    with pytest.raises(AnswerContractError):
        _target(tmp_path, case["body"])


def test_a_file_bound_to_another_set_or_revision_is_refused(tmp_path) -> None:
    body = FILES["accepted"][0]
    path = tmp_path / "answers.json"
    path.write_text(json.dumps(body))
    with pytest.raises(AnswerContractError, match="another set"):
        FileAnswerTarget(str(path), set_hash="sha256:" + "0" * 64, retriever_revision=body["retrieverRevision"])
    with pytest.raises(AnswerContractError, match="another revision"):
        FileAnswerTarget(str(path), set_hash=body["setHash"], retriever_revision={**body["retrieverRevision"], "k": 10})


def test_a_case_the_share_stopped_is_the_budget_stopping_the_run(tmp_path) -> None:
    body = next(b for b in FILES["accepted"] if b["status"] == "BUDGET_EXHAUSTED")
    target = _target(tmp_path, body)
    with pytest.raises(BudgetExhausted):
        target.answer(body["unanswered"][0], "anything")


def test_an_answer_to_another_question_is_refused(tmp_path) -> None:
    body = FILES["accepted"][0]
    target = _target(tmp_path, body)
    with pytest.raises(AnswerContractError, match="another question"):
        target.answer(body["answers"][0]["caseId"], "a different question")
