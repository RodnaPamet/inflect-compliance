"""The judge keeps raw values: a value Ragas cannot compute is None and says why, never 0 or 1."""

from __future__ import annotations

import asyncio
import json
import math

import pytest

from inflect_rag.judge import JUDGED, MAX_OUTPUT_CHARS, Judge, raw_value, _clip
from inflect_rag.meter import BudgetExhausted

from .conftest import FakeEmbeddings, FakeLLM


def judge(exhausted: bool = False) -> tuple[Judge, FakeLLM]:
    llm = FakeLLM()
    return Judge(llm, FakeEmbeddings(), lambda: exhausted), llm


def test_a_grounded_answer_scores_from_the_judges_raw_verdicts() -> None:
    j, llm = judge()
    s = asyncio.run(j.score("Is MFA required?", "Yes, for critical systems.", ["MFA is required for critical systems."], "Yes."))
    assert s.metrics == {"faithfulness": 1.0, "answerRelevancy": 1.0, "contextPrecision": 1.0, "contextRecall": 1.0}
    assert s.abstained is False
    # Faithfulness 2 calls, relevancy 3 (strictness), precision 1 per context, recall 1, abstention 1.
    assert len(llm.calls) == 8
    assert {o["metric"] for o in s.judge_outputs} == set(JUDGED)


def test_no_retrieval_is_not_assessed_never_zero() -> None:
    j, _ = judge()
    s = asyncio.run(j.score("Is MFA required?", "The documents do not contain this.", [], "Yes."))
    assert s.metrics["faithfulness"] is None
    assert s.metrics["contextPrecision"] is None
    assert s.metrics["contextRecall"] is None
    assert s.abstained is True
    notes = {o["metric"]: o["output"] for o in s.judge_outputs}
    assert "not assessed: ValueError" in notes["faithfulness"]


def test_an_answer_with_no_statements_is_nan_and_so_none() -> None:
    j, _ = judge()
    s = asyncio.run(j.score("Q?", "The documents do not contain this.", ["context"], "ref"))
    assert s.metrics["faithfulness"] is None  # Ragas returns NaN for no statements


def test_a_refused_call_stops_the_run_rather_than_scoring_none() -> None:
    class Refusing(FakeLLM):
        async def agenerate(self, prompt, response_model):  # type: ignore[override]
            raise RuntimeError("402 budget_exhausted")

    j = Judge(Refusing(), FakeEmbeddings(), lambda: True)
    with pytest.raises(BudgetExhausted):
        asyncio.run(j.score("Q?", "A.", ["c"], "ref"))


def test_raw_values() -> None:
    assert raw_value(float("nan")) is None
    assert raw_value(None) is None
    assert raw_value(1.0000000001) == 1.0
    assert raw_value(-1e-9) == 0.0
    assert raw_value(1.5) is None
    assert raw_value(0.3333333333) == 0.333333
    assert not math.isnan(raw_value(0.5) or 0)


def test_outputs_are_clipped_to_the_records_bound() -> None:
    long = "x" * (MAX_OUTPUT_CHARS * 2)
    clipped = _clip(long)
    assert len(clipped) <= MAX_OUTPUT_CHARS
    assert "characters cut" in clipped
    assert _clip("short") == "short"


def test_each_metric_keeps_its_outputs_as_one_json_list() -> None:
    j, _ = judge()
    s = asyncio.run(j.score("Q?", "Yes.", ["c1", "c2"], "ref"))
    precision = next(o for o in s.judge_outputs if o["metric"] == "contextPrecision")
    assert len(json.loads(precision["output"])) == 2
