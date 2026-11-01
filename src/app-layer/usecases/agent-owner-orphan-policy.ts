/**
 * The owner-orphan pass's mode — what a tenant has allowed the pass to do to its
 * agents (#3670, step 2b).
 *
 * ═══ THE IDENTITY LADDER, NOT A SECOND ONE ═══
 *
 * The pass stops agents unattended at its top rung, which is the same class of
 * authority as the leaver's directory disables: an automatic act on something
 * the customer depends on, with a false positive that stops real work. So it
 * moves the way the leaver does — DISABLED → DRY_RUN → AUTOMATIC, one rung per
 * widen, at least `DRY_RUN_MIN_DAYS` (7) at DRY_RUN with at least
 * `DRY_RUN_MIN_PASSES` (1) recorded pass inside the window before leaving it,
 * and narrowing always allowed — and it reuses that ladder's pieces rather than
 * copying them:
 *
 *   - `LADDER`, the rung order, and `isAboveClamp`, the ordinal comparison,
 *     from `src/lib/identity/write-ladder.ts`;
 *   - `coerceStoredMode` at the read boundary, so a stored PROPOSE (the column
 *     reuses the `IdentityWriteMode` enum, which still carries it) reads as
 *     DRY_RUN and anything unrecognised as DISABLED, before any comparison;
 *   - `DRY_RUN_MIN_DAYS` and `DRY_RUN_MIN_PASSES` from the identity policy, so
 *     the dwell cannot drift from the leaver's.
 *
 * What is NOT shared is the refusal SENTENCE. `describeRefusal` in
 * `identity-write-policy.ts` speaks of a direction and a termination-and-hire
 * cycle, and gates on `DIRECTION_IMPLEMENTED`, a closed two-key record; the
 * orphan pass is not a third identity direction (the union is closed on
 * purpose, see CLAUDE.md "There is no mover"), so it says its own sentences
 * over the same rules.
 *
 * ═══ THE GATE ═══
 *
 * `admin.tenant_lifecycle` at the route — the key `/admin/identity-write-policy`
 * carries — because the mode decides whether a scheduled job stops agents
 * unattended (the permission table of `docs/agentic-iam-roadmap.md`). The usecase
 * re-asserts it as defence in depth; the route's literal is the gate whose
 * denial writes `AUTHZ_DENIED`.
 *
 * @module usecases/agent-owner-orphan-policy
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import {
    LADDER,
    coerceStoredMode,
    isAboveClamp,
    type IdentityWriteMode,
} from '@/lib/identity/write-ladder';
import { ORPHAN_PASS_AUTOMATION_KEY, ORPHAN_PASS_MAX_MODE } from '@/lib/agentic/owner-orphan';
import { DRY_RUN_MIN_DAYS, DRY_RUN_MIN_PASSES } from './identity-write-policy';
import { assertCanRead } from '../policies/common';

export interface OrphanPassPolicy {
    mode: IdentityWriteMode;
    dryRunSince: Date | null;
}

/** The key, re-asserted here; the route's `requirePermission` is the gate. */
function assertCanGovernOrphanPass(ctx: RequestContext) {
    assertCanRead(ctx);
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden(
            "Setting the owner-orphan pass's mode requires the tenant lifecycle permission, " +
                'which among the built-in roles only an OWNER holds.',
        );
    }
}

/**
 * The pass's mode, as a rung this build understands.
 *
 * THE ONLY PLACE THE STORED VALUE BECOMES A RUNG. The pass's gate, the dwell
 * arithmetic and the admin GET all read it from here, so `coerceStoredMode` is
 * applied before anything compares, ranks or acts on it — `isAboveClamp` sorts
 * an unknown value to -1, which reads as permitted, so the conversion has to come
 * before the first comparison rather than at each one. No settings row is
 * DISABLED: absence is a real "off".
 */
export async function getAgentOrphanPassPolicy(ctx: RequestContext): Promise<OrphanPassPolicy> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { agentOrphanPassMode: true, agentOrphanPassDryRunSince: true },
        });
        return {
            mode: coerceStoredMode(row?.agentOrphanPassMode),
            dryRunSince: row?.agentOrphanPassDryRunSince ?? null,
        };
    });
}

/**
 * Why a requested move is refused, or null if it is allowed. Pure, so the admin
 * GET can explain a refusal before the operator submits it.
 *
 * `passesInWindow` is supplied only when leaving DRY_RUN; `undefined` skips the
 * evidence check. `clamp` defaults to the pass's own ceiling.
 */
export function describeOrphanPassModeRefusal(
    current: OrphanPassPolicy,
    next: IdentityWriteMode,
    now: Date,
    passesInWindow?: number,
    clamp: IdentityWriteMode = ORPHAN_PASS_MAX_MODE,
): string | null {
    const refusal = orphanPassModeRefusal(current, next, now, passesInWindow, clamp);
    if (!refusal) return null;
    switch (refusal.code) {
        case 'ABOVE_CLAMP':
            return (
                `${refusal.next} is above the highest rung the owner-orphan pass acts at (${refusal.clamp}). ` +
                'Raising that ceiling is a reviewed change to the pass, not a setting.'
            );
        case 'MULTI_RUNG': {
            const from = LADDER.indexOf(refusal.from);
            const to = LADDER.indexOf(refusal.to);
            return (
                `Cannot go from ${refusal.from} to ${refusal.to} in one step. Widen one level at a time ` +
                `(${LADDER.slice(from, to + 1).join(' → ')}), so each level is observed before the ` +
                'next is granted.'
            );
        }
        case 'NO_DRY_RUN_START':
            return 'Dry-run has no recorded start. Re-select DRY_RUN to start the observation window.';
        case 'TOO_FEW_PASSES':
            return (
                `Dry-run has recorded ${refusal.passes} owner-orphan passes since the window opened, ` +
                `and at least ${refusal.required} is required. A week with no pass at all is a ` +
                'pass that never ran, not a quiet week — check the recorded passes before ' +
                'letting it stop agents unattended.'
            );
        case 'DWELL':
            return (
                `Dry-run has been active for ${refusal.days} of ${refusal.required} required ` +
                `days. ${refusal.left} more before the pass may stop agents unattended — the window exists ` +
                'so the orphans it reports can be compared against who actually left. This counts ' +
                'elapsed days, so running more passes does not shorten it.'
            );
    }
}

/**
 * WHY a widen is refused, as a code and its arguments, so the page can word it
 * in the reader's language rather than show the server's English with mode
 * codes in it (#4903). `describeOrphanPassModeRefusal` builds its sentence from
 * this same answer, so the two cannot disagree.
 */
export type OrphanPassModeRefusal =
    | { code: 'ABOVE_CLAMP'; next: IdentityWriteMode; clamp: IdentityWriteMode }
    | { code: 'MULTI_RUNG'; from: IdentityWriteMode; to: IdentityWriteMode }
    | { code: 'NO_DRY_RUN_START' }
    | { code: 'TOO_FEW_PASSES'; passes: number; required: number }
    | { code: 'DWELL'; days: number; required: number; left: number };

export function orphanPassModeRefusal(
    current: OrphanPassPolicy,
    next: IdentityWriteMode,
    now: Date,
    passesInWindow?: number,
    clamp: IdentityWriteMode = ORPHAN_PASS_MAX_MODE,
): OrphanPassModeRefusal | null {
    if (current.mode === next) return null;
    const from = LADDER.indexOf(current.mode);
    const to = LADDER.indexOf(next);

    // NARROWING IS ALWAYS ALLOWED, straight to DISABLED included. Somebody
    // turning automatic kills off is reacting to something.
    if (to < from) return null;

    if (isAboveClamp(next, clamp)) return { code: 'ABOVE_CLAMP', next, clamp };
    if (to - from > 1) return { code: 'MULTI_RUNG', from: current.mode, to: next };

    if (current.mode === 'DRY_RUN') {
        if (!current.dryRunSince) return { code: 'NO_DRY_RUN_START' };
        if (passesInWindow !== undefined && passesInWindow < DRY_RUN_MIN_PASSES) {
            return { code: 'TOO_FEW_PASSES', passes: passesInWindow, required: DRY_RUN_MIN_PASSES };
        }
        const days = (now.getTime() - current.dryRunSince.getTime()) / 86_400_000;
        if (days < DRY_RUN_MIN_DAYS) {
            return {
                code: 'DWELL',
                days: Math.floor(days),
                required: DRY_RUN_MIN_DAYS,
                left: Math.ceil(DRY_RUN_MIN_DAYS - days),
            };
        }
    }
    return null;
}

/**
 * Passes that RAN since a timestamp — every recorded row but ERROR, a refusal
 * included: a pass that found no ACTIVE agent is still the machinery working,
 * which is the fact the dwell cannot otherwise see.
 */
export async function countOrphanPassesSince(ctx: RequestContext, since: Date): Promise<number> {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.count({
            where: {
                tenantId: ctx.tenantId,
                automationKey: ORPHAN_PASS_AUTOMATION_KEY,
                executedAt: { gte: since },
                status: { not: 'ERROR' },
            },
        }),
    );
}

/** Set the pass's mode, one rung at a time. Audited as an access change. */
export async function setAgentOrphanPassMode(
    ctx: RequestContext,
    input: { mode: IdentityWriteMode },
    now: Date = new Date(),
): Promise<OrphanPassPolicy> {
    assertCanGovernOrphanPass(ctx);
    if (!(LADDER as readonly string[]).includes(input.mode)) {
        throw badRequest(`Unknown owner-orphan pass mode: ${String(input.mode)}`);
    }

    const current = await getAgentOrphanPassPolicy(ctx);
    const leavingDryRun = current.mode === 'DRY_RUN' && input.mode !== 'DRY_RUN';
    const passesInWindow =
        leavingDryRun && current.dryRunSince
            ? await countOrphanPassesSince(ctx, current.dryRunSince)
            : undefined;

    const refusal = describeOrphanPassModeRefusal(current, input.mode, now, passesInWindow);
    if (refusal) throw forbidden(refusal);
    if (current.mode === input.mode) return current;

    // Entering DRY_RUN (re)starts the clock; leaving it clears the stamp.
    const since = input.mode === 'DRY_RUN' ? now : null;
    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: {
                tenantId: ctx.tenantId,
                agentOrphanPassMode: input.mode,
                agentOrphanPassDryRunSince: since,
            },
            update: { agentOrphanPassMode: input.mode, agentOrphanPassDryRunSince: since },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'AGENT_ORPHAN_PASS_MODE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Agent owner-orphan pass mode: ${current.mode} → ${input.mode}`,
            // `access`: widening this lets a scheduled job stop agents
            // unattended — an access reviewer is its audience.
            detailsJson: {
                category: 'access',
                operation: input.mode === 'DISABLED' ? 'revoke' : 'grant',
                summary: `Agent owner-orphan pass mode: ${current.mode} → ${input.mode}`,
            },
            metadata: { from: current.mode, to: input.mode },
        }),
    );

    logger.info('agent owner-orphan pass mode changed', {
        component: 'agent-owner-orphan-policy',
        tenantId: ctx.tenantId,
        from: current.mode,
        to: input.mode,
    });

    return { mode: input.mode, dryRunSince: since };
}
