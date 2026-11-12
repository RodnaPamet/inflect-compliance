"""The Inspect tasks: one per governed-run invariant in ``task-set.json``.

    inspect eval evals/inspect/inflect_inspect/tasks.py@governed_runs \\
        -T engine=flue --model mockllm/model --max-samples 1 --epochs 1

Inspect's own model slot is unused (``mockllm/model``): the model under test is
the ENGINE's, which the product calls through its own funnel, guards, caps and
ledger. The solver never calls Inspect's model; it starts a run on the product
and awaits it (``runner.run_sample``). The scorer reads only the facts the
solver stored, and the record writer (``record.py``) keeps those facts and no
verdict.

Configuration comes from the environment the workflow sets, never from a task
argument Inspect would echo into its log: ``INSPECT_PRODUCT_URL`` (loopback),
``INSPECT_SEED_MANIFEST`` (path to the seed step's JSON, no secrets) and one
session cookie per tenant in ``INSPECT_SESSION_<TENANT>``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import CORRECT, INCORRECT, NOANSWER, Score, Target, accuracy, scorer
from inspect_ai.solver import Generate, TaskState, solver

from . import verdicts
from .product import HttpProduct
from .runner import SeedManifest, run_sample

ROOT = Path(__file__).resolve().parent.parent
TASK_SET = json.loads((ROOT / "task-set.json").read_text(encoding="utf-8"))
TENANT_SLUG = {
    ("external", "flue"): "inspect-ext-flue",
    ("external", "tool-runner"): "inspect-ext-tool-runner",
    ("local-only", "flue"): "inspect-local-flue",
    ("local-only", "tool-runner"): "inspect-local-tool-runner",
}
VALUE = {"PASS": CORRECT, "FAIL": INCORRECT, "VACUOUS": NOANSWER}


def _tenant(task_def: Dict[str, Any], engine: str) -> str:
    return TENANT_SLUG[(task_def["tenant"], engine)]


def _product_for(slug: str) -> HttpProduct:
    cookie = os.environ[f"INSPECT_SESSION_{slug.upper().replace('-', '_')}"]
    return HttpProduct(os.environ["INSPECT_PRODUCT_URL"], slug, cookie)


def _seed_for(slug: str) -> SeedManifest:
    manifest = json.loads(Path(os.environ["INSPECT_SEED_MANIFEST"]).read_text(encoding="utf-8"))[slug]
    return SeedManifest(agent_id=manifest["agentId"], profiles=manifest["profiles"], markers=manifest["markers"])


@solver
def governed_run(engine: str):
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        task_def = state.metadata["task"]
        slug = _tenant(task_def, engine)
        sample = run_sample(_product_for(slug), task_def, state.metadata["inputId"], engine, _seed_for(slug))
        state.metadata["sample"] = {**sample, "epoch": state.epoch}
        state.completed = True
        return state

    return solve


@scorer(metrics=[accuracy()])
def ledger_scorer(engine: str):
    async def score(state: TaskState, target: Target) -> Score:
        sample = state.metadata["sample"]
        verdict = verdicts.score(sample["taskId"], sample["facts"], engine)
        return Score(value=VALUE[verdict], answer=verdict, explanation=f"{sample['taskId']}: {verdict} (facts only)")

    return score


@task
def governed_runs(engine: str = "flue") -> Task:
    samples = [
        Sample(
            id=f"{t['id']}:{i['id']}",
            input=i["text"] or "(absent)",
            target=t["criterion"],
            metadata={"task": t, "inputId": i["id"]},
        )
        for t in TASK_SET["tasks"]
        if "notApplicable" not in t["engines"][engine]
        for i in t["inputs"]
    ]
    return Task(
        dataset=MemoryDataset(samples, name=f"inflect-inspect-tasks@{engine}", shuffled=False),
        solver=governed_run(engine),
        scorer=ledger_scorer(engine),
    )
