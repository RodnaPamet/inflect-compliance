/**
 * Agent register — usecase.
 *
 * This is the STAGE-1 write seam: enough of a usecase layer to make the model
 * real (sanitisation before encryption, an audited create, a tenant-bound
 * conditional update, the kill switch) and to give the two-tenant isolation
 * suite real callers to drive. The HTTP surface, the risk scorer and the
 * per-agent coverage query land on top of this — they extend it, they do not
 * replace it.
 *
 * Two invariants worth stating here, because both are enforced in more than one
 * place on purpose:
 *
 *  • `description` is sanitised at THIS seam, not at each renderer. The column
 *    is encrypted at rest (Epic B manifest), and encryption protects
 *    confidentiality — it does nothing for the PDF export, the register export
 *    or an SDK consumer that decrypts the row and renders it verbatim.
 *  • A `riskTier` of NULL means UNSCORED, and every consumer must read UNSCORED
 *    as "deny". An agent nobody has assessed is exactly the one that should not
 *    be running, so `createRegisteredAgent` deliberately leaves the tier NULL
 *    and the status DRAFT rather than seeding a plausible-looking low tier.
 */
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import { authorAiSystemEntry } from './ai-system';
import { assertOwnerInTenant } from './vendor-link-targets';
import {
    CreateRegisteredAgentSchema,
    RegisterAgentSchema,
    UpdateRegisteredAgentSchema,
} from '../schemas/agent-registry.schemas';
import type { RequestContext } from '../types';

/**
 * Three-state preserving sanitiser: `undefined` means "leave the column alone",
 * `null` means "clear it", a string means "replace it". Collapsing the first two
 * is how a partial update silently wipes a field it never mentioned.
 */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

/**
 * Resolve the accountable owner.
 *
 * `User` is a GLOBAL table, so the FK on `RegisteredAgent.ownerUserId` is
 * satisfied by ANY user id in the system — including one belonging to another
 * tenant. The row is then stamped with `ctx.tenantId` and reads as entirely
 * legitimate: the agent has an owner who is not a member, cannot see it, and
 * will never act on it, while the register reports it as owned. That matters
 * more here than on an ordinary record, because this column is what the
 * downstream two-person rule compares against.
 *
 * Reuses the shared `assertOwnerInTenant` rather than growing a fourth copy of
 * the same `TenantMembership` lookup — it already refuses a merely-present
 * membership, requiring ACTIVE.
 */
async function assertAgentOwner(db: PrismaTx, ctx: RequestContext, ownerUserId: string) {
    await assertOwnerInTenant(db, ctx, ownerUserId);
}

/**
 * Resolve the supplier of a THIRD_PARTY agent.
 *
 * `RegisteredAgent.vendorId` is a PLAIN FK to `Vendor.id`, not the composite
 * `(id, tenantId)` shape the AI-system link uses — and Postgres runs FK checks
 * as the table owner, so RLS does not stop a row from naming another tenant's
 * vendor. Without this, "which supplier is accountable for this agent" could
 * resolve to a company the tenant has never heard of, and the read that would
 * expose it is hidden by the same RLS that failed to prevent it.
 */
async function assertVendorInTenant(db: PrismaTx, ctx: RequestContext, vendorId: string) {
    const vendor = await db.vendor.findFirst({
        where: { id: vendorId, tenantId: ctx.tenantId },
        select: { id: true },
    });
    // Same shape whether the vendor is absent or foreign, so a caller learns
    // nothing about another tenant's id space.
    if (!vendor) throw badRequest('The selected vendor does not exist in this tenant');
}

export async function listRegisteredAgents(
    ctx: RequestContext,
    options: { take?: number; status?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => RegisteredAgentRepository.list(db, ctx, options));
}

export async function getRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const agent = await runInTenantContext(ctx, (db) =>
        RegisteredAgentRepository.getById(db, ctx, id),
    );
    if (!agent) throw notFound('Registered agent not found');
    return agent;
}

export async function createRegisteredAgent(ctx: RequestContext, input: unknown) {
    assertCanWrite(ctx);
    const parsed = CreateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const created = await RegisteredAgentRepository.create(db, ctx, {
            aiSystemId: parsed.aiSystemId,
            name: parsed.name,
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'AGENT_REGISTERED',
            entityType: 'RegisteredAgent',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'create',
                summary: `Registered agent "${parsed.name}" — autonomy ${parsed.autonomyLevel}, ${parsed.dataAccessScope}, ${parsed.reversibility}`,
                after: {
                    autonomyLevel: parsed.autonomyLevel,
                    dataAccessScope: parsed.dataAccessScope,
                    reversibility: parsed.reversibility,
                    provenance: parsed.provenance,
                    status: created.status,
                    // Recorded explicitly so the trail shows the agent arrived
                    // UNSCORED rather than leaving the reader to infer it.
                    riskTier: created.riskTier,
                },
            },
        });

        return created;
    });
}

export async function updateRegisteredAgent(ctx: RequestContext, id: string, input: unknown) {
    assertCanWrite(ctx);
    const parsed = UpdateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // Both checks apply to an UPDATE as much as a create — reassigning
        // ownership to a non-member is the same hole arrived at later.
        if (parsed.ownerUserId !== undefined) await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const count = await RegisteredAgentRepository.update(db, ctx, id, {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.description !== undefined
                ? { description: sanitizeOptional(parsed.description) ?? null }
                : {}),
            ...(parsed.autonomyLevel !== undefined ? { autonomyLevel: parsed.autonomyLevel } : {}),
            ...(parsed.dataAccessScope !== undefined
                ? { dataAccessScope: parsed.dataAccessScope }
                : {}),
            ...(parsed.reversibility !== undefined ? { reversibility: parsed.reversibility } : {}),
            ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
            ...(parsed.ownerUserId !== undefined ? { ownerUserId: parsed.ownerUserId } : {}),
            ...(parsed.vendorId !== undefined ? { vendorId: parsed.vendorId ?? null } : {}),
        });
        // Zero rows means the id was not this tenant's (or is soft-deleted).
        // Reported as notFound, never as a silent success.
        if (count === 0) throw notFound('Registered agent not found');

        await logEvent(db, ctx, {
            action: 'AGENT_UPDATED',
            entityType: 'RegisteredAgent',
            entityId: id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'update',
                summary: `Updated registered agent ${id}`,
                changedFields: Object.keys(parsed),
            },
        });

        return { id, updated: true };
    });
}

/**
 * Retire an agent — and REFUSE while it has proposals awaiting a human.
 *
 * ## The choice, and why refusing beats cascading
 *
 * A PENDING `AgentProposal` is not a record of something that happened; it is a
 * request that, when a human approves it, runs the REAL create-usecase. So an
 * agent with a pending queue still has reach into the tenant's data — its
 * authority outlives the click that retired it. Two ways to close that:
 *
 *   • CASCADE — reject every pending proposal as a side effect of retirement.
 *     Rejected. It is a bulk mutation of a HUMAN REVIEW QUEUE performed by a
 *     lifecycle action, and the reviewer who was mid-decision on one of those
 *     proposals is never told. "I retired an agent and my review queue emptied"
 *     is a worse surprise than any error message.
 *
 *   • REFUSE — say what is in the way and let the operator clear it. Chosen.
 *
 * The refusal is only tolerable because there is an immediate answer to the
 * emergency it might otherwise block: SUSPEND. `suspendRegisteredAgent` is the
 * kill switch, it takes effect at the MCP gate on the next request, it is
 * reversible, and it has no precondition at all. So the pairing is: SUSPEND
 * stops an agent NOW, RETIRE closes its file once its queue is settled. An
 * operator who has to make it stop is never blocked by this refusal — they are
 * one route away from the control that actually stops it, which is the one they
 * wanted.
 *
 * "Open" means `PENDING` only. ACCEPTED / REJECTED / EDITED are decided; they
 * are history, and history is exactly what the register must keep.
 */
export async function retireRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const openProposals = await db.agentProposal.count({
            where: { tenantId: ctx.tenantId, agentId: id, status: 'PENDING' },
        });
        if (openProposals > 0) {
            throw conflict(
                `This agent has ${openProposals} proposal(s) still awaiting review. ` +
                    'Approve or reject them first, or suspend the agent — suspension ' +
                    'stops it immediately and is reversible.',
            );
        }
        return applyRegisteredAgentStatus(db, ctx, id, 'RETIRED', 'AGENT_RETIRED');
    });
}

/**
 * The kill switch. Reversible, unlike retirement, and — deliberately — carrying
 * no precondition whatsoever: this is the control an operator reaches for when
 * an agent is doing something it should not be, and a check that could refuse it
 * would be a check that refuses the emergency stop.
 */
export async function suspendRegisteredAgent(ctx: RequestContext, id: string) {
    return setRegisteredAgentStatus(ctx, id, 'SUSPENDED', 'AGENT_SUSPENDED');
}

/**
 * Move an agent into service. This is the moment the MCP gate begins letting its
 * credentials through, so it is a deliberate human act and never a side effect
 * of registration — `createRegisteredAgent` and `registerAgent` both land DRAFT.
 */
export async function activateRegisteredAgent(ctx: RequestContext, id: string) {
    return setRegisteredAgentStatus(ctx, id, 'ACTIVE', 'AGENT_ACTIVATED');
}

/**
 * Register an agent AND the EU AI Act entry that covers it, in ONE transaction.
 *
 * The register entry is AUTHORED, not fabricated: `authorAiSystemEntry` runs the
 * deterministic classifier from `@/lib/eu-ai-act/classification` over the
 * operator's Art 5 / Annex III / Art 50 answers and links the obligations that
 * tier pulls in. The tier is never accepted from the client — `RegisterAgentSchema`
 * has no field for it.
 *
 * One transaction because the link is NOT NULL in both directions of meaning: an
 * AI-system row with no agent is a register entry for a thing that does not
 * exist, and an agent with no entry cannot be created at all. Splitting them
 * would make the first failure mode reachable.
 */
export async function registerAgent(ctx: RequestContext, input: unknown) {
    assertCanWrite(ctx);
    const parsed = RegisterAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // Validate the two caller-supplied ids BEFORE writing anything. Both
        // are cheap reads, and doing them first means a rejected registration
        // leaves no half-authored register entry behind even if the transaction
        // semantics were ever to change under us.
        await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const { created: aiSystem, classification, obligationsLinked } =
            await authorAiSystemEntry(db, ctx, {
                name: parsed.name,
                purpose: parsed.purpose ?? null,
                useContext: parsed.useContext ?? null,
                provider: parsed.provider ?? null,
                deploymentRole: parsed.deploymentRole,
                ownerUserId: parsed.ownerUserId,
                classification: parsed.classification,
            });

        const agent = await RegisteredAgentRepository.create(db, ctx, {
            aiSystemId: aiSystem.id,
            name: parsed.name,
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'AGENT_REGISTERED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'create',
                summary:
                    `Registered agent "${parsed.name}" — autonomy ${parsed.autonomyLevel}, ` +
                    `${parsed.dataAccessScope}, ${parsed.reversibility}; ` +
                    `AI Act ${classification.tier} (${classification.clauseId})`,
                after: {
                    autonomyLevel: parsed.autonomyLevel,
                    dataAccessScope: parsed.dataAccessScope,
                    reversibility: parsed.reversibility,
                    provenance: parsed.provenance,
                    status: agent.status,
                    // Recorded explicitly so the trail shows the agent arrived
                    // UNSCORED rather than leaving the reader to infer it. The
                    // AI-Act tier beside it is a DIFFERENT taxonomy —
                    // regulatory classification, not operational authority.
                    riskTier: agent.riskTier,
                    aiSystemId: aiSystem.id,
                    aiActRiskTier: classification.tier,
                    aiActClauseId: classification.clauseId,
                    obligationsLinked,
                },
            },
        });

        return {
            id: agent.id,
            status: agent.status,
            riskTier: agent.riskTier,
            aiSystemId: aiSystem.id,
            aiActRiskTier: classification.tier,
            aiActClauseId: classification.clauseId,
            aiActRationale: classification.rationale,
            obligationsLinked,
        };
    });
}

type AgentLifecycleStatus = 'ACTIVE' | 'RETIRED' | 'SUSPENDED';

async function setRegisteredAgentStatus(
    ctx: RequestContext,
    id: string,
    status: AgentLifecycleStatus,
    action: string,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, (db) => applyRegisteredAgentStatus(db, ctx, id, status, action));
}

/**
 * The status write itself, taking an open transaction so a caller that has
 * already read something in the same transaction (retirement, which counts the
 * open proposal queue first) does not have to open a second one and race itself.
 */
async function applyRegisteredAgentStatus(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    status: AgentLifecycleStatus,
    action: string,
) {
    const count = await RegisteredAgentRepository.setStatus(db, ctx, id, status);
    if (count === 0) throw notFound('Registered agent not found');

    await logEvent(db, ctx, {
        action,
        entityType: 'RegisteredAgent',
        entityId: id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'RegisteredAgent',
            operation: 'update',
            summary: `Registered agent ${id} moved to ${status}`,
            after: { status },
        },
    });

    return { id, status };
}
