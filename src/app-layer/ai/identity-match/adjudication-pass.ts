/**
 * The adjudication pass - one outcome per account, never fewer.
 *
 * ===========================================================================
 * EXACTLY ONE RESULT PER SUBJECT, IN INPUT ORDER
 * ===========================================================================
 *
 * The same contract `reconcile()` holds, and for the same reason: callers index
 * the result against their own list, and a silently dropped account is an
 * account nobody reviews. Every refusal is therefore a VALUE in the returned
 * array, never an early return and never a filtered-out subject.
 *
 * That is why the pre-flight refusals come IN rather than being handled by the
 * caller. A subject the payload builder refused (`OVER_BUDGET`,
 * `NO_CANDIDATES`) or the guard quarantined arrives as
 * `{ kind: 'refused', reason }` and leaves with that reason attached. One place
 * produces the per-account outcome, so there is one place to read to know what
 * every account got.
 *
 * ===========================================================================
 * THE ORDER OF THE GATES IS THE DESIGN
 * ===========================================================================
 *
 *   gate refusal (kill switch, breaker)   -> every subject, no call made
 *   no provider                           -> every subject
 *   no evaluation record                  -> every subject
 *   canary                                -> every subject on failure
 *   deadline                              -> every subject not yet started
 *   per-subject pre-flight refusal        -> that subject
 *   the call                              -> that subject
 *
 * The first four are pass-wide and are checked BEFORE any account payload is
 * sent. The kill switch coming first is the point of a kill switch: it must
 * stop the batch without a single model call, so it cannot be a filter applied
 * to results.
 *
 * ===========================================================================
 * A CANARY THAT COULD NOT RUN HAS NOT PASSED
 * ===========================================================================
 *
 * Before the batch, the record's canary states are sent and the answers
 * compared with the recorded ones. A mismatch refuses the batch with
 * `MODEL_DRIFT` - that is the published behaviour, and it catches a vendor
 * updating a checkpoint behind an unchanged model name, or a Laya server
 * serving the wrong weights.
 *
 * What is easy to get wrong is the other three cases, all of which also refuse:
 *
 *   - a canary call that TIMES OUT or errors. We learned nothing about the
 *     model, and "could not check" must never read as "checked and fine";
 *   - a record with NO canaries. There is nothing to fingerprint, so the
 *     fingerprint cannot have matched;
 *   - a canary answer naming a DIFFERENT option. Comparing probabilities then
 *     compares two different quantities, and a drifted model that happens to
 *     report a similar confidence for a different answer is precisely the
 *     drift worth catching.
 *
 * ===========================================================================
 * TWO SOURCES OF `OVER_BUDGET`, AND THIS MODULE OWNS THE SECOND
 * ===========================================================================
 *
 * Pre-flight, the payload builder refuses a state that will not fit. Post-hoc,
 * an answer whose reported `usage.input_tokens` reaches the model's window was
 * computed on input the VENDOR may have truncated - so the answer is discarded
 * even though it parsed, validated and looks entirely reasonable. It is the one
 * refusal that throws away a usable-looking answer, which is why the reasoning
 * sits next to it rather than in a commit message.
 *
 * @module app-layer/ai/identity-match/adjudication-pass
 */

import {
    deriveVerdict,
    type DerivedVerdict,
    type NonVerdictReason,
} from '@/lib/legacy-access/verdict';

import type { CanaryCase, EvaluationRecord } from './evaluation-record';
import {
    MODEL_TOKEN_WINDOW,
    REQUESTS_IN_FLIGHT,
    type MatchOption,
    type MatchState,
    type SystemOneResponse,
} from './systemone-wire';
import { SystemOneTransportError } from './transport';
import type { DecisionProvider } from './types';
import type { LabelAssignment } from './match-state-builder';

/** How close a canary answer must be to its recorded one. */
export const CANARY_TOLERANCE = 0.02;

/**
 * Slack on the tolerance comparison, so the documented boundary is reachable.
 *
 * Without it "within 0.02" is not quite what the code does. A recorded 0.9
 * against an observed 0.88 differs by `0.020000000000000018` in IEEE-754, so a
 * canary differing by exactly the published tolerance would be REFUSED — and a
 * refusal here stops a whole batch and sends somebody to re-evaluate a model
 * that never drifted.
 *
 * 1e-9 is nine orders of magnitude below any probability difference that could
 * mean anything, so it cannot admit a real drift. Choosing to widen rather than
 * restate the tolerance as exclusive: the design says "within", a reader checks
 * a recorded value against an observed one by hand, and the arithmetic they do
 * on paper should agree with the arithmetic here.
 */
const TOLERANCE_SLACK = 1e-9;

/** The whole pass's wall-clock budget, from the design document's table. */
export const RUN_DEADLINE_MS = 120_000;

// --- Subjects -------------------------------------------------------------

/**
 * One account ready to be sent.
 *
 * `suggestedEmployeeId` is the ENGINE's suggestion as an employee id, resolved
 * to a letter here against `labelling` rather than by the caller. One place
 * does that translation, and it has to handle the case below.
 */
export interface ReadySubject {
    readonly kind: 'ready';
    readonly resolutionId: string;
    readonly state: MatchState;
    readonly labelling: readonly LabelAssignment[];
    readonly suggestedEmployeeId: string | null;
}

/** One account that never gets sent, with the reason already decided. */
export interface RefusedSubject {
    readonly kind: 'refused';
    readonly resolutionId: string;
    readonly reason: NonVerdictReason;
}

export type AdjudicationSubject = ReadySubject | RefusedSubject;

// --- Results --------------------------------------------------------------

export interface AdjudicatedOutcome {
    readonly resolutionId: string;
    /** Exactly one of these two is non-null. The DB CHECK enforces the same. */
    readonly verdict: DerivedVerdict | null;
    readonly reason: NonVerdictReason | null;
    /** The model the ENDPOINT reported, when a call was answered. */
    readonly reportedModel: string | null;
    readonly latencyMs: number | null;
    readonly inputTokens: number | null;
    /** The letter-to-employee mapping, so a stored verdict stays readable. */
    readonly labelling: readonly LabelAssignment[];
}

export interface CanaryReport {
    readonly ran: boolean;
    readonly passed: boolean;
    readonly checked: number;
    /** Case ids that disagreed, or that could not be checked at all. */
    readonly failedCaseIds: readonly string[];
    readonly reason: 'OK' | 'NO_CANARIES' | 'MISMATCH' | 'CALL_FAILED' | 'NOT_REACHED';
}

export interface AdjudicationPassResult {
    readonly outcomes: readonly AdjudicatedOutcome[];
    readonly canary: CanaryReport;
    readonly calls: number;
}

// --- Input ----------------------------------------------------------------

export interface AdjudicationPassInput {
    readonly subjects: readonly AdjudicationSubject[];
    /** Null means no provider could be constructed: `NO_PROVIDER` for everybody. */
    readonly provider: DecisionProvider | null;
    /**
     * A pass-wide refusal the CALLER decided, or null.
     *
     * `KILL_SWITCH` and `BREAKER_OPEN` are reads against the database, which
     * this module deliberately cannot make - see the module's import list. The
     * caller resolves them and hands the verdict in, and the pass guarantees
     * that when one is present no provider method is invoked at all.
     */
    readonly gateRefusal: NonVerdictReason | null;
    /**
     * The record for the revision we EXPECT, used for the canary and for the
     * thresholds. Null means `NO_EVALUATION` for everybody.
     */
    readonly record: EvaluationRecord | null;
    readonly deadlineAt: number;
    readonly nowMs?: () => number;
    /** Defaults to the model's own figure; present for the tests. */
    readonly concurrency?: number;
}

// --- Helpers --------------------------------------------------------------

function everySubject(
    subjects: readonly AdjudicationSubject[],
    reason: NonVerdictReason,
): readonly AdjudicatedOutcome[] {
    return subjects.map((s) => ({
        resolutionId: s.resolutionId,
        verdict: null,
        // A subject the caller already refused keeps ITS OWN reason. A pass-wide
        // refusal is why no call was made; it is not a better explanation of an
        // account whose payload could never have been built.
        reason: s.kind === 'refused' ? s.reason : reason,
        reportedModel: null,
        latencyMs: null,
        inputTokens: null,
        labelling: s.kind === 'ready' ? s.labelling : [],
    }));
}

/**
 * Requests in flight for a model, failing safe on an unknown one.
 *
 * The tightest known figure rather than the loosest: overshooting what a vendor
 * accepts turns one run into a rate-limit incident for the whole deployment.
 */
export function concurrencyForModel(model: string): number {
    const known: Readonly<Record<string, number | undefined>> = REQUESTS_IN_FLIGHT;
    return known[model] ?? Math.min(...Object.values(REQUESTS_IN_FLIGHT));
}

/** The vendor's token window, failing safe on an unknown model. */
export function tokenWindowForModel(model: string): number {
    const known: Readonly<Record<string, number | undefined>> = MODEL_TOKEN_WINDOW;
    return known[model] ?? Math.min(...Object.values(MODEL_TOKEN_WINDOW));
}

/** Map a thrown transport failure onto the reason that names it. */
function reasonForThrow(e: unknown): NonVerdictReason {
    if (e instanceof SystemOneTransportError) {
        if (e.kind === 'timeout') return 'TIMEOUT';
        if (e.kind === 'deadline') return 'DEADLINE';
        return 'PROVIDER_ERROR';
    }
    // A schema failure lands here too, and `PROVIDER_ERROR` is the right name
    // for it: the provider answered with something we will not act on.
    return 'PROVIDER_ERROR';
}

/**
 * Run `tasks` with at most `limit` in flight, preserving index order.
 *
 * Hand-rolled rather than adding a dependency for nine lines, and index-keyed
 * rather than built from `Promise.all` over chunks: chunking would make the
 * slowest call in each chunk a barrier, and a 500-account residue under a
 * 120-second deadline cannot afford to idle seven workers waiting for one.
 */
async function withConcurrency<T>(
    limit: number,
    count: number,
    task: (index: number) => Promise<T>,
): Promise<T[]> {
    const out = new Array<T>(count);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= count) return;
            out[i] = await task(i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, worker));
    return out;
}

// --- The canary -----------------------------------------------------------

function canaryAgrees(expected: CanaryCase, got: SystemOneResponse): boolean {
    // The OPTION first. With a different option the two probabilities below
    // describe different quantities, and a drifted model reporting similar
    // confidence for a different answer is the case most worth catching.
    if (got.answers.match.option !== expected.option) return false;

    const within = (a: number, b: number): boolean =>
        Math.abs(a - b) <= CANARY_TOLERANCE + TOLERANCE_SLACK;

    const p = got.answers.match.probabilities[expected.option as MatchOption];
    if (typeof p !== 'number') return false;
    if (!within(p, expected.optionProbability)) return false;

    // BOTH recorded probabilities. A revision that still picks the right option
    // with the right confidence but has changed its mind about whether the
    // subject is a person has drifted, and `NOT_A_PERSON` is checked first in
    // the verdict order — so that half decides a lane on its own.
    return within(got.answers.person.probability, expected.personProbability);
}

/**
 * Fingerprint the revision before trusting it with tenant data.
 *
 * Sequential, not concurrent. There are a handful of canaries, they run before
 * any real payload, and a failure means the batch is refused - so the thing
 * worth optimising is finding the first disagreement early, not finishing all
 * of them quickly.
 */
async function runCanary(
    provider: DecisionProvider,
    record: EvaluationRecord,
    deadlineAt: number,
    now: () => number,
): Promise<CanaryReport> {
    const cases = record.canaries ?? [];
    if (cases.length === 0) {
        // Nothing to fingerprint. The audit test requires a committed record to
        // carry canaries, and this is the runtime refusing to TRUST that.
        return { ran: false, passed: false, checked: 0, failedCaseIds: [], reason: 'NO_CANARIES' };
    }

    const failed: string[] = [];
    let checked = 0;

    for (const c of cases) {
        if (now() >= deadlineAt) {
            return {
                ran: true,
                passed: false,
                checked,
                failedCaseIds: [...failed, c.caseId],
                reason: 'NOT_REACHED',
            };
        }
        try {
            const got = await provider.adjudicate(c.state, { deadlineAt });
            checked++;
            if (!canaryAgrees(c, got)) failed.push(c.caseId);
        } catch {
            // A canary we could not run is a canary that did not pass. The
            // error is deliberately not inspected: a timeout and a 500 are the
            // same amount of evidence about the model, namely none.
            return {
                ran: true,
                passed: false,
                checked,
                failedCaseIds: [...failed, c.caseId],
                reason: 'CALL_FAILED',
            };
        }
    }

    return {
        ran: true,
        passed: failed.length === 0,
        checked,
        failedCaseIds: failed,
        reason: failed.length === 0 ? 'OK' : 'MISMATCH',
    };
}

// --- The pass -------------------------------------------------------------

/**
 * Adjudicate a residue, or refuse it, with one outcome per subject.
 *
 * Never throws for a per-account failure - a hostile record, a timeout or a
 * drifted revision must quarantine ITSELF and leave the rest of the pass
 * running. The run adjudicates hundreds of accounts and an exception would
 * discard the ones already answered.
 */
export async function runAdjudicationPass(
    input: AdjudicationPassInput,
): Promise<AdjudicationPassResult> {
    const now = input.nowMs ?? (() => Date.now());
    const notReached: CanaryReport = {
        ran: false,
        passed: false,
        checked: 0,
        failedCaseIds: [],
        reason: 'NOT_REACHED',
    };

    // 1. The kill switch and the breaker, before anything is sent.
    if (input.gateRefusal !== null) {
        return { outcomes: everySubject(input.subjects, input.gateRefusal), canary: notReached, calls: 0 };
    }
    // 2. No provider at all.
    if (!input.provider) {
        return { outcomes: everySubject(input.subjects, 'NO_PROVIDER'), canary: notReached, calls: 0 };
    }
    // 3. No committed record for the revision we intend to call.
    if (!input.record) {
        return { outcomes: everySubject(input.subjects, 'NO_EVALUATION'), canary: notReached, calls: 0 };
    }

    const provider = input.provider;
    const record = input.record;

    // 4. The canary. Its calls spend the same deadline the batch does.
    const canary = await runCanary(provider, record, input.deadlineAt, now);
    if (!canary.passed) {
        // A canary the deadline cut short did not find drift - it found no time.
        // Reporting `MODEL_DRIFT` there would blame the model for the clock, and
        // `MODEL_DRIFT` is the reason that makes somebody go and re-evaluate a
        // revision. The hardening checklist asks for `DEADLINE` on every
        // remaining account, and "remaining" includes all of them.
        const reason: NonVerdictReason = canary.reason === 'NOT_REACHED' ? 'DEADLINE' : 'MODEL_DRIFT';
        return { outcomes: everySubject(input.subjects, reason), canary, calls: canary.checked };
    }

    const limit = input.concurrency ?? concurrencyForModel(provider.modelName);
    const window = tokenWindowForModel(provider.modelName);
    let calls = canary.checked;

    const outcomes = await withConcurrency(limit, input.subjects.length, async (i) => {
        const subject = input.subjects[i];
        const base = {
            resolutionId: subject.resolutionId,
            verdict: null,
            reportedModel: null,
            latencyMs: null,
            inputTokens: null,
            labelling: subject.kind === 'ready' ? subject.labelling : [],
        } as const;

        if (subject.kind === 'refused') return { ...base, reason: subject.reason };

        // 5. The deadline, checked before STARTING a call rather than after.
        // Checked inside the worker, so a slow early account turns the
        // remainder into DEADLINE instead of queueing calls nobody waits for.
        if (now() >= input.deadlineAt) return { ...base, reason: 'DEADLINE' as const };

        const startedAt = now();
        let parsed: SystemOneResponse;
        try {
            calls++;
            // No re-parse. `DecisionProvider.adjudicate` is typed to return a
            // PARSED response, and both providers call `parseSystemOneResponse`
            // before returning — so a schema failure arrives here as a throw and
            // is named `PROVIDER_ERROR` below. Validating a second time would
            // read as not trusting the contract while changing nothing.
            parsed = await provider.adjudicate(subject.state, { deadlineAt: input.deadlineAt });
        } catch (e) {
            return { ...base, reason: reasonForThrow(e), latencyMs: now() - startedAt };
        }

        const latencyMs = now() - startedAt;
        const inputTokens = parsed.usage.input_tokens;

        // 6. The revision the ENDPOINT reported, not the one we asked for. A
        // vendor serving a different checkpoint behind the same request is what
        // the canary fingerprinted - so an answer from a revision the canary did
        // not validate is drift, however well-formed it is.
        if (parsed.model !== record.revision && parsed.model !== record.model) {
            return {
                ...base,
                reason: 'MODEL_DRIFT' as const,
                reportedModel: parsed.model,
                latencyMs,
                inputTokens,
            };
        }

        // 7. Truncation, reported by the vendor's own accounting.
        if (inputTokens >= window) {
            return {
                ...base,
                reason: 'OVER_BUDGET' as const,
                reportedModel: parsed.model,
                latencyMs,
                inputTokens,
            };
        }

        // The engine's suggestion as a LETTER. Null when the engine had no
        // suggestion - and also when its suggestion is not in `labelling`,
        // because the budget trim dropped it. That second case matters: the
        // model cannot agree with a candidate it never saw, so the answer can
        // only ever be `PROPOSES`, and reporting `AGREES` would claim a
        // corroboration that did not happen.
        const suggestedOption: MatchOption | null =
            subject.suggestedEmployeeId === null
                ? null
                : (subject.labelling.find((l) => l.employeeId === subject.suggestedEmployeeId)
                      ?.label ?? null);

        // The probability MAP becomes the option list `deriveVerdict` ranks. Every
        // scored option is passed, including ones the chosen answer is not: the
        // margin is the gap to the runner-up, so dropping the others would make
        // every answer look unopposed.
        const options = Object.entries(parsed.answers.match.probabilities)
            .filter((e): e is [string, number] => typeof e[1] === 'number')
            .map(([option, probability]) => ({ option, probability }));

        const verdict = deriveVerdict(
            { options, personProbability: parsed.answers.person.probability },
            { suggestedOption },
            record.thresholds,
        );

        return {
            ...base,
            verdict,
            reason: null,
            reportedModel: parsed.model,
            latencyMs,
            inputTokens,
        };
    });

    return { outcomes, canary, calls };
}
