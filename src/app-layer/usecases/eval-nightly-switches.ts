/**
 * The LLM evaluation nightlies' on/off switches (owner decision 2026-11-27).
 *
 * ═══ THE SWITCH LIVES IN THE PRODUCT ═══
 *
 * garak, Ragas and Inspect run as GitHub Actions against a throwaway copy of
 * the app on the CI runner. Their on/off state is a row of the platform-level
 * `EvalNightlySwitch` table, ONE per nightly, and an absent row is off. A
 * scheduled run asks production for it (`readEvalNightlySwitchesForCi`, behind
 * the CI bearer token at `GET /api/evals/nightly-switches`) and stays off on
 * any answer but `true`. Production holds no GitHub credential and writes
 * nothing back.
 *
 * ═══ WHO READS, WHO WRITES ═══
 *
 * Reading: anybody the org settings page shows the "Evaluations" card to (the
 * page asks `evalsCardVisible` first; this read asks the org admin tier again
 * so no other caller skips it). The answer carries `canSwitch`, so the card
 * renders a control only where the write would be accepted.
 *
 * Writing: an ORG_OWNER of an OPERATOR organization, `EVALS_SWITCH_ORG_SLUGS`
 * (`evalSwitchRefusal`). The route's `requireOrgPermission` asks the owner half
 * and audits a refusal; this usecase asks both halves, and audits the operator
 * half's refusal as `ORG_AUTHZ_DENIED` itself, because the middleware cannot
 * see an environmental condition.
 *
 * ═══ WRITE, THEN AUDIT, BOTH VALUES ═══
 *
 * As `org-agent-switches.ts`: a change that moves nothing writes no row and no
 * audit entry; a change writes the row, then appends
 * `ORG_EVAL_NIGHTLY_SWITCHED` with the nightly and its before and after to the
 * operator organization's own chain (its own transaction, the org's advisory
 * lock). A failure of the audit append is logged at ERROR and does not undo
 * the switch, as the agent-switch and member-role writers behave.
 *
 * Platform-scoped (global prisma; no tenant, so no RLS applies).
 */
import prisma from '@/lib/prisma';
import { env } from '@/env';
import type { OrgContext } from '../types';
import { badRequest, forbidden } from '@/lib/errors/types';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { logger } from '@/lib/observability/logger';
import { isOrgAdminTier } from '@/lib/org-roles';
import { EVAL_NIGHTLY_KEYS, isEvalNightlyKey, type EvalNightlyKey } from '@/lib/evals/evaluation-nightlies';
import { evalSwitchRefusal } from '@/lib/evals/eval-switch-access';

export interface EvalNightlySwitchState {
    readonly enabled: boolean;
    /** When it was last switched; `null` for a nightly never switched (off). */
    readonly changedAt: string | null;
}

export interface EvalNightlySwitches {
    readonly nightlies: Readonly<Record<EvalNightlyKey, EvalNightlySwitchState>>;
    /** Whether the caller may change them: an owner of an operator organization. */
    readonly canSwitch: boolean;
}

/** What the CI endpoint answers: one boolean per nightly, nothing else. */
export type EvalNightlySwitchesForCi = Readonly<Record<EvalNightlyKey, boolean>>;

async function readStates(): Promise<Record<EvalNightlyKey, EvalNightlySwitchState>> {
    // Three rows at most, held by the CHECK; bounded by the key list.
    const rows = await prisma.evalNightlySwitch.findMany({
        where: { nightly: { in: [...EVAL_NIGHTLY_KEYS] } },
        select: { nightly: true, enabled: true, changedAt: true },
        take: EVAL_NIGHTLY_KEYS.length,
    });
    const byKey = new Map(rows.map((r) => [r.nightly, r]));
    const out = {} as Record<EvalNightlyKey, EvalNightlySwitchState>;
    for (const key of EVAL_NIGHTLY_KEYS) {
        const row = byKey.get(key);
        // Absent is off. `=== true` so nothing but a stored true reads as on.
        out[key] = { enabled: row?.enabled === true, changedAt: row ? row.changedAt.toISOString() : null };
    }
    return out;
}

function canSwitchFor(ctx: OrgContext): boolean {
    return (
        evalSwitchRefusal({
            orgSlug: ctx.orgSlug,
            canSwitchEvalNightlies: ctx.permissions.canSwitchEvalNightlies,
            operatorOrgs: env.EVALS_SWITCH_ORG_SLUGS,
        }) === null
    );
}

/** Read the switches, for the card. An org owner or admin may read them. */
export async function getEvalNightlySwitches(ctx: OrgContext): Promise<EvalNightlySwitches> {
    // The card's own audience: an org owner or admin (`evalsCardVisible`).
    if (!ctx.permissions.canViewPortfolio || !isOrgAdminTier(ctx.orgRole)) {
        throw forbidden('You do not have access to the evaluation nightlies.');
    }
    return { nightlies: await readStates(), canSwitch: canSwitchFor(ctx) };
}

/**
 * Turn one nightly on or off. Refused unless the caller is an ORG_OWNER of an
 * operator organization.
 */
export async function setEvalNightlySwitch(
    ctx: OrgContext,
    input: { nightly: EvalNightlyKey; enabled: boolean },
): Promise<EvalNightlySwitches> {
    if (!ctx.permissions.canSwitchEvalNightlies) {
        // The route's `requireOrgPermission` refused this first and audited it.
        throw forbidden('Only an organization owner can switch the evaluation nightlies.');
    }
    if (!canSwitchFor(ctx)) {
        await auditOperatorRefusal(ctx, input.nightly);
        throw forbidden('The evaluation nightlies are switched by the platform operator.');
    }
    if (!isEvalNightlyKey(input.nightly)) {
        throw badRequest('Unknown evaluation nightly.');
    }

    const current = await readStates();
    const before = current[input.nightly].enabled;
    if (before === input.enabled) {
        return { nightlies: current, canSwitch: true };
    }

    await prisma.evalNightlySwitch.upsert({
        where: { nightly: input.nightly },
        create: {
            nightly: input.nightly,
            enabled: input.enabled,
            changedAt: new Date(),
            changedByUserId: ctx.userId,
            changedInOrganizationId: ctx.organizationId,
        },
        update: {
            enabled: input.enabled,
            changedAt: new Date(),
            changedByUserId: ctx.userId,
            changedInOrganizationId: ctx.organizationId,
        },
    });

    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_EVAL_NIGHTLY_SWITCHED',
            targetUserId: null,
            detailsJson: { nightly: input.nightly, before, after: input.enabled },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.error('eval-nightly-switches.audit_emit_failed', {
            component: 'eval-nightly-switches',
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return { nightlies: await readStates(), canSwitch: true };
}

/**
 * The refusal the permission middleware cannot write: an owner, but of an
 * organization the operator has not named. Best-effort, as the middleware's.
 */
async function auditOperatorRefusal(ctx: OrgContext, nightly: string): Promise<void> {
    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_AUTHZ_DENIED',
            detailsJson: {
                reason: 'EVALS_SWITCH_NOT_OPERATOR_ORG',
                orgRole: ctx.orgRole,
                nightly: isEvalNightlyKey(nightly) ? nightly : null,
            },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('audit: failed to record ORG_AUTHZ_DENIED', {
            requestId: ctx.requestId,
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * What a scheduled nightly asks: one boolean per nightly, absent as false.
 * Called only by the CI endpoint, after its bearer token is verified.
 */
export async function readEvalNightlySwitchesForCi(): Promise<EvalNightlySwitchesForCi> {
    const states = await readStates();
    const out = {} as Record<EvalNightlyKey, boolean>;
    for (const key of EVAL_NIGHTLY_KEYS) out[key] = states[key].enabled;
    return out;
}
