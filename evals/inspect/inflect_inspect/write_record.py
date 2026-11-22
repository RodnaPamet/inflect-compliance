"""Turn one Inspect eval log into one evaluation record (facts only).

    python -m inflect_inspect.write_record --log <eval log> --engine flue \\
        --model-provider anthropic --model-revision <as the decision rows name it> \\
        --app-image-digest <d> --harness-image-digest <d> --seed-fixture-hash sha256:<h> \\
        --out records/<engine>-<date>.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from inspect_ai.log import read_eval_log

from .record import build_record
from .tasks import TASK_SET


def main() -> None:
    p = argparse.ArgumentParser()
    for name in ("log", "engine", "model-provider", "model-revision", "app-image-digest", "harness-image-digest", "seed-fixture-hash", "out"):
        p.add_argument(f"--{name}", required=True)
    a = p.parse_args()
    log = read_eval_log(a.log)
    samples = [s.metadata["sample"] for s in log.samples or [] if "sample" in (s.metadata or {})]
    record = build_record(
        TASK_SET,
        a.engine,
        {"provider": a.model_provider, "revision": a.model_revision},
        {"appImageDigest": a.app_image_digest, "harnessImageDigest": a.harness_image_digest, "seedFixtureHash": a.seed_fixture_hash},
        datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        samples,
    )
    Path(a.out).write_text(json.dumps(record, indent=4) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
