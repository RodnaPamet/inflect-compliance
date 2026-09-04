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
import { notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import {
    CreateRegisteredAgentSchema,
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
 * Retire an agent. RETIRED is the end of its life; SUSPENDED (the reversible
 * kill switch) is a separate move and goes through `suspendRegisteredAgent`.
 * Neither deletes the row — the register has to keep saying that the agent
 * existed and what authority it held.
 */
export async function retireRegisteredAgent(ctx: RequestContext, id: string) {
    return setRegisteredAgentStatus(ctx, id, 'RETIRED', 'AGENT_RETIRED');
}

/** The kill switch. Reversible, unlike retirement. */
export async function suspendRegisteredAgent(ctx: RequestContext, id: string) {
    return setRegisteredAgentStatus(ctx, id, 'SUSPENDED', 'AGENT_SUSPENDED');
}

async function setRegisteredAgentStatus(
    ctx: RequestContext,
    id: string,
    status: 'RETIRED' | 'SUSPENDED',
    action: string,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
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
    });
}
