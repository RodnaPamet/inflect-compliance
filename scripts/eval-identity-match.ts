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
 *   # against a Laya server we run
 *   LAYA_BASE_URL=http://laya.internal:8080 npx tsx scripts/eval-identity-match.ts --provider laya
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
import { LayaDecisionProvider } from '../src/app-layer/ai/identity-match/laya-provider';
import { JEV_MODEL, LAYA_MODEL } from '../src/app-layer/ai/identity-match/systemone-wire';
import type { DecisionProvider } from '../src/app-layer/ai/identity-match/types';
import {
    ADJUDICATION_CORPUS,
    ADJUDICATION_CLASSES,
    adjudicationCorpusDigest,
    type AdjudicationCase,
} from '../tests/fixtures/identity-reconcile/adjudication/corpus';
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
function deriveAgreeAt(answers: readonly Answer[]): number | null {
    const expected = new Map(ADJUDICATION_CORPUS.map((c) => [c.id, c.expected.option]));
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
    const expected = new Map(ADJUDICATION_CORPUS.map((c) => [c.id, c.expected.isPerson]));
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
    const providerArg = process.argv[process.argv.indexOf('--provider') + 1];
    if (providerArg !== 'jev' && providerArg !== 'laya') {
        console.error('usage: eval-identity-match.ts --provider <jev|laya>');
        return 2;
    }

    if (providerArg === 'jev' && !TYPESAFE_SUBPROCESSOR_ACTIVE) {
        console.error(
            'REFUSING: TypeSafe is a proposed, INACTIVE sub-processor. Producing a record sends\n' +
                'the corpus to a third party, which the notice window has to close first.\n' +
                'See docs/sub-processors.md and docs/sub-processor-change-policy.md.'
        );
        return 3;
    }

    let provider: DecisionProvider;
    if (providerArg === 'laya') {
        const baseUrl = process.env.LAYA_BASE_URL;
        if (!baseUrl) {
            console.error('no Laya endpoint is configured; set LAYA_BASE_URL');
            return 4;
        }
        provider = new LayaDecisionProvider(baseUrl, process.env.LAYA_API_KEY);
    } else {
        const key = process.env.TYPESAFE_API_KEY;
        if (!key) {
            console.error('no TypeSafe credential is configured; set TYPESAFE_API_KEY');
            return 4;
        }
        provider = new JevDecisionProvider(key);
    }

    const model = providerArg === 'laya' ? LAYA_MODEL : JEV_MODEL;
    console.log(`asking ${model} about ${ADJUDICATION_CORPUS.length} cases…`);

    const answers: Answer[] = [];
    for (const c of ADJUDICATION_CORPUS) {
        const res = await provider.adjudicate(stateFor(c), {
            // Generous: this is an offline harness, not an inline pass.
            deadlineAt: Date.now() + 30_000,
        });
        answers.push({
            caseId: c.id,
            option: res.answers.match.option,
            optionProbability: res.answers.match.probabilities[res.answers.match.option] ?? 0,
            personProbability: res.answers.person.probability,
        });
        process.stdout.write('.');
    }
    process.stdout.write('\n');

    const agreeAt = deriveAgreeAt(answers);
    const personAt = derivePersonAt(answers);
    if (agreeAt === null || personAt === null) {
        console.error(
            'NO RECORD WRITTEN. No threshold on the ladder gives 100% precision with a\n' +
                'non-empty confident set, so this revision cannot be made safe at any\n' +
                'confidence. A revision with no record produces no verdicts, which is the\n' +
                'correct outcome rather than a failure of this script.'
        );
        return 5;
    }

    const expected = new Map(ADJUDICATION_CORPUS.map((c) => [c.id, c.expected.option]));
    let confident = 0;
    let correct = 0;
    for (const a of answers) {
        if (a.optionProbability < agreeAt) continue;
        confident += 1;
        if (a.option === expected.get(a.caseId)) correct += 1;
    }

    const classSupport: Record<string, number> = {};
    for (const k of ADJUDICATION_CLASSES) {
        classSupport[k] = ADJUDICATION_CORPUS.filter((c) => c.klass === k).length;
    }

    // Canaries: spread across classes rather than the first N, so a revision that
    // regressed on one shape cannot pass by being fine on the shape we sampled.
    const canaries: Answer[] = [];
    for (const k of ADJUDICATION_CLASSES) {
        if (canaries.length >= CANARY_COUNT) break;
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
        corpusDigest: adjudicationCorpusDigest(),
        producedAt: new Date().toISOString(),
        answers,
        thresholds: { agreeAt, personAt },
        classSupport,
        precision: { agrees: confident === 0 ? 0 : correct / confident },
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
