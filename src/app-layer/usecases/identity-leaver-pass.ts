/**
 * The leaver pass: the first thing that actually assembles a batch.
 *
 * Everything below this line already existed and had no caller — the ladder, the
 * breaker, the link model, the write-target derivation, the journal, the two
 * writers, and the orchestration. This is the code path from "the HR feed says
 * this person has left" to those rails being asked their questions.
 *
 * ═══ CLAMPED AT DRY_RUN, BY CONSTRUCTION ═══
 *
 * `LEAVER_MAX_MODE` is `DRY_RUN` and this module refuses above it. Wiring a
 * feature and moving a tenant to unattended writes are two decisions, and the
 * ladder exists so they cannot be taken in one change. A tenant configured at
 * PROPOSE or AUTOMATIC today reached that rung by ELAPSED TIME — the gate counts
 * days since `dryRunSince`, and no pass has ever run — so its configured mode is
 * a statement about waiting, not about anything anyone observed. Refusing it is
 * the reading that cannot be got wrong.
 *
 * ═══ WHY LINK FRESHNESS IS ALSO THE COMPLETENESS GATE ═══
 *
 * Workday reports no completeness signal, so a termination inferred from ABSENCE
 * must never act. This pass never infers: it reads employees the feed explicitly
 * marks TERMINATED.
 *
 * The directory side has the same problem and it is solved upstream. Links are
 * stamped `lastVerifiedAt` ONLY by the reconciler, which runs ONLY after a sync
 * that returned `PASSED` — a confirmed-complete enumeration. So requiring a link
 * to be fresh IS requiring that a complete directory read happened recently.
 * There is deliberately no second completeness check here: one gate, held where
 * the evidence is produced, cannot drift from a copy of itself.
 *
 * ═══ THE UNIT IS (TENANT, PROVIDER) ═══
 *
 * Not per connection. `ConnectedIdentityAccount` carries no `connectionId`, so
 * with two enabled connections for one provider there is no way to say which
 * directory an account came from — the factory refuses that outright rather than
 * addressing a disable at a forest the account may not live in.
 *
 * @module usecases/identity-leaver-pass
 */
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import { resolveDirectoryWriter, type WriterRefusal } from '../integrations/identity-writer-factory';
import { getIdentityWritePolicy } from './identity-write-policy';
import {
    disableAccountsForLeaver,
    findLeaverCandidates,
    type DisableOutcome,
    type DisableResult,
} from './identity-disable-account';
import { recordLeaverPassOutcome } from '@/lib/observability/integration-metrics';

/**
 * The highest rung this pass will act at.
 *
 * A constant rather than a config value on purpose: raising it must be a diff
 * somebody reviews, not a setting somebody flips.
 */
export const LEAVER_MAX_MODE = 'DRY_RUN' as const;

/**
 * How recently a link must have been re-observed to be actable.
 *
 * Two days rather than one: the sync is daily, so a one-day bound turns a single
 * missed run into a silent no-op pass, and "we disabled nobody" would look
 * identical to "nobody left".
 */
export const LINK_FRESHNESS_MS = 2 * 24 * 60 * 60 * 1000;

/** Bound on the per-decision detail carried into the execution report. */
export const MAX_REPORTED_DECISIONS = 200;

export type LeaverPassStatus = 'PASSED' | 'NOT_APPLICABLE' | 'ERROR';

export type LeaverPassRefusal =
    | 'MODE_DISABLED'
    | 'MODE_ABOVE_CLAMP'
    | 'NO_TERMINATED_WORKERS'
    | 'NO_FRESH_LINKS'
    | `WRITER_${WriterRefusal}`;

export interface LeaverPassResult {
    readonly status: LeaverPassStatus;
    readonly mode: string;
    readonly refusal?: LeaverPassRefusal;
    readonly detail?: string;
    readonly counts: Partial<Record<DisableOutcome, number>>;
    readonly terminatedWorkers: number;
    readonly candidates: number;
    readonly population: number;
    readonly batchRefused?: string;
    readonly errorMessage?: string;
}

function tally(results: readonly DisableResult[]): Partial<Record<DisableOutcome, number>> {
    const counts: Partial<Record<DisableOutcome, number>> = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    return counts;
}

function refused(
    mode: string,
    refusal: LeaverPassRefusal,
    detail: string,
    over: Partial<LeaverPassResult> = {},
): LeaverPassResult {
    return {
        status: 'NOT_APPLICABLE',
        mode,
        refusal,
        detail,
        counts: {},
        terminatedWorkers: 0,
        candidates: 0,
        population: 0,
        ...over,
    };
}

/**
 * Run one leaver pass for one (tenant, provider).
 *
 * Never throws. Every failure is a status on the result, because the caller is a
 * fan-out over tenants and one tenant's broken connection must not end the run
 * for the rest.
 */
export async function runIdentityLeaverPass(input: {
    tenantId: string;
    provider: string;
    now?: Date;
}): Promise<LeaverPassResult> {
    const now = input.now ?? new Date();
    // `context-system`, never `context` — the latter reaches @/lib/auth -> @/auth
    // and dies in the worker, which has no Next request to hang a session on.
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'identity-leaver-pass' });

    try {
        // ── 1. The ladder. Cheapest gate, and the one that must never be skipped.
        const policy = await getIdentityWritePolicy(ctx);
        const mode = policy.leaver.mode;

        if (mode === 'DISABLED') {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'mode_disabled' });
            return refused(mode, 'MODE_DISABLED', 'Leaver writes are switched off for this tenant.');
        }
        if (mode !== LEAVER_MAX_MODE) {
            // The clamp. Not an error — a deliberate ceiling while the pass
            // itself is new — but loud, because a tenant sitting at AUTOMATIC
            // and seeing nothing happen deserves to find out why from a log
            // rather than from an offboarding that quietly never ran.
            logger.warn('leaver pass clamped below the tenant’s configured mode', {
                component: 'identity-leaver-pass',
                tenantId: ctx.tenantId,
                provider: input.provider,
                configuredMode: mode,
                clamp: LEAVER_MAX_MODE,
            });
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'mode_above_clamp' });
            return refused(
                mode,
                'MODE_ABOVE_CLAMP',
                `This tenant is configured at ${mode}, but the leaver pass is clamped at ${LEAVER_MAX_MODE} ` +
                    'until it has been observed in the field. Wiring the pass and granting it unattended ' +
                    'authority are separate decisions, and no tenant has yet watched a single pass.',
            );
        }

        // ── 2. Who the FEED says has left. Never inferred from absence.
        const terminated = await runInTenantContext(ctx, (db) =>
            db.employee.findMany({
                where: { tenantId: ctx.tenantId, status: 'TERMINATED' },
                select: { id: true },
                // Bounded: past this, the roster is not a departure wave, and the
                // breaker downstream refuses a batch this size anyway.
                take: 5000,
            }),
        );
        if (terminated.length === 0) {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'no_terminated' });
            return refused(mode, 'NO_TERMINATED_WORKERS', 'No worker is marked TERMINATED in the HR feed.');
        }

        // ── 3. Which of their accounts we have OBSERVED recently enough to act on.
        const staleBefore = new Date(now.getTime() - LINK_FRESHNESS_MS);
        const candidates = await findLeaverCandidates(
            ctx,
            input.provider,
            terminated.map((e) => e.id),
            staleBefore,
        );
        if (candidates.length === 0) {
            // Distinct from "nobody left". An empty candidate set with terminated
            // workers present means the link table is stale or empty — which is
            // exactly the silent-nothing failure this subsystem is most prone to.
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'no_fresh_links' });
            return refused(
                mode,
                'NO_FRESH_LINKS',
                `${terminated.length} terminated worker(s), but none has a directory link re-observed since ` +
                    `${staleBefore.toISOString()}. Either the identity sync has not completed recently, or ` +
                    'these workers hold no account this product has matched to them.',
                { terminatedWorkers: terminated.length },
            );
        }

        // ── 4. The population the breaker measures the batch against.
        const population = await runInTenantContext(ctx, (db) =>
            db.connectedIdentityAccount.count({
                where: { tenantId: ctx.tenantId, provider: input.provider },
            }),
        );

        // ── 5. The writer. DRY_RUN gets the snapshot reader and no socket.
        const resolution = await resolveDirectoryWriter({ ctx, provider: input.provider, mode });
        if (resolution.kind === 'none') {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'writer_refused' });
            return refused(mode, `WRITER_${resolution.refusal}`, resolution.detail, {
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
            });
        }

        try {
            const outcome = await disableAccountsForLeaver(ctx, resolution.writer, {
                candidates,
                population,
            });
            const counts = tally(outcome.results);

            logger.info('leaver pass complete', {
                component: 'identity-leaver-pass',
                tenantId: ctx.tenantId,
                provider: input.provider,
                mode,
                evidence: resolution.kind,
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
                batchRefused: outcome.refused ?? null,
                counts,
            });

            recordLeaverPassOutcome({
                provider: input.provider,
                outcome: outcome.refused ? 'batch_refused' : 'completed',
            });
            return {
                status: 'PASSED',
                mode,
                counts,
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
                batchRefused: outcome.refused,
            };
        } finally {
            // Unconditional because `close` is in the type on every arm — a
            // no-op for the snapshot reader and for Entra, a real unbind for AD.
            // The obligation is discharged by the compiler, not by memory.
            await resolution.close();
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('leaver pass failed', {
            component: 'identity-leaver-pass',
            tenantId: input.tenantId,
            provider: input.provider,
            error: detail,
        });
        recordLeaverPassOutcome({ provider: input.provider, outcome: 'error' });
        return {
            status: 'ERROR',
            mode: 'unknown',
            counts: {},
            terminatedWorkers: 0,
            candidates: 0,
            population: 0,
            errorMessage: detail,
        };
    }
}
