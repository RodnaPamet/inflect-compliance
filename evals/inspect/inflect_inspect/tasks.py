"""The Inspect tasks: one per governed-run invariant in ``task-set.json``.

    inspect eval inflect_inspect/tasks.py@governed_runs \\
        -T engine=flue --model mockllm/model --max-samples 1 --epochs 1

Inspect loads a task FILE by path with no parent package
(``inspect_ai/_util/module.py``), so this module imports its siblings
ABSOLUTELY (``inflect_inspect.*``) and the image puts the harness root on
``PYTHONPATH``; a relative import here fails before any sample runs. The
pytest suite loads this file the way Inspect does.

Inspect's own model slot is unused (``mockllm/model``): the model under test is
the ENGINE's, which the product calls through its own funnel, guards, caps and
ledger. The solver never calls Inspect's model; it starts a run on the product
and awaits it (``runner.run_sample``). The scorer reads only the facts the
solver stored, and the record writer (``record.py``) keeps those facts and no
verdict. A sample whose facts are missing is never a crash and never a pass:
the scorer answers NOT_RUN / INCOMPLETE (``verdicts.inspect_outcome``) and the
record module refuses the record, naming the task.

Configuration comes from the environment the workflow sets, never from a task
argument Inspect would echo into its log: ``INSPECT_PRODUCT_URL`` (loopback),
``INSPECT_SEED_MANIFEST`` (path to the seed step's JSON, no secrets), per
tenant the OWNER's session cookie in ``INSPECT_SESSION_<TENANT>``, and per
seed agent its bound API key in ``INSPECT_AGENT_KEY_<TENANT>_<AGENT ID>``
(``runner.agent_key_env``; ``product.py`` says which route takes which). A
Flue tenant has one eval agent; a Tool Runner tenant has one per profile
(``runner.seed_for`` says why), and each sample uses the key of the agent its
run binds.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import CORRECT, INCORRECT, NOANSWER, Score, Target, accuracy, scorer
from inspect_ai.solver import Generate, TaskState, solver

from inflect_inspect import verdicts
from inflect_inspect.product import HttpProduct
from inflect_inspect.runner import RunNotObserved, SeedManifest, agent_key_env, run_sample, seed_for

ROOT = Path(__file__).resolve().parent.parent
TASK_SET = json.loads((ROOT / "task-set.json").read_text(encoding="utf-8"))
TENANT_SLUG = {
    ("external", "flue"): "inspect-ext-flue",
    ("external", "tool-runner"): "inspect-ext-tool-runner",
    ("local-only", "flue"): "inspect-local-flue",
    ("local-only", "tool-runner"): "inspect-local-tool-runner",
}
# PASS and FAIL only are scored; VACUOUS and every no-verdict answer
# (verdicts.NOT_RUN / INCOMPLETE / UNSCORABLE) are NOANSWER, never a pass.
VALUE = {"PASS": CORRECT, "FAIL": INCORRECT}
log = logging.getLogger("inflect_inspect")


def _tenant(task_def: Dict[str, Any], engine: str) -> str:
    return TENANT_SLUG[(task_def["tenant"], engine)]


def _env_name(slug: str) -> str:
    return slug.upper().replace("-", "_")


def _product_for(slug: str, agent_id: str) -> HttpProduct:
    cookie = os.environ[f"INSPECT_SESSION_{_env_name(slug)}"]
    agent_key = os.environ[agent_key_env(slug, agent_id)]
    return HttpProduct(os.environ["INSPECT_PRODUCT_URL"], slug, cookie, agent_key)


def _seed_for(slug: str, task_def: Dict[str, Any], engine: str) -> SeedManifest:
    manifest = json.loads(Path(os.environ["INSPECT_SEED_MANIFEST"]).read_text(encoding="utf-8"))[slug]
    return seed_for(manifest, task_def, engine)


@solver
def governed_run(engine: str):
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        task_def = state.metadata["task"]
        state.completed = True
        try:
            slug = _tenant(task_def, engine)
            seed = _seed_for(slug, task_def, engine)
            product = _product_for(slug, seed.agent_id)
        except (KeyError, ValueError, OSError) as err:
            # Configuration (a seed or a credential the workflow did not hand
            # over): nothing started, so the next sample may still run.
            state.metadata["harnessError"] = f"not started: {type(err).__name__}: {err}"
            log.warning("%s: %s", task_def["id"], state.metadata["harnessError"])
            return state
        try:
            sample = run_sample(product, task_def, state.metadata["inputId"], engine, seed)
        except RunNotObserved as err:
            # Stored as read, claiming no run: the record refuses it
            # FACTS_INCOMPLETE, naming the task. PassMustStop is let through.
            state.metadata["sample"] = {**err.sample, "epoch": state.epoch}
            state.metadata["harnessError"] = err.reason
            log.warning("%s", err)
            return state
        state.metadata["sample"] = {**sample, "epoch": state.epoch}
        return state

    return solve


@scorer(metrics=[accuracy()])
def ledger_scorer(engine: str):
    async def score(state: TaskState, target: Target) -> Score:
        # Inspect also scores a sample its own limit or a TimeoutError stopped,
        # with whatever the state holds: no sample, here, is NOT_RUN.
        answer, explanation = verdicts.inspect_outcome(
            state.metadata.get("sample"), engine, state.metadata.get("harnessError")
        )
        return Score(value=VALUE.get(answer, NOANSWER), answer=answer, explanation=explanation)

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
