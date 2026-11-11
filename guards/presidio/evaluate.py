"""Produce a PII evaluation record: the committed corpus, run through the
analyzer configuration in ``inflect_pii``, raw spans only.

Phase 0.4 of docs/ai-architecture/presidio.md. The record carries no rate:
``src/lib/ai/pii/evaluation-record.ts`` recomputes precision and recall from
these spans every time, and refuses a record that states its own. Records are
committed by pull request, never pushed by a job (G11).

    python guards/presidio/evaluate.py \\
        --corpus tests/fixtures/pii/corpus.json \\
        --out evals/pii/records/

Every case is answered, including those with nothing to find, so a record can
never be silent about a case it skipped.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import sys
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inflect_pii import config  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    raw = args.corpus.read_bytes()
    corpus = json.loads(raw.decode("utf-8"))
    analyzer = config.build_analyzer()

    answers = []
    for case in corpus["cases"]:
        found = analyzer.analyze(text=case["text"], language=case["locale"], entities=config.SCOPE)
        spans = sorted(
            ({"type": r.entity_type, "start": r.start, "end": r.end, "score": round(float(r.score), 4)} for r in found),
            key=lambda s: (s["start"], s["end"], s["type"]),
        )
        answers.append({"caseId": case["id"], "spans": spans})

    config_hash = config.config_hash()
    record = {
        "schema": "inflect-pii-record/1",
        "corpusDigest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "detector": {
            "name": "presidio",
            "version": metadata.version("presidio-analyzer"),
            "configHash": config_hash,
            "models": {lang: f"{name}@{metadata.version(name)}" for lang, name in config.MODELS.items()},
        },
        "ranAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "answers": answers,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / f"{config_hash.removeprefix('sha256:')[:16]}.json"
    target.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
