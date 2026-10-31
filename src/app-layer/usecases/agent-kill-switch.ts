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
import { sweepOpenSandboxLeases } from '@/app-layer/integrations/openshell-sandbox-leases';
import type { PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { KILL_SWITCH_DRILL_AGENT_ID, type KillScope } from '@/lib/agentic/kill-switch';
import {
    isOwnerDepartedKill,
    ORPHAN_PASS_ACTOR,
    ownerDepartedReasonText,
    type DepartureSignal,
} from '@/lib/agentic/owner-orphan';
import { SYSTEM_PRINCIPAL } from '../context-system';

import { logger } from '@/lib/observability/logger';
import { assertCanRead } from '../policies/common';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { logEvent } from '../events/audit';
import {
    createAgenticNotification,
    resolveAgenticRecipients,
} from '../notifications/agentic';
import type { RequestContext } from '../types';

/** How a kill row is reported to an operator surface. */
export interface KillSwitchRecord {
    id: string;
    /** DERIVED from `agentId`, never stored — see the model docstring. */
    scope: Extract<KillScope, 'AGENT' | 'TENANT'>;
    agentId: string | null;
    reason: string;
    /**
     * The structured reason, or null for every kill a person engaged (#3670).
     * `OWNER_DEPARTED` is the owner-orphan pass's: counted apart from incidents,
     * and lifted only by the agent's new owner after a completed transfer.
     */
    reasonCode: string | null;
    engagedByUserId: string;
    engagedAt: Date;
    liftedAt: Date | null;
    liftedByUserId: string | null;
    liftReason: string | null;
    /**
     * WHO, resolved (#2450).
     *
     * The model stores ids and carries no `User` relation, so every surface that
     * wanted to say "stopped by Dana" had to either print a cuid or run its own
     * lookup. The usecase calls this "the evidence that agents were stopped
     * between two timestamps" — evidence naming an opaque id is evidence an
     * incident review cannot use.
     *
     * NULL when the actor no longer exists. A deleted user is not an error and
     * must not blank the row: the stop still happened, and losing the record
     * because the person left is the failure mode this field exists to avoid.
     */
    engagedBy: KillSwitchActor | null;
    liftedBy: KillSwitchActor | null;
}

/** An actor on a kill-switch row, named rather than referenced. */
export interface KillSwitchActor {
    id: string;
    name: string | null;
    email: string;
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

/** The columns every read of a kill row selects, so the record shape cannot drift. */
const KILL_ROW_SELECT = {
    id: true, agentId: true, reason: true, reasonCode: true, engagedByUserId: true,
    engagedAt: true, liftedAt: true, liftedByUserId: true, liftReason: true,
} as const;

function toRecord(row: {
    id: string;
    agentId: string | null;
    reason: string;
    reasonCode: string | null;
    engagedByUserId: string;
    engagedAt: Date;
    liftedAt: Date | null;
    liftedByUserId: string | null;
    liftReason: string | null;
}, actors?: Map<string, KillSwitchActor>): KillSwitchRecord {
    return {
        ...row,
        scope: killScopeOf(row.agentId),
        engagedBy: actors?.get(row.engagedByUserId) ?? null,
        liftedBy: row.liftedByUserId ? (actors?.get(row.liftedByUserId) ?? null) : null,
    };
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
    /**
     * Injected sandbox deletion — #4568. Absent in production today, because
     * nothing constructs a transport yet; a test supplies one to drive the
     * sweep's arms. Optional and third, so every existing caller is unchanged.
     */
    deps?: { readonly deleteSandbox?: (sandboxId: string) => Promise<void> },
): Promise<KillSwitchRecord> {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
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
            select: KILL_ROW_SELECT,
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
            select: KILL_ROW_SELECT,
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

        /*
            WHAT THE KILL REACHED IN THE SANDBOX RUNTIME — #4568.

            After the row exists, because the kill is already in force by then
            and this is cleanup after it. `sweepOpenSandboxLeases` NEVER throws:
            a kill that failed because a gateway was unreachable would be the
            safety control failing for a reason outside its own job.

            The coverage is written verbatim rather than as a bare count,
            because the owner decision owes exactly that: the guarantee is
            "sandboxes of currently-running work", not "sandboxes", and a row
            reading the latter is the overclaim this phase keeps catching. With
            no transport configured — production today — it reports
            `transport-absent` WITH the number it would have reached, so
            "0 deleted" cannot be read as "there were none".
        */
        const sweep = await sweepOpenSandboxLeases(db, {
            tenantId: ctx.tenantId,
            agentId,
            deleteSandbox: deps?.deleteSandbox,
        });
        /*
            Resolved into locals BEFORE the sink, the same reason the engage
            row above does it: `no-raw-prompt-logging` classifies an expression
            at a value position as "a helper this rule cannot open", and a
            PROPERTY ACCESS at a value position is exactly that. The engage row
            above interpolates `scope`, a local scalar, and is fine — so the
            template is not the problem, reading `sweep.deleted` inside it is.
            An intermediate attempt replaced the template with `String(...)`
            concatenation and made it WORSE, 218 to 223: every one of those
            calls is another helper the rule cannot open.
        */
        const sweptDeleted = sweep.deleted;
        const sweptAttempted = sweep.attempted;
        const sweptFailed = sweep.failed;
        const sweptCoverage = sweep.coverage;
        const sweepSummary = `Sandbox sweep: ${sweptDeleted} deleted of ${sweptAttempted} live (${sweptCoverage})`;
        await logEvent(db, ctx, {
            action: 'AGENT_KILL_SANDBOX_SWEEP',
            entityType: 'AgentKillSwitch',
            entityId: row.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentKillSwitch',
                operation: 'update',
                summary: sweepSummary,
                after: {
                    killScope: scope,
                    sandboxesAttempted: sweptAttempted,
                    sandboxesDeleted: sweptDeleted,
                    sandboxesFailed: sweptFailed,
                    sandboxCoverage: sweptCoverage,
                },
            },
        });

        // ─── The bell (#2441) ───────────────────────────────────────────
        //
        // AFTER the audit row, and best-effort. The audit entry is the
        // durable record and must not be jeopardised by a notification write;
        // the notification is a courtesy to the person whose integration has
        // just stopped. A kill switch that could not be engaged because the
        // bell was down is the wrong failure mode for a stop control, so the
        // catch is unconditional.
        //
        // INSIDE the tenant transaction, unlike `createAssignmentNotification`
        // at its call sites: `Notification` is a tenant-scoped table under
        // RLS, so the write needs the bound client. The isolation the
        // assignment sites buy with a separate transaction is bought here by
        // the try/catch — `createMany({ skipDuplicates: true })` is the one
        // write shape that cannot throw P2002 and poison the transaction,
        // which is exactly why the emitter uses it.
        try {
            const { recipientUserIds, agentName } = await resolveAgenticRecipients(
                db,
                ctx.tenantId,
                agentId,
            );
            await createAgenticNotification(db, 'AGENT_KILL_SWITCH_ENGAGED', {
                tenantId: ctx.tenantId,
                tenantSlug: ctx.tenantSlug ?? null,
                entityId: row.id,
                // Names what was stopped, at the scope it was stopped at. A
                // tenant-scope kill reports the whole workspace rather than
                // borrowing an agent's name, because lifting one agent would
                // not restart anything while the tenant arm stands.
                subject:
                    agentId === null
                        ? 'Every agent in this workspace'
                        : (agentName ?? `Agent ${agentId}`),
                recipientUserIds,
                actorUserId: ctx.userId,
            });
        } catch (err) {
            logger.warn('notification: failed to record agent kill-switch bell', {
                requestId: ctx.requestId,
                tenantId: ctx.tenantId,
                killSwitchId: row.id,
                // See the note at the quarantine bell in `agent-proposals.ts`
                // for why this is not `String(err)`.
                error: err instanceof Error ? err.message : 'non-Error thrown',
            });
        }

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
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    const liftReason = requireReason(input.liftReason, 'liftReason');

    return runInTenantContext(ctx, async (db) => {
        // AN OWNER_DEPARTED KILL HAS A PRECONDITION (#3670). Asked before the
        // claim, so a refused lift changes nothing; the trigger
        // `agent_kill_switch_reason_code_guard` asks the same question below the
        // usecase for any writer that does not come through here.
        const target = await db.agentKillSwitch.findFirst({
            where: { id: switchId, tenantId: ctx.tenantId },
            select: { id: true, agentId: true, reasonCode: true, engagedAt: true, liftedAt: true },
        });
        if (target && target.liftedAt === null && isOwnerDepartedKill(target)) {
            await assertOwnerDepartedKillLiftable(db, ctx, target);
        }

        let claimed: { count: number };
        try {
            claimed = await db.agentKillSwitch.updateMany({
                where: { id: switchId, tenantId: ctx.tenantId, liftedAt: null },
                data: { liftedAt: new Date(), liftedByUserId: ctx.userId, liftReason },
            });
        } catch (err) {
            // The trigger refused: the agent was re-owned, or the transfer the
            // check above read is no longer the one that names this person,
            // between the read and the write. Said as the same refusal.
            if (err instanceof Error && err.message.includes(OWNER_DEPARTED_LIFT_DB_REFUSAL)) {
                throw conflict(OWNER_DEPARTED_LIFT_REFUSED_MESSAGE);
            }
            throw err;
        }
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
            select: KILL_ROW_SELECT,
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
                    // NULL for every human kill; OWNER_DEPARTED for the pass's.
                    reasonCode: row.reasonCode,
                },
            },
        });

        return toRecord(row);
    });
}

/** The trigger's refusal code, matched when the database refuses a lift. */
const OWNER_DEPARTED_LIFT_DB_REFUSAL = 'AGENT_OWNER_DEPARTED_LIFT_REFUSED';

const OWNER_DEPARTED_LIFT_REFUSED_MESSAGE =
    "This kill was engaged because the agent's owner left the workspace (OWNER_DEPARTED). " +
    'It cannot be lifted until a two-step ownership transfer of the agent has completed ' +
    'after the kill: an OWNER proposes the new owner, the new owner accepts, and the new ' +
    'owner then lifts this kill with a reason.';

/**
 * May this person lift this OWNER_DEPARTED kill? (Q6 of the roadmap, #3670.)
 *
 * Two conditions, and both are the decision rather than either alone:
 *
 *   1. A COMPLETED `AgentOwnershipTransfer` of the agent exists whose
 *      `completedAt` is AFTER the kill was engaged. A transfer that completed
 *      before the kill is the history that led to the departed owner, not the
 *      remedy for their departure.
 *   2. The person lifting is the agent's CURRENT owner, and that owner is the
 *      person the latest such transfer named. "The new owner lifts it with a
 *      reason": the accountability the kill says is missing is restored by the
 *      transfer, and the person who now carries it is the one who restarts it.
 *
 * The kill-switch key (`admin.agent_kill_switch`, at the route) is still
 * required; this adds a precondition to it rather than a second key, as the
 * permission table of `docs/agentic-iam-roadmap.md` records. A retired or
 * removed agent cannot be transferred, so its OWNER_DEPARTED kill stays — inert,
 * because a retired agent's credentials are revoked, and visible in the history.
 */
async function assertOwnerDepartedKillLiftable(
    db: PrismaTx,
    ctx: RequestContext,
    kill: { id: string; agentId: string | null; engagedAt: Date },
): Promise<void> {
    if (kill.agentId === null) throw conflict(OWNER_DEPARTED_LIFT_REFUSED_MESSAGE);
    const agent = await db.registeredAgent.findFirst({
        where: { id: kill.agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { ownerUserId: true },
    });
    if (!agent) {
        throw conflict(
            'This OWNER_DEPARTED kill names an agent that is no longer in the register, so ' +
                'no ownership transfer of it can complete and the kill stays in force.',
        );
    }
    const transfer = await db.agentOwnershipTransfer.findFirst({
        where: {
            tenantId: ctx.tenantId,
            agentId: kill.agentId,
            status: 'COMPLETED',
            completedAt: { gt: kill.engagedAt },
        },
        orderBy: { completedAt: 'desc' },
        select: { toOwnerUserId: true },
    });
    if (!transfer) throw conflict(OWNER_DEPARTED_LIFT_REFUSED_MESSAGE);
    if (ctx.userId !== agent.ownerUserId || transfer.toOwnerUserId !== agent.ownerUserId) {
        throw forbidden(
            "Only the agent's new owner — the person the completed ownership transfer named — " +
                'can lift a kill engaged because the previous owner left.',
        );
    }
}

/**
 * Stop one agent because its accountable owner has left — the owner-orphan
 * pass's kill, and the only writer of `reasonCode` (#3670).
 *
 * NOT reachable by a person. The context must be the system principal with
 * actor type JOB — what `buildSystemContext` builds — so the audit row is
 * written with no user (the `system` sentinel maps to NULL at the audit seam)
 * and `actorType: 'JOB'`, and names nobody. The kill row records
 * `ORPHAN_PASS_ACTOR` as `engagedByUserId`, which the database CHECK requires
 * beside the code; the route's engage path writes the caller's own user id and
 * can therefore never produce an OWNER_DEPARTED row.
 *
 * AGENT scope only. Idempotent the way the human engage is: an agent-scope kill
 * already in force is left standing (the partial unique index admits one per
 * target), whatever engaged it, and `created: false` says so. No
 * `AGENT_KILL_SWITCH_ENGAGED` bell: it would route to the agent's owner, who is
 * the person who left — the pass sends `AGENT_OWNER_DEPARTED` to the
 * workspace's OWNERs instead.
 */
export async function engageOwnerDepartedKill(
    ctx: RequestContext,
    input: { agentId: string; signals: readonly DepartureSignal[] },
): Promise<{ record: KillSwitchRecord; created: boolean }> {
    if (ctx.actorType !== 'JOB' || ctx.userId !== SYSTEM_PRINCIPAL) {
        throw forbidden('An OWNER_DEPARTED kill is engaged only by the owner-orphan pass.');
    }
    if (input.agentId === KILL_SWITCH_DRILL_AGENT_ID) {
        throw badRequest('The drill canary has no owner to depart.');
    }
    if (input.signals.length === 0) {
        throw badRequest('An OWNER_DEPARTED kill needs the departure signal that caused it.');
    }

    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: input.agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent) throw notFound('Registered agent not found');

        const existing = await db.agentKillSwitch.findFirst({
            where: { tenantId: ctx.tenantId, agentId: input.agentId, liftedAt: null },
            select: KILL_ROW_SELECT,
        });
        if (existing) return { record: toRecord(existing), created: false };

        const row = await db.agentKillSwitch.create({
            data: {
                tenantId: ctx.tenantId,
                agentId: input.agentId,
                reason: ownerDepartedReasonText(input.signals),
                reasonCode: 'OWNER_DEPARTED',
                engagedByUserId: ORPHAN_PASS_ACTOR,
            },
            select: KILL_ROW_SELECT,
        });

        // Every value is a member of the row just written or a literal — no
        // person, no reason text. The departed owner is identified by the
        // agent, which is `entityId`'s subject. AGENT scope is a literal
        // because this path cannot write any other: `agentId` is required.
        await logEvent(db, ctx, {
            action: 'AGENT_KILL_ENGAGED',
            entityType: 'AgentKillSwitch',
            entityId: row.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentKillSwitch',
                operation: 'create',
                summary: 'Kill switch ENGAGED at AGENT scope, reason code OWNER_DEPARTED',
                after: {
                    killScope: 'AGENT',
                    agentId: row.agentId,
                    engagedByUserId: row.engagedByUserId,
                    reasonCode: row.reasonCode,
                },
            },
        });

        return { record: toRecord(row), created: true };
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
            select: KILL_ROW_SELECT,
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

        // ONE lookup for every actor on the page, not one per row. `take` is
        // bounded at 500, so this is at most 1000 ids before dedup — and the
        // alternative, resolving per row in the client, is the N+1 that made
        // every previous surface print the cuid instead.
        const actorIds = [
            ...new Set(
                rows.flatMap((r) => [r.engagedByUserId, r.liftedByUserId]).filter(
                    (id): id is string => typeof id === 'string' && id.length > 0,
                ),
            ),
        ];
        const actors = new Map<string, KillSwitchActor>(
            actorIds.length === 0
                ? []
                : (
                      await db.user.findMany({
                          where: { id: { in: actorIds } },
                          select: { id: true, name: true, email: true },
                      })
                  ).map((u) => [u.id, u]),
        );

        const records = rows.map((r) => toRecord(r, actors));
        return {
            inForce: records.filter((r) => r.liftedAt === null),
            history: records,
            recentDrills: drills,
        };
    });
}
