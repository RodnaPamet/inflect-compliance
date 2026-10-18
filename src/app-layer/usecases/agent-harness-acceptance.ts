/**
 * Time-limited acceptance of a HARNESS_SHORTFALL (#3665; owner decisions of
 * 2026-10-17: the bar is report-only, and an acceptance is a sibling model with
 * ControlException's shape, swept by the same expiry monitor).
 *
 * A shortfall finding closes in one of two ways: a later scan shows the agent
 * at the bar, or the agent's OWNER records why the tenant carries the risk and
 * until when. This module is the second.
 *
 * ── WHO MAY ACCEPT ──────────────────────────────────────────────────────────
 *
 * The register row's `ownerUserId`, and only while they also hold
 * `admin.agent_registry`. The owner because the decision says so and because
 * accepting a risk is the act of the person accountable for it; the key
 * because the route sits with the register's other authority. A shadow agent
 * has no owner and so cannot be accepted: it has to be registered first, which
 * is the point of the SHADOW_AGENT finding beside it.
 *
 * ── EXPIRY ──────────────────────────────────────────────────────────────────
 *
 * `reopenExpiredHarnessAcceptances` runs inside the exception expiry monitor's
 * nightly pass. Each expired acceptance is claimed once (`expiryProcessedAt`),
 * and its shortfall reopens if the agent's latest scan is still below the bar —
 * unless a renewal is in force.
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { appendAuditEntry } from '@/lib/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    HARNESS_FINDING_SOURCE_KIND,
    isHarnessShortfall,
    shortfallFinding,
    shortfallRefOf,
    type StoredReach,
} from '@/lib/agentic/harness-findings';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';
import {
    JUSTIFICATION_MAX_CHARS,
    JUSTIFICATION_MIN_CHARS,
    MAX_ACCEPTANCE_DAYS,
    shortfallAcceptanceRefusal,
} from '@/lib/agentic/harness-acceptance-rules';

/** The bound lives with the rule the harness tab shares; re-exported for existing importers. */
export { MAX_ACCEPTANCE_DAYS };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const AcceptHarnessShortfallSchema = z
    .object({
        discoveredAgentId: z.string().min(1).max(64),
        justification: z.string().trim().min(JUSTIFICATION_MIN_CHARS).max(JUSTIFICATION_MAX_CHARS),
        expiresAt: z.string().datetime(),
    })
    .strict();

export async function acceptHarnessShortfall(ctx: RequestContext, input: z.infer<typeof AcceptHarnessShortfallSchema>) {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Accepting a harness shortfall requires admin.agent_registry');
    }
    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) throw badRequest('expiresAt must be in the future');
    if (expiresAt.getTime() > now.getTime() + MAX_ACCEPTANCE_DAYS * MS_PER_DAY) {
        throw badRequest(`An acceptance may run for at most ${MAX_ACCEPTANCE_DAYS} days; renew it to extend`);
    }

    return runInTenantContext(ctx, async (db) => {
        const agent = await db.discoveredAgent.findFirst({
            where: { id: input.discoveredAgentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                discoveredId: true,
                lastLevel: true,
                lastReach: true,
                registeredAgent: { select: { id: true, ownerUserId: true, deletedAt: true } },
            },
        });
        if (!agent) throw notFound('Discovered agent not found');
        // The SAME rule the harness tab decides its accept action with, so the
        // action is never shown and then refused, or hidden from the owner.
        switch (shortfallAcceptanceRefusal(agent, ctx.userId)) {
            case 'SHADOW':
                throw badRequest('A shadow agent has no owner to accept its risk; register it first');
            case 'NOT_OWNER':
                throw forbidden('Only the agent’s owner may accept its harness shortfall');
            case 'NO_SHORTFALL':
                throw badRequest('The agent’s latest scan is at the bar; there is no shortfall to accept');
            case null:
                break;
        }

        // A renewal supersedes whatever is in force, so exactly one acceptance
        // speaks for the agent at a time.
        const inForce = await db.agentHarnessAcceptance.findFirst({
            where: { tenantId: ctx.tenantId, discoveredAgentId: agent.id, revokedAt: null, expiresAt: { gt: now } },
            orderBy: { expiresAt: 'desc' },
            select: { id: true },
        });
        if (inForce) {
            await db.agentHarnessAcceptance.update({
                where: { id: inForce.id },
                data: { revokedAt: now, revokedByUserId: ctx.userId },
            });
        }

        const acceptance = await db.agentHarnessAcceptance.create({
            data: {
                tenantId: ctx.tenantId,
                discoveredAgentId: agent.id,
                acceptedLevel: agent.lastLevel,
                justification: sanitizePlainText(input.justification),
                acceptedByUserId: ctx.userId,
                expiresAt,
                renewedFromId: inForce?.id ?? null,
            },
            select: { id: true, expiresAt: true, acceptedLevel: true },
        });

        const finding = await db.finding.findFirst({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: HARNESS_FINDING_SOURCE_KIND,
                sourceRef: shortfallRefOf(agent.discoveredId),
                deletedAt: null,
            },
            select: { id: true, status: true },
        });
        if (finding && finding.status !== 'CLOSED') {
            await db.finding.update({
                where: { id: finding.id },
                data: {
                    status: 'CLOSED',
                    verifiedAt: now,
                    verificationNotes: sanitizePlainText(
                        `Risk accepted by the agent's owner until ${expiresAt.toISOString()} (acceptance ${acceptance.id})`,
                    ),
                },
            });
        }

        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_SHORTFALL_ACCEPTED',
            entityType: 'AgentHarnessAcceptance',
            entityId: acceptance.id,
            details: `Accepted the harness shortfall of ${agent.discoveredId} until ${acceptance.expiresAt.toISOString()}`,
            detailsJson: {
                category: 'custom',
                entityName: 'AgentHarnessAcceptance',
                operation: 'created',
                after: {
                    discoveredAgentId: agent.id,
                    acceptedLevel: acceptance.acceptedLevel,
                    expiresAt: acceptance.expiresAt.toISOString(),
                    renewedFromId: inForce?.id ?? null,
                    findingId: finding?.id ?? null,
                },
            },
        });
        return acceptance;
    });
}

export async function listHarnessAcceptances(ctx: RequestContext, discoveredAgentId?: string) {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading harness acceptances requires admin.agent_registry');
    }
    return runInTenantContext(ctx, (db) =>
        db.agentHarnessAcceptance.findMany({
            where: { tenantId: ctx.tenantId, ...(discoveredAgentId ? { discoveredAgentId } : {}) },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
                id: true,
                discoveredAgentId: true,
                acceptedLevel: true,
                justification: true,
                acceptedByUserId: true,
                expiresAt: true,
                renewedFromId: true,
                revokedAt: true,
                expiryProcessedAt: true,
                createdAt: true,
            },
        }),
    );
}

/**
 * The expiry half, run by the exception expiry monitor with its global client.
 * Returns how many shortfalls it reopened.
 */
export async function reopenExpiredHarnessAcceptances(
    db: PrismaClient,
    now: Date,
    tenantId?: string,
): Promise<number> {
    const expired = await db.agentHarnessAcceptance.findMany({
        where: {
            expiresAt: { lte: now },
            revokedAt: null,
            expiryProcessedAt: null,
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            discoveredAgentId: true,
            discoveredAgent: { select: { discoveredId: true, lastLevel: true, lastReach: true } },
        },
        take: 1_000,
    });
    if (expired.length === 0) return 0;

    // Both lookups are read once for the whole batch. Neither changes under the
    // loop except through the loop itself, which keeps the finding map current.
    // Keys carry the tenant: a `discoveredId` is the scanner's name for an
    // agent and is unique per tenant, not globally.
    const keyOf = (tenant: string, value: string) => `${tenant}\u0000${value}`;
    const renewals = await db.agentHarnessAcceptance.findMany({
        where: {
            discoveredAgentId: { in: [...new Set(expired.map((a) => a.discoveredAgentId))] },
            revokedAt: null,
            expiresAt: { gt: now },
        },
        select: { id: true, tenantId: true, discoveredAgentId: true },
        take: 1_000,
    });
    const renewalBy = new Map(renewals.map((r) => [keyOf(r.tenantId, r.discoveredAgentId), r]));
    const findings = await db.finding.findMany({
        where: {
            tenantId: { in: [...new Set(expired.map((a) => a.tenantId))] },
            sourceKind: HARNESS_FINDING_SOURCE_KIND,
            sourceRef: { in: [...new Set(expired.map((a) => shortfallRefOf(a.discoveredAgent.discoveredId)))] },
            deletedAt: null,
        },
        select: { id: true, tenantId: true, sourceRef: true, status: true },
        take: 1_000,
    });
    const findingBy = new Map(findings.map((f) => [keyOf(f.tenantId, f.sourceRef ?? ''), f]));

    let reopened = 0;
    for (const a of expired) {
        // Claim it once, so a second monitor run reopens nothing twice.
        const claim = await db.agentHarnessAcceptance.updateMany({
            where: { id: a.id, tenantId: a.tenantId, expiryProcessedAt: null },
            data: { expiryProcessedAt: now },
        });
        if (claim.count === 0) continue;

        const level = a.discoveredAgent.lastLevel as HarnessLevel;
        const reach = a.discoveredAgent.lastReach as StoredReach;
        const outcome = {
            renewedBy: renewalBy.get(keyOf(a.tenantId, a.discoveredAgentId))?.id ?? null,
            stillBelowBar: isHarnessShortfall(level, reach),
            findingId: null as string | null,
        };

        if (outcome.renewedBy === null && outcome.stillBelowBar) {
            const ref = shortfallRefOf(a.discoveredAgent.discoveredId);
            const finding = findingBy.get(keyOf(a.tenantId, ref));
            const notes = sanitizePlainText(`Reopened: acceptance ${a.id} expired at ${now.toISOString()}`);
            if (finding) {
                if (finding.status === 'CLOSED') {
                    await db.finding.update({ where: { id: finding.id }, data: { status: 'OPEN', verificationNotes: notes } });
                    finding.status = 'OPEN';
                    reopened += 1;
                }
                outcome.findingId = finding.id;
            } else {
                const planned = shortfallFinding(a.discoveredAgent.discoveredId, level, reach, 'The latest harness scan');
                const created = await db.finding.create({
                    data: {
                        tenantId: a.tenantId,
                        severity: planned.severity,
                        type: planned.type,
                        title: sanitizePlainText(planned.title),
                        description: sanitizePlainText(planned.description),
                        status: 'OPEN',
                        sourceKind: HARNESS_FINDING_SOURCE_KIND,
                        sourceRef: planned.sourceRef,
                        verificationNotes: notes,
                    },
                    select: { id: true, tenantId: true, sourceRef: true, status: true },
                });
                findingBy.set(keyOf(a.tenantId, ref), created);
                outcome.findingId = created.id;
                reopened += 1;
            }
        }

        await appendAuditEntry({
            tenantId: a.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'AgentHarnessAcceptance',
            entityId: a.id,
            action: 'AGENT_HARNESS_ACCEPTANCE_EXPIRED',
            detailsJson: {
                category: 'status_change',
                entityName: 'AgentHarnessAcceptance',
                summary: `Harness shortfall acceptance ${a.id} expired`,
                after: {
                    discoveredAgentId: a.discoveredAgentId,
                    renewedBy: outcome.renewedBy,
                    stillBelowBar: outcome.stillBelowBar,
                    findingId: outcome.findingId,
                    transitionedBy: 'exception-expiry-monitor',
                },
            },
        });
    }
    return reopened;
}
