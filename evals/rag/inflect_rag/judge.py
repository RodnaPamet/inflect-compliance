"""The judge: Ragas's four metrics and the abstention verdict, per case (D-EV-2).

The model is the cost meter's share model (Haiku-class, `evals/cost-meter/shares.json`),
reached ONLY through the metering proxy on loopback, which holds the key and
reserves every call before it is sent. `answer_relevancy`'s embeddings come
from the deployment's own TEI (`multilingual-e5-small`, D-L4-3) running beside
the job, so nothing but the judge's prompts leaves the runner.

Raw values only. A metric Ragas cannot compute — NaN, or a ValueError for an
empty answer or empty contexts — is `None` ("not assessed"), never 0 or 1, and
the reason is kept in the case's raw judge outputs. Every aggregate is
recomputed later by `src/lib/ai/evals/rag-record.ts`; nothing here averages.
"""

from __future__ import annotations

import contextvars
import json
import math
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from pydantic import BaseModel, Field
from ragas.embeddings.base import BaseRagasEmbedding
from ragas.llms.base import InstructorBaseRagasLLM

# The keys a record's `judgeOutputs[].metric` may take (rag-record.ts JUDGED).
JUDGED = ("faithfulness", "answerRelevancy", "contextPrecision", "contextRecall", "abstained")
MAX_OUTPUT_CHARS = 8_192
# Each judge call's output bound; the proxy refuses a call that asks for more
# than its cap, and reserves exactly this much output in the worst case.
JUDGE_MAX_TOKENS = 1024

_current_metric: contextvars.ContextVar[str] = contextvars.ContextVar("current_metric", default="")


class AbstentionVerdict(BaseModel):
    """The abstention judge's structured answer."""

    reason: str = Field(..., description="One sentence on why")
    abstained: bool = Field(
        ...,
        description="true when the answer declines to answer the question from the documents "
        "(says the information is not there, or cannot be found); false when it gives a substantive answer",
    )


ABSTENTION_PROMPT = """You are checking an assistant that answers questions ONLY from an organisation's own documents.

Decide whether the ANSWER below declines to answer the QUESTION from those documents: for example it says the
documents do not contain the information, that it cannot find it, or that a document needed is missing.
An answer that gives a substantive answer, even a partial or wrong one, has NOT abstained.
Judge only what the answer says; do not judge whether it is correct.

QUESTION:
{question}

ANSWER:
{answer}
"""


class RecordingLLM(InstructorBaseRagasLLM):
    """Wraps a Ragas Instructor LLM and keeps every structured output, tagged by the metric being scored.

    Ragas's collections metrics refuse anything but an `InstructorBaseRagasLLM`;
    this one delegates `agenerate(prompt, response_model)` to the real one. The outputs
    are the record's raw `judgeOutputs`, kept for audit and never parsed into a
    figure.
    """

    def __init__(self, inner: Any):
        self.inner = inner
        self.outputs: list[tuple[str, str]] = []

    def generate(self, prompt: str, response_model: type) -> Any:  # pragma: no cover - the harness is async
        raise TypeError("the harness scores asynchronously")

    async def agenerate(self, prompt: str, response_model: type) -> Any:
        result = await self.inner.agenerate(prompt, response_model)
        try:
            text = result.model_dump_json()
        except Exception:  # noqa: BLE001 - kept as text whatever it is
            text = str(result)
        self.outputs.append((_current_metric.get(), text))
        return result


class TeiEmbeddings(BaseRagasEmbedding):
    """Ragas's embedding interface over TEI's `/embed`, with the E5 query prefix on both sides.

    answer_relevancy compares the question with questions generated from the
    answer: query against query, so both take `query: ` (the deployment's
    AI_EMBED_LOCAL_QUERY_PREFIX).
    """

    def __init__(self, base_url: str, prefix: str = "query: ", timeout: float = 30.0, post: Callable | None = None):
        if not base_url.startswith(("http://127.0.0.1", "http://localhost")):
            raise ValueError("TEI runs beside the job, on loopback")
        self.base_url = base_url.rstrip("/")
        self.prefix = prefix
        self.timeout = timeout
        self._post = post or self._http_post
        super().__init__(cache=None)

    def _http_post(self, path: str, body: dict) -> Any:
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - loopback only
            return json.loads(res.read())

    def model_id(self) -> str:
        req = urllib.request.Request(f"{self.base_url}/info", method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - loopback only
            return str(json.loads(res.read())["model_id"])

    def embed_texts(self, texts: Sequence[str], **_: Any) -> list[list[float]]:
        out = self._post("/embed", {"inputs": [f"{self.prefix}{t}" for t in texts], "truncate": True})
        if not isinstance(out, list) or len(out) != len(texts):
            raise RuntimeError("TEI answered a different number of vectors than texts sent")
        return [list(map(float, v)) for v in out]

    def embed_text(self, text: str, **kw: Any) -> list[float]:
        return self.embed_texts([text], **kw)[0]

    async def aembed_text(self, text: str, **kw: Any) -> list[float]:
        return self.embed_text(text, **kw)

    async def aembed_texts(self, texts: Sequence[str], **kw: Any) -> list[list[float]]:
        return self.embed_texts(texts, **kw)


@dataclass
class CaseScore:
    metrics: dict[str, float | None]
    abstained: bool | None
    judge_outputs: list[dict[str, str]] = field(default_factory=list)


def raw_value(value: Any) -> float | None:
    """A Ragas value as the record holds it: [0, 1], or None where Ragas computed nothing."""
    if value is None:
        return None
    v = float(getattr(value, "value", value))
    if math.isnan(v) or math.isinf(v):
        return None
    # Average precision divides by (sum + 1e-10): a float a hair over 1 is 1.
    if v > 1 and v - 1 < 1e-6:
        v = 1.0
    if v < 0 and v > -1e-6:
        v = 0.0
    if not 0 <= v <= 1:
        return None
    return round(v, 6)


def _clip(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    marker = f" …[{len(text) - MAX_OUTPUT_CHARS + 32} characters cut]"
    return text[: MAX_OUTPUT_CHARS - len(marker)] + marker


class Judge:
    """Scores one case. `exhausted` is asked after any failure, so a refused call stops the run."""

    def __init__(self, llm: Any, embeddings: Any, exhausted: Callable[[], bool], strictness: int = 3):
        from ragas.metrics.collections import (  # imported late: tests construct the judge with fakes
            AnswerRelevancy,
            ContextPrecisionWithReference,
            ContextRecall,
            Faithfulness,
        )

        self.llm = RecordingLLM(llm)
        self.exhausted = exhausted
        self.faithfulness = Faithfulness(llm=self.llm)
        self.answer_relevancy = AnswerRelevancy(llm=self.llm, embeddings=embeddings, strictness=strictness)
        self.context_precision = ContextPrecisionWithReference(llm=self.llm)
        self.context_recall = ContextRecall(llm=self.llm)

    async def _metric(self, name: str, fn: Callable[[], Any], errors: list[tuple[str, str]]) -> float | None:
        token = _current_metric.set(name)
        try:
            return raw_value(await fn())
        except Exception as err:  # noqa: BLE001 - a metric that fails is not assessed, and says why
            from .meter import BudgetExhausted

            if self.exhausted():
                raise BudgetExhausted(f"{name}: the share cannot fit the next judge call") from err
            errors.append((name, f"not assessed: {type(err).__name__}: {str(err)[:200]}"))
            return None
        finally:
            _current_metric.reset(token)

    async def score(self, question: str, answer: str, contexts: Sequence[str], reference: str) -> CaseScore:
        start = len(self.llm.outputs)
        errors: list[tuple[str, str]] = []
        ctx = list(contexts)
        metrics = {
            "faithfulness": await self._metric(
                "faithfulness", lambda: self.faithfulness.ascore(user_input=question, response=answer, retrieved_contexts=ctx), errors
            ),
            "answerRelevancy": await self._metric(
                "answerRelevancy", lambda: self.answer_relevancy.ascore(user_input=question, response=answer), errors
            ),
            "contextPrecision": await self._metric(
                "contextPrecision",
                lambda: self.context_precision.ascore(user_input=question, reference=reference, retrieved_contexts=ctx),
                errors,
            ),
            "contextRecall": await self._metric(
                "contextRecall", lambda: self.context_recall.ascore(user_input=question, retrieved_contexts=ctx, reference=reference), errors
            ),
        }
        abstained = await self._abstained(question, answer, errors)
        outputs: dict[str, list[str]] = {m: [] for m in JUDGED}
        for metric, text in self.llm.outputs[start:]:
            outputs.setdefault(metric, []).append(text)
        for metric, text in errors:
            outputs[metric].append(text)
        return CaseScore(
            metrics=metrics,
            abstained=abstained,
            judge_outputs=[{"metric": m, "output": _clip(json.dumps(v, ensure_ascii=False))} for m, v in outputs.items() if v],
        )

    async def _abstained(self, question: str, answer: str, errors: list[tuple[str, str]]) -> bool | None:
        token = _current_metric.set("abstained")
        try:
            verdict = await self.llm.agenerate(ABSTENTION_PROMPT.format(question=question, answer=answer), AbstentionVerdict)
            return bool(verdict.abstained)
        except Exception as err:  # noqa: BLE001 - no verdict is None, never read as either answer
            from .meter import BudgetExhausted

            if self.exhausted():
                raise BudgetExhausted("abstained: the share cannot fit the next judge call") from err
            errors.append(("abstained", f"no verdict: {type(err).__name__}: {str(err)[:200]}"))
            return None
        finally:
            _current_metric.reset(token)


def anthropic_judge_llm(proxy_url: str, model: str) -> Any:
    """The Ragas LLM for the judge: Anthropic's SDK pointed at the metering proxy.

    The key the SDK is given is a placeholder the proxy discards; the proxy
    holds the real one. `top_p` is dropped from Ragas's defaults because
    Anthropic's current models refuse `temperature` and `top_p` together, and
    `max_tokens` is the proxy's reservation unit.
    """
    from anthropic import AsyncAnthropic
    from ragas.llms import llm_factory

    # Not a key: a placeholder the SDK requires, which the proxy discards.
    client = AsyncAnthropic(base_url=proxy_url, api_key="held-by-the-metering-proxy", max_retries=2, timeout=120.0)  # pragma: allowlist secret
    llm = llm_factory(model, provider="anthropic", client=client, max_tokens=JUDGE_MAX_TOKENS, temperature=0.0)
    llm.model_args.pop("top_p", None)
    return llm
