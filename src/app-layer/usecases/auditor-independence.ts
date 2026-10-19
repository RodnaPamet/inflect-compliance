/**
 * AUDITOR INDEPENDENCE — the refusal and the finding (#3675, step 3b).
 *
 * The rule itself is pure, in `src/lib/agentic/auditor-independence.ts`: an
 * auditor agent's owner holds an ACTIVE, SECOND-line membership and owns no
 * audited agent. This module reads the facts and acts on the verdict, in the
 * caller's transaction, in two ways:
 *
 *   • `assertAuditorIndependentInTx` REFUSES — when an agent becomes an auditor
 *     (registered as one, or amended into one) and when an auditor goes ACTIVE.
 *     `details.reason` is `AUDITOR_NOT_INDEPENDENT`, with every failing term in
 *     `details.independenceReasons`. The trigger
 *     `registered_agent_auditor_independence` refuses the same rows for any
 *     writer that skips this.
 *   • `reconcileAuditorIndependenceInTx` RAISES A FINDING — after a later change
 *     that can break the rule for an auditor already in service: an ownership
 *     transfer completes, an agent is registered, an auditor is unmarked, an
 *     owner's line of defence changes. It never suspends the auditor, never
 *     edits its grants, and never closes a finding. One finding per auditor
 *     (`sourceKind = AUDITOR_INDEPENDENCE`, `sourceRef = <agentId>`), reopened
 *     rather than duplicated.
 *
 * ## The lock
 *
 * Every path that can make or break independence takes
 * `lockAuditorIndependence` — a per-tenant transaction advisory lock — as its
 * first act in the transaction, and the trigger takes the same key. Without it
 * an activation of an auditor and a registration of an audited agent to the
 * same owner each pass on a snapshot that cannot see the other, and both
 * commit. With it the second waits, and under READ COMMITTED its next
 * statement sees the first. The key is namespaced (`auditor-independence:`),
 * as `assertConcurrencyUnderLock` explains, so it never shares a queue with the
 * audit chain's per-tenant lock. Taken first so no path waits on it while
 * holding a row lock another holder of it needs.
 *
 * ## Which auditors a reconcile looks at
 *
 * ACTIVE auditors, owned by the people whose standing just changed. A DRAFT or
 * SUSPENDED auditor writes nothing, and every way back into service passes
 * `assertActivatable`, which asks the whole rule again.
 */
import type { PrismaTx } from '@/lib/db-context';
import { ConflictError } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    AUDITOR_INDEPENDENCE_FINDING_SEVERITY,
    AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND,
    AUDITOR_INDEPENDENCE_FINDING_TYPE,
    AUDITOR_NOT_INDEPENDENT,
    evaluateAuditorIndependence,
    independenceFindingText,
    independenceReasonText,
    type AuditorIndependenceVerdict,
    type AuditorOwnerFacts,
    type IndependenceBreakTrigger,
    type LineOfDefenceValue,
} from '@/lib/agentic/auditor-independence';
import { logEvent } from '../events/audit';
import { FindingRepository } from '../repositories/FindingRepository';
import type { RequestContext } from '../types';

/** Bound on the auditors one reconcile reads: a tenant has a handful. */
const AUDITOR_SCAN_CAP = 200;
/** Bound on the audited agents read per owner set. */
const AUDITED_AGENT_SCAN_CAP = 2000;

/** The lock key, shared with the trigger's `'auditor-independence:' || tenantId`. */
export function auditorIndependenceLockKey(tenantId: string): string {
    return `auditor-independence:${tenantId}`;
}

/** Take the tenant's independence lock. Re-entrant within a transaction. */
export async function lockAuditorIndependence(db: PrismaTx, ctx: RequestContext): Promise<void> {
    // `$executeRawUnsafe` with a bound parameter, the idiom
    // `assertConcurrencyUnderLock` documents: `pg_advisory_xact_lock` returns
    // void, which `$queryRaw` cannot deserialize.
    await db.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        auditorIndependenceLockKey(ctx.tenantId),
    );
}

/**
 * The facts the rule reads, for several owners at once: each owner's
 * membership and line, and the audited agents each owns. Two queries, whatever
 * the number of owners. `excludeAgentIds` are left out of the audited set — an
 * auditor is never its own auditee.
 */
async function readOwnerFacts(
    db: PrismaTx,
    ctx: RequestContext,
    ownerUserIds: readonly string[],
    excludeAgentIds: readonly string[] = [],
): Promise<Map<string, AuditorOwnerFacts>> {
    const owners = [...new Set(ownerUserIds)];
    const [memberships, audited] = await Promise.all([
        db.tenantMembership.findMany({
            where: { tenantId: ctx.tenantId, userId: { in: owners } },
            select: { userId: true, status: true, lineOfDefence: true },
            take: owners.length,
        }),
        db.registeredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                ownerUserId: { in: owners },
                isAuditor: false,
                status: { not: 'RETIRED' },
                deletedAt: null,
                ...(excludeAgentIds.length > 0 ? { id: { notIn: [...excludeAgentIds] } } : {}),
            },
            select: { id: true, ownerUserId: true },
            take: AUDITED_AGENT_SCAN_CAP,
        }),
    ]);
    const byOwner = new Map<string, AuditorOwnerFacts>();
    for (const owner of owners) {
        const m = memberships.find((row) => row.userId === owner);
        byOwner.set(owner, {
            membershipStatus: m?.status ?? null,
            lineOfDefence: (m?.lineOfDefence ?? null) as LineOfDefenceValue | null,
            auditedAgentIds: audited.filter((a) => a.ownerUserId === owner).map((a) => a.id),
        });
    }
    return byOwner;
}

/** Judge one owner, as the auditor `agentId` (or a not-yet-inserted auditor, `null`) sees them. */
export async function evaluateOwnerIndependenceInTx(
    db: PrismaTx,
    ctx: RequestContext,
    input: { ownerUserId: string; agentId: string | null },
): Promise<AuditorIndependenceVerdict> {
    const facts = await readOwnerFacts(db, ctx, [input.ownerUserId], input.agentId ? [input.agentId] : []);
    return evaluateAuditorIndependence(facts.get(input.ownerUserId)!);
}

/**
 * REFUSE an agent standing as an auditor unless its owner is independent.
 *
 * Takes the lock first. `agentId` is the auditor's own id when it already
 * exists (amend, activation) and `null` before the insert (registration).
 */
export async function assertAuditorIndependentInTx(
    db: PrismaTx,
    ctx: RequestContext,
    input: { ownerUserId: string; agentId: string | null },
): Promise<void> {
    await lockAuditorIndependence(db, ctx);
    const verdict = await evaluateOwnerIndependenceInTx(db, ctx, input);
    if (verdict.independent) return;
    throw new ConflictError(
        'This agent cannot be an auditor agent, because the auditor must not be the auditee: ' +
            verdict.reasons.map(independenceReasonText).join('; ') +
            '. An auditor agent is owned by a member whose line of defence an OWNER has declared ' +
            'SECOND, and who owns none of the agents it audits.',
        {
            reason: AUDITOR_NOT_INDEPENDENT,
            independenceReasons: [...verdict.reasons],
            auditedAgentCount: verdict.auditedAgentIds.length,
        },
    );
}

export interface IndependenceReconcileResult {
    /** Findings opened by this reconcile. */
    readonly opened: readonly string[];
    /** Closed findings reopened by this reconcile. */
    readonly reopened: readonly string[];
}

/**
 * RAISE A FINDING for every ACTIVE auditor owned by `ownerUserIds` whose
 * independence no longer holds. Run inside the transaction of the change that
 * may have broken it, after that change's write, under the lock the caller
 * took first.
 *
 * Writes only `Finding` rows (through `FindingRepository`) and their audit rows.
 * An OPEN, IN_PROGRESS or READY_FOR_VERIFICATION finding for the auditor is
 * left as it stands; a CLOSED one is reopened, because the break is back. A
 * break that is FIXED closes nothing: closing a finding is a person's act.
 */
export async function reconcileAuditorIndependenceInTx(
    db: PrismaTx,
    ctx: RequestContext,
    input: { trigger: IndependenceBreakTrigger; ownerUserIds: readonly string[] },
): Promise<IndependenceReconcileResult> {
    const owners = [...new Set(input.ownerUserIds)];
    if (owners.length === 0) return { opened: [], reopened: [] };

    const auditors = await db.registeredAgent.findMany({
        where: {
            tenantId: ctx.tenantId,
            ownerUserId: { in: owners },
            isAuditor: true,
            status: 'ACTIVE',
            deletedAt: null,
        },
        select: { id: true, name: true, ownerUserId: true },
        orderBy: { id: 'asc' },
        take: AUDITOR_SCAN_CAP,
    });
    if (auditors.length === 0) return { opened: [], reopened: [] };

    const facts = await readOwnerFacts(
        db,
        ctx,
        auditors.map((a) => a.ownerUserId),
        auditors.map((a) => a.id),
    );
    const breaks = auditors.flatMap((a) => {
        const verdict = evaluateAuditorIndependence(facts.get(a.ownerUserId)!);
        return verdict.independent ? [] : [{ agent: a, verdict }];
    });
    if (breaks.length === 0) return { opened: [], reopened: [] };

    const existing = await db.finding.findMany({
        where: {
            tenantId: ctx.tenantId,
            sourceKind: AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND,
            sourceRef: { in: breaks.map((b) => b.agent.id) },
            deletedAt: null,
        },
        select: { id: true, sourceRef: true, status: true },
        take: breaks.length,
    });
    const byRef = new Map(existing.map((f) => [f.sourceRef as string, f]));

    const opened: string[] = [];
    const reopened: string[] = [];
    for (const { agent, verdict } of breaks) {
        const prior = byRef.get(agent.id);
        const text = independenceFindingText({
            agentId: agent.id,
            agentName: agent.name,
            reasons: verdict.reasons,
            auditedAgentIds: verdict.auditedAgentIds,
            trigger: input.trigger,
        });
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: AUDITOR_INDEPENDENCE_FINDING_SEVERITY,
                type: AUDITOR_INDEPENDENCE_FINDING_TYPE,
                title: sanitizePlainText(text.title),
                description: sanitizePlainText(text.description),
                status: 'OPEN',
                sourceKind: AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND,
                sourceRef: agent.id,
            });
            opened.push(created.id);
            await logEvent(db, ctx, {
                action: 'AUDITOR_INDEPENDENCE_FINDING_RAISED',
                entityType: 'Finding',
                entityId: created.id,
                details: `Auditor agent ${agent.id} is not independent (${verdict.reasons.join(', ')})`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'created',
                    after: {
                        sourceRef: agent.id,
                        severity: AUDITOR_INDEPENDENCE_FINDING_SEVERITY,
                        independenceReasons: [...verdict.reasons],
                        auditedAgentCount: verdict.auditedAgentIds.length,
                        trigger: input.trigger,
                    },
                },
            });
        } else if (prior.status === 'CLOSED') {
            await db.finding.updateMany({
                where: { id: prior.id, tenantId: ctx.tenantId },
                data: {
                    status: 'OPEN',
                    verificationNotes: sanitizePlainText(
                        `Reopened: the auditor's independence broke again after ${input.trigger}`,
                    ),
                },
            });
            reopened.push(prior.id);
            await logEvent(db, ctx, {
                action: 'AUDITOR_INDEPENDENCE_FINDING_REOPENED',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Auditor agent ${agent.id} is not independent again (${verdict.reasons.join(', ')})`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    fromStatus: 'CLOSED',
                    toStatus: 'OPEN',
                    reason: input.trigger,
                },
            });
        }
    }
    return { opened, reopened };
}
