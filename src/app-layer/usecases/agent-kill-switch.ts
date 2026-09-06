/**
 * The kill switch — usecase. Stopping one agent, or every agent in a tenant.
 *
 * The PLATFORM scope is deliberately not here: it has no tenant to bind, no
 * `RequestContext` to open a tenant transaction with, and no `PermissionSet` key
 * that could express it. It lives in `@/lib/agentic/kill-switch` and is gated by
 * `PLATFORM_ADMIN_API_KEY`. See that module's header.
 *
 * ## What is enforced where
 *
 * The route carries `requirePermission('admin.agent_kill_switch', …)`, so a
 * denial writes a hash-chained `AUTHZ_DENIED` row and returns the generic 403
 * that never names the key. This layer additionally asserts the coarse
 * read/write policy, so a caller reaching the usecase by some other path is
 * still bounded — but the ROUTE is where the audit row comes from, which is the
 * whole of Epic D.3 and the reason no new admin surface is left on a usecase
 * throw alone.
 *
 * ## The asymmetry between engaging and lifting, stated once
 *
 * Both take the same permission today. That is a deliberate starting point, not
 * an oversight: splitting them would let a tenant grant "may stop" without "may
 * start", which sounds prudent and is the wrong shape — an on-call who can stop
 * a fleet and cannot start it again turns a five-minute incident into a
 * next-business-day one, and the pressure that produces is to hand out the wider
 * key instead. What the separate `admin.agent_kill_switch` key BUYS is the
 * ability to delegate the pair without also delegating `admin.agent_registry`'s
 * authority to admit an agent nobody has scored.
 *
 * ## Lifting is an UPDATE, never a DELETE
 *
 * The row is the evidence that agents were stopped between two timestamps. An
 * incident review that cannot see the window cannot review the incident, and a
 * kill switch whose history is erased by using it is a control that destroys its
 * own audit trail.
 *
 * ## Concurrency
 *
 * Engage is protected by a partial unique index (`one_in_force_per_target`), so
 * two administrators pulling the same switch at the same instant cannot leave
 * two rows that must BOTH be lifted before agents resume — which would be a
 * stop that looks lifted and is not. Lift is a conditional `updateMany` on
 * `liftedAt: null`, so exactly one of two concurrent lifts claims it.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { KILL_SWITCH_DRILL_AGENT_ID, type KillScope } from '@/lib/agentic/kill-switch';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

/** How a kill row is reported to an operator surface. */
export interface KillSwitchRecord {
    id: string;
    /** DERIVED from `agentId`, never stored — see the model docstring. */
    scope: Extract<KillScope, 'AGENT' | 'TENANT'>;
    agentId: string | null;
    reason: string;
    engagedByUserId: string;
    engagedAt: Date;
    liftedAt: Date | null;
    liftedByUserId: string | null;
    liftReason: string | null;
}

/** One recorded drill, as the operator surface reports it. */
export interface KillSwitchDrillRecord {
    id: string;
    startedAt: Date;
    completedAt: Date | null;
    outcome: string;
    scopesHonoured: string[];
    scopesFailed: string[];
    toolCallsAfterKill: number;
    boundaryRefusalReason: string | null;
    detail: string;
    evidenceId: string | null;
    findingId: string | null;
}

/**
 * The one place `agentId` becomes a scope name. Two encodings of one fact can
 * disagree; one encoding plus one function cannot.
 */
export function killScopeOf(agentId: string | null): Extract<KillScope, 'AGENT' | 'TENANT'> {
    return agentId === null ? 'TENANT' : 'AGENT';
}

/** A reason an operator can act on, or a refusal. Never an empty string. */
function requireReason(raw: unknown, field: string): string {
    if (typeof raw !== 'string') throw badRequest(`\`${field}\` is required.`);
    const clean = sanitizePlainText(raw).trim();
    if (clean.length === 0) {
        throw badRequest(
            `\`${field}\` is required. A kill switch with no stated reason is an ` +
                'outage nobody can review afterwards.',
        );
    }
    if (clean.length > 2000) throw badRequest(`\`${field}\` must be 2000 characters or fewer.`);
    return clean;
}

function toRecord(row: {
    id: string;
    agentId: string | null;
    reason: string;
    engagedByUserId: string;
    engagedAt: Date;
    liftedAt: Date | null;
    liftedByUserId: string | null;
    liftReason: string | null;
}): KillSwitchRecord {
    return { ...row, scope: killScopeOf(row.agentId) };
}

/**
 * Stop an agent, or every agent in this tenant.
 *
 * `agentId: null` (or absent) means TENANT scope. When an agent IS named it is
 * resolved inside the tenant transaction first — not because a foreign key would
 * have done it (there deliberately is none: see the model docstring) but because
 * an operator who mistypes an id during an incident must be told immediately
 * rather than left believing a fleet is stopped when nothing is.
 *
 * `KILL_SWITCH_DRILL_AGENT_ID` is refused here. The drill engages its canary kill
 * through the store, not through this usecase; a human engaging one by hand would
 * make the next drill read its own leftover state and report PASSED for the
 * wrong reason.
 */
export async function engageKillSwitch(
    ctx: RequestContext,
    input: { agentId?: string | null; reason: string },
): Promise<KillSwitchRecord> {
    assertCanWrite(ctx);
    const reason = requireReason(input.reason, 'reason');
    const agentId = input.agentId ?? null;

    if (agentId === KILL_SWITCH_DRILL_AGENT_ID) {
        throw badRequest(
            'That agent id is reserved for the scheduled kill-switch drill and ' +
                'cannot be killed by hand.',
        );
    }

    return runInTenantContext(ctx, async (db) => {
        if (agentId !== null) {
            const agent = await db.registeredAgent.findFirst({
                where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            // Same shape whether absent or foreign, so a caller learns nothing
            // about another tenant's id space.
            if (!agent) throw notFound('Registered agent not found');
        }

        const existing = await db.agentKillSwitch.findFirst({
            where: { tenantId: ctx.tenantId, agentId, liftedAt: null },
            select: {
                id: true, agentId: true, reason: true, engagedByUserId: true,
                engagedAt: true, liftedAt: true, liftedByUserId: true, liftReason: true,
            },
        });
        // IDEMPOTENT. An operator hammering the stop button during an incident
        // must get "yes, it is stopped" rather than a unique-violation 500. The
        // partial unique index is still the authority; this is what makes the
        // common case pleasant, not what makes it correct.
        if (existing) return toRecord(existing);

        const row = await db.agentKillSwitch.create({
            data: {
                tenantId: ctx.tenantId,
                agentId,
                reason,
                engagedByUserId: ctx.userId,
            },
            select: {
                id: true, agentId: true, reason: true, engagedByUserId: true,
                engagedAt: true, liftedAt: true, liftedByUserId: true, liftReason: true,
            },
        });

        // Resolved into a local BEFORE the sink. Not style: `no-raw-prompt-logging`
        // classifies a call at a value position as "a helper this rule cannot
        // open", which is the hole class reserved for field bags whose names
        // never reach the source. A scalar computed one line earlier is a name
        // the rule can see, and it is computed once instead of twice.
        const scope = killScopeOf(agentId);
        await logEvent(db, ctx, {
            action: 'AGENT_KILL_ENGAGED',
            entityType: 'AgentKillSwitch',
            entityId: row.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentKillSwitch',
                operation: 'create',
                // Every field NAMED at the sink. Nothing is spread, and the
                // operator's reason text is deliberately absent: it is tenant
                // free text on a plaintext, hash-chained, never-deleted row.
                // What the trail needs is WHAT was stopped and by WHOM; the
                // reason lives on the switch row, which retention can reach.
                summary: `Kill switch ENGAGED at ${scope} scope`,
                after: {
                    killScope: scope,
                    agentId,
                    engagedByUserId: ctx.userId,
                },
            },
        });

        return toRecord(row);
    });
}

/**
 * Let the killed agents run again.
 *
 * A conditional `updateMany` on `liftedAt: null`, so two concurrent lifts cannot
 * both claim to have been the one that lifted it — and the loser is told the
 * switch was already lifted rather than reporting a success that did nothing.
 */
export async function liftKillSwitch(
    ctx: RequestContext,
    switchId: string,
    input: { liftReason: string },
): Promise<KillSwitchRecord> {
    assertCanWrite(ctx);
    const liftReason = requireReason(input.liftReason, 'liftReason');

    return runInTenantContext(ctx, async (db) => {
        const claimed = await db.agentKillSwitch.updateMany({
            where: { id: switchId, tenantId: ctx.tenantId, liftedAt: null },
            data: { liftedAt: new Date(), liftedByUserId: ctx.userId, liftReason },
        });
        if (claimed.count !== 1) {
            const present = await db.agentKillSwitch.findFirst({
                where: { id: switchId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!present) throw notFound('Kill switch not found');
            throw badRequest('That kill switch has already been lifted.');
        }

        const row = await db.agentKillSwitch.findFirstOrThrow({
            where: { id: switchId, tenantId: ctx.tenantId },
            select: {
                id: true, agentId: true, reason: true, engagedByUserId: true,
                engagedAt: true, liftedAt: true, liftedByUserId: true, liftReason: true,
            },
        });

        const scope = killScopeOf(row.agentId);
        // Computed here rather than inline at the sink, for the reason given at
        // the engage site above.
        const stoppedForMs = (row.liftedAt?.getTime() ?? 0) - row.engagedAt.getTime();
        await logEvent(db, ctx, {
            action: 'AGENT_KILL_LIFTED',
            entityType: 'AgentKillSwitch',
            entityId: row.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentKillSwitch',
                operation: 'update',
                summary: `Kill switch LIFTED at ${scope} scope`,
                after: {
                    killScope: scope,
                    agentId: row.agentId,
                    liftedByUserId: ctx.userId,
                    // How long agents were stopped. On the row rather than left
                    // to be computed later, because it is the number an incident
                    // review reaches for first and the two timestamps it comes
                    // from live on a table retention may eventually reach.
                    stoppedForMs,
                },
            },
        });

        return toRecord(row);
    });
}

/**
 * What is stopped here, and what was.
 *
 * `inForceOnly` defaults to FALSE so the operator surface shows the HISTORY by
 * default. A page that showed only live kills would answer "is anything stopped
 * right now" and silently lose the only record that anything ever was.
 *
 * Bounded `take`, ordered newest-first. Both halves matter: the bound keeps an
 * unbounded `findMany` off a tenant surface, and the ordering makes the bound
 * cut the OLDEST rows rather than an arbitrary slice.
 */
export async function listKillSwitches(
    ctx: RequestContext,
    opts: { inForceOnly?: boolean; take?: number } = {},
): Promise<{
    inForce: KillSwitchRecord[];
    history: KillSwitchRecord[];
    recentDrills: KillSwitchDrillRecord[];
}> {
    assertCanRead(ctx);
    const take = Math.min(Math.max(opts.take ?? 100, 1), 500);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.agentKillSwitch.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(opts.inForceOnly ? { liftedAt: null } : {}),
            },
            orderBy: { engagedAt: 'desc' },
            take,
            select: {
                id: true, agentId: true, reason: true, engagedByUserId: true,
                engagedAt: true, liftedAt: true, liftedByUserId: true, liftReason: true,
            },
        });
        // The DRILLS come back on the same read, and that pairing is the point.
        // "What is stopped here" and "is the stop control proven to work" are
        // the same operator question asked twice, and a surface that answered
        // only the first would show a kill switch nobody has evidence for. Ten
        // rows: enough to see the last week and a half of a daily drill, which
        // is the window in which a regression is still attributable to a deploy.
        const drills = await db.agentKillSwitchDrill.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { startedAt: 'desc' },
            take: 10,
            select: {
                id: true, startedAt: true, completedAt: true, outcome: true,
                scopesHonoured: true, scopesFailed: true, toolCallsAfterKill: true,
                boundaryRefusalReason: true, detail: true,
                evidenceId: true, findingId: true,
            },
        });

        const records = rows.map(toRecord);
        return {
            inForce: records.filter((r) => r.liftedAt === null),
            history: records,
            recentDrills: drills,
        };
    });
}
