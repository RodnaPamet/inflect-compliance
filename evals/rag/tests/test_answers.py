"""The answer contract: what the product's answer route must return, held from both sides."""

from __future__ import annotations

import json

import pytest

from inflect_rag.answers import AnswerContractError, RetrievedChunk, parse_answer
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
