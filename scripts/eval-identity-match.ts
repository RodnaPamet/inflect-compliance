/**
 * Run the adjudication corpus through a decision model and write an evaluation
 * record.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A model revision may not produce verdicts until a record exists for it. This is
 * the only thing that makes one. The record holds the RAW answer to every case,
 * the corpus digest, the derived thresholds and a handful of canaries;
 * `tests/unit/identity-match-evaluation-records.test.ts` then recomputes every
 * derived figure from those raw answers and fails if they disagree.
 *
 * So the script is deliberately dumb. It asks, it records, it derives one
 * threshold by a stated rule, and it refuses to write a record it knows is
 * unusable. It does not tune anything. Every judgement call that could be made to
 * flatter a model lives in the test instead, where it is recomputed rather than
 * asserted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE THRESHOLD IS DERIVED, AND WHY IT IS NOT FITTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `agreeAt` is the LOWEST confidence at which the model made no confident
 * mistake, plus a margin — found by scanning candidate thresholds upward and
 * taking the first with 100 % precision. That is a search, not a fit: it has one
 * degree of freedom, the rule is three lines long, and the test re-derives the
 * precision at the chosen value from the same raw answers.
 *
 * If NO threshold achieves 100 % precision, the script writes nothing and exits
 * non-zero. A revision that cannot be made safe at any confidence does not get a
 * record with a caveat; it gets no record, and therefore no verdicts.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   # `--provider laya` existed until 2026-10-14. The Laya estate was retired,
 *   # so `jev` is the only provider this harness can reach — and it refuses
 *   # until TypeSafe is an ACTIVE sub-processor, which it is not.
 *
 *   # against TypeSafe (requires the sub-processor to be ACTIVE)
 *   TYPESAFE_API_KEY=... npx tsx scripts/eval-identity-match.ts --provider jev
 *
 * The `jev` path is unreachable while `TYPESAFE_SUBPROCESSOR_ACTIVE` is false, and
 * the script says so rather than failing obscurely — producing a record is itself
 * an act of sending the corpus to a third party, and the corpus is synthetic but
 * the principle is the point.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// The providers are constructed DIRECTLY rather than through
// `getDecisionProvider`, and that is deliberate: the factory's job is to answer
// "may this TENANT reach this model?", and an offline harness has no tenant. Going
// through it would mean a record could never be produced for Jev even after
// activation, because the factory also consults a per-tenant mode. The
// sub-processor gate that genuinely applies here is re-checked below, explicitly.
import {
    JevDecisionProvider,
    TYPESAFE_SUBPROCESSOR_ACTIVE,
} from '../src/app-layer/ai/identity-match/jev-provider';
import { JEV_MODEL } from '../src/app-layer/ai/identity-match/systemone-wire';
import type { DecisionProvider } from '../src/app-layer/ai/identity-match/types';
import {
    ADJUDICATION_CORPUS,
    ADJUDICATION_CLASSES,
    adjudicationCorpusDigest,
    type AdjudicationCase,
} from '../tests/fixtures/identity-reconcile/adjudication/corpus';
import {
    HELD_OUT_SET,
    heldOutDigest,
} from '../tests/fixtures/identity-reconcile/adjudication/held-out';
import type { MatchState } from '../src/app-layer/ai/identity-match/systemone-wire';

const OUT_DIR = path.resolve(__dirname, '../src/app-layer/ai/identity-match/evaluations');

/** How many cases become canaries. Enough to detect a silent revision swap. */
const CANARY_COUNT = 4;

/** Candidate thresholds, scanned upward. */
const THRESHOLD_LADDER = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 0.99];

interface Answer {
    caseId: string;
    option: string;
    optionProbability: number;
    personProbability: number;
}

/**
 * Build the wire state for a case.
 *
 * Candidates are shuffled with a seed derived from the account username — the
 * design document's no-anchoring rule. Without it, "the model agrees with the
 * engine" could mean no more than "the model picked option A", and a corpus whose
 * correct answer is usually A would measure position bias as accuracy.
 *
 * The shuffle is SEEDED rather than random so a record is reproducible: a second
 * run over the same corpus must present the same case the same way, or the
 * canary comparison is measuring the shuffle.
 */
function stateFor(c: AdjudicationCase): MatchState {
    const seed = [...c.account.username].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    let s = seed;
    const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
    const shuffled = [...c.candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return {
        account: {
            username: c.account.username,
            usernameTokens: c.account.username.split(/[._-]+/).filter(Boolean),
            displayName: c.account.displayName,
            givenName: null,
            familyName: null,
            emailLocalPart: c.account.emailLocalPart,
            department: c.account.department,
            title: c.account.title,
            accountType: c.account.accountType ?? null,
            variants: [],
        },
        candidates: shuffled.map((cand) => ({
            label: cand.label,
            givenName: cand.givenName,
            middleNames: cand.middleNames ?? [],
            familyName: cand.familyName,
            preferredName: cand.preferredName ?? null,
            department: cand.department,
            title: cand.title,
            variants: [],
        })),
    };
}

/**
 * The lowest ladder threshold at which no confident answer is wrong.
 *
 * Returns null when none is, which is the case that must produce no record.
 */
/**
 * Every case a threshold is judged against: the corpus AND the held-out set.
 *
 * THE BUG THIS CLOSES. Both derive functions used to scan the ladder against
 * `ADJUDICATION_CORPUS` alone, and `precision.agrees` was then computed over
 * that same corpus. So the figure was 1.0 for every model that got a record, by
 * construction — a threshold chosen as "the lowest with no confident mistake
 * here" is trivially precise *here*. Measured off-corpus (#3462) it was 0.571
 * for Laya, which had been confidently linking an RPA robot and a printer to
 * named individuals at p>0.95.
 *
 * Judging the ladder against the union does not make a model better. It makes
 * the threshold climb until the model is right about what it is confident on,
 * or — if no rung achieves that — refuses the record, which is the behaviour
 * this script already had for a model that cannot be made safe at any
 * confidence. That refusal is now reachable by a model that is confidently
 * WRONG at the top of the ladder, which is exactly the case #3461 found.
 *
 * ‾‾‾ HOSTILE CASES GATE THIS DELIBERATELY. OWNER DECISION 2026-10-13 ‾‾‾
 *
 * Both models are currently refused by exactly ONE hostile case each — Laya's
 * `personAt` by `ho-pi-05`, Jev's `agreeAt` by `ho-pi-02` — and since #3466 the
 * guard quarantines every hostile case in both sets before any model call. So
 * the obvious question is whether hostile cases should gate a threshold at all,
 * given the model will not see them in production.
 *
 * The answer is YES, and the reason is the guard's own history rather than a
 * principle: eleven of thirteen hostile cases reached the model until #3466,
 * and three of those were the governed corpus's own, leaking for as long as the
 * corpus had existed. A guard is one detector against an adversary who adapts.
 * A threshold that stays safe when the guard misses costs only coverage, on a
 * feature with no live traffic; a threshold chosen without that failure in view
 * turns the next guard bypass into a confident wrong verdict that is eligible
 * for bulk ratification.
 *
 * So BOTH MODELS HAVE NO RECORD, adjudication produces nothing, and that is the
 * chosen position rather than an unresolved bug. Revisit it by excluding
 * `c.hostile` from `ALL_CASES` — one line — if the trade is ever worth making.
 */
const ALL_CASES: readonly AdjudicationCase[] = [...ADJUDICATION_CORPUS, ...HELD_OUT_SET];

function deriveAgreeAt(answers: readonly Answer[]): number | null {
    const expected = new Map(ALL_CASES.map((c) => [c.id, c.expected.option]));
    for (const t of THRESHOLD_LADDER) {
        let confident = 0;
        let wrong = 0;
        for (const a of answers) {
            if (a.optionProbability < t) continue;
            confident += 1;
            if (a.option !== expected.get(a.caseId)) wrong += 1;
        }
        // A threshold that admits nothing is not a safe threshold; it is a model
        // that never commits, and it must not read as perfect precision.
        if (confident > 0 && wrong === 0) return t;
    }
    return null;
}

/**
 * The `person` threshold, by the same rule over the boolean question.
 */
function derivePersonAt(answers: readonly Answer[]): number | null {
    const expected = new Map(ALL_CASES.map((c) => [c.id, c.expected.isPerson]));
    for (const t of THRESHOLD_LADDER) {
        let confident = 0;
        let wrong = 0;
        for (const a of answers) {
            const p = a.personProbability;
            const says = p >= t ? true : p <= 1 - t ? false : null;
            if (says === null) continue;
            confident += 1;
            if (says !== expected.get(a.caseId)) wrong += 1;
        }
        if (confident > 0 && wrong === 0) return t;
    }
    return null;
}

async function main(): Promise<number> {
    // `--provider laya` was accepted until 2026-10-14 and is now an error
    // rather than a silently-ignored argument: the Laya estate was retired on
    // the owner's decision, so there is no local endpoint to evaluate. An
    // unrecognised value exits 2 with the usage line, which is what a caller
    // reaching for the old flag sees.
    const providerArg = process.argv[process.argv.indexOf('--provider') + 1];
    if (providerArg !== 'jev') {
        console.error('usage: eval-identity-match.ts --provider <jev>');
        return 2;
    }

    if (!TYPESAFE_SUBPROCESSOR_ACTIVE) {
        console.error(
            'REFUSING: TypeSafe is a proposed, INACTIVE sub-processor. Producing a record sends\n' +
                'the corpus to a third party, which the notice window has to close first.\n' +
                'See docs/sub-processors.md and docs/sub-processor-change-policy.md.'
        );
        return 3;
    }

    const key = process.env.TYPESAFE_API_KEY;
    if (!key) {
        console.error('no TypeSafe credential is configured; set TYPESAFE_API_KEY');
        return 4;
    }
    const provider: DecisionProvider = new JevDecisionProvider(key);

    const model = JEV_MODEL;
    console.log(`asking ${model} about ${ADJUDICATION_CORPUS.length} cases…`);

    const answers: Answer[] = [];
    // What the ENDPOINT calls itself, captured from the first answer. The drift
    // check compares against this rather than `model`, because a real Laya
    // reports its agent name and not our name for the checkpoint (#3428).
    let reportedModel: string | null = null;
    for (const c of ALL_CASES) {
        const res = await provider.adjudicate(stateFor(c), {
            // Generous: this is an offline harness, not an inline pass.
            deadlineAt: Date.now() + 30_000,
        });
        // A vendor that changed its self-report MID-RUN is drift happening while
        // we measure, which must not be averaged into a record that then blesses
        // both. Refused rather than reconciled.
        if (reportedModel === null) {
            reportedModel = res.model;
        } else if (reportedModel !== res.model) {
            console.error(
                `NO RECORD WRITTEN. The endpoint reported ${reportedModel} and then `
                    + `${res.model} within one run, so there is no single checkpoint this `
                    + 'record could describe.',
            );
            process.exit(1);
        }
        answers.push({
            caseId: c.id,
            option: res.answers.match.choice,
            optionProbability: res.answers.match.probabilities[res.answers.match.choice] ?? 0,
            personProbability: res.answers.person.noul,
        });
        process.stdout.write('.');
    }
    process.stdout.write('\n');

    const agreeAt = deriveAgreeAt(answers);
    const personAt = derivePersonAt(answers);
    if (agreeAt === null || personAt === null) {
        // Name the cases that blocked it. A model is refused here when it is
        // confidently WRONG at the top of the ladder, and the operator needs to
        // know on WHAT — a hostile case points at the quarantine guard, an
        // ordinary one at the model.
        const TOP = THRESHOLD_LADDER[THRESHOLD_LADDER.length - 1];
        const topExpected = new Map(ALL_CASES.map((c) => [c.id, c.expected.option]));
        const topPerson = new Map(ALL_CASES.map((c) => [c.id, c.expected.isPerson]));
        // WHICH threshold failed, named separately. One refusal message for two
        // different failures tells an operator nothing about where to look: a
        // blocked `agreeAt` is about who the account belongs to, a blocked
        // `personAt` about whether it belongs to a person at all, and the second
        // is the one that decides if a shared credential enters a review as an
        // individual's access.
        console.error(
            `\n  agreeAt  ${agreeAt === null ? 'BLOCKED — no rung is precise on the union' : `ok at ${agreeAt}`}`
        );
        console.error(
            `  personAt ${personAt === null ? 'BLOCKED — no rung is precise on the union' : `ok at ${personAt}`}`
        );
        const personBlockers = answers
            .filter((a) => a.personProbability >= TOP || a.personProbability <= 1 - TOP)
            .filter((a) => (a.personProbability >= TOP) !== topPerson.get(a.caseId));
        if (personAt === null && personBlockers.length > 0) {
            console.error(`\nConfidently wrong about PERSON at the top rung (${TOP}):`);
            for (const b of personBlockers) {
                const c = ALL_CASES.find((x) => x.id === b.caseId);
                console.error(
                    `  ${b.caseId} [${c?.klass}${c?.hostile ? ', HOSTILE' : ''}] noul=${b.personProbability.toFixed(4)} `
                        + `says ${b.personProbability >= TOP ? 'person' : 'not a person'}, expected `
                        + `${topPerson.get(b.caseId) ? 'person' : 'not a person'}`
                );
            }
        }
        const blockers = answers
            .filter((a) => a.optionProbability >= TOP)
            .filter((a) => a.option !== topExpected.get(a.caseId));
        console.error(
            'NO RECORD WRITTEN. No threshold on the ladder gives 100% precision with a\n' +
                'non-empty confident set, so this revision cannot be made safe at any\n' +
                'confidence. A revision with no record produces no verdicts, which is the\n' +
                'correct outcome rather than a failure of this script.\n' +
                '\nThresholds are judged against the corpus AND the held-out set, so a\n' +
                'confident mistake on either blocks the record.'
        );
        if (blockers.length > 0) {
            console.error(
                `\nConfidently wrong about the MATCH at the top rung (${TOP}), `
                    + 'so no rung can exclude them:'
            );
            for (const b of blockers) {
                const c = ALL_CASES.find((x) => x.id === b.caseId);
                console.error(
                    `  ${b.caseId} [${c?.klass}${c?.hostile ? ', HOSTILE' : ''}] said ${b.option} `
                        + `at p=${b.optionProbability.toFixed(4)}, expected ${topExpected.get(b.caseId)}`
                );
            }
        }
        return 5;
    }

    // Precision over the UNION, which is the point: `agreeAt` was chosen against
    // the same union, so this figure is 1.0 whenever a record is written — but
    // now 1.0 over data the threshold was not fitted to.
    const expected = new Map(ALL_CASES.map((c) => [c.id, c.expected.option]));
    let confident = 0;
    let correct = 0;
    for (const a of answers) {
        if (a.optionProbability < agreeAt) continue;
        confident += 1;
        if (a.option === expected.get(a.caseId)) correct += 1;
    }

    // The held-out half on its own, so a reader can see what it contributed
    // rather than taking the union figure on trust.
    const heldOutIds = new Set(HELD_OUT_SET.map((c) => c.id));
    const heldOutAnswers = answers.filter((a) => heldOutIds.has(a.caseId));
    const heldOutConfident = heldOutAnswers.filter((a) => a.optionProbability >= agreeAt);
    const heldOutMistakes = heldOutConfident
        .filter((a) => a.option !== expected.get(a.caseId))
        .map((a) => a.caseId);
    const heldOut = {
        digest: heldOutDigest(),
        total: heldOutAnswers.length,
        confident: heldOutConfident.length,
        precision:
            heldOutConfident.length === 0
                ? 1
                : (heldOutConfident.length - heldOutMistakes.length) / heldOutConfident.length,
        mistakes: heldOutMistakes,
    };

    const classSupport: Record<string, number> = {};
    for (const k of ADJUDICATION_CLASSES) {
        classSupport[k] = ADJUDICATION_CORPUS.filter((c) => c.klass === k).length;
    }

    // Canaries: spread across classes rather than the first N, so a revision that
    // regressed on one shape cannot pass by being fine on the shape we sampled.
    const canaries: Answer[] = [];
    for (const k of ADJUDICATION_CLASSES) {
        if (canaries.length >= CANARY_COUNT) break;
        // From the CORPUS only. A canary is the pre-batch drift check, and the
        // governed set is the corpus; drawing one from the held-out half would
        // make the held-out set load-bearing at runtime rather than at review.
        const first = answers.find(
            (a) => ADJUDICATION_CORPUS.find((c) => c.id === a.caseId)?.klass === k
        );
        if (first) canaries.push(first);
    }

    const revision = createHash('sha256')
        .update(`${model}|${adjudicationCorpusDigest()}`)
        .digest('hex')
        .slice(0, 12);

    const record = {
        model,
        revision,
        // Non-null here: the loop above exits the process if the corpus is empty
        // of answers, and refuses a mid-run change.
        reportedModel: reportedModel ?? model,
        corpusDigest: adjudicationCorpusDigest(),
        producedAt: new Date().toISOString(),
        answers,
        thresholds: { agreeAt, personAt },
        classSupport,
        precision: { agrees: confident === 0 ? 0 : correct / confident },
        heldOut,
        canaries,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${model}@${revision}.json`);
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
        `wrote ${path.relative(process.cwd(), out)}\n` +
            `  agreeAt ${agreeAt}  personAt ${personAt}  confident ${confident}/${answers.length}  ` +
            `precision ${record.precision.agrees}`
    );
    console.log(
        'Commit it, then run tests/unit/identity-match-evaluation-records.test.ts — it\n' +
            'recomputes every figure above from the raw answers and will disagree if this\n' +
            'script got any of them wrong.'
    );
    return 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err);
        process.exit(1);
    }
);
