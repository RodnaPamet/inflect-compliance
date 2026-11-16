"""The whole judge path, nothing faked between the harness and the wire.

Ragas's metrics → Instructor → the Anthropic SDK → the REAL metering proxy
(`evals/cost-meter/anthropic-proxy.mjs`, run under node) → a fake Anthropic
upstream that answers by rule. Beside it, a fake TEI and a fake answer route
speaking `fixtures/answer-contract.json`. So the test sees what the nightly
will send: the share's model, a `max_tokens` inside the proxy's cap, no
`top_p` beside `temperature`, no stream, and no key from the harness.

The record it produces is compared with `fixtures/mini-record.golden.json`,
which `tests/unit/rag-eval-harness-record.test.ts` validates with the
TypeScript schema on every pull request: the two languages are held to one
shape. Regenerate with UPDATE_GOLDEN=1 after a deliberate change.

Skipped where node or the repository's cost meter is absent (the image's test
stage, whose context is evals/rag alone).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import pytest

from inflect_rag.run import EXIT_NO_ANSWER_TARGET, main_async

from .conftest import FIXTURES, canned

REPO = Path(__file__).resolve().parents[3]
PROXY = REPO / "evals" / "cost-meter" / "anthropic-proxy.mjs"
GOLDEN = FIXTURES / "mini-record.golden.json"

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not PROXY.exists(), reason="needs node and evals/cost-meter")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(handle: Callable[[str, str, Any], tuple[int, Any]]) -> tuple[ThreadingHTTPServer, int]:
    class H(BaseHTTPRequestHandler):
        def _reply(self, method: str) -> None:
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n)) if n else None
            status, out = handle(method, self.path, body)
            data = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            self._reply("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._reply("POST")

        def log_message(self, *_: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


class Upstream:
    """A fake Anthropic: answers each tool call by rule, and keeps every request body."""

    def __init__(self) -> None:
        self.bodies: list[dict] = []

    def __call__(self, method: str, path: str, body: Any) -> tuple[int, Any]:
        assert (method, path) == ("POST", "/v1/messages")
        self.bodies.append(body)
        tool = body["tools"][0]["name"]
        content = body["messages"][-1]["content"]
        prompt = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content)
        return 200, {
            "id": f"msg_{len(self.bodies)}",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [{"type": "tool_use", "id": f"toolu_{len(self.bodies)}", "name": tool, "input": canned(tool, prompt)}],
            "stop_reason": "tool_use",
            "stop_sequence": None,
            "usage": {"input_tokens": 400, "output_tokens": 40},
        }


def answer_route(set_: dict, manifest: dict) -> Callable[[str, str, Any], tuple[int, Any]]:
    by_q = {c["question"]: c for c in set_["cases"]}
    version = {s["sourceKey"]: s["sourceId"] for s in manifest["answerTenant"]["sources"]}

    def handle(method: str, path: str, body: Any) -> tuple[int, Any]:
        c = by_q[body["question"]]
        refs = c["groundTruth"]["refs"]
        retrieved = [{"sourceModel": "PolicyVersion", "sourceId": version[r["sourceKey"]], "chunkIndex": i, "text": r["passage"]} for i, r in enumerate(refs)]
        if c.get("injected"):
            retrieved.append({"sourceModel": "PolicyVersion", "sourceId": version[c["injected"]["sourceKey"]], "chunkIndex": 0, "text": c["injected"]["text"]})
        answer = c["groundTruth"]["answer"] if refs else "The documents do not contain this information."
        return 200, {"answer": answer, "retrieved": retrieved, "retriever": {"embeddingModel": "intfloat/multilingual-e5-small", "k": 10}, "usage": {"inputTokens": 900, "outputTokens": 60}}

    return handle


def tei(method: str, path: str, body: Any) -> tuple[int, Any]:
    if (method, path) == ("GET", "/info"):
        return 200, {"model_id": "intfloat/multilingual-e5-small"}
    return 200, [[1.0, 0.0, 0.0] for _ in body["inputs"]]


def start_proxy(upstream_port: int, share_usd: float) -> tuple[subprocess.Popen, int]:
    port = free_port()
    shares = {"nightlyCapUsd": 5, "shares": {"ragas": {"usd": share_usd, "model": "claude-haiku-4-5"}}}
    script = (
        f"import {{ createProxy }} from {json.dumps(PROXY.as_uri())};"
        f"const {{ server }} = createProxy({{ job: 'ragas', apiKey: 'test-key', upstream: 'http://127.0.0.1:{upstream_port}', shares: {json.dumps(shares)}, log: () => {{}} }});"
        f"server.listen({port}, '127.0.0.1', () => process.stdout.write('ready\\n'));"
    )
    proc = subprocess.Popen(["node", "--input-type=module", "-e", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.stdout.readline().strip() == "ready":
            return proc, port
    proc.kill()
    raise AssertionError("the metering proxy did not start")


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def run_harness(tmp: Path, share_usd: float, upstream: Upstream) -> tuple[int, dict | None, list[dict]]:
    set_, manifest = load("mini-set.json"), load("mini-manifest.json")
    servers = [serve(upstream), serve(answer_route(set_, manifest)), serve(tei)]
    (_, up_port), (_, answer_port), (_, tei_port) = servers
    proxy, proxy_port = start_proxy(up_port, share_usd)
    try:
        out = tmp / "record.json"
        code = asyncio.run(
            main_async(
                [
                    "--set", str(FIXTURES / "mini-set.json"),
                    "--manifest", str(FIXTURES / "mini-manifest.json"),
                    "--retrieval", str(FIXTURES / "mini-retrieval.json"),
                    "--proxy", f"http://127.0.0.1:{proxy_port}",
                    "--tei", f"http://127.0.0.1:{tei_port}",
                    "--answer-url", f"http://127.0.0.1:{answer_port}/answer",
                    "--answer-max-input-tokens", "4000",
                    "--answer-max-output-tokens", "1000",
                    "--out", str(out),
                    "--now", "2026-11-16T02:30:00.000Z",
                ]
            )
        )
        record = json.loads(out.read_text()) if out.exists() else None
        return code, record, upstream.bodies
    finally:
        proxy.terminate()
        proxy.wait(timeout=10)
        for server, _ in servers:
            server.shutdown()


def test_a_full_night_through_the_real_proxy(tmp_path: Path) -> None:
    upstream = Upstream()
    code, record, bodies = run_harness(tmp_path, 2.5, upstream)
    assert code == 0
    assert record is not None and record["status"] == "COMPLETE"
    assert [c["caseId"] for c in record["cases"]] == [c["id"] for c in load("mini-set.json")["cases"]]
    # What reached the wire: the share's model, the proxy's output bound, no top_p, no stream.
    assert bodies and all(b["model"] == "claude-haiku-4-5" for b in bodies)
    assert all(b["max_tokens"] == 1024 and "top_p" not in b and not b.get("stream") for b in bodies)
    # Spend is the meter's: every call settled at the upstream's usage, the answers at theirs.
    calls, answers = len(bodies), len(record["cases"])
    assert record["spendUsd"] == pytest.approx(calls * (400 * 1 + 40 * 5) / 1e6 + answers * (900 + 60 * 5) / 1e6)
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    assert record == json.loads(GOLDEN.read_text()), "the harness's record moved; regenerate the golden with UPDATE_GOLDEN=1"


def test_the_share_stops_the_run_and_the_record_says_so(tmp_path: Path) -> None:
    # Enough for the two sentinels and part of the set, not all of it.
    code, record, _ = run_harness(tmp_path, 0.03, Upstream())
    assert code == 0
    assert record is not None and record["status"] == "BUDGET_EXHAUSTED"
    assert 0 < len(record["cases"]) < 4
    assert record["spendUsd"] <= 0.03


def test_no_answer_target_spends_nothing(tmp_path: Path) -> None:
    code = asyncio.run(
        main_async(
            [
                "--set", str(FIXTURES / "mini-set.json"),
                "--manifest", str(FIXTURES / "mini-manifest.json"),
                "--retrieval", str(FIXTURES / "mini-retrieval.json"),
                "--proxy", "http://127.0.0.1:9",
                "--tei", "http://127.0.0.1:9",
                "--out", str(tmp_path / "record.json"),
            ]
        )
    )
    assert code == EXIT_NO_ANSWER_TARGET
    assert not (tmp_path / "record.json").exists()
