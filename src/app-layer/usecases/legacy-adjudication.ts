/**
 * Adjudication inside the reconciliation run.
 *
 * ===========================================================================
 * CALLED FROM THE JOB, NOT FROM THE RUN, AND THAT IS STRUCTURAL
 * ===========================================================================
 *
 * The design says adjudication runs "inside the job and never in an HTTP
 * request". This function is called by `runLegacyReconcileJob` AFTER
 * `runLegacyReconcile` has returned and its results are committed - not from
 * inside `runLegacyReconcile` itself.
 *
 * That placement is the enforcement. If adjudication lived inside the run, then
 * any future HTTP caller of the run would adjudicate in a request, and the "never
 * in a request" property would be a convention held by whoever remembered it.
 * Called from the job entry, a request cannot reach it without somebody adding a
 * second caller to a function whose docblock says not to.
 *
 * It also means a failure here cannot lose a run. The resolutions are already on
 * disk; adjudication only ever ADDS annotations, so the worst case is a queue
 * that looks exactly as it would with the mode `OFF`.
 *
 * ===========================================================================
 * THE RESIDUE IS NOT EVERY ACCOUNT
 * ===========================================================================
 *
 * `SUGGESTED`, `AMBIGUOUS` and `UNMATCHED` are adjudicated. The other two are
 * not, and the reasons differ:
 *
 *   - `LINKED` was decided by a strong deterministic signal - a confirmed alias,
 *     a real employee number, an exact email, the directory bridge. A verdict
 *     cannot improve on that and must not appear to contradict it, and spending
 *     a model call to agree is spending a model call to agree.
 *   - `NON_PERSON` was decided by the non-person RULE. The model's own
 *     `NOT_A_PERSON` lane exists for accounts the rule did not catch.
 *
 * ===========================================================================
 * WHAT STOPS IT, IN ORDER
 * ===========================================================================
 *
 *   mode OFF (or stricter residency)  -> nothing written at all
 *   the kill switch                   -> KILL_SWITCH on every account
 *   a stub provider                   -> NO_PROVIDER
 *   no evaluation record              -> NO_EVALUATION
 *   the canary                        -> MODEL_DRIFT
 *   a guard hit, per account          -> QUARANTINED
 *   a payload that will not fit       -> OVER_BUDGET
 *
 * **An ORPHAN is adjudicated, not skipped.** An `UNMATCHED` row with no
 * candidates is asked the `person` question alone, so only `NOT_A_PERSON` and
 * `UNSURE` are reachable for it — and `NOT_A_PERSON` is the valuable one: an
 * account with live access and nobody on the roster is the urgent case, and
 * whether it is a robot or a person is most of the triage.
 *
 * **`OFF` writes nothing rather than a row per account.** An undecided account
 * must look exactly as it would with the mode off, and the cheapest way to be
 * certain of that is for there to be no row. Every tenant that never enables
 * adjudication would otherwise accumulate one verdict row per account per run
 * saying so.
 *
 * **A stub provider is `NO_PROVIDER`, not `PROVIDER_ERROR`.** `getDecisionProvider`
 * returns the stub - whose `adjudicate` throws - when `LOCAL_ONLY` is set with no
 * `LAYA_BASE_URL`. Letting that arrive as a provider error would report a
 * deployment that was never configured as a model that misbehaved. The typed
 * `providerName` discriminator is what tells them apart.
 *
 * @module app-layer/usecases/legacy-adjudication
 */

import type { LegacyResolutionOutcome, Prisma } from '@prisma/client';

import {
    runAdjudicationPass,
    type AdjudicationSubject,
} from '@/app-layer/ai/identity-match/adjudication-pass';
import { RUN_DEADLINE_MS } from '@/app-layer/ai/identity-match/adjudication-pass';
import {
    findEvaluationRecord,
    thresholdsAreComplete,
    type EvaluationRecord,
} from '@/app-layer/ai/identity-match/evaluation-record';
import { getDecisionProvider } from '@/app-layer/ai/identity-match';
import {
    budgetForModel,
    buildMatchState,
    guardQuarantines,
    guardSubject,
    type AdjudicationCandidate,
} from '@/app-layer/ai/identity-match/match-state-builder';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { guardUntrustedInput } from '@/app-layer/ai/guard';
import { buildSystemContext } from '@/app-layer/context-system';
import { effectiveLegacyMatchAiMode } from '@/lib/legacy-access/adjudication-mode';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    recordLegacyAdjudicationLatency,
    recordLegacyAdjudicationNonVerdicts,
    recordLegacyAdjudicationVerdicts,
} from '@/lib/observability/integration-metrics';
import type { NonVerdictReason } from '@/lib/legacy-access/verdict';

/** The outcomes a model is asked about. See the module docblock. */
export const RESIDUE_OUTCOMES: readonly LegacyResolutionOutcome[] = [
    'SUGGESTED',
    'AMBIGUOUS',
    'UNMATCHED',
];

/** The decision-log feature key. Stable: it is a dimension on stored rows. */
export const ADJUDICATION_FEATURE = 'legacy-identity-match';

export interface AdjudicateResidueInput {
    readonly tenantId: string;
    readonly executionId: string;
    /** Present for the tests; production lets it default to the wall clock. */
    readonly nowMs?: () => number;
}

export interface AdjudicateResidueResult {
    /** False when the mode left adjudication off: nothing was read or written. */
    readonly ran: boolean;
    readonly considered: number;
    readonly written: number;
    readonly byClass: Readonly<Record<string, number>>;
    readonly byReason: Readonly<Record<string, number>>;
    readonly canaryPassed: boolean;
}

const EMPTY: AdjudicateResidueResult = {
    ran: false,
    considered: 0,
    written: 0,
    byClass: {},
    byReason: {},
    canaryPassed: false,
};

/** One scored candidate as the engine stored it on the resolution row. */
interface StoredCandidate {
    readonly employeeId?: unknown;
    readonly score?: unknown;
}

/**
 * Read the engine's candidates off a resolution row.
 *
 * Defensive about the JSON because it is JSON: the column is written as
 * `ScoredCandidate[]` today, and a row written by an older revision of this
 * subsystem is still a row this function has to read. A candidate it cannot
 * key is DROPPED rather than defaulted - a candidate with an invented id would
 * be offered to a reviewer as a person.
 */
function storedCandidates(value: Prisma.JsonValue | null): readonly StoredCandidate[] {
    if (!Array.isArray(value)) return [];
    const out: StoredCandidate[] = [];
    for (const c of value) {
        if (typeof c === 'object' && c !== null && !Array.isArray(c)) out.push(c as StoredCandidate);
    }
    return out;
}

export async function adjudicateResidue(
    input: AdjudicateResidueInput,
): Promise<AdjudicateResidueResult> {
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'legacy-adjudication' });
    const now = input.nowMs ?? (() => Date.now());

    // ── Is adjudication on at all? ────────────────────────────────────────
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: input.tenantId },
            select: { legacyMatchAiMode: true, aiResidency: true },
        }),
    );
    const mode = effectiveLegacyMatchAiMode(
        settings?.legacyMatchAiMode ?? null,
        settings?.aiResidency ?? null,
    );
    // No settings row and `OFF` take the same path, which is the one the
    // hardening checklist asks for: nothing reaches any provider, and there is
    // no row to prove it because there is nothing to prove.
    if (mode === 'OFF') return EMPTY;

    // ── The residue ───────────────────────────────────────────────────────
    const rows = await runInTenantContext(ctx, (db) =>
        db.legacyAccountResolution.findMany({
            where: {
                tenantId: input.tenantId,
                executionId: input.executionId,
                outcome: { in: RESIDUE_OUTCOMES as LegacyResolutionOutcome[] },
            },
            select: {
                id: true,
                accountKey: true,
                employeeId: true,
                candidatesJson: true,
            },
            // Bounded: a first recertification can leave hundreds of residue
            // accounts, and the deadline is what actually limits the work. The
            // cap is here so one enormous snapshot cannot make the READ the
            // thing that fails.
            take: 1_000,
        }),
    );
    if (rows.length === 0) return { ...EMPTY, ran: true, canaryPassed: false };

    // ── The provider, and the record for the revision it will call ────────
    const provider = getDecisionProvider(mode);
    const isStub = provider.providerName === 'stub';
    const record: EvaluationRecord | null = isStub
        ? null
        : findEvaluationRecord(provider.modelName, provider.modelName);
    // A record missing a threshold is NOT a record. Checked at read time as
    // well as in the audit test, because a record committed before the shape
    // gained its third and fourth threshold passes the audit historically.
    const usableRecord = record && thresholdsAreComplete(record) ? record : null;

    // ── The kill switch ───────────────────────────────────────────────────
    // `agentId` is null: this surface has no `RegisteredAgent` of its own yet,
    // so a PLATFORM or TENANT kill stops it and an AGENT-scoped one has nothing
    // to name. Filed separately - the breaker needs that agent too, which is
    // why `BREAKER_OPEN` is not produced here and is a one-line addition at
    // this call site once it exists.
    const kill = await resolveKillState(input.tenantId, null);
    const gateRefusal: NonVerdictReason | null = kill ? 'KILL_SWITCH' : null;

    // ── Build one subject per residue account ─────────────────────────────
    const budget = budgetForModel(provider.modelName);
    const subjects: AdjudicationSubject[] = [];

    // TWO READS FOR THE WHOLE RESIDUE, not two per account. A thousand-account
    // residue through a per-account read is two thousand queries, and Layer D1
    // of `query-shape-guardrails` is right to refuse it — the first draft here
    // argued the reads were indexed and the pass network-bound, which is a
    // rationalisation rather than a reason.
    const allEmployeeIds = [
        ...new Set(
            rows.flatMap((r) =>
                storedCandidates(r.candidatesJson)
                    .map((c) => (typeof c.employeeId === 'string' ? c.employeeId : null))
                    .filter((id): id is string => id !== null),
            ),
        ),
    ];
    const employees = allEmployeeIds.length
        ? await runInTenantContext(ctx, (db) =>
              db.employee.findMany({
                  where: { tenantId: input.tenantId, id: { in: allEmployeeIds } },
                  select: {
                      id: true,
                      fullName: true,
                      givenName: true,
                      middleName: true,
                      familyName: true,
                      preferredName: true,
                      department: true,
                      jobTitle: true,
                  },
              }),
          )
        : [];
    const byId = new Map(employees.map((e) => [e.id, e]));

    const accounts = await runInTenantContext(ctx, (db) =>
        db.legacyAccount.findMany({
            where: { tenantId: input.tenantId, accountKey: { in: rows.map((r) => r.accountKey) } },
            orderBy: { createdAt: 'desc' },
            take: 2_000,
        }),
    );
    // The NEWEST row per key wins, which is what the per-account
    // `findFirst({ orderBy: desc })` did: a key can appear in more than one
    // snapshot, and the first write into the map is the latest.
    const accountByKey = new Map<string, (typeof accounts)[number]>();
    for (const a of accounts) if (!accountByKey.has(a.accountKey)) accountByKey.set(a.accountKey, a);

    for (const row of rows) {
        const candidates: AdjudicationCandidate[] = [];

        for (const stored of storedCandidates(row.candidatesJson)) {
            const id = typeof stored.employeeId === 'string' ? stored.employeeId : null;
            const employee = id ? byId.get(id) : undefined;
            if (!id || !employee) continue;
            candidates.push({
                employeeId: id,
                fullName: employee.fullName,
                givenName: employee.givenName,
                middleName: employee.middleName,
                familyName: employee.familyName,
                preferredName: employee.preferredName,
                department: employee.department,
                jobTitle: employee.jobTitle,
                score: typeof stored.score === 'number' ? stored.score : 0,
            });
        }

        const built = buildMatchState({
            account: canonicalFrom(row.accountKey, accountByKey.get(row.accountKey)),
            candidates,
            budgetChars: budget,
        });
        if (!built.ok) {
            subjects.push({ kind: 'refused', resolutionId: row.id, reason: built.reason });
            continue;
        }

        // The guard reads exactly what the provider will receive, because the
        // subject is derived from the built state rather than from the row.
        const outcome = await guardUntrustedInput(ctx, guardSubject(built.state), {
            source: ADJUDICATION_FEATURE,
        });
        if (guardQuarantines(outcome)) {
            subjects.push({ kind: 'refused', resolutionId: row.id, reason: 'QUARANTINED' });
            continue;
        }

        subjects.push({
            kind: 'ready',
            resolutionId: row.id,
            state: built.state,
            labelling: built.labelling,
            suggestedEmployeeId: row.employeeId,
        });
    }

    // ── Adjudicate ────────────────────────────────────────────────────────
    const pass = await runAdjudicationPass({
        subjects,
        provider: isStub ? null : provider,
        gateRefusal,
        record: usableRecord,
        deadlineAt: now() + RUN_DEADLINE_MS,
        nowMs: now,
    });

    // ── Write one immutable row per account, and one decision-log row ─────
    const byClass: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    let written = 0;

    for (const o of pass.outcomes) {
        if (o.verdict) byClass[o.verdict.verdict] = (byClass[o.verdict.verdict] ?? 0) + 1;
        if (o.reason) byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
        if (o.latencyMs !== null) {
            recordLegacyAdjudicationLatency({
                model: o.reportedModel ?? provider.modelName,
                latencyMs: o.latencyMs,
            });
        }

        try {
            await runInTenantContext(ctx, async (db) => {
                const verdictRow = await db.legacyMatchVerdict.create({
                    data: {
                        tenantId: input.tenantId,
                        resolutionId: o.resolutionId,
                        modelId: provider.providerName,
                        modelRevision: o.reportedModel ?? provider.modelName,
                        verdict: o.verdict?.verdict ?? null,
                        nonVerdictReason: o.reason ?? null,
                        probabilitiesJson: o.verdict
                            ? ({ top: o.verdict.topOption } as Prisma.InputJsonValue)
                            : undefined,
                        labellingJson: o.labelling.length
                            ? (Object.fromEntries(
                                  o.labelling.map((l) => [l.label, l.employeeId]),
                              ) as Prisma.InputJsonValue)
                            : undefined,
                        topProbability: o.verdict?.topProbability ?? null,
                        topMargin:
                            o.verdict && Number.isFinite(o.verdict.margin)
                                ? o.verdict.margin
                                : null,
                        latencyMs: o.latencyMs,
                        inputTokens: o.inputTokens,
                    },
                    select: { id: true },
                });
                written++;

                // `sessionRef` is the VERDICT id, so a reviewer's decision can
                // stamp exactly this row through `recordDecisionOutcome`. The
                // digest is of the payload, never the payload - this module is
                // on the agentic path and a legacy display name is personal data
                // that must not reach a plaintext, never-deleted audit row.
                await logAiDecision(db as PrismaTx, ctx, {
                    feature: ADJUDICATION_FEATURE,
                    provider: provider.providerName,
                    model: o.reportedModel ?? provider.modelName,
                    sanitizedInput: { resolutionId: o.resolutionId },
                    outputSummary: o.verdict
                        ? `${o.verdict.verdict} p=${o.verdict.topProbability.toFixed(3)}`
                        : `no verdict: ${o.reason}`,
                    latencyMs: o.latencyMs,
                    tokensIn: o.inputTokens,
                    guardVerdict: o.reason === 'QUARANTINED' ? 'malicious' : null,
                    guardBlocked: o.reason === 'QUARANTINED',
                    sessionRef: verdictRow.id,
                });
            });
        } catch (err) {
            // One row failing must not discard the others. The unique on
            // `(resolutionId, modelRevision)` is the expected case: a second
            // run under the same revision is the same question, and refusing to
            // answer it twice is the model being immutable rather than an error.
            logger.warn('legacy-adjudication: verdict row not written', {
                component: 'legacy-adjudication',
                resolutionId: o.resolutionId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const revision = usableRecord?.revision ?? provider.modelName;
    recordLegacyAdjudicationVerdicts({ model: provider.modelName, revision, byClass });
    recordLegacyAdjudicationNonVerdicts({ model: provider.modelName, revision, byReason });

    return {
        ran: true,
        considered: subjects.length,
        written,
        byClass,
        byReason,
        canaryPassed: pass.canary.passed,
    };
}

/**
 * One snapshot row as the payload builder's input type.
 *
 * PURE: it takes a row that was already read, so it cannot become a query
 * inside a loop again. The builder deliberately takes the WIDE
 * `CanonicalAccount` - which carries the employee number, the dates, the
 * manager, the entitlements and the privilege flag - so that the narrowing
 * happens in one tested place rather than here.
 *
 * A MISSING row fails closed. A resolution always has an account, since the
 * same run writes both, so an absence is a torn read; what it produces is an
 * account with no identifying text, and a payload built from it carries nothing
 * a model could match on.
 */
function canonicalFrom(
    accountKey: string,
    row:
        | {
              username: string | null;
              displayName: string | null;
              givenName: string | null;
              familyName: string | null;
              email: string | null;
              employeeNumber: string | null;
              department: string | null;
              title: string | null;
              managerRef: string | null;
              status: string;
              lastLoginAt: Date | null;
              sourceCreatedAt: Date | null;
              expiresAt: Date | null;
              isPrivileged: boolean | null;
              accountType: string;
          }
        | undefined,
) {
    return {
        accountKey,
        username: row?.username ?? null,
        displayName: row?.displayName ?? null,
        givenName: row?.givenName ?? null,
        familyName: row?.familyName ?? null,
        email: row?.email ?? null,
        employeeNumber: row?.employeeNumber ?? null,
        department: row?.department ?? null,
        title: row?.title ?? null,
        managerRef: row?.managerRef ?? null,
        status: (row?.status ?? 'UNKNOWN') as
            | 'ACTIVE'
            | 'DISABLED'
            | 'LOCKED'
            | 'EXPIRED'
            | 'UNKNOWN',
        lastLoginAt: row?.lastLoginAt ?? null,
        // `sourceCreatedAt`, the date the LEGACY system reports - not the row's
        // own insertion time. Neither is ever sent (a date is a forbidden field
        // and the payload type has nowhere to put one), so this is accuracy
        // rather than safety: a `CanonicalAccount` built here should mean what
        // one built by the pull means.
        createdAt: row?.sourceCreatedAt ?? null,
        expiresAt: row?.expiresAt ?? null,
        entitlements: [] as string[],
        isPrivileged: row?.isPrivileged ?? null,
        accountType: (row?.accountType ?? 'UNKNOWN') as
            | 'HUMAN'
            | 'SERVICE'
            | 'SHARED'
            | 'SYSTEM'
            | 'UNKNOWN',
    };
}
