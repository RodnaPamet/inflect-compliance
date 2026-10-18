/**
 * THE AGENT OWNER-ORPHAN PASS (#3670, step 2b of the agentic IAM roadmap).
 *
 * When a person leaves, the agents they own keep their credentials and their
 * grants, and nobody answers for them. Once a day, per tenant, this pass finds
 * the ACTIVE agents whose accountable owner has left (`lib/agentic/owner-orphan`
 * decides what "left" means) and, depending on the tenant's own mode:
 *
 *   DISABLED   evaluates nothing, and records that it refused (`MODE_DISABLED`).
 *   DRY_RUN    records each orphan on the execution row and rings
 *              `AGENT_OWNER_DEPARTED` to the workspace's OWNERs. It writes no
 *              kill, no suspension, no task and no credential change.
 *   AUTOMATIC  contains each orphan: engages its kill switch with reason code
 *              `OWNER_DEPARTED` as `system:agent-owner-orphan-pass`
 *              (`engageOwnerDepartedKill`), suspends it
 *              (`suspendAgentForOwnerDeparture`), opens an ownership-transfer
 *              task for the departed owner's manager when one is known, and
 *              rings the bell. Both audit rows have actor type JOB and no user.
 *
 * ## Every refusal records a row
 *
 * Unlike the identity leaver — whose two ladder refusals write no execution row,
 * which is why a DISABLED tenant there "looks identical to a dead worker" — every
 * refusal here writes a NOT_APPLICABLE row naming its reason: `MODE_DISABLED`,
 * `MODE_ABOVE_CLAMP`, `NO_ACTIVE_AGENTS`. The issue's hardening checklist asks
 * for it, and the cost is one small row per tenant per day. A pass that threw
 * writes an ERROR row through its own seam.
 *
 * ## The kill comes first
 *
 * The kill switch is what stops an agent at the tool boundary, including runs
 * already in flight; the register's status is what stops new credentials being
 * honoured and what an operator reads. So the kill is engaged first and the
 * suspension second, each in its own transaction, and each recorded: a
 * suspension that fails after a kill succeeded leaves the agent stopped, and the
 * row says which half did not land (`failedStep`). Containment stays idempotent
 * across days: an agent the pass suspended is no longer ACTIVE, so tomorrow's
 * pass does not see it; one somebody reactivated without lifting the kill is
 * suspended again and its standing kill reported, not doubled.
 *
 * ## What the row carries, and what it never does
 *
 * Agent ids, the owner's user id (an opaque cuid), signal CODES and employee
 * ids. Never an email, a name or a reason text — `IntegrationExecution.resultJson`
 * is not encrypted at rest.
 *
 * @module usecases/agent-owner-orphan-pass
 */
import type { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';
import { emailKey } from '@/lib/identity/email-key';
import { isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { logger } from '@/lib/observability/logger';
import { recordAgentOwnerOrphanPass } from '@/lib/observability/integration-metrics';
import {
    AGENTIC_PASS_PROVIDER,
    classifyOwnerDeparture,
    indexRosterByEmailKey,
    matchOwnerToRoster,
    MAX_REPORTED_ORPHANS,
    MAX_ROSTER_READ,
    ORPHAN_PASS_AUTOMATION_KEY,
    ORPHAN_PASS_MAX_MODE,
    orphanPassStatus,
    type DepartureSignal,
    type HrMatch,
    type MembershipObservation,
    type OrphanNote,
    type OrphanOutcome,
    type OrphanPassRefusal,
    type RosterEmployee,
} from '@/lib/agentic/owner-orphan';
import { buildDelegatedJobContext, buildSystemContext, SYSTEM_PRINCIPAL } from '../context-system';
import { drainPages, DRAIN_PAGE_SIZE } from '../jobs/drain-pages';
import { createAgenticNotification, resolveAgenticRecipients } from '../notifications/agentic';
import { getAgentOrphanPassPolicy } from './agent-owner-orphan-policy';
import { engageOwnerDepartedKill } from './agent-kill-switch';
import { suspendAgentForOwnerDeparture } from './agent-registry';
import { createTask } from './task';

/** What the pass decided — and, at AUTOMATIC, did — about the transfer task. */
export type TransferTaskOutcome =
    | { status: 'WOULD_OPEN'; managerUserId: string }
    | { status: 'OPENED'; managerUserId: string; taskId: string }
    | { status: 'NO_MANAGER_KNOWN' }
    | { status: 'NOT_OPENED_KILL_ALREADY_IN_FORCE' }
    | { status: 'FAILED'; managerUserId: string; error: string };

/** One orphan, as the execution row records it. */
export interface OrphanDecision {
    agentId: string;
    /** An opaque cuid. The person is identified by nothing else on the row. */
    ownerUserId: string;
    signals: DepartureSignal[];
    outcome: OrphanOutcome;
    killSwitchId?: string;
    suspended?: boolean;
    failedStep?: 'KILL' | 'SUSPEND';
    error?: string;
    transferTask: TransferTaskOutcome;
    notified: number;
}

export interface OrphanPassResult {
    tenantId: string;
    mode: IdentityWriteMode | 'unknown';
    status: 'PASSED' | 'PARTIAL' | 'NOT_APPLICABLE' | 'ERROR';
    refusal: OrphanPassRefusal | null;
    activeAgents: number;
    orphans: number;
    contained: number;
    failed: number;
    executionId: string | null;
}

/** A thrown message, bounded, for the row. Our own errors, never a person's data. */
function errorText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

interface AgentRow {
    id: string;
    name: string;
    ownerUserId: string;
}

interface Population {
    agents: AgentRow[];
    membershipByOwner: ReadonlyMap<string, MembershipObservation>;
    hrByOwner: ReadonlyMap<string, HrMatch>;
    rosterRead: boolean;
    rosterSize: number;
    /** Manager's user id per departed-owner employee id, when exactly one is known. */
    managerUserByEmployee: ReadonlyMap<string, string>;
}

/**
 * Read everything the decision needs, in one tenant transaction and a fixed
 * number of queries — never one per agent.
 */
async function readPopulation(ctx: RequestContext): Promise<Population> {
    return runInTenantContext(ctx, async (db) => {
        const agents = await drainPages((cursor) =>
            db.registeredAgent.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ACTIVE',
                    deletedAt: null,
                    isLegacyPlaceholder: false,
                },
                select: { id: true, name: true, ownerUserId: true },
                orderBy: { id: 'asc' },
                take: DRAIN_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
        );
        if (agents.length === 0) {
            return {
                agents,
                membershipByOwner: new Map(),
                hrByOwner: new Map(),
                rosterRead: true,
                rosterSize: 0,
                managerUserByEmployee: new Map(),
            };
        }

        const ownerIds = [...new Set(agents.map((a) => a.ownerUserId))];
        const [memberships, owners, roster] = await Promise.all([
            db.tenantMembership.findMany({
                where: { tenantId: ctx.tenantId, userId: { in: ownerIds } },
                select: { userId: true, status: true },
                take: ownerIds.length,
            }),
            db.user.findMany({
                where: { id: { in: ownerIds } },
                select: { id: true, email: true },
                take: ownerIds.length,
            }),
            // ONE PAST the cap, so a truncated roster is a fact the pass holds
            // rather than one it cannot observe.
            db.employee.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, workEmail: true, status: true, managerEmployeeId: true },
                orderBy: { id: 'asc' },
                take: MAX_ROSTER_READ + 1,
            }),
        ]);

        // An ABSENT row is what the product's own Remove action leaves: it
        // deletes the membership. See `lib/agentic/owner-orphan`.
        const membershipByOwner = new Map<string, MembershipObservation>(
            ownerIds.map((id) => [id, 'ABSENT' as MembershipObservation]),
        );
        for (const m of memberships) membershipByOwner.set(m.userId, m.status);

        const rosterRead = roster.length <= MAX_ROSTER_READ;
        const typedRoster: RosterEmployee[] = roster.map((e) => ({
            id: e.id,
            workEmail: e.workEmail,
            status: e.status,
            managerEmployeeId: e.managerEmployeeId,
        }));
        const index = indexRosterByEmailKey(rosterRead ? typedRoster : []);
        const emailByOwner = new Map(owners.map((u) => [u.id, u.email]));
        const hrByOwner = new Map<string, HrMatch>(
            ownerIds.map((id) => [id, matchOwnerToRoster(emailByOwner.get(id), index, rosterRead)]),
        );

        // THE MANAGER, by the same rule as the owner: the manager Employee's
        // work email, normalised, against a User whose own address normalises
        // to the same key (`hashForLookup` normalises exactly as `emailKey`
        // does, so the lookup is by key, and the result is re-checked by key),
        // holding an ACTIVE membership here. Exactly one, or nobody.
        const employeeById = new Map(typedRoster.map((e) => [e.id, e]));
        const managerKeyByEmployee = new Map<string, string>();
        for (const match of hrByOwner.values()) {
            if (match.kind !== 'ONE' || match.managerEmployeeId === null) continue;
            const manager = employeeById.get(match.managerEmployeeId);
            const key = emailKey(manager?.workEmail);
            if (key) managerKeyByEmployee.set(match.employeeId, key);
        }
        const managerKeys = [...new Set(managerKeyByEmployee.values())];
        const managerUsers =
            managerKeys.length === 0
                ? []
                : await db.user.findMany({
                      where: { emailHash: { in: managerKeys.map((k) => hashForLookup(k)) } },
                      select: { id: true, email: true },
                      take: managerKeys.length * 2,
                  });
        const activeManagerIds =
            managerUsers.length === 0
                ? new Set<string>()
                : new Set(
                      (
                          await db.tenantMembership.findMany({
                              where: {
                                  tenantId: ctx.tenantId,
                                  userId: { in: managerUsers.map((u) => u.id) },
                                  status: 'ACTIVE',
                              },
                              select: { userId: true },
                              take: managerUsers.length,
                          })
                      ).map((m) => m.userId),
                  );
        const usersByKey = new Map<string, string[]>();
        for (const u of managerUsers) {
            const key = emailKey(u.email);
            if (!key) continue;
            usersByKey.set(key, [...(usersByKey.get(key) ?? []), u.id]);
        }
        const managerUserByEmployee = new Map<string, string>();
        for (const [employeeId, key] of managerKeyByEmployee) {
            const hits = usersByKey.get(key) ?? [];
            if (hits.length === 1 && activeManagerIds.has(hits[0])) {
                managerUserByEmployee.set(employeeId, hits[0]);
            }
        }

        return {
            agents,
            membershipByOwner,
            hrByOwner,
            rosterRead,
            rosterSize: Math.min(roster.length, MAX_ROSTER_READ),
            managerUserByEmployee,
        };
    });
}

function triggeredByOf(ctx: RequestContext): 'scheduled' | 'manual' {
    return ctx.userId && ctx.userId !== SYSTEM_PRINCIPAL ? 'manual' : 'scheduled';
}

/** The one writer of a pass that RAN. ERROR has its own seam below. */
async function writeExecutionRow(
    ctx: RequestContext,
    status: 'PASSED' | 'PARTIAL' | 'NOT_APPLICABLE',
    resultJson: Prisma.InputJsonValue,
    jobRunId: string | undefined,
): Promise<string> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                provider: AGENTIC_PASS_PROVIDER,
                automationKey: ORPHAN_PASS_AUTOMATION_KEY,
                status,
                triggeredBy: triggeredByOf(ctx),
                jobRunId: jobRunId ?? null,
                completedAt: new Date(),
                resultJson,
            },
            select: { id: true },
        }),
    );
    return row.id;
}

async function writeErrorExecutionRow(
    ctx: RequestContext,
    resultJson: Prisma.InputJsonValue,
    jobRunId: string | undefined,
): Promise<string> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                provider: AGENTIC_PASS_PROVIDER,
                automationKey: ORPHAN_PASS_AUTOMATION_KEY,
                status: 'ERROR',
                triggeredBy: triggeredByOf(ctx),
                jobRunId: jobRunId ?? null,
                completedAt: new Date(),
                resultJson,
            },
            select: { id: true },
        }),
    );
    return row.id;
}

const REFUSAL_DETAIL: Readonly<Record<OrphanPassRefusal, string>> = {
    MODE_DISABLED:
        "The owner-orphan pass is DISABLED for this workspace, so no agent's owner was checked. " +
        'An OWNER sets the mode at /admin/agents/owner-orphan-pass.',
    MODE_ABOVE_CLAMP:
        'The stored mode is above the highest rung this build of the pass acts at, so nothing ' +
        'was evaluated. Narrow the mode, or raise the ceiling in a reviewed change.',
    NO_ACTIVE_AGENTS:
        'This workspace has no ACTIVE registered agent, so there was no owner to check. ' +
        'An empty population is recorded as such — it is not a clean result.',
};

/**
 * Who the bells go to: the workspace's ACTIVE OWNERs — the holders of the key
 * that moves ownership. Read ONCE per pass, not once per orphan.
 */
async function resolveOwnerRecipients(ctx: RequestContext): Promise<string[]> {
    try {
        return await runInTenantContext(ctx, async (db) =>
            (await resolveAgenticRecipients(db, ctx.tenantId, null)).recipientUserIds,
        );
    } catch {
        return [];
    }
}

/**
 * The rung's sentence for the bell — what the pass DID, never more. A FAILED
 * containment must not ring as a contained one: the reader of that bell is the
 * person who would otherwise go and stop the agent by hand.
 */
function bellDetail(outcome: OrphanOutcome, failedStep: 'KILL' | 'SUSPEND' | undefined): string {
    switch (outcome) {
        case 'WOULD_SUSPEND_AND_KILL':
            return (
                'the owner-orphan pass is in DRY_RUN, so it was NOT stopped. At AUTOMATIC it ' +
                'would be suspended and its kill switch engaged.'
            );
        case 'FAILED':
            return failedStep === 'KILL'
                ? 'the owner-orphan pass could NOT engage its kill switch, so it may still be acting. ' +
                      'Stop it by hand and check the pass record.'
                : 'the owner-orphan pass engaged its kill switch (OWNER_DEPARTED) but could not suspend ' +
                      'it. Check the pass record.';
        default:
            return (
                'the owner-orphan pass suspended it and engaged its kill switch (OWNER_DEPARTED). ' +
                'The kill lifts only after a completed ownership transfer, by the new owner.'
            );
    }
}

/** The bell for one orphan. Best-effort: a bell that fails never fails the pass. */
async function notifyOrphan(
    ctx: RequestContext,
    agent: AgentRow,
    detail: string,
    owners: readonly string[],
): Promise<number> {
    try {
        return await runInTenantContext(ctx, async (db) => {
            const outcome = await createAgenticNotification(db, 'AGENT_OWNER_DEPARTED', {
                tenantId: ctx.tenantId,
                tenantSlug: ctx.tenantSlug ?? null,
                entityId: agent.id,
                subject: agent.name,
                detail,
                // The departed owner is never told about their own departure:
                // filtered out here rather than passed as the actor, because
                // there is no human actor.
                recipientUserIds: owners.filter((id) => id !== agent.ownerUserId),
                actorUserId: null,
            });
            return outcome.created;
        });
    } catch (err) {
        logger.warn('agent owner-orphan pass could not ring its bell', {
            component: 'agent-owner-orphan-pass',
            tenantId: ctx.tenantId,
            agentId: agent.id,
            errorMessage: err instanceof Error ? err.message : 'non-Error thrown',
        });
        return 0;
    }
}

/** Open the transfer task for the departed owner's manager. AUTOMATIC only. */
async function openTransferTask(
    ctx: RequestContext,
    agent: AgentRow,
    managerUserId: string,
    killSwitchId: string,
): Promise<TransferTaskOutcome> {
    try {
        // `Task.createdByUserId` is a NOT NULL foreign key to `User`, so a task
        // cannot be created by the system principal. Delegated to the manager
        // it is assigned to — the policy-review reminder's precedent — with
        // actor type JOB, so the trail reads "a job raised this for <manager>".
        const taskCtx = buildDelegatedJobContext({
            tenantId: ctx.tenantId,
            job: 'agent-owner-orphan-pass',
            onBehalfOf: managerUserId,
            tenantSlug: ctx.tenantSlug,
            requestId: ctx.requestId,
        });
        const task = await createTask(taskCtx, {
            source: 'INTEGRATION',
            type: 'TASK',
            title: `Arrange an ownership transfer for agent "${agent.name}"`,
            description:
                `The registered agent "${agent.name}" was suspended and its kill switch engaged ` +
                '(reason OWNER_DEPARTED) because its accountable owner has left. You are their ' +
                'manager on record. Agree who should own it now; an OWNER of this workspace proposes ' +
                'the transfer, the new owner accepts it, and the new owner then lifts the kill switch ' +
                'with a reason. Until then the agent stays stopped.',
            priority: 'P1',
            assigneeUserId: managerUserId,
            metadataJson: {
                kind: 'AGENT_OWNERSHIP_TRANSFER',
                agentId: agent.id,
                killSwitchId,
                reasonCode: 'OWNER_DEPARTED',
            },
        });
        return { status: 'OPENED', managerUserId, taskId: task.id };
    } catch (err) {
        return { status: 'FAILED', managerUserId, error: errorText(err) };
    }
}

/** The manager's user id for this owner, when exactly one is known. */
function managerFor(population: Population, ownerUserId: string): string | null {
    const match = population.hrByOwner.get(ownerUserId);
    if (!match || match.kind !== 'ONE') return null;
    const manager = population.managerUserByEmployee.get(match.employeeId) ?? null;
    // A departed owner listed as their own manager is a roster defect, and a
    // task assigned to the person who left reaches nobody.
    return manager === ownerUserId ? null : manager;
}

/** Contain one orphan at AUTOMATIC: kill first, then suspend, then the task. */
async function containOrphan(
    ctx: RequestContext,
    agent: AgentRow,
    signals: DepartureSignal[],
    managerUserId: string | null,
): Promise<Omit<OrphanDecision, 'notified'>> {
    const base = { agentId: agent.id, ownerUserId: agent.ownerUserId, signals };

    let killSwitchId: string;
    let killCreated: boolean;
    try {
        const engaged = await engageOwnerDepartedKill(ctx, { agentId: agent.id, signals });
        killSwitchId = engaged.record.id;
        killCreated = engaged.created;
    } catch (err) {
        // The kill is the stop that matters. Without it the suspension is
        // still attempted — a suspended agent's credentials are refused too —
        // and the row says the kill did not land.
        let suspended = false;
        try {
            suspended = (await suspendAgentForOwnerDeparture(ctx, { agentId: agent.id })).suspended;
        } catch {
            suspended = false;
        }
        return {
            ...base,
            outcome: 'FAILED',
            failedStep: 'KILL',
            error: errorText(err),
            suspended,
            transferTask: managerUserId
                ? { status: 'FAILED', managerUserId, error: 'not opened: the kill was not engaged' }
                : { status: 'NO_MANAGER_KNOWN' },
        };
    }

    let suspended: boolean;
    try {
        suspended = (await suspendAgentForOwnerDeparture(ctx, { agentId: agent.id })).suspended;
    } catch (err) {
        return {
            ...base,
            outcome: 'FAILED',
            failedStep: 'SUSPEND',
            error: errorText(err),
            killSwitchId,
            suspended: false,
            transferTask: managerUserId
                ? await openTransferTaskIfNew(ctx, agent, managerUserId, killSwitchId, killCreated)
                : { status: 'NO_MANAGER_KNOWN' },
        };
    }

    return {
        ...base,
        outcome: killCreated ? 'SUSPENDED_AND_KILLED' : 'SUSPENDED_KILL_ALREADY_IN_FORCE',
        killSwitchId,
        suspended,
        transferTask: managerUserId
            ? await openTransferTaskIfNew(ctx, agent, managerUserId, killSwitchId, killCreated)
            : { status: 'NO_MANAGER_KNOWN' },
    };
}

/**
 * One task per KILL ENGAGEMENT. A kill already in force was engaged by somebody
 * else, or by an earlier pass that already opened the task — a second task for
 * the same stop is noise the manager learns to close.
 */
async function openTransferTaskIfNew(
    ctx: RequestContext,
    agent: AgentRow,
    managerUserId: string,
    killSwitchId: string,
    killCreated: boolean,
): Promise<TransferTaskOutcome> {
    if (!killCreated) return { status: 'NOT_OPENED_KILL_ALREADY_IN_FORCE' };
    return openTransferTask(ctx, agent, managerUserId, killSwitchId);
}

/**
 * Run one tenant's pass and record it. Never throws: a pass that broke is a
 * recorded ERROR row, so the sweep moves on and the tenant is not left looking
 * like one nobody checked.
 */
export async function runAgentOwnerOrphanPass(input: {
    tenantId: string;
    tenantSlug?: string;
    jobRunId?: string;
}): Promise<OrphanPassResult> {
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'agent-owner-orphan-pass',
        tenantSlug: input.tenantSlug,
        ...(input.jobRunId ? { discriminator: input.jobRunId } : {}),
    });

    const empty = {
        tenantId: input.tenantId,
        activeAgents: 0,
        orphans: 0,
        contained: 0,
        failed: 0,
    };

    let mode: IdentityWriteMode | 'unknown' = 'unknown';
    try {
        const policy = await getAgentOrphanPassPolicy(ctx);
        mode = policy.mode;

        const refusal: OrphanPassRefusal | null =
            policy.mode === 'DISABLED'
                ? 'MODE_DISABLED'
                : isAboveClamp(policy.mode, ORPHAN_PASS_MAX_MODE)
                  ? 'MODE_ABOVE_CLAMP'
                  : null;
        if (refusal) {
            const executionId = await writeExecutionRow(
                ctx,
                'NOT_APPLICABLE',
                { mode: policy.mode, refusal, detail: REFUSAL_DETAIL[refusal], maxMode: ORPHAN_PASS_MAX_MODE },
                input.jobRunId,
            );
            recordAgentOwnerOrphanPass({
                outcome: refusal === 'MODE_DISABLED' ? 'mode_disabled' : 'mode_above_clamp',
                mode: policy.mode,
                orphans: 0,
            });
            return { ...empty, mode: policy.mode, status: 'NOT_APPLICABLE', refusal, executionId };
        }

        const population = await readPopulation(ctx);
        if (population.agents.length === 0) {
            const executionId = await writeExecutionRow(
                ctx,
                'NOT_APPLICABLE',
                {
                    mode: policy.mode,
                    refusal: 'NO_ACTIVE_AGENTS',
                    detail: REFUSAL_DETAIL.NO_ACTIVE_AGENTS,
                    population: { activeAgents: 0 },
                    maxMode: ORPHAN_PASS_MAX_MODE,
                },
                input.jobRunId,
            );
            recordAgentOwnerOrphanPass({ outcome: 'no_active_agents', mode: policy.mode, orphans: 0 });
            return {
                ...empty,
                mode: policy.mode,
                status: 'NOT_APPLICABLE',
                refusal: 'NO_ACTIVE_AGENTS',
                executionId,
            };
        }

        const decisions: OrphanDecision[] = [];
        const notes: { agentId: string; note: OrphanNote }[] = [];
        const owners = await resolveOwnerRecipients(ctx);
        for (const agent of population.agents) {
            const verdict = classifyOwnerDeparture({
                membership: population.membershipByOwner.get(agent.ownerUserId) ?? 'ABSENT',
                hr: population.hrByOwner.get(agent.ownerUserId) ?? { kind: 'NOT_READ' },
            });
            if (verdict.note) notes.push({ agentId: agent.id, note: verdict.note });
            if (!verdict.orphaned) continue;

            const managerUserId = managerFor(population, agent.ownerUserId);
            if (policy.mode === 'AUTOMATIC') {
                const decided = await containOrphan(ctx, agent, verdict.signals, managerUserId);
                const notified = await notifyOrphan(
                    ctx,
                    agent,
                    bellDetail(decided.outcome, decided.failedStep),
                    owners,
                );
                decisions.push({ ...decided, notified });
            } else {
                // DRY_RUN: nothing below this line writes a kill, a suspension,
                // a task or a credential. The bell is the only write.
                const notified = await notifyOrphan(
                    ctx,
                    agent,
                    bellDetail('WOULD_SUSPEND_AND_KILL', undefined),
                    owners,
                );
                decisions.push({
                    agentId: agent.id,
                    ownerUserId: agent.ownerUserId,
                    signals: verdict.signals,
                    outcome: 'WOULD_SUSPEND_AND_KILL',
                    transferTask: managerUserId
                        ? { status: 'WOULD_OPEN', managerUserId }
                        : { status: 'NO_MANAGER_KNOWN' },
                    notified,
                });
            }
        }

        const failed = decisions.filter((d) => d.outcome === 'FAILED').length;
        const contained = decisions.filter(
            (d) => d.outcome === 'SUSPENDED_AND_KILLED' || d.outcome === 'SUSPENDED_KILL_ALREADY_IN_FORCE',
        ).length;
        const taskFailures = decisions.filter((d) => d.transferTask.status === 'FAILED').length;
        const decisionsTruncated = decisions.length > MAX_REPORTED_ORPHANS;
        const status = orphanPassStatus({
            refusal: null,
            mode: policy.mode,
            failed: failed + taskFailures,
            decisionsTruncated,
            rosterRead: population.rosterRead,
        });

        const executionId = await writeExecutionRow(
            ctx,
            status,
            {
                mode: policy.mode,
                refusal: null,
                maxMode: ORPHAN_PASS_MAX_MODE,
                population: {
                    activeAgents: population.agents.length,
                    ownersChecked: population.membershipByOwner.size,
                },
                hrRoster: {
                    read: population.rosterRead,
                    employees: population.rosterSize,
                    refusal: population.rosterRead ? null : 'HR_ROSTER_TRUNCATED',
                },
                counts: {
                    orphans: decisions.length,
                    contained,
                    failed,
                    transferTaskFailures: taskFailures,
                    wouldContain: policy.mode === 'AUTOMATIC' ? 0 : decisions.length,
                },
                decisions: decisions.slice(0, MAX_REPORTED_ORPHANS) as unknown as Prisma.InputJsonValue,
                decisionsTruncated,
                notes: notes.slice(0, MAX_REPORTED_ORPHANS),
                notesTruncated: notes.length > MAX_REPORTED_ORPHANS,
            },
            input.jobRunId,
        );

        const result: OrphanPassResult = {
            tenantId: input.tenantId,
            mode: policy.mode,
            status,
            refusal: null,
            activeAgents: population.agents.length,
            orphans: decisions.length,
            contained,
            failed,
            executionId,
        };
        recordAgentOwnerOrphanPass({
            outcome:
                policy.mode === 'AUTOMATIC'
                    ? status === 'PASSED'
                        ? 'contained'
                        : 'partial'
                    : 'dry_run',
            mode: policy.mode,
            orphans: result.orphans,
        });
        logger.info('agent owner-orphan pass complete', {
            component: 'agent-owner-orphan-pass',
            tenantId: ctx.tenantId,
            mode: result.mode,
            status: result.status,
            activeAgents: result.activeAgents,
            orphans: result.orphans,
            contained: result.contained,
            failed: result.failed,
        });
        return result;
    } catch (err) {
        logger.error('agent owner-orphan pass threw', {
            component: 'agent-owner-orphan-pass',
            tenantId: ctx.tenantId,
            errorMessage: err instanceof Error ? err.message : 'non-Error thrown',
        });
        let executionId: string | null = null;
        try {
            executionId = await writeErrorExecutionRow(
                ctx,
                { mode, refusal: null, detail: `The pass could not run to completion: ${errorText(err)}` },
                input.jobRunId,
            );
        } catch (writeErr) {
            logger.error('agent owner-orphan pass threw and its record could not be written', {
                component: 'agent-owner-orphan-pass',
                tenantId: ctx.tenantId,
                errorMessage: writeErr instanceof Error ? writeErr.message : 'non-Error thrown',
            });
        }
        recordAgentOwnerOrphanPass({ outcome: 'error', mode: mode === 'unknown' ? 'unknown' : mode, orphans: 0 });
        return { ...empty, mode, status: 'ERROR', refusal: null, executionId };
    }
}

/** Bound on how many passes one read returns. A daily pass over a short window. */
const MAX_LISTED_PASSES = 60;

/**
 * The passes this tenant has run, newest first — the read half of the record.
 * `resultJson` verbatim: the per-orphan decision list IS the artefact.
 */
export async function listOrphanPasses(ctx: RequestContext, options: { limit?: number } = {}) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, automationKey: ORPHAN_PASS_AUTOMATION_KEY },
            select: { id: true, status: true, executedAt: true, completedAt: true, resultJson: true },
            orderBy: { executedAt: 'desc' },
            take: Math.min(Math.max(options.limit ?? MAX_LISTED_PASSES, 1), MAX_LISTED_PASSES),
        }),
    );
}
