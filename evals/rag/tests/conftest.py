"""Fakes for the harness's tests: a judge that answers by rule, embeddings, and a network fence.

The fence refuses every connection that is not to loopback, for every test:
the harness may reach the metering proxy and TEI — both on
the runner — and nothing else, and a library that phones home (Ragas's usage
analytics, a tokenizer download) fails here rather than in the nightly.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path
from typing import Any

import pytest
from ragas.embeddings.base import BaseRagasEmbedding
from ragas.llms.base import InstructorBaseRagasLLM

os.environ.setdefault("RAGAS_DO_NOT_TRACK", "true")

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"

DECLINE = "do not contain"


def canned(name: str, prompt: str) -> dict:
    """What the fake judge answers for one structured output, by its model's class name."""
    # The abstention prompt itself mentions declining; read only the answer it quotes.
    declining = DECLINE in (prompt.rsplit("ANSWER:", 1)[-1] if name == "AbstentionVerdict" else prompt)
    if name == "StatementGeneratorOutput":
        return {"statements": [] if declining else ["The policy requires it.", "It names the factors."]}
    if name == "NLIStatementOutput":
        return {"statements": [{"statement": "s", "reason": "supported", "verdict": 1}, {"statement": "t", "reason": "supported", "verdict": 1}]}
    if name == "AnswerRelevanceOutput":
        return {"question": "Is multi-factor authentication required?", "noncommittal": 1 if declining else 0}
    if name == "ContextPrecisionOutput":
        return {"reason": "useful", "verdict": 1}
    if name == "ContextRecallOutput":
        return {"classifications": [{"statement": "s", "reason": "in context", "attributed": 1}]}
    if name == "AbstentionVerdict":
        return {"reason": "by rule", "abstained": declining}
    raise AssertionError(f"the fake judge has no answer for {name}")


class FakeLLM(InstructorBaseRagasLLM):
    def __init__(self) -> None:
        self.calls: list[str] = []

    def generate(self, prompt: str, response_model: type) -> Any:  # pragma: no cover
        raise TypeError("async only")

    async def agenerate(self, prompt: str, response_model: type) -> Any:
        self.calls.append(response_model.__name__)
        return response_model.model_validate(canned(response_model.__name__, prompt))


class FakeEmbeddings(BaseRagasEmbedding):
    """Every text the same unit vector: the generated question always matches the asked one."""

    def __init__(self) -> None:
        super().__init__(cache=None)

    def model_id(self) -> str:
        return "intfloat/multilingual-e5-small"

    def embed_text(self, text: str, **_: Any) -> list[float]:
        return [1.0, 0.0, 0.0]

    async def aembed_text(self, text: str, **_: Any) -> list[float]:
        return [1.0, 0.0, 0.0]


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch: pytest.MonkeyPatch) -> None:
    real = socket.socket.connect

    def connect(self: socket.socket, address: Any) -> Any:
        if self.family in (socket.AF_INET, socket.AF_INET6):
            host = address[0]
            try:
                loop = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loop = host == "localhost"
            if not loop:
                raise AssertionError(f"the harness reached {host}, which is not on this runner")
        return real(self, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
