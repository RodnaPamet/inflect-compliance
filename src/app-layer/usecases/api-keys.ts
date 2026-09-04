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
                createdBy: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
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
        if (agentId !== null) {
            const agent = await db.registeredAgent.findFirst({
                where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true, status: true },
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
            },
            select: {
                id: true,
                name: true,
                keyPrefix: true,
                scopes: true,
                expiresAt: true,
                createdAt: true,
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
                after: { name, scopes: input.scopes, expiresAt: expiresAt?.toISOString() ?? null },
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
