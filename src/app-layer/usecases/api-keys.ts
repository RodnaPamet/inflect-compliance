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
import { isAgentRetiredDbRefusal } from '@/lib/agentic/agent-retirement';
import {
    AUTONOMY_MAX,
    AUTONOMY_MIN,
    resolveAutonomyCeiling,
    riskTierCeilingFor,
} from '@/lib/agentic/autonomy-ceiling';
import { agentCredentialStanding, agentTermsApply } from '@/lib/agentic/agent-credential-standing';
import { isAgentRegistrationEnforced } from '@/lib/agentic/agent-registration-gate';
import { readPlatformKill } from '@/lib/agentic/kill-switch';
import { MCP_ENDPOINT_SCOPES } from '@/lib/mcp/endpoint-scope';

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
                // The BINDING, named rather than referenced (#2446). The screen
                // has to say "acts as Deploy Bot", not print a cuid — and an
                // operator deciding whether to revoke during an incident is
                // choosing between agents, not between ids. `agentId` alone
                // forced the MCP hub to be open alongside this page to resolve
                // it, which is the two-screen problem this closes.
                agent: { select: { id: true, name: true, status: true, autonomyLevel: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

/** How many agent credentials `/admin/mcp` lists before it says it stopped. */
export const AGENT_CREDENTIALS_CAP = 200;

/**
 * The agent credentials, with the facts an operator running agents needs: can
 * this key act right now, and how far up the autonomy ladder can it drive?
 *
 * A separate reader from `listApiKeys` rather than a filter over it, because the
 * questions differ. `/admin/api-keys` asks "what integrations exist"; this asks
 * "what can act autonomously right now, and what have we switched off". It
 * therefore RETURNS revoked and expired rows rather than hiding them: a
 * revocation you cannot see is one nobody can confirm took effect, and the whole
 * point of surfacing it here is that revoking a key is the operator's move
 * during an incident.
 *
 * THE POPULATION is credential hygiene's (`isAgentCredential`): a key bound to
 * an agent, OR one the `/api/mcp` gate admits (`MCP_ENDPOINT_SCOPES`). In a
 * workspace that does not require registered agents, an unbound key with an
 * agent-tool scope reaches the agent tools, and leaving it off this page made
 * "what can act" narrower than what can (#4879).
 *
 * THE ANSWER is `agentCredentialStanding`: the key's state, the registration
 * gate, the kill switch, suspension and the risk assessment, in the order the
 * tool boundary applies them. A key bound to a suspended or killed agent used
 * to read "Live".
 *
 * It reads one past the cap, so a truncated list says it is truncated rather
 * than passing for the whole population.
 */
export async function listAgentCredentials(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    const now = new Date();
    const [enforcing, platformKill] = await Promise.all([
        isAgentRegistrationEnforced(ctx.tenantId),
        readPlatformKill(),
    ]);
    return runInTenantContext(ctx, async (db) => {
        const found = await db.tenantApiKey.findMany({
            where: {
                tenantId: ctx.tenantId,
                OR: [
                    { agentId: { not: null } },
                    ...MCP_ENDPOINT_SCOPES.map((scope) => ({
                        scopes: { array_contains: [scope] },
                    })),
                ],
            },
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
                agent: {
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        deletedAt: true,
                        autonomyLevel: true,
                        // The tier is a TERM in the ceiling below, so this
                        // column is not decoration: omitting it would make the
                        // reported number disagree with the one the tool
                        // boundary enforces, which is the exact confusion the
                        // `effectiveAutonomy` field exists to end.
                        riskTier: true,
                    },
                },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: AGENT_CREDENTIALS_CAP + 1,
        });
        const truncated = found.length > AGENT_CREDENTIALS_CAP;
        const rows = truncated ? found.slice(0, AGENT_CREDENTIALS_CAP) : found;

        // The kills in force, read once for the whole page: the workspace's
        // own (agentId NULL) and each listed agent's.
        const agentIds = [...new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))];
        const kills = await db.agentKillSwitch.findMany({
            where: {
                tenantId: ctx.tenantId,
                liftedAt: null,
                OR: [{ agentId: null }, { agentId: { in: agentIds } }],
            },
            select: { agentId: true },
            take: agentIds.length + 1,
        });
        const killFacts = {
            platform: platformKill !== null,
            tenant: kills.some((kill) => kill.agentId === null),
            agentIds: new Set(kills.flatMap((kill) => (kill.agentId ? [kill.agentId] : []))),
        };

        const credentials = rows.map((row) => {
            /**
             * One word an operator can scan a column for. `revoked` wins over
             * `expired` when both apply: revocation is the deliberate act and is
             * what somebody wants confirmation of.
             */
            const state = row.revokedAt
                ? ('revoked' as const)
                : row.expiresAt !== null && row.expiresAt <= now
                  ? ('expired' as const)
                  : ('live' as const);
            // A soft-deleted agent no longer resolves at the gate.
            const liveAgent = row.agent && row.agent.deletedAt === null ? row.agent : null;
            const resolved = liveAgent
                ? { status: liveAgent.status, riskTier: liveAgent.riskTier }
                : null;
            const governs = agentTermsApply(resolved);
            return {
                id: row.id,
                name: row.name,
                keyPrefix: row.keyPrefix,
                scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
                lastUsedAt: row.lastUsedAt,
                revokedAt: row.revokedAt,
                expiresAt: row.expiresAt,
                state,
                agent: row.agent
                    ? {
                          id: row.agent.id,
                          name: row.agent.name,
                          status: row.agent.status,
                          autonomyLevel: row.agent.autonomyLevel,
                          riskTier: row.agent.riskTier,
                      }
                    : null,
                keyMaxAutonomy: row.maxAutonomyLevel,
                standing: agentCredentialStanding({
                    live: state === 'live',
                    agentId: row.agentId,
                    agent: resolved,
                    enforcing,
                    kills: killFacts,
                }),
                /**
                 * The ceiling this credential actually exercises — the SAME
                 * `min` the tool funnel computes, from the same three terms,
                 * with the agent's terms applied only where its agent governs
                 * the key (`governedAgentIdOf`). Shown rather than left for the
                 * reader to do in their head, because the whole hazard the
                 * column exists for is somebody assuming the key's own number
                 * is the answer.
                 *
                 * `DENY_CEILING` here is not a rendering bug: it means the agent
                 * has never been risk-assessed, and the credential can therefore
                 * call nothing. `unscored` says so in a word so a UI does not
                 * have to recognise a magic -1.
                 */
                effectiveAutonomy: resolveAutonomyCeiling({
                    keyMax: row.maxAutonomyLevel,
                    agentAutonomy: governs ? (liveAgent?.autonomyLevel ?? null) : null,
                    riskTierCeiling: riskTierCeilingFor(
                        governs && liveAgent ? { riskTier: liveAgent.riskTier } : null,
                    ),
                }),
                unscored: row.agent !== null && row.agent.riskTier === null,
            };
        });
        return { credentials, truncated };
    });
}

/** Why an agent in `status` cannot be bound to a new key — one sentence, two callers. */
function agentNotBindableMessage(status: string): string {
    return `Agent is ${status.toLowerCase()}; only an ACTIVE agent can be bound to a key.`;
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
                throw badRequest(agentNotBindableMessage(agent.status));
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

        // The status read above is unlocked, so it cannot see a retirement
        // committing between it and this insert. The insert trigger
        // `tenant_api_key_agent_not_retired` can: it takes FOR SHARE on the agent
        // row, waits for a retirement in flight, and refuses once it reads
        // RETIRED — otherwise this key would land behind the retirement's
        // cascade, unrevoked (#3698). Its refusal is the same answer the read
        // above gives.
        let apiKey;
        try {
            apiKey = await db.tenantApiKey.create({
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
        } catch (err) {
            if (isAgentRetiredDbRefusal(err)) throw badRequest(agentNotBindableMessage('RETIRED'));
            throw err;
        }

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
