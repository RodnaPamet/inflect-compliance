/**
 * API Key Management Usecases
 *
 * Admin-only operations for creating, listing, and revoking API keys.
 * All mutations require ADMIN via assertCanManageMembers.
 *
 * @module usecases/api-keys
 */
import { RequestContext } from '../types';
import { assertCanManageMembers, assertCanViewAdminSettings } from '../policies/admin.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { generateApiKey, validateScopes } from '@/lib/auth/api-key-auth';
import {
    AUTONOMY_MAX,
    AUTONOMY_MIN,
    RISK_TIER_CEILING_UNWIRED,
    resolveAutonomyCeiling,
} from '@/lib/agentic/autonomy-ceiling';

// ─── List API Keys ───

export async function listApiKeys(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, (db) =>
        db.tenantApiKey.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                expiresAt: true,
                revokedAt: true,
                lastUsedAt: true,
                lastUsedIp: true,
                createdById: true,
                createdAt: true,
                agentId: true,
                maxAutonomyLevel: true,
                createdBy: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

/**
 * The agent-bound credentials, with the two facts an operator running agents
 * actually needs: is this key still live, and how far up the autonomy ladder can
 * it drive its agent?
 *
 * A separate reader from `listApiKeys` rather than a filter over it, because the
 * questions differ. `/admin/api-keys` asks "what integrations exist"; this asks
 * "what can act autonomously right now, and what have we switched off". It
 * therefore RETURNS revoked and expired rows rather than hiding them: a
 * revocation you cannot see is one nobody can confirm took effect, and the whole
 * point of surfacing it here is that revoking a key is the operator's move
 * during an incident.
 */
export async function listAgentCredentials(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    const now = new Date();
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.tenantApiKey.findMany({
            where: { tenantId: ctx.tenantId, agentId: { not: null } },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                expiresAt: true,
                revokedAt: true,
                lastUsedAt: true,
                maxAutonomyLevel: true,
                agentId: true,
                agent: { select: { id: true, name: true, status: true, autonomyLevel: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
        });

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            keyPrefix: row.keyPrefix,
            scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
            lastUsedAt: row.lastUsedAt,
            revokedAt: row.revokedAt,
            expiresAt: row.expiresAt,
            /**
             * One word an operator can scan a column for. `revoked` wins over
             * `expired` when both apply: revocation is the deliberate act and is
             * what somebody wants confirmation of.
             */
            state: row.revokedAt
                ? ('revoked' as const)
                : row.expiresAt !== null && row.expiresAt <= now
                  ? ('expired' as const)
                  : ('live' as const),
            agent: row.agent
                ? {
                      id: row.agent.id,
                      name: row.agent.name,
                      status: row.agent.status,
                      autonomyLevel: row.agent.autonomyLevel,
                  }
                : null,
            keyMaxAutonomy: row.maxAutonomyLevel,
            /**
             * The ceiling this credential actually exercises — the SAME `min`
             * the tool funnel computes, from the same two terms. Shown rather
             * than left for the reader to do in their head, because the whole
             * hazard the column exists for is somebody assuming the key's own
             * number is the answer.
             */
            effectiveAutonomy: resolveAutonomyCeiling({
                keyMax: row.maxAutonomyLevel,
                agentAutonomy: row.agent?.autonomyLevel ?? null,
                riskTierCeiling: RISK_TIER_CEILING_UNWIRED,
            }),
        }));
    });
}

// ─── Create API Key ───

export interface CreateApiKeyInput {
    name: string;
    scopes: string[];
    expiresAt?: string | null;
    /**
     * The registered agent this credential acts as.
     *
     * REQUIRED IN PRACTICE once the tenant enforces agent registration, and the
     * reason it is optional in the type is only that the flag is per-tenant.
     * `assertRegisteredAgent` refuses a key whose `agentId` is null, and an
     * absent `TenantSecuritySettings` row reads as ENFORCING — which together
     * mean that without this field a tenant created after the gate shipped
     * could mint no usable MCP credential at all. The binding lives on the KEY
     * rather than on the agent because rotation issues the new key before
     * revoking the old, so a single `apiKeyId` on the agent would make every
     * rotation a window in which the agent is, by the gate's own definition,
     * unregistered.
     */
    agentId?: string | null;
    /**
     * The highest rung on the 0-6 agent-autonomy ladder this credential may
     * drive its agent to. Requires `agentId`: a ceiling with no agent term to be
     * the lower of would read as the whole authority rather than a narrowing of
     * it, which is the state the column exists to end.
     */
    maxAutonomyLevel?: number | null;
}

export async function createApiKey(ctx: RequestContext, input: CreateApiKeyInput) {
    assertCanManageMembers(ctx);

    const name = input.name.trim();
    if (!name || name.length > 100) {
        throw badRequest('Key name is required and must be 100 characters or fewer.');
    }

    // Validate scopes
    const scopeErrors = validateScopes(input.scopes);
    if (scopeErrors.length > 0) {
        throw badRequest(`Invalid scopes: ${scopeErrors.join('; ')}`);
    }

    // Parse optional expiry
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
        expiresAt = new Date(input.expiresAt);
        if (isNaN(expiresAt.getTime())) {
            throw badRequest('Invalid expiry date.');
        }
        if (expiresAt <= new Date()) {
            throw badRequest('Expiry date must be in the future.');
        }
    }

    // Generate key
    const { plaintext, keyHash, keyPrefix } = generateApiKey();

    return runInTenantContext(ctx, async (db) => {
        // Resolve the agent binding INSIDE the tenant context, so RLS is what
        // proves the agent is this tenant's. A plain FK would not: Postgres runs
        // foreign-key checks as the table owner, which bypasses row security, so
        // an id belonging to another tenant would satisfy the constraint.
        const agentId = input.agentId ?? null;
        const maxAutonomyLevel = input.maxAutonomyLevel ?? null;

        if (maxAutonomyLevel !== null && agentId === null) {
            throw badRequest(
                'A maximum autonomy level requires an agent binding: without one there ' +
                    'is no agent level for it to be the lower of, so it would read as the ' +
                    'whole of the authority rather than a narrowing of it.',
            );
        }
        if (
            maxAutonomyLevel !== null &&
            (!Number.isInteger(maxAutonomyLevel) ||
                maxAutonomyLevel < AUTONOMY_MIN ||
                maxAutonomyLevel > AUTONOMY_MAX)
        ) {
            throw badRequest(
                `Maximum autonomy level must be a whole number between ${AUTONOMY_MIN} and ${AUTONOMY_MAX}.`,
            );
        }

        if (agentId !== null) {
            const agent = await db.registeredAgent.findFirst({
                where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, status: true, autonomyLevel: true },
            });
            if (!agent) {
                throw badRequest('Unknown agent.');
            }
            // A key minted against a SUSPENDED or RETIRED agent is refused by the
            // gate on every request, so minting one is a configuration error
            // worth failing loudly at creation rather than at first use.
            if (agent.status !== 'ACTIVE') {
                throw badRequest(
                    `Agent is ${agent.status.toLowerCase()}; only an ACTIVE agent can be bound to a key.`,
                );
            }
            // A key ceiling ABOVE the agent's own level is refused rather than
            // silently clamped. The runtime `min` would make it harmless, but a
            // stored 6 against an agent registered at 2 reads to the next
            // operator as "this key may do 6" — and the register is supposed to
            // be the place you can read an agent's authority off. Refusing keeps
            // the stored number and the effective number the same thing.
            if (maxAutonomyLevel !== null && maxAutonomyLevel > agent.autonomyLevel) {
                throw badRequest(
                    `Maximum autonomy level ${maxAutonomyLevel} exceeds the agent's own ` +
                        `registered level of ${agent.autonomyLevel}. A key may narrow an ` +
                        'agent\'s authority, never widen it.',
                );
            }
        }

        const apiKey = await db.tenantApiKey.create({
            data: {
                tenantId: ctx.tenantId,
                name,
                keyPrefix,
                keyHash,
                scopes: input.scopes,
                expiresAt,
                createdById: ctx.userId,
                agentId,
                maxAutonomyLevel,
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                expiresAt: true,
                createdAt: true,
                agentId: true,
                maxAutonomyLevel: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'API_KEY_CREATED',
            entityType: 'TenantApiKey',
            entityId: apiKey.id,
            details: `Created API key: ${name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantApiKey',
                operation: 'created',
                after: {
                    name,
                    scopes: input.scopes,
                    expiresAt: expiresAt?.toISOString() ?? null,
                    agentId,
                    maxAutonomyLevel,
                },
                summary: `Created API key: ${name}`,
            },
        });

        // Return the plaintext key ONLY at creation — never stored, never re-shown
        return {
            ...apiKey,
            plaintext,
        };
    });
}

// ─── Revoke API Key ───

export async function revokeApiKey(ctx: RequestContext, apiKeyId: string) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantApiKey.findFirst({
            where: { id: apiKeyId, tenantId: ctx.tenantId },
        });

        if (!existing) {
            throw notFound('API key not found.');
        }

        if (existing.revokedAt) {
            throw badRequest('API key is already revoked.');
        }

        const revoked = await db.tenantApiKey.update({
            where: { id: apiKeyId },
            data: { revokedAt: new Date() },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                revokedAt: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'API_KEY_REVOKED',
            entityType: 'TenantApiKey',
            entityId: revoked.id,
            details: `Revoked API key: ${existing.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantApiKey',
                operation: 'deleted',
                summary: `Revoked API key: ${existing.name}`,
            },
        });

        return revoked;
    });
}
