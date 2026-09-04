/**
 * API Key Authentication — Machine-to-Machine Auth
 *
 * Provides:
 *   - Key generation (cryptographically random, prefixed for identification)
 *   - Hash-only storage (SHA-256, plaintext shown once at creation)
 *   - Bearer token verification against stored hash
 *   - Expiry and revocation enforcement
 *   - Last-used tracking (async, non-blocking)
 *   - Scope-based authorization (maps to PermissionSet resource:action)
 *   - RequestContext construction for downstream authorization
 *
 * Key format: "iflk_" + 48 random hex chars (total 53 chars)
 * Storage: SHA-256(full key) — deterministic, fast, collision-resistant
 *
 * Scope format: "resource:action" (e.g. "controls:read", "evidence:write")
 * Special scopes:
 *   - "*" = full access (all resources, all actions)
 *   - "resource:*" = all actions on a resource
 *
 * SECURITY NOTES:
 *   - Plaintext key is returned ONLY at creation time, never stored.
 *   - SHA-256 is suitable for API key hashing (keys have high entropy,
 *     unlike passwords which need bcrypt/argon2).
 *   - Expired and revoked keys are rejected immediately.
 *   - lastUsedAt updates are fire-and-forget to avoid auth latency.
 *   - Scope enforcement is mandatory for API-key-authenticated requests.
 *
 * @module auth/api-key-auth
 */
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import { forbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import {
    PrincipalUnresolvedError,
    resolveAgentAuthority,
    auditPrincipalUnresolved,
} from '@/lib/agentic/agent-authority';
import type { TenantApiKey, Tenant } from '@prisma/client';

// ─── Constants ───

/** Prefix for all API keys — enables quick visual identification */
export const API_KEY_PREFIX = 'iflk_';

/** Length of random hex portion (48 hex = 24 bytes of entropy) */
const KEY_RANDOM_LENGTH = 48;

/** Number of prefix chars stored for key identification (e.g. "iflk_a1b2") */
const KEY_PREFIX_DISPLAY_LENGTH = 8;

// ─── Scope Definitions ───

/**
 * Mapping from scope action keywords to PermissionSet action names.
 *
 * Scopes use simplified verbs:
 *   - "read"  → maps to "view" (and "download", "export" where applicable)
 *   - "write" → maps to "create", "edit", "upload", "assign", etc.
 *   - "admin" → maps to "manage", "approve", "freeze", etc.
 *
 * This keeps the scope vocabulary small and M2M-friendly while mapping
 * to the full PermissionSet internally.
 *
 * ─── Domain coverage is a DECISION, not bookkeeping (#2225) ─────────
 *
 * Every domain in `PERMISSION_SCHEMA` must appear here. The grouping
 * of actions into read / write / admin is editorial and cannot be
 * derived, so it is not — but the COVERAGE is asserted, by
 * `tests/unit/api-key-management.test.ts`: adding a domain to
 * `PermissionSet` without deciding its scope shape fails that test.
 *
 * `assets` / `personnel` / `incidents` were absent until #2225, which
 * meant the only way to give an API key access to those domains was
 * `*` — a full-ADMIN grant. Adding them is purely additive: nothing
 * that was a valid scope stops being one, and `scopesToPermissions`
 * builds its skeleton from `getPermissionsForRole('READER')` rather
 * than from this map, so an existing key's resolved permissions are
 * byte-identical unless it names one of the new scopes.
 *
 * `personnel.manage` and `incidents.manage` sit under `admin`, not
 * `write`, because `PermissionSet` documents both as privileged
 * OWNER/ADMIN actions rather than ordinary editor writes (filing a
 * regulatory notification is not "editing an incident"). That mirrors
 * `policies.approve`. `audits` groups its `manage`/`freeze`/`share`
 * under `write` and is deliberately left alone — regrouping it would
 * silently change what an already-issued `audits:write` key resolves
 * to, which is a behaviour break, not a tidy-up.
 *
 * Some ACTIONS are deliberately unreachable by any NAMED scope:
 * `admin.tenant_lifecycle`, `admin.owner_management`,
 * `admin.agent_registry`, `admin.agent_tool_exposure`,
 * `admin.compliance_dsar_*` and `reports.schedule_external`. Deleting
 * the tenant, rotating the DEK, managing OWNERs, deciding which agents
 * may act and what they may reach, moving DSARs, and aiming a standing
 * report feed off-tenant are not things a bearer token should be able
 * to do.
 *
 * NOT EVEN `*`, for FOUR of those six. This paragraph used to end "a
 * `*` key still reaches them, and that is the one grant an operator
 * has to make consciously", which is false: `*` resolves below to
 * ADMIN, and ADMIN denies `tenant_lifecycle` and `owner_management`
 * explicitly (`permissions.ts` — OWNER is the only role that carries
 * them). The error was safe in direction — it overstated what a key
 * grants — but it described the security model wrongly, and automation
 * planned against it earns a 403.
 *
 * The two agent-governance flags are denied to `*` EXPLICITLY, at the
 * branch below, because ADMIN does hold them: a `*` key carried by an
 * agent could otherwise activate its own registration and grant itself
 * every MCP tool, and an allowlist its subject can widen is not an
 * allowlist. `compliance_dsar_*` and `reports.schedule_external` are
 * the remaining two, and `*` DOES reach them — they are privileged
 * operations on data, not authority over which principals may act.
 *
 * Pinned by the `*` cases in `tests/unit/api-key-management.test.ts`,
 * which assert the denials rather than only that `*` equals ADMIN — a
 * shape assertion that stayed green all the while this comment said
 * the opposite.
 */
const SCOPE_ACTION_MAP: Record<string, Record<string, string[]>> = {
    controls:   { read: ['view'], write: ['create', 'edit'] },
    evidence:   { read: ['view', 'download'], write: ['upload', 'edit'] },
    policies:   { read: ['view'], write: ['create', 'edit'], admin: ['approve'] },
    tasks:      { read: ['view'], write: ['create', 'edit', 'assign'] },
    risks:      { read: ['view'], write: ['create', 'edit'] },
    assets:     { read: ['view'], write: ['create', 'edit'] },
    vendors:    { read: ['view'], write: ['create', 'edit'] },
    tests:      { read: ['view'], write: ['create', 'execute'] },
    incidents:  { read: ['view'], admin: ['manage'] },
    personnel:  { read: ['view'], admin: ['manage'] },
    // No `read` group on these two: `PermissionSet` gives them a single
    // `edit` action and no `view`, so there is no flag a read scope could
    // set. `continuity:write` / `processes:write` are the only meaningful
    // grants, and `<domain>:read` is deliberately not a valid scope rather
    // than a valid scope that resolves to nothing.
    continuity: { write: ['edit'] },
    processes:  { write: ['edit'] },
    frameworks: { read: ['view'], write: ['install'] },
    audits:     { read: ['view'], write: ['manage', 'freeze', 'share'] },
    reports:    { read: ['view'], write: ['export'] },
    admin:      { read: ['view'], write: ['manage', 'members', 'sso', 'scim'] },
    // MCP capability gate (Epic MCP). These are CAPABILITY scopes, not
    // resource permissions — they deliberately map to NO PermissionSet flags
    // (empty action arrays). `mcp:read` gates access to the read-only MCP tool
    // surface (Phase 1); `mcp:propose` gates the strictly-more-privileged
    // propose-not-commit write tools (Phase 3). There is intentionally NO
    // `mcp:write` / write-direct scope — every MCP write is a human-approved
    // proposal, never a direct mutation. A key still needs the underlying
    // RESOURCE scope (e.g. `risks:read`) for a given tool: `mcp:read` is the
    // "may talk to MCP at all" gate, resource scopes gate individual tools.
    mcp:        { read: [], propose: [], orchestrate: [] },
};

/**
 * All valid scope strings that can be assigned to an API key.
 */
export const VALID_SCOPES: string[] = [
    '*', // full access
    ...Object.entries(SCOPE_ACTION_MAP).flatMap(([resource, actions]) => [
        `${resource}:*`,
        ...Object.keys(actions).map(action => `${resource}:${action}`),
    ]),
];

/**
 * Validates an array of scope strings.
 * Returns error messages for invalid scopes.
 */
export function validateScopes(scopes: unknown): string[] {
    if (!Array.isArray(scopes)) return ['Scopes must be an array'];
    if (scopes.length === 0) return ['At least one scope is required'];

    const errors: string[] = [];
    for (const scope of scopes) {
        if (typeof scope !== 'string') {
            errors.push(`Invalid scope type: ${typeof scope}`);
            continue;
        }
        if (!VALID_SCOPES.includes(scope)) {
            errors.push(`Invalid scope: "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`);
        }
    }
    return errors;
}

/**
 * Convert an array of scope strings into a PermissionSet.
 * Used to build appPermissions for API-key-authenticated contexts.
 */
export function scopesToPermissions(scopes: string[]): PermissionSet {
    // Start with all-false
    const base = getPermissionsForRole('READER');
    const result: Record<string, Record<string, boolean>> = {};
    for (const [resource, actions] of Object.entries(base)) {
        result[resource] = {};
        for (const action of Object.keys(actions as Record<string, boolean>)) {
            result[resource][action] = false;
        }
    }

    // Full access shortcut — ADMIN, MINUS the agent-governance flags.
    //
    // The two subtractions are the point of the branch, not a detail of it.
    // `admin.agent_registry` decides which autonomous agents may act at all;
    // `admin.agent_tool_exposure` decides what each of them may reach, and it is
    // the list `/api/mcp` refuses a tool against. A `*` key held BY an agent
    // that could set either would make both self-modifiable: the credential
    // could activate its own registration and grant itself every tool, and a
    // deny-by-default allowlist a caller can widen is not an allowlist. So they
    // join `tenant_lifecycle` and `owner_management` — actions that need a real
    // session and that no bearer token, however scoped, performs.
    //
    // Asymmetric with `compliance_dsar_manage` and `reports.schedule_external`,
    // which `*` DOES grant, and deliberately: those are ordinary privileged
    // operations on data. These two are authority over the principals
    // themselves, which is a different kind of thing to hand a token.
    if (scopes.includes('*')) {
        // Resolved ONCE, rather than calling the role resolver a second time
        // for the nested spread. Two calls built two identical objects for no
        // reason, and the duplicated call site also made
        // `enterprise-identity-epic.test.ts`'s whole-file assertion about this
        // branch satisfiable by either of them — a Class D ambiguity that a
        // source diff touching no test had introduced.
        const adminPermissions = getPermissionsForRole('ADMIN');
        return {
            ...adminPermissions,
            admin: {
                ...adminPermissions.admin,
                agent_registry: false,
                agent_tool_exposure: false,
            },
        };
    }

    for (const scope of scopes) {
        const [resource, action] = scope.split(':');

        if (!(resource in SCOPE_ACTION_MAP)) continue;

        if (action === '*') {
            // All actions on this resource
            for (const [, permActions] of Object.entries(SCOPE_ACTION_MAP[resource])) {
                for (const permAction of permActions) {
                    if (permAction in result[resource]) {
                        result[resource][permAction] = true;
                    }
                }
            }
        } else if (action in SCOPE_ACTION_MAP[resource]) {
            // Specific action group
            const permActions = SCOPE_ACTION_MAP[resource][action];
            for (const permAction of permActions) {
                if (permAction in result[resource]) {
                    result[resource][permAction] = true;
                }
            }
        }
    }

    return result as PermissionSet;
}

/**
 * Enforce API key scopes on a request context.
 *
 * Call this in any endpoint that may receive API-key-authenticated requests.
 * Checks whether the API key's scopes grant access to the requested
 * resource and action. Throws 403 if not.
 *
 * For session-authenticated requests (no apiKeyId), this is a no-op.
 *
 * @param ctx - Request context (may or may not be API-key-authenticated)
 * @param resource - The resource being accessed (e.g. "controls")
 * @param action - The action being performed ("read" | "write" | "admin")
 */
export function enforceApiKeyScope(
    ctx: RequestContext,
    resource: string,
    action: 'read' | 'write' | 'admin',
): void {
    // Not an API key request — skip scope enforcement (user auth handles permissions)
    if (!ctx.apiKeyId || !ctx.apiKeyScopes) return;

    const scopes = ctx.apiKeyScopes;

    // Full access
    if (scopes.includes('*')) return;

    // Resource wildcard
    if (scopes.includes(`${resource}:*`)) return;

    // Specific scope
    if (scopes.includes(`${resource}:${action}`)) return;

    throw forbidden(
        `API key does not have scope "${resource}:${action}". ` +
        `Granted scopes: ${scopes.join(', ')}`
    );
}

// ─── Key Generation ───

/**
 * Generate a new API key.
 *
 * @returns Object with `plaintext` (show once), `keyHash`, and `keyPrefix`
 */
export function generateApiKey(): {
    plaintext: string;
    keyHash: string;
    keyPrefix: string;
} {
    const randomPart = crypto.randomBytes(KEY_RANDOM_LENGTH / 2).toString('hex');
    const plaintext = `${API_KEY_PREFIX}${randomPart}`;
    const keyHash = hashApiKey(plaintext);
    const keyPrefix = plaintext.slice(0, API_KEY_PREFIX.length + KEY_PREFIX_DISPLAY_LENGTH);

    return { plaintext, keyHash, keyPrefix };
}

/**
 * Hash an API key for storage/lookup using SHA-256.
 *
 * SHA-256 is appropriate here because API keys have high entropy
 * (24 bytes = 192 bits), unlike user passwords.
 */
export function hashApiKey(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// ─── Key Verification ───

export interface ApiKeyAuthResult {
    valid: true;
    apiKey: TenantApiKey & { tenant: Tenant };
    ctx: RequestContext;
}

export interface ApiKeyAuthError {
    valid: false;
    reason:
        | 'not_found'
        | 'expired'
        | 'revoked'
        | 'invalid_format'
        | 'tenant_deleted'
        /**
         * An agent-bound key whose human principal no longer resolves — removed
         * from the tenant, deactivated, or their role withdrawn. Distinct from
         * `revoked`, which is about the credential; this is about the person it
         * speaks for. Fails closed rather than falling back to the key's own
         * scopes, which is exactly the authority the narrowing exists to remove.
         */
        | 'principal_unresolved';
}

export type ApiKeyVerifyResult = ApiKeyAuthResult | ApiKeyAuthError;

/**
 * Verify a bearer token as an API key and build a RequestContext.
 *
 * @param bearerToken - The raw token from the Authorization header (without "Bearer " prefix)
 * @param clientIp - Optional IP for last-used tracking
 * @returns Verification result with RequestContext if valid
 */
export async function verifyApiKey(
    bearerToken: string,
    clientIp?: string | null,
): Promise<ApiKeyVerifyResult> {
    // Quick format check
    if (!bearerToken.startsWith(API_KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }

    const keyHash = hashApiKey(bearerToken);

    // Look up by hash (unique index — fast)
    const apiKey = await prisma.tenantApiKey.findUnique({
        where: { keyHash },
        include: { tenant: true },
    });

    return finaliseApiKeyAuth(apiKey, clientIp);
}

/**
 * Resolve a key by its ID and run the IDENTICAL liveness checks + context build
 * `verifyApiKey` runs.
 *
 * Exists for the RFC 8693 exchanged token, which names its issuing key by id
 * rather than carrying it: the token is proof that the key was presented ONCE,
 * at exchange time, and this re-establishes what that key is authorised for now
 * — revocation, expiry, tenant liveness and scopes all re-read.
 *
 * Deliberately the same `finaliseApiKeyAuth` body rather than a second copy.
 * A parallel resolver here would be a second authentication path over the same
 * credential, free to drift from the first, which is the shape this whole epic
 * exists to remove.
 */
export async function resolveApiKeyById(
    apiKeyId: string,
    clientIp?: string | null,
): Promise<ApiKeyVerifyResult> {
    const apiKey = await prisma.tenantApiKey.findUnique({
        where: { id: apiKeyId },
        include: { tenant: true },
    });
    return finaliseApiKeyAuth(apiKey, clientIp);
}

/** The shared tail of both resolvers: liveness, tracking, context. */
async function finaliseApiKeyAuth(
    apiKey: (TenantApiKey & { tenant: Tenant }) | null,
    clientIp?: string | null,
): Promise<ApiKeyVerifyResult> {
    if (!apiKey) {
        return { valid: false, reason: 'not_found' };
    }

    // Check revocation
    if (apiKey.revokedAt) {
        return { valid: false, reason: 'revoked' };
    }

    // Check expiry
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return { valid: false, reason: 'expired' };
    }

    // Check the TENANT is still live.
    //
    // This path deliberately skips `resolveTenantContext`, which is where
    // `deletedAt` is otherwise enforced and which its own docstring calls
    // "the single authoritative gate". For a key caller it is not, so the
    // check has to be repeated here.
    //
    // `deleteTenantUnderOrg` soft-deletes a tenant and does NOT revoke its
    // `TenantApiKey` rows, so without this an offboarded customer's
    // integration key keeps reading and writing all 305 tenant routes
    // indefinitely — while that usecase's docstring says the tenant becomes
    // "inaccessible immediately, everywhere".
    if (apiKey.tenant?.deletedAt) {
        return { valid: false, reason: 'tenant_deleted' };
    }

    // Update lastUsedAt (fire-and-forget — don't block auth)
    updateLastUsed(apiKey.id, clientIp).catch(() => {
        // Swallow errors — tracking failure must not break auth
    });

    // Parse scopes from stored JSON
    const scopes = Array.isArray(apiKey.scopes) ? (apiKey.scopes as string[]) : [];

    // Build permissions from scopes instead of giving blanket ADMIN
    const appPermissions = scopesToPermissions(scopes);

    // Determine effective role from scopes
    const hasAdminScope = scopes.includes('*') || scopes.includes('admin:write');
    const hasWriteScope = scopes.some(s => s.endsWith(':write') || s.endsWith(':*') || s === '*');
    const role = hasAdminScope ? 'ADMIN' as const
        : hasWriteScope ? 'EDITOR' as const
        : 'READER' as const;

    const ctx: RequestContext = {
        requestId: crypto.randomUUID(),
        userId: apiKey.createdById,
        tenantId: apiKey.tenantId,
        tenantSlug: apiKey.tenant.slug,
        role,
        permissions: computePermissions(role),
        appPermissions,
        apiKeyId: apiKey.id,
        apiKeyScopes: scopes,
        // The agent principal this credential speaks for, when it speaks for
        // one. Left UNSET rather than null when the key names no agent, so a
        // consumer that forgets to handle it gets `undefined` and not a value
        // that looks deliberate.
        ...(apiKey.agentId ? { agentId: apiKey.agentId } : {}),
        // The key's own autonomy narrowing. Carried as `null` when the column is
        // null — unlike `agentId` above, because here the null has a MEANING
        // ("no key-level narrowing") that a consumer should see rather than have
        // to infer from an absent property.
        apiKeyMaxAutonomy: apiKey.maxAutonomyLevel ?? null,
    };

    // ── Narrow an AGENT-BOUND credential to its principal, HERE ──────────
    //
    // Everything above derives authority from the KEY'S SCOPES alone. For an
    // agent-bound key that is the confused deputy in its textbook form: the
    // credential carries ambient authority the human who created it does not
    // have, so the agent acts beyond its principal.
    //
    // This was closed at the MCP door only. `resolveAgentAuthority` had exactly
    // one caller — `buildMcpInvocation` — while `iflk_` bearers are admitted at
    // `/api/t/**` too (#2224). Measured on this branch before the fix: one key,
    // created by a READER and bound to an ACTIVE agent, was refused
    // `propose_risks` at `/api/mcp` and simultaneously accepted at
    // `POST /api/t/<slug>/risks`, creating a real Risk row — strictly WORSE
    // than the path that was blocked, because it commits outright instead of
    // entering the propose-not-commit queue. A `*`-scoped key from the same
    // principal issued an ADMIN invite.
    //
    // So the narrowing belongs where the credential's context is MINTED, not at
    // each consumer. Every caller of `verifyApiKey` — REST and MCP alike —
    // inherits it, and the PR's own rule ("no parallel agent-authz path that
    // can drift") is satisfied by there being one path.
    //
    // Scoped to agent-bound keys deliberately. A key with no `agentId` keeps
    // today's scope-derived authority: that broader question — should ANY key
    // exceed its creator? — is a real one, but it is pre-existing, affects every
    // existing integration, and is not this change's to decide silently.
    if (apiKey.agentId) {
        try {
            const { ctx: narrowed } = await resolveAgentAuthority(ctx);
            return { valid: true, apiKey, ctx: narrowed };
        } catch (err) {
            // The principal no longer resolves — the member was removed,
            // deactivated, or their role was withdrawn. A credential whose
            // human is gone must not keep acting on their behalf, so this
            // fails CLOSED rather than falling back to the key's own scopes.
            if (err instanceof PrincipalUnresolvedError) {
                // Write the denial before returning. An agent refusal that
                // leaves no audit row is invisible, and this refusal moved here
                // from the MCP funnel — which no longer sees it, because the
                // credential now fails verification before reaching that gate.
                await auditPrincipalUnresolved(ctx, err.reason);
                return { valid: false, reason: 'principal_unresolved' };
            }
            throw err;
        }
    }

    return { valid: true, apiKey, ctx };
}

/**
 * Extract a bearer token from an Authorization header value.
 *
 * @param authHeader - Full "Authorization" header value
 * @returns The token portion, or null if not a Bearer token
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
    if (!authHeader) return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    return parts[1];
}

/**
 * Check if a bearer token looks like an API key (starts with prefix).
 * Used to decide whether to route to API key auth vs JWT auth.
 */
export function isApiKeyToken(token: string): boolean {
    return token.startsWith(API_KEY_PREFIX);
}

// ─── Internal Helpers ───

async function updateLastUsed(apiKeyId: string, clientIp?: string | null): Promise<void> {
    await prisma.tenantApiKey.update({
        where: { id: apiKeyId },
        data: {
            lastUsedAt: new Date(),
            ...(clientIp ? { lastUsedIp: clientIp } : {}),
        },
    });
}
