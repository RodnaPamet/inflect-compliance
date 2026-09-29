/**
 * One connection's position on the external-write ladder (#2861).
 *
 * The ladder itself is `src/lib/integrations/external-write-ladder.ts`, landed by
 * #2933 with no storage on purpose: "adding `externalWriteMode` columns now would
 * be a migration for a mechanism with no reader and no writer". This file is that
 * reader and writer.
 *
 * ## What this does NOT do
 *
 * It changes no agent behaviour. Nothing in the funnel consults the rung yet, so
 * a connection at `DRY_RUN` and a connection at `DISABLED` are treated
 * identically by every tool call today. That is deliberate and it is the whole
 * argument of #2933's note: the control arrives BEFORE the authority it governs,
 * because #2241's lesson is what a rung costs when it arrives after. The write
 * path cannot be born ungated — it has to ask, and the default answer is
 * `DISABLED`.
 *
 * `EXTERNAL_MAX_MODE` is `DRY_RUN` for the same reason: the two rungs above it
 * name authorities this build cannot exercise, and publishing a rung the product
 * then ignores is exactly what #2241 removed.
 *
 * ## Where the authorization lives
 *
 * OWNER-only, at the ROUTE, via `requirePermission('admin.tenant_lifecycle')`.
 * It is NOT repeated here as an `assertCanAdmin` — the identity policy states the
 * reason and it applies unchanged: a second, weaker gate inside the usecase is
 * how a route ends up looking protected while granting more than the route said,
 * and an `assertCanAdmin` denial writes no `AUTHZ_DENIED` row where a
 * `requirePermission` denial does.
 */
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

import {
    LADDER,
    EXTERNAL_MAX_MODE,
    coerceStoredMode,
    isAboveClamp,
    refusalForMove,
    type ExternalWriteMode,
    type ExternalWriteState,
} from '@/lib/integrations/external-write-ladder';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';

/** One connection's rung, plus what the surface needs to explain it. */
export interface ExternalWritePolicy extends ExternalWriteState {
    readonly connectionId: string;
    readonly connectionName: string;
    /** The ceiling this build honours, published so a UI can grey out the rest. */
    readonly maxMode: ExternalWriteMode;
    /** Why each rung above the current one is refused, or null where permitted. */
    readonly refusals: Readonly<Record<string, string | null>>;
}

/**
 * What the CURRENT rung has produced since its window opened.
 *
 * ── THE SEAM THAT NEVER CONNECTED ───────────────────────────────────────────
 *
 * This counted `IntegrationExecution` rows whose `automationKey` ended in
 * `:external-write`. NOTHING HAS EVER WRITTEN SUCH A ROW. The constant naming
 * that suffix said as much itself — declared beside the rung "rather than in the
 * dispatch that will write it" — and warned that a hardcoded 0 "would go on
 * refusing after the dispatch shipped, silently, until somebody remembered the
 * line". The dispatch shipped as #2983, recorded intents in the JOURNAL instead,
 * and nobody remembered the line. The docstring predicted its own failure mode
 * and was right.
 *
 * So the count was 0 for every connection, always, and `DRY_RUN → PROPOSE_ONLY`
 * was refused on a stated reason that was false — the operator is told the rung
 * has recorded nothing while the journal fills up beside it.
 *
 * It stayed invisible because `getExternalWritePolicy` asks `isAboveClamp`
 * FIRST: with the clamp at `DRY_RUN`, every wider rung returns the ceiling
 * message and `refusalForMove` is never reached, so this gate has never once
 * been exercised. It would have gone live, broken, on the first diff that raised
 * the clamp — the single change it exists to guard.
 *
 * The journal is the right table and the schema says so in three places that all
 * predate this fix: `ExternalWriteJournal`'s header ("the dwell counts rows by
 * `mode` and `outcome`"), its `@@index([tenantId, mode, attemptedAt])` commented
 * "the dwell's evidence query", and `ExternalWriteOutcome.RECORDED_ONLY` ("this
 * is what the ladder's dwell COUNTS as evidence"). The index was built for
 * exactly this query and had no caller.
 *
 * ── WHY PROPOSE_ONLY RETURNS undefined RATHER THAN 0 ────────────────────────
 *
 * `MODE_MIN_EVIDENCE` asks that rung for APPROVED PROPOSALS, and no external
 * write can be proposed yet — `dispatchWrite` refuses the rung outright with
 * `external_write_rung_unimplemented`. There is nothing to count, which is a
 * different fact from having counted and found none. `refusalForMove`
 * distinguishes the two deliberately, and a 0 here would claim we looked.
 * `undefined` makes the ladder say the true thing instead.
 */
async function countEvidenceForRung(
    ctx: RequestContext,
    connectionId: string,
    mode: ExternalWriteMode,
    since: Date,
): Promise<number | undefined> {
    if (mode === 'DRY_RUN') {
        return runInTenantContext(ctx, (db) =>
            db.externalWriteJournal.count({
                where: {
                    tenantId: ctx.tenantId,
                    connectionId,
                    // `mode` AND `outcome`, not `outcome` alone: the pair is what
                    // the index leads on and what the enum's contract names.
                    // `recordIntent` refuses every other mode, so this cannot
                    // narrow the population today — it pins the claim rather than
                    // trusting one writer to remain the only one.
                    mode: 'DRY_RUN',
                    outcome: 'RECORDED_ONLY',
                    attemptedAt: { gte: since },
                },
            }),
        );
    }
    // PROPOSE_ONLY — see the header. Nothing can produce what this rung is asked
    // for, so the honest answer is "could not count", never zero.
    return undefined;
}

/** Load one MCP-server connection's rung, coerced at the read boundary. */
export async function getExternalWritePolicy(
    ctx: RequestContext,
    connectionId: string,
): Promise<ExternalWritePolicy> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: MCP_SERVER_PROVIDER_ID },
            select: {
                id: true,
                name: true,
                externalWriteMode: true,
                externalWriteModeSince: true,
            },
        }),
    );
    if (!row) throw notFound('No such MCP server connection');

    // COERCED HERE, at the read boundary, and never further in. `coerceStoredMode`
    // fails closed to DISABLED for a rung this build does not recognise — and the
    // failure direction is the point, because `isAboveClamp` sorts an unknown mode
    // to -1, which reads as NOT above any clamp, i.e. permitted.
    const mode = coerceStoredMode(row.externalWriteMode);
    const modeSince = row.externalWriteModeSince;

    // Counted only when it can arise: a rung with an evidence requirement and an
    // open window. Every other state has nothing to prove, and this keeps the
    // read cheap for the common DISABLED case.
    const evidenceInWindow =
        modeSince && mode !== 'DISABLED'
            ? await countEvidenceForRung(ctx, row.id, mode, modeSince)
            : undefined;

    const state: ExternalWriteState = { mode, modeSince, evidenceInWindow };
    const now = new Date();

    // Every rung's verdict, precomputed. A surface that shows only "widen" has to
    // guess what the next rung is; one that shows a reason per rung can explain
    // the refusal the operator is about to hit before they hit it.
    const refusals: Record<string, string | null> = {};
    for (const rung of LADDER) {
        refusals[rung] = isAboveClamp(rung, EXTERNAL_MAX_MODE)
            ? `${rung} is above the ceiling this build honours (${EXTERNAL_MAX_MODE}). `
              + 'Nothing reads this rung to decide whether to send yet, so selecting it '
              + 'would name an authority that cannot be exercised.'
            : refusalForMove(state, rung, now);
    }

    return {
        ...state,
        connectionId: row.id,
        connectionName: row.name,
        maxMode: EXTERNAL_MAX_MODE,
        refusals,
    };
}

/**
 * Move one connection to `next`, or refuse with a reason.
 *
 * `clamp` is REQUIRED rather than defaulted, and that is the defence here, copied
 * from `setIdentityWriteMode`: this value comes from OUTSIDE this file, and an
 * optional parameter that callers forget is indistinguishable from a check that
 * was never written. The only caller is the admin route, which already imports
 * `EXTERNAL_MAX_MODE` to publish it as `maxMode`.
 */
export async function setExternalWriteMode(
    ctx: RequestContext,
    connectionId: string,
    next: ExternalWriteMode,
    clamp: ExternalWriteMode,
    now: Date = new Date(),
): Promise<ExternalWritePolicy> {
    if (!LADDER.includes(next)) throw badRequest(`Unknown external write mode: ${next}`);

    const current = await getExternalWritePolicy(ctx, connectionId);

    // The clamp is checked BEFORE the ladder, because it is the stronger claim:
    // the ladder says "not yet", the clamp says "not in this build at all", and
    // telling an operator to wait seven days for a rung that would still be
    // refused afterwards is the refusal #2843 finding 31 called worse than a
    // vaguer one.
    if (isAboveClamp(next, clamp)) {
        throw badRequest(
            `${next} is above the ceiling this build honours (${clamp}). No external write `
            + 'dispatch reads this rung yet, so selecting it would grant nothing and record '
            + 'that something had been granted.',
        );
    }

    const refusal = refusalForMove(current, next, now);
    if (refusal) throw badRequest(refusal);

    // A no-op is not a move, and must not restart the window. Re-selecting the
    // current rung IS the documented way to open a window that has none — see the
    // ladder's `modeSince` refusal — so that case is allowed through below.
    if (next === current.mode && current.modeSince) return current;

    await runInTenantContext(ctx, async (db) => {
        await db.integrationConnection.update({
            where: { id: connectionId, tenantId: ctx.tenantId },
            data: { externalWriteMode: next, externalWriteModeSince: now },
        });
        await logEvent(db, ctx, {
            action: 'EXTERNAL_WRITE_MODE_CHANGED',
            entityType: 'IntegrationConnection',
            entityId: connectionId,
            details: `External write mode for "${current.connectionName}": ${current.mode} → ${next}`,
            detailsJson: {
                // `access`, not `configuration`, for the reason the identity
                // equivalent gives: widening this grants the product authority to
                // CHANGE something in a system that is not ours, and an
                // access-review reader is the audience for that.
                category: 'access',
                operation: next === 'DISABLED' ? 'revoke' : 'grant',
                summary: `External write mode: ${current.mode} → ${next}`,
            },
            metadata: { connectionId, from: current.mode, to: next },
        });
    });

    logger.info('external write mode changed', {
        component: 'external-write-policy',
        tenantId: ctx.tenantId,
        connectionId,
        from: current.mode,
        to: next,
    });

    return getExternalWritePolicy(ctx, connectionId);
}
