"""The Ragas nightly's ANSWER and JUDGE stages: one record per run (Ragas Phase 1).

    python -m inflect_rag.run --set seed-policies.json --manifest corpus.json \\
        --retrieval retrieval.json --proxy http://127.0.0.1:8787 --tei http://127.0.0.1:8080 \\
        --answers answers.json --out record.json

Exit codes, each a different night:
    0  a record was written (COMPLETE, or BUDGET_EXHAUSTED with its unanswered cases left out)
    3  NO_ANSWER_TARGET: no answers file was given, so nothing is judged and nothing is
       spent; the retrieval stage's figures are the night's only output
    4  SENTINELS_MISSED: the two fixed sentinel cases did not land where they must, so
       the judge is not trusted tonight and no record is written
    1  anything else

Order of the night: the two sentinels (a perfect case and an empty retrieval) first;
then every case of the set in order — read the product's answer from the answer
stage's file (`scripts/rag-eval/answer.ts`), map what it retrieved back to the set's
keys (a chunk outside the answer tenant is refused), score — until the set is done or
the share is exhausted. A case the budget interrupted, while answering or while
judging, is left out whole and the record says BUDGET_EXHAUSTED, which never passes a
floor.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from typing import Any

from .answers import AnswerTarget, FileAnswerTarget
from .judge import JUDGE_MODEL, Judge, TeiEmbeddings, anthropic_judge_llm
from .meter import BudgetExhausted, Meter
from .record import build_record, chunk_refs, iso_now

EXIT_NO_ANSWER_TARGET = 3
EXIT_SENTINELS_MISSED = 4
JOB = "ragas"
RETRIEVAL_KIND = "rag-retrieval-probe@1"
# A sentinel's metric must land at or above this on the perfect case.
SENTINEL_PERFECT_FLOOR = 0.7


class RevisionMismatch(Exception):
    """The product says it retrieved with a revision other than the one the retrieval stage measured."""


async def run_sentinels(judge: Judge, set_: dict) -> dict:
    """Two fixed cases whose verdicts are known before the judge is asked (ragas.md, Evals).

    PERFECT: a task question answered with its own ground truth over its own
    passages — faithfulness, context precision and context recall at least
    SENTINEL_PERFECT_FLOOR, and not an abstention. EMPTY: the same question
    answered "not in the documents" over no retrieval — an abstention, with the
    three context-bound metrics not assessed (None), never a score.
    """
    case = next(c for c in set_["cases"] if c["kind"] == "task")
    q, truth = case["question"], case["groundTruth"]
    passages = [r["passage"] for r in truth["refs"]]
    perfect = await judge.score(q, truth["answer"], passages, truth["answer"])
    empty = await judge.score(q, "The documents provided do not contain this information.", [], truth["answer"])
    problems = []
    for m in ("faithfulness", "contextPrecision", "contextRecall"):
        v = perfect.metrics[m]
        if v is None or v < SENTINEL_PERFECT_FLOOR:
            problems.append(f"perfect {m} = {v}")
    if perfect.abstained is not False:
        problems.append(f"perfect abstained = {perfect.abstained}")
    if empty.abstained is not True:
        problems.append(f"empty abstained = {empty.abstained}")
    for m in ("faithfulness", "contextPrecision", "contextRecall"):
        if empty.metrics[m] is not None:
            problems.append(f"empty {m} = {empty.metrics[m]} (no retrieval scores nothing)")
    return {
        "caseId": case["id"],
        "perfect": {"metrics": perfect.metrics, "abstained": perfect.abstained},
        "empty": {"metrics": empty.metrics, "abstained": empty.abstained},
        "landed": not problems,
        "problems": problems,
    }


async def judge_set(
    *,
    set_: dict,
    retrieval: dict,
    manifest: dict,
    target: AnswerTarget,
    judge: Judge,
    meter: Meter,
) -> tuple[list[dict], bool]:
    """Every case in order; returns the scored cases and whether the budget stopped the run."""
    revision = retrieval["retrieverRevision"]
    cases: list[dict] = []
    for c in set_["cases"]:
        if meter.exhausted():
            return cases, True
        try:
            ans = target.answer(c["id"], c["question"])
            if ans.embedding_model != revision["embeddingModel"] or ans.k != revision["k"]:
                raise RevisionMismatch(
                    f"the product retrieved with {ans.embedding_model} at k {ans.k}; the retrieval stage measured "
                    f"{revision['embeddingModel']} at k {revision['k']}"
                )
            # Each case was asked in its own tenant (owner decision 2026-11-17):
            # the injection cases in the injection tenant, every other case in
            # the answer tenant. A chunk from the other tenant is refused.
            tenant = manifest["injectionTenant"] if c["kind"] == "injection" else manifest["answerTenant"]
            refs = chunk_refs(ans.retrieved, tenant["sources"])
            score = await judge.score(c["question"], ans.answer, [r.text for r in ans.retrieved], c["groundTruth"]["answer"])
        except BudgetExhausted:
            return cases, True
        cases.append(
            {
                "caseId": c["id"],
                "answer": ans.answer,
                "retrieved": refs,
                "metrics": score.metrics,
                "abstained": score.abstained,
                "judgeOutputs": score.judge_outputs,
            }
        )
    return cases, False


def _load(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


async def main_async(argv: list[str] | None = None, *, judge_llm: Any = None, embeddings: Any = None) -> int:
    p = argparse.ArgumentParser(prog="inflect_rag.run")
    p.add_argument("--set", required=True)
    p.add_argument("--manifest", required=True)
    p.add_argument("--retrieval", required=True)
    p.add_argument("--proxy", required=True)
    p.add_argument("--tei", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--sentinels-out")
    p.add_argument("--answers", help="the answer stage's file (rag-answers@1)")
    p.add_argument("--now", help="a fixed ranAt (tests)")
    a = p.parse_args(argv)

    set_ = _load(a.set)
    retrieval = _load(a.retrieval)
    manifest = _load(a.manifest)
    if retrieval.get("kind") != RETRIEVAL_KIND:
        print(f"rag-eval: {a.retrieval} is not the retrieval stage's output", file=sys.stderr)
        return 1
    if not a.answers:
        print(
            "rag-eval: NO_ANSWER_TARGET: no answers file was given, so nothing is judged and no judge call is made. "
            "The product's answers come from the answer stage, scripts/rag-eval/answer.ts "
            "(docs/ai-architecture/ragas.md 1.2).",
            file=sys.stderr,
        )
        return EXIT_NO_ANSWER_TARGET
    # Read before anything is spent: a file bound to another set or revision is refused here.
    target = FileAnswerTarget(a.answers, set_hash=retrieval["setHash"], retriever_revision=retrieval["retrieverRevision"])

    meter = Meter(a.proxy)
    state = meter.state()
    if state.job != JOB:
        print(f"rag-eval: the metering proxy meters job {state.job}, not {JOB}", file=sys.stderr)
        return 1
    if JUDGE_MODEL not in state.models:
        print(f"rag-eval: the {JOB} share does not list the judge's model {JUDGE_MODEL}", file=sys.stderr)
        return 1
    tei = embeddings or TeiEmbeddings(a.tei)
    embedding_model = tei.model_id()
    judge = Judge(judge_llm or anthropic_judge_llm(a.proxy, JUDGE_MODEL), tei, meter.exhausted)

    try:
        sentinels = await run_sentinels(judge, set_)
    except BudgetExhausted:
        sentinels = {"landed": False, "problems": ["the share could not fit the sentinels"]}
    if a.sentinels_out:
        with open(a.sentinels_out, "w", encoding="utf-8") as f:
            json.dump(sentinels, f, indent=2)
    if not sentinels["landed"]:
        print(f"rag-eval: SENTINELS_MISSED: {'; '.join(sentinels['problems'])}", file=sys.stderr)
        return EXIT_SENTINELS_MISSED

    cases, stopped = await judge_set(set_=set_, retrieval=retrieval, manifest=manifest, target=target, judge=judge, meter=meter)

    final = meter.state()
    if final.open_reservations:
        print("rag-eval: a reservation is still open; the spend cannot be stated", file=sys.stderr)
        return 1
    import ragas

    record = build_record(
        retrieval=retrieval,
        judge_revision={
            "provider": "anthropic",
            "model": JUDGE_MODEL,
            "embeddingModel": embedding_model,
            "ragasVersion": ragas.__version__,
            "priceTableHash": final.price_table_hash,
        },
        answer_revision=target.answer_model,
        status="BUDGET_EXHAUSTED" if stopped or final.status == "BUDGET_EXHAUSTED" or target.status == "BUDGET_EXHAUSTED" else "COMPLETE",
        spend_usd=final.spent_usd,
        cases=cases,
        ran_at=a.now or iso_now(datetime.now().astimezone()),
    )
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"rag-eval: {len(cases)} of {len(set_['cases'])} cases, {record['status']}, USD {record['spendUsd']}", file=sys.stderr)
    return 0


def main() -> None:
    sys.exit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
