/**
 * A PERSON CONFIRMS AN AGENT'S ENTRA SERVICE PRINCIPAL (#3671, agentic IAM 2c).
 *
 * The disable of a contained agent's principal acts on the harness scanner's
 * reconciliation: a `DiscoveredAgent` whose `discoveredId` is
 * `entra:sp:<GUID>` and whose `registeredAgentId` is the agent. The ingest
 * checks only that the register row exists, so the link is the scanner's
 * claim. Owner decision, 2026-10-18: that is enough for DRY_RUN and
 * PROPOSE_ONLY, where a person reads what would be disabled, and NOT enough for
 * AUTOMATIC, where nobody does. So an unattended disable needs a person holding
 * `admin.agent_registry` to have confirmed the link — and this module is the
 * only writer of that confirmation.
 *
 * ═══ A CONFIRMATION CONFIRMS THE SCANNER'S LINK; IT DOES NOT MAKE ONE ═══
 *
 * The confirm refuses unless the harness CURRENTLY links that principal to that
 * agent, and links the agent to that principal alone. A person who could
 * confirm a link the scanner never made would be a second source of links,
 * and the disable reads one: the request path finds the principal through the
 * reconciliation, and a confirmation is consulted only for the link it found.
 *
 * ═══ ONE-WAY, AND INVALIDATED RATHER THAN RE-POINTED ═══
 *
 * A row records who confirmed which triple — discovered agent, its harness id,
 * registered agent — and when. A trigger refuses any rewrite of that, and the
 * one permitted move is `invalidatedAt` NULL -> a value with its reason. When
 * a scan moves the link — the principal reconciled to a different agent or to
 * none (`PRINCIPAL_RELINKED`), or the agent reconciled to a different
 * principal (`AGENT_RELINKED`) — the ingest calls
 * `invalidateRelinkedConfirmations` in its own transaction, and the
 * confirmation stops counting for good. A scan that later moves the link BACK
 * does not revive it: an unstable link is exactly the one a person should look
 * at again.
 *
 * Every reader also compares the triple against the link as it stands
 * (`liveConfirmationFor`), so a row nobody invalidated still cannot vouch for a
 * link it does not describe.
 *
 * @module usecases/agent-service-principal-confirmation
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import {
    ENTRA_SP_DISCOVERED_PREFIX,
    isDirectoryObjectId,
    servicePrincipalObjectIdOf,
} from '@/lib/agentic/service-principal-disable';

import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';

/** Why a confirmation stopped counting. Fixed codes; a CHECK holds the set. */
export type ConfirmationInvalidation = 'PRINCIPAL_RELINKED' | 'AGENT_RELINKED';

/** The triple a confirmation is about. */
export interface ServicePrincipalLinkTriple {
    readonly agentId: string;
    readonly discoveredAgentId: string;
    /** `entra:sp:<GUID>` exactly as the harness row holds it. */
    readonly discoveredId: string;
}

/**
 * The live confirmation for exactly this triple, or null.
 *
 * Exact on all three — the discovered agent, its harness id and the registered
 * agent — and only a row with no `invalidatedAt`. The caller passes the link AS
 * IT STANDS NOW, so a confirmation of an earlier link never matches.
 */
export async function liveConfirmationFor(
    ctx: RequestContext,
    link: ServicePrincipalLinkTriple,
): Promise<{ readonly id: string; readonly confirmedByUserId: string; readonly confirmedAt: Date } | null> {
    return runInTenantContext(ctx, (db) =>
        db.agentServicePrincipalConfirmation.findFirst({
            where: {
                tenantId: ctx.tenantId,
                discoveredAgentId: link.discoveredAgentId,
                registeredAgentId: link.agentId,
                discoveredId: link.discoveredId,
                invalidatedAt: null,
            },
            select: { id: true, confirmedByUserId: true, confirmedAt: true },
        }),
    );
}

/**
 * Is the link the harness holds for this PRINCIPAL confirmed by a person?
 *
 * The dispatch's send-time question for an `AUTOMATIC` disable, which holds an
 * object id and nothing else. Resolved the way the request path resolves it:
 * the one `DiscoveredAgent` naming the principal, its agent, that agent naming
 * that principal alone, and a live confirmation of exactly that triple.
 * Anything else — no row, two rows, no agent, an agent with two principals —
 * is "not confirmed", never a guess.
 */
export async function servicePrincipalLinkConfirmed(
    ctx: RequestContext,
    servicePrincipalId: unknown,
): Promise<boolean> {
    if (!isDirectoryObjectId(servicePrincipalId)) return false;
    const wanted = servicePrincipalId.trim().toLowerCase();
    return runInTenantContext(ctx, async (db) => {
        const rows = (
            await db.discoveredAgent.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    discoveredId: {
                        equals: `${ENTRA_SP_DISCOVERED_PREFIX}${wanted}`,
                        mode: 'insensitive',
                    },
                },
                select: { id: true, discoveredId: true, registeredAgentId: true },
                take: 2,
            })
        ).filter((r) => servicePrincipalObjectIdOf(r.discoveredId) === wanted);
        if (rows.length !== 1) return false;
        const row = rows[0];
        if (!row.registeredAgentId) return false;
        const principals = await db.discoveredAgent.count({
            where: {
                tenantId: ctx.tenantId,
                registeredAgentId: row.registeredAgentId,
                discoveredId: { startsWith: ENTRA_SP_DISCOVERED_PREFIX },
            },
        });
        if (principals !== 1) return false;
        const live = await db.agentServicePrincipalConfirmation.findFirst({
            where: {
                tenantId: ctx.tenantId,
                discoveredAgentId: row.id,
                registeredAgentId: row.registeredAgentId,
                discoveredId: row.discoveredId,
                invalidatedAt: null,
            },
            select: { id: true },
        });
        return live !== null;
    });
}

export const ConfirmServicePrincipalLinkSchema = z
    .object({ discoveredAgentId: z.string().min(1).max(64) })
    .strict();

export interface ServicePrincipalLinkConfirmationResult {
    readonly confirmationId: string;
    /** False when a live confirmation of the same link already existed. */
    readonly created: boolean;
    readonly agentId: string;
    readonly discoveredAgentId: string;
    readonly servicePrincipalId: string;
}

/**
 * Confirm that a discovered principal is the agent's own. Idempotent: a second
 * confirmation of a link that already has a live one returns it.
 *
 * The route's literal `requirePermission('admin.agent_registry')` is the
 * authority; the floor here is `assertAgentGovernanceWrite` on the same key, so
 * the AI_ADMIN role, which holds the key on READER's coarse tier, can confirm.
 */
export async function confirmServicePrincipalLink(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
): Promise<ServicePrincipalLinkConfirmationResult> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const parsed = ConfirmServicePrincipalLinkSchema.safeParse(input);
    if (!parsed.success) throw badRequest('Invalid confirmation', parsed.error.flatten());
    const { discoveredAgentId } = parsed.data;

    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent) throw notFound('Registered agent not found');

        const discovered = await db.discoveredAgent.findFirst({
            where: { id: discoveredAgentId, tenantId: ctx.tenantId },
            select: { id: true, discoveredId: true, registeredAgentId: true },
        });
        if (!discovered) throw notFound('Discovered agent not found');

        const servicePrincipalId = servicePrincipalObjectIdOf(discovered.discoveredId);
        if (!servicePrincipalId) {
            throw badRequest(
                'Only an Entra service principal (a discovered id of the form entra:sp:<GUID>) '
                    + 'can be confirmed as an agent\'s principal.',
            );
        }
        if (discovered.registeredAgentId !== agent.id) {
            throw badRequest(
                'The harness does not currently link that principal to this agent. A confirmation '
                    + 'confirms the scanner\'s link; it does not make one. Fix the link at the '
                    + 'scanner, and confirm after the next scan.',
            );
        }
        const principals = await db.discoveredAgent.count({
            where: {
                tenantId: ctx.tenantId,
                registeredAgentId: agent.id,
                discoveredId: { startsWith: ENTRA_SP_DISCOVERED_PREFIX },
            },
        });
        if (principals !== 1) {
            throw badRequest(
                `The harness links ${principals} Entra service principals to this agent. A disable `
                    + 'names one, so a link can be confirmed only while it is the only one.',
            );
        }

        const triple = {
            tenantId: ctx.tenantId,
            discoveredAgentId: discovered.id,
            registeredAgentId: agent.id,
            discoveredId: discovered.discoveredId,
        };
        const existing = await db.agentServicePrincipalConfirmation.findFirst({
            where: { ...triple, invalidatedAt: null },
            select: { id: true },
        });
        if (existing) {
            return {
                confirmationId: existing.id,
                created: false,
                agentId: agent.id,
                discoveredAgentId: discovered.id,
                servicePrincipalId,
            };
        }

        const row = await db.agentServicePrincipalConfirmation.create({
            data: { ...triple, confirmedByUserId: ctx.userId },
            select: { id: true },
        });
        await logEvent(db, ctx, {
            action: 'AGENT_SERVICE_PRINCIPAL_LINK_CONFIRMED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            details: 'Confirmed the agent\'s Entra service principal link',
            detailsJson: {
                // `access`: this is what lets an unattended disable reach a
                // customer's directory.
                category: 'access',
                operation: 'grant',
                summary: 'Service-principal link confirmed for an unattended disable',
            },
            metadata: { confirmationId: row.id, discoveredAgentId: discovered.id },
        });
        return {
            confirmationId: row.id,
            created: true,
            agentId: agent.id,
            discoveredAgentId: discovered.id,
            servicePrincipalId,
        };
    });
}

/**
 * The agent's principal links and their confirmation state, for the operator.
 *
 * The link list is the harness's; each carries whether a live confirmation of
 * exactly that link exists. Invalidated confirmations are listed too, newest
 * first and bounded, because "confirmed once, then the scan moved it" is the
 * case an operator needs to see to know why a disable is refused.
 */
export async function getServicePrincipalLinkState(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!agent) throw notFound('Registered agent not found');
        const links = await db.discoveredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                registeredAgentId: agent.id,
                discoveredId: { startsWith: ENTRA_SP_DISCOVERED_PREFIX },
            },
            select: { id: true, discoveredId: true, lastSeenAt: true },
            orderBy: { id: 'asc' },
            take: 10,
        });
        const confirmations = await db.agentServicePrincipalConfirmation.findMany({
            where: { tenantId: ctx.tenantId, registeredAgentId: agent.id },
            select: {
                id: true,
                discoveredAgentId: true,
                discoveredId: true,
                confirmedByUserId: true,
                confirmedAt: true,
                invalidatedAt: true,
                invalidatedReason: true,
            },
            orderBy: { confirmedAt: 'desc' },
            take: 20,
        });
        const live = (l: { id: string; discoveredId: string }) =>
            confirmations.find(
                (c) => c.invalidatedAt === null && c.discoveredAgentId === l.id && c.discoveredId === l.discoveredId,
            ) ?? null;
        return {
            agentId: agent.id,
            links: links.map((l) => ({
                discoveredAgentId: l.id,
                servicePrincipalId: servicePrincipalObjectIdOf(l.discoveredId),
                lastSeenAt: l.lastSeenAt,
                confirmation: live(l),
            })),
            // A disable names one principal; this says whether it could.
            confirmable: links.length === 1 && servicePrincipalObjectIdOf(links[0].discoveredId) !== null,
            confirmations,
        };
    });
}

/** One link the ingest moved, as it moved it. */
export interface ServicePrincipalRelink {
    readonly discoveredAgentId: string;
    readonly discoveredId: string;
    /** The agent the row named before this scan; null for a new row or a shadow. */
    readonly previousAgentId: string | null;
    /** The agent the row names after this scan; null for a shadow. */
    readonly nextAgentId: string | null;
}

/**
 * Invalidate the confirmations a scan's re-links make untrue. Called by the
 * harness ingest, in its transaction, with the `entra:sp:` rows whose agent
 * changed in this scan (new rows included, with `previousAgentId: null`).
 *
 *   PRINCIPAL_RELINKED — every live confirmation of THAT principal for an agent
 *     other than the one it now names (none, if it is now a shadow).
 *   AGENT_RELINKED — every live confirmation of a DIFFERENT principal for the
 *     agent this principal now names: the agent has gained a principal, so a
 *     person's statement about which one is its own no longer stands alone.
 *
 * Writes nothing for an empty list. Returns how many it invalidated.
 */
export async function invalidateRelinkedConfirmations(
    db: PrismaTx,
    ctx: RequestContext,
    scan: { readonly id: string },
    relinks: readonly ServicePrincipalRelink[],
    now: Date,
): Promise<number> {
    const moved = relinks.filter(
        (r) => r.discoveredId.startsWith(ENTRA_SP_DISCOVERED_PREFIX) && r.previousAgentId !== r.nextAgentId,
    );
    if (moved.length === 0) return 0;

    const principal = await db.agentServicePrincipalConfirmation.updateMany({
        where: {
            tenantId: ctx.tenantId,
            invalidatedAt: null,
            OR: moved.map((r) => ({
                discoveredAgentId: r.discoveredAgentId,
                ...(r.nextAgentId === null ? {} : { registeredAgentId: { not: r.nextAgentId } }),
            })),
        },
        data: { invalidatedAt: now, invalidatedReason: 'PRINCIPAL_RELINKED' },
    });

    const gained = moved.filter((r): r is ServicePrincipalRelink & { nextAgentId: string } => r.nextAgentId !== null);
    const agent = gained.length === 0
        ? { count: 0 }
        : await db.agentServicePrincipalConfirmation.updateMany({
            where: {
                tenantId: ctx.tenantId,
                invalidatedAt: null,
                OR: gained.map((r) => ({
                    registeredAgentId: r.nextAgentId,
                    discoveredAgentId: { not: r.discoveredAgentId },
                })),
            },
            data: { invalidatedAt: now, invalidatedReason: 'AGENT_RELINKED' },
        });

    const total = principal.count + agent.count;
    if (total > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_SERVICE_PRINCIPAL_LINK_INVALIDATED',
            entityType: 'AgentHarnessScan',
            entityId: scan.id,
            details:
                'A harness scan moved confirmed service-principal links; each needs a new confirmation',
            detailsJson: {
                category: 'access',
                operation: 'revoke',
                summary: 'Confirmed service-principal links invalidated by a re-link',
            },
            metadata: { principalRelinked: principal.count, agentRelinked: agent.count },
        });
        logger.info('service-principal link confirmations invalidated', {
            component: 'agent-service-principal-confirmation',
            tenantId: ctx.tenantId,
            principalRelinked: principal.count,
            agentRelinked: agent.count,
        });
    }
    return total;
}
