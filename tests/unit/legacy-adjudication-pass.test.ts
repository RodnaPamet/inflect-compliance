/**
 * The adjudication pass: one outcome per account, and every gate in its place.
 *
 * WHAT THIS SUITE IS REALLY FOR. Three classes of assertion carry it, and the
 * rest exist to make those three trustworthy:
 *
 *  - **A refusal must make NO CALL.** The kill switch, the breaker, a missing
 *    record and a failed canary are all checked by asserting the provider spy
 *    saw nothing — not by asserting the outcome, which a post-hoc filter over
 *    results would also satisfy. A kill switch that stops the verdicts but
 *    sends the payloads has already sent the payloads.
 *  - **Every boundary is checked in BOTH directions.** The canary tolerance,
 *    the token window and the deadline each have a test that passes at the
 *    limit and one that fails just past it. One-sided boundary tests are
 *    satisfied by a gate that always refuses.
 *  - **"Could not check" must not read as "checked and fine."** A canary that
 *    times out, a record with no canaries, and a deadline that cut the canary
 *    short are three different nothings, and all three refuse.
 */

import {
    CANARY_TOLERANCE,
    concurrencyForModel,
    runAdjudicationPass,
    tokenWindowForModel,
    type AdjudicationSubject,
} from '@/app-layer/ai/identity-match/adjudication-pass';
import type { CanaryCase, EvaluationRecord } from '@/app-layer/ai/identity-match/evaluation-record';
import {
    JEV_MODEL,
    LAYA_MODEL,
    MODEL_TOKEN_WINDOW,
    REQUESTS_IN_FLIGHT,
    SystemOneResponseError,
    type MatchState,
    type SystemOneResponse,
} from '@/app-layer/ai/identity-match/systemone-wire';
import { SystemOneTransportError } from '@/app-layer/ai/identity-match/transport';
import type { DecisionCallContext, DecisionProvider } from '@/app-layer/ai/identity-match/types';

// --- Fixtures -------------------------------------------------------------

const MODEL = LAYA_MODEL;
const WINDOW = MODEL_TOKEN_WINDOW[LAYA_MODEL];

function state(tag: string): MatchState {
    return {
        account: {
            username: tag,
            usernameTokens: [tag],
            displayName: tag,
            givenName: null,
            familyName: null,
            emailLocalPart: null,
            department: null,
            title: null,
            accountType: 'HUMAN',
            variants: [],
        },
        candidates: [
            {
                label: 'A',
                givenName: 'One',
                middleNames: [],
                familyName: 'Person',
                preferredName: null,
                department: null,
                title: null,
                variants: [],
            },
            {
                label: 'B',
                givenName: 'Two',
                middleNames: [],
                familyName: 'Person',
                preferredName: null,
                department: null,
                title: null,
                variants: [],
            },
        ],
    };
}

function canary(over: Partial<CanaryCase> = {}): CanaryCase {
    return {
        caseId: 'canary-1',
        state: state('canary'),
        option: 'A',
        optionProbability: 0.9,
        personProbability: 0.95,
        ...over,
    };
}

function record(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
    return {
        model: MODEL,
        revision: MODEL,
        corpusDigest: 'sha256:deadbeef',
        producedAt: '2026-10-10T00:00:00.000Z',
        answers: [],
        thresholds: { agreeAt: 0.8, personAt: 0.7, nonPersonAt: 0.2, agreeMargin: 0.2 },
        classSupport: {},
        precision: { agrees: 1 },
        canaries: [canary()],
        ...over,
    };
}

/** A well-formed response: option A at 0.9, B at 0.05, person 0.95. */
function answer(over: {
    option?: string;
    probabilities?: Record<string, number>;
    person?: number;
    inputTokens?: number;
    model?: string;
} = {}): SystemOneResponse {
    return {
        model: over.model ?? MODEL,
        answers: {
            match: {
                type: 'choice',
                option: over.option ?? 'A',
                probabilities: over.probabilities ?? { A: 0.9, B: 0.05, NONE: 0.05 },
            },
            person: { type: 'noul', probability: over.person ?? 0.95 },
        },
        usage: { input_tokens: over.inputTokens ?? 100, output_tokens: 4 },
    } as SystemOneResponse;
}

interface Spy {
    readonly provider: DecisionProvider;
    readonly seen: string[];
    inFlight: number;
    maxInFlight: number;
}

/**
 * A provider that records every state it is handed.
 *
 * `seen` is what the no-call assertions read. It records the account's username
 * — the fixtures tag each state with its own — so a test can tell a canary call
 * from a tenant payload, which is the distinction a plain call count cannot make.
 */
function spyProvider(
    reply: (tag: string, call: number) => SystemOneResponse | Promise<SystemOneResponse>,
    modelName = MODEL,
): Spy {
    const s: Spy = {
        seen: [],
        inFlight: 0,
        maxInFlight: 0,
        provider: {
            providerName: 'laya',
            modelName,
            isExternal: false,
            async adjudicate(st: MatchState, _ctx: DecisionCallContext) {
                const tag = st.account.username;
                s.seen.push(tag);
                s.inFlight++;
                s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
                try {
                    return await reply(tag, s.seen.length);
                } finally {
                    s.inFlight--;
                }
            },
        },
    };
    return s;
}

function ready(id: string, over: Partial<AdjudicationSubject> = {}): AdjudicationSubject {
    return {
        kind: 'ready',
        resolutionId: id,
        state: state(id),
        labelling: [
            { label: 'A', employeeId: `emp-${id}-A` },
            { label: 'B', employeeId: `emp-${id}-B` },
        ],
        suggestedEmployeeId: `emp-${id}-A`,
        ...over,
    } as AdjudicationSubject;
}

const FAR = 1_000_000_000;

function pass(over: Partial<Parameters<typeof runAdjudicationPass>[0]> = {}) {
    return runAdjudicationPass({
        subjects: [ready('r1'), ready('r2')],
        provider: spyProvider(() => answer()).provider,
        gateRefusal: null,
        record: record(),
        deadlineAt: FAR,
        nowMs: () => 0,
        ...over,
    });
}

// --- One outcome per subject ---------------------------------------------

describe('one outcome per subject, in input order', () => {
    it('returns exactly one outcome per subject, ids in order', async () => {
        const subjects = [ready('r1'), ready('r2'), ready('r3')];
        const result = await pass({ subjects, provider: spyProvider(() => answer()).provider });
        expect(result.outcomes.map((o) => o.resolutionId)).toEqual(['r1', 'r2', 'r3']);
    });

    it('gives every outcome exactly one of verdict or reason', async () => {
        const result = await pass();
        for (const o of result.outcomes) {
            expect((o.verdict === null) !== (o.reason === null)).toBe(true);
        }
    });

    it('answers a mixed batch of ready and already-refused subjects', async () => {
        const subjects: AdjudicationSubject[] = [
            ready('r1'),
            { kind: 'refused', resolutionId: 'r2', reason: 'OVER_BUDGET' },
            ready('r3'),
            { kind: 'refused', resolutionId: 'r4', reason: 'QUARANTINED' },
        ];
        const spy = spyProvider(() => answer());
        const result = await pass({ subjects, provider: spy.provider });
        expect(result.outcomes.map((o) => o.reason)).toEqual([null, 'OVER_BUDGET', null, 'QUARANTINED']);
        // The refused two were never sent.
        expect(spy.seen.filter((t) => t === 'r2' || t === 'r4')).toEqual([]);
    });
});

// --- The gates refuse WITHOUT CALLING ------------------------------------

describe('a pass-wide refusal makes no model call', () => {
    it.each([['KILL_SWITCH'], ['BREAKER_OPEN']] as const)(
        '%s refuses every subject and sends nothing',
        async (gateRefusal) => {
            const spy = spyProvider(() => answer());
            const result = await pass({ provider: spy.provider, gateRefusal });
            expect(result.outcomes.every((o) => o.reason === gateRefusal)).toBe(true);
            // THE assertion. Without it a post-hoc filter over results passes.
            expect(spy.seen).toEqual([]);
            expect(result.calls).toBe(0);
        },
    );

    it('NO_PROVIDER when no provider could be constructed', async () => {
        const result = await pass({ provider: null });
        expect(result.outcomes.every((o) => o.reason === 'NO_PROVIDER')).toBe(true);
    });

    it('NO_EVALUATION with no record, and nothing is sent', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({ provider: spy.provider, record: null });
        expect(result.outcomes.every((o) => o.reason === 'NO_EVALUATION')).toBe(true);
        expect(spy.seen).toEqual([]);
    });

    it('a pre-refused subject keeps ITS OWN reason under a pass-wide refusal', async () => {
        // QUARANTINED is why THAT account could never be sent; KILL_SWITCH is
        // why none of them were. Overwriting the first with the second loses the
        // only reason a reviewer could act on.
        const subjects: AdjudicationSubject[] = [
            ready('r1'),
            { kind: 'refused', resolutionId: 'r2', reason: 'QUARANTINED' },
        ];
        const result = await pass({ subjects, gateRefusal: 'KILL_SWITCH' });
        expect(result.outcomes.map((o) => o.reason)).toEqual(['KILL_SWITCH', 'QUARANTINED']);
    });
});

// --- The canary ----------------------------------------------------------

describe('the canary fingerprints the revision before the batch', () => {
    it('runs the canary FIRST, before any tenant payload', async () => {
        const spy = spyProvider(() => answer());
        await pass({ provider: spy.provider });
        expect(spy.seen[0]).toBe('canary');
    });

    it('passes the batch when the canary reproduces its recorded answer', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({ provider: spy.provider });
        expect(result.canary).toMatchObject({ ran: true, passed: true, reason: 'OK', checked: 1 });
        expect(result.outcomes.every((o) => o.verdict !== null)).toBe(true);
    });

    it('refuses the batch on a drifted probability, and sends no payload', async () => {
        const spy = spyProvider(() => answer({ probabilities: { A: 0.5, B: 0.3, NONE: 0.2 } }));
        const result = await pass({ provider: spy.provider });
        expect(result.canary.reason).toBe('MISMATCH');
        expect(result.canary.failedCaseIds).toEqual(['canary-1']);
        expect(result.outcomes.every((o) => o.reason === 'MODEL_DRIFT')).toBe(true);
        expect(spy.seen).toEqual(['canary']);
    });

    it('accepts a drift of EXACTLY the tolerance', async () => {
        const at = 0.9 - CANARY_TOLERANCE;
        const spy = spyProvider(() => answer({ probabilities: { A: at, B: 0.05, NONE: 0.05 } }));
        const result = await pass({ provider: spy.provider });
        expect(result.canary.passed).toBe(true);
    });

    it('refuses a drift just PAST the tolerance', async () => {
        const past = 0.9 - CANARY_TOLERANCE - 0.001;
        const spy = spyProvider(() => answer({ probabilities: { A: past, B: 0.05, NONE: 0.05 } }));
        const result = await pass({ provider: spy.provider });
        expect(result.canary.passed).toBe(false);
    });

    it('refuses a DIFFERENT option even when its probability matches', async () => {
        // The recorded answer is A at 0.9. B at 0.9 is the same number about a
        // different claim, and comparing the two would read as agreement.
        const spy = spyProvider(() => answer({ option: 'B', probabilities: { A: 0.05, B: 0.9, NONE: 0.05 } }));
        const result = await pass({ provider: spy.provider });
        expect(result.canary.reason).toBe('MISMATCH');
    });

    it('refuses on a drifted PERSON probability alone', async () => {
        // Proves both recorded probabilities are compared, not just the option's.
        const spy = spyProvider(() => answer({ person: 0.5 }));
        const result = await pass({ provider: spy.provider });
        expect(result.canary.reason).toBe('MISMATCH');
    });

    it('refuses when the canary call THROWS - could not check is not fine', async () => {
        const spy = spyProvider(() => {
            throw new SystemOneTransportError('nope', 'timeout');
        });
        const result = await pass({ provider: spy.provider });
        expect(result.canary).toMatchObject({ ran: true, passed: false, reason: 'CALL_FAILED' });
        expect(result.outcomes.every((o) => o.reason === 'MODEL_DRIFT')).toBe(true);
    });

    it('refuses a record with NO canaries, and sends nothing', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({ provider: spy.provider, record: record({ canaries: [] }) });
        expect(result.canary).toMatchObject({ ran: false, passed: false, reason: 'NO_CANARIES' });
        expect(result.outcomes.every((o) => o.reason === 'MODEL_DRIFT')).toBe(true);
        expect(spy.seen).toEqual([]);
    });

    it('checks EVERY canary, not just the first', async () => {
        const two = record({
            canaries: [canary({ caseId: 'c1' }), canary({ caseId: 'c2', state: state('canary2') })],
        });
        // The second canary drifts; the first does not.
        const spy = spyProvider((tag) =>
            tag === 'canary2' ? answer({ person: 0.1 }) : answer(),
        );
        const result = await pass({ provider: spy.provider, record: two });
        expect(result.canary.failedCaseIds).toEqual(['c2']);
        expect(result.canary.checked).toBe(2);
    });
});

// --- The deadline --------------------------------------------------------

describe('the deadline', () => {
    it('reports DEADLINE, not MODEL_DRIFT, when the clock beats the canary', async () => {
        // Blaming the model for the clock would send somebody to re-evaluate a
        // revision that is fine.
        const spy = spyProvider(() => answer());
        const result = await pass({ provider: spy.provider, deadlineAt: 0, nowMs: () => 0 });
        expect(result.canary.reason).toBe('NOT_REACHED');
        expect(result.outcomes.every((o) => o.reason === 'DEADLINE')).toBe(true);
        expect(spy.seen).toEqual([]);
    });

    it('answers what it reached and marks the rest DEADLINE', async () => {
        // A clock that advances 40 units per observation, with the deadline at
        // 200: the canary and the first account or two fit, the rest do not.
        let t = 0;
        const spy = spyProvider(() => answer());
        const result = await runAdjudicationPass({
            subjects: [ready('r1'), ready('r2'), ready('r3'), ready('r4'), ready('r5')],
            provider: spy.provider,
            gateRefusal: null,
            record: record(),
            deadlineAt: 200,
            nowMs: () => (t += 40),
            concurrency: 1,
        });
        const answered = result.outcomes.filter((o) => o.verdict !== null);
        const timedOut = result.outcomes.filter((o) => o.reason === 'DEADLINE');
        expect(answered.length).toBeGreaterThan(0);
        expect(timedOut.length).toBeGreaterThan(0);
        expect(answered.length + timedOut.length).toBe(5);
        // The ones that ran are the EARLY ones: the pass does not skip ahead.
        expect(answered.map((o) => o.resolutionId)).toEqual(
            result.outcomes.slice(0, answered.length).map((o) => o.resolutionId),
        );
    });

    it('records a latency for an answered account', async () => {
        let t = 0;
        const spy = spyProvider(() => answer());
        const result = await runAdjudicationPass({
            subjects: [ready('r1')],
            provider: spy.provider,
            gateRefusal: null,
            record: record(),
            deadlineAt: FAR,
            nowMs: () => (t += 10),
            concurrency: 1,
        });
        expect(result.outcomes[0].latencyMs).toBeGreaterThan(0);
    });
});

// --- OVER_BUDGET from the vendor's own accounting ------------------------

describe('truncation is read off usage.input_tokens', () => {
    it('discards an answer whose input tokens REACH the window', async () => {
        const spy = spyProvider(() => answer({ inputTokens: WINDOW }));
        const result = await pass({ provider: spy.provider });
        expect(result.outcomes.every((o) => o.reason === 'OVER_BUDGET')).toBe(true);
        expect(result.outcomes[0].verdict).toBeNull();
        expect(result.outcomes[0].inputTokens).toBe(WINDOW);
    });

    it('keeps an answer one token BELOW the window', async () => {
        const spy = spyProvider(() => answer({ inputTokens: WINDOW - 1 }));
        const result = await pass({ provider: spy.provider });
        expect(result.outcomes.every((o) => o.verdict !== null)).toBe(true);
    });

    it('fails safe to the tightest window on an unknown model', async () => {
        const tightest = Math.min(...Object.values(MODEL_TOKEN_WINDOW));
        expect(tokenWindowForModel('nobody-pinned-this')).toBe(tightest);
        expect(tokenWindowForModel(JEV_MODEL)).toBe(MODEL_TOKEN_WINDOW[JEV_MODEL]);
    });
});

// --- The revision the endpoint reports -----------------------------------

describe('the revision the ENDPOINT reports decides', () => {
    it('refuses an answer from a revision the canary did not validate', async () => {
        const spy = spyProvider((tag) =>
            tag === 'canary' ? answer() : answer({ model: 'laya-multilingual-v2-surprise' }),
        );
        const result = await pass({ provider: spy.provider });
        expect(result.outcomes.every((o) => o.reason === 'MODEL_DRIFT')).toBe(true);
        expect(result.outcomes[0].reportedModel).toBe('laya-multilingual-v2-surprise');
    });

    it('drifts only the accounts that drifted, not the whole batch', async () => {
        // A mid-batch switch must not discard the answers already given.
        const spy = spyProvider((tag) =>
            tag === 'r2' ? answer({ model: 'something-else' }) : answer(),
        );
        const result = await pass({ provider: spy.provider, concurrency: 1 });
        expect(result.outcomes.map((o) => o.reason)).toEqual([null, 'MODEL_DRIFT']);
        expect(result.outcomes[0].verdict).not.toBeNull();
    });
});

// --- Transport failures map onto named reasons ---------------------------

describe('a per-account failure names itself and spares the rest', () => {
    it.each([
        ['timeout', 'TIMEOUT'],
        ['deadline', 'DEADLINE'],
        ['status', 'PROVIDER_ERROR'],
        ['network', 'PROVIDER_ERROR'],
    ] as const)('a %s failure becomes %s', async (kind, expected) => {
        const spy = spyProvider((tag) => {
            if (tag === 'canary') return answer();
            throw new SystemOneTransportError('x', kind);
        });
        const result = await pass({ provider: spy.provider });
        expect(result.outcomes.every((o) => o.reason === expected)).toBe(true);
    });

    it('a response that fails the schema becomes PROVIDER_ERROR', async () => {
        // What a real provider does: `parseSystemOneResponse` throws inside it,
        // so the pass never sees a half-valid answer — it sees a rejection.
        const spy = spyProvider((tag) => {
            if (tag === 'canary') return answer();
            throw new SystemOneResponseError('answers.match: invalid_type');
        });
        const result = await pass({ provider: spy.provider });
        expect(result.outcomes.every((o) => o.reason === 'PROVIDER_ERROR')).toBe(true);
    });

    it('one hostile account does not take the pass down with it', async () => {
        const spy = spyProvider((tag) => {
            if (tag === 'r2') throw new Error('boom');
            return answer();
        });
        const result = await pass({
            subjects: [ready('r1'), ready('r2'), ready('r3')],
            provider: spy.provider,
        });
        expect(result.outcomes.map((o) => o.reason)).toEqual([null, 'PROVIDER_ERROR', null]);
    });
});

// --- The engine's suggestion, as a letter --------------------------------

describe("the engine's suggestion is resolved to a letter here", () => {
    it('AGREES when the model picks the letter the engine suggested', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({ subjects: [ready('r1')], provider: spy.provider });
        expect(result.outcomes[0].verdict?.verdict).toBe('AGREES');
    });

    it('PROPOSES when the engine had no suggestion', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({
            subjects: [ready('r1', { suggestedEmployeeId: null })],
            provider: spy.provider,
        });
        expect(result.outcomes[0].verdict?.verdict).toBe('PROPOSES');
    });

    it('PROPOSES when the suggested candidate was TRIMMED from the payload', async () => {
        // The subtle one. The budget trim can drop the engine's suggestion when
        // it is not the top-scored candidate — a veto can do that. The model
        // never saw that person, so it cannot be agreeing with them, and
        // reporting AGREES would claim a corroboration that did not happen.
        const spy = spyProvider(() => answer());
        const result = await pass({
            subjects: [ready('r1', { suggestedEmployeeId: 'emp-r1-E-was-trimmed' })],
            provider: spy.provider,
        });
        expect(result.outcomes[0].verdict?.verdict).toBe('PROPOSES');
    });

    it('carries the labelling out, so a stored verdict stays readable', async () => {
        const spy = spyProvider(() => answer());
        const result = await pass({ subjects: [ready('r1')], provider: spy.provider });
        expect(result.outcomes[0].labelling).toEqual([
            { label: 'A', employeeId: 'emp-r1-A' },
            { label: 'B', employeeId: 'emp-r1-B' },
        ]);
    });

    it('passes EVERY scored option to the derivation, so the margin is real', async () => {
        // Dropping the unchosen options would leave every answer unopposed, and
        // an unopposed answer has an infinite margin — it would clear agreeMargin
        // by construction.
        const spy = spyProvider((tag) =>
            tag === 'canary' ? answer() : answer({ probabilities: { A: 0.45, B: 0.44, NONE: 0.11 } }),
        );
        const result = await pass({ subjects: [ready('r1')], provider: spy.provider });
        expect(result.outcomes[0].verdict?.margin).toBeCloseTo(0.01, 5);
        expect(result.outcomes[0].verdict?.verdict).toBe('UNSURE');
    });
});

// --- Concurrency ---------------------------------------------------------

describe('requests in flight', () => {
    it('reads each pinned model its own figure and fails safe otherwise', () => {
        expect(concurrencyForModel(JEV_MODEL)).toBe(REQUESTS_IN_FLIGHT[JEV_MODEL]);
        expect(concurrencyForModel(LAYA_MODEL)).toBe(REQUESTS_IN_FLIGHT[LAYA_MODEL]);
        expect(concurrencyForModel('unknown')).toBe(Math.min(...Object.values(REQUESTS_IN_FLIGHT)));
    });

    it('never exceeds the limit, and still answers everybody', async () => {
        const spy = spyProvider(
            (tag) => (tag === 'canary' ? answer() : new Promise((r) => setTimeout(() => r(answer()), 5))),
        );
        const subjects = Array.from({ length: 12 }, (_, i) => ready(`r${i}`));
        const result = await pass({ subjects, provider: spy.provider, concurrency: 4 });
        expect(result.outcomes).toHaveLength(12);
        expect(result.outcomes.every((o) => o.verdict !== null)).toBe(true);
        expect(spy.maxInFlight).toBeLessThanOrEqual(4);
        // The positive control: without it, a limit of 4 is indistinguishable
        // from a serial loop, which also never exceeds 4.
        expect(spy.maxInFlight).toBeGreaterThan(1);
    });

    it('uses the provider model figure when no override is given', async () => {
        const spy = spyProvider(
            (tag) => (tag === 'canary' ? answer() : new Promise((r) => setTimeout(() => r(answer()), 5))),
            LAYA_MODEL,
        );
        const subjects = Array.from({ length: 10 }, (_, i) => ready(`r${i}`));
        await pass({ subjects, provider: spy.provider });
        expect(spy.maxInFlight).toBeLessThanOrEqual(REQUESTS_IN_FLIGHT[LAYA_MODEL]);
        expect(spy.maxInFlight).toBeGreaterThan(1);
    });
});

// --- Invariant 2: no path to a write ------------------------------------

describe('the pass imports nothing that can write a link', () => {
    it('loads with every resolution and alias writer mocked to throw', () => {
        jest.resetModules();
        for (const mod of [
            '@/app-layer/usecases/legacy-reconcile',
            '@/app-layer/usecases/legacy-reviewer-actions',
            '@/app-layer/usecases/identity-account-link',
            '@/app-layer/repositories/IdentityLinkRepository',
        ]) {
            jest.doMock(mod, () => {
                throw new Error(`adjudication-pass must not import ${mod}`);
            });
        }
        // A text scan would miss a TRANSITIVE path. Loading the module with the
        // writers booby-trapped is the assertion that cannot.
        expect(() =>
            require('@/app-layer/ai/identity-match/adjudication-pass'),
        ).not.toThrow();
    });
});
