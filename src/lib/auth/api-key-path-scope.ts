/**
 * Which tenant REST paths an API key may call, by its scopes.
 *
 * A key's resource scopes become its `appPermissions`, which `requirePermission`
 * and the granular policies read. But much of the REST surface is gated by the
 * coarse tier alone (`canRead` / `canWrite` / `canAdmin`), and a key's coarse
 * tier comes from ANY of its scopes (`keyAuthorityFromScopes`): one `:write`
 * scope made the key a writer on every coarse-gated register, and every key
 * could read them all.
 *
 * So, before any handler runs, a key other than `*` must hold a scope on the
 * resource its path belongs to (owner decision, 2026-11-12: refuse unmapped):
 *
 *   - a read (`GET`, `HEAD`) needs any scope on that resource;
 *   - a write needs a scope on that resource other than its `read` group.
 *
 * A path whose resource maps to no scope is refused to every key but `*`. This
 * layer only narrows: the route's `requirePermission` and the usecase still
 * decide the action. Each refusal writes an `AUTHZ_DENIED` row.
 */
import type { RequestContext } from '@/app-layer/types';
import { appendAuditEntry } from '@/lib/audit';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * The first segment under `/api/t/<slug>/` → the scope resource that governs
 * it. A segment absent here is unmapped, and only a `*` key reaches it.
 */
export const API_KEY_PATH_RESOURCES: Readonly<Record<string, string>> = {
    'access-reviews': 'access_reviews',
    admin: 'admin',
    'agent-proposals': 'admin',
    // A run is started by a runner's key holding `mcp:orchestrate` (the usecase
    // enforces it) and read with `mcp:read`.
    'agent-runs': 'mcp',
    assets: 'assets',
    'security-testing': 'assets',
    vulnerabilities: 'assets',
    'audit-log': 'admin',
    audits: 'audits',
    automation: 'admin',
    billing: 'admin',
    'notification-settings': 'admin',
    security: 'admin',
    sso: 'admin',
    integrations: 'admin',
    'background-checks': 'personnel',
    devices: 'personnel',
    personnel: 'personnel',
    training: 'personnel',
    'business-continuity': 'continuity',
    clauses: 'frameworks',
    frameworks: 'frameworks',
    'framework-updates': 'frameworks',
    'gap-assessments': 'frameworks',
    'gap-assignments': 'frameworks',
    mapping: 'frameworks',
    controls: 'controls',
    coverage: 'controls',
    questionnaires: 'controls',
    traceability: 'controls',
    evidence: 'evidence',
    files: 'evidence',
    findings: 'findings',
    incidents: 'incidents',
    issues: 'tasks',
    tasks: 'tasks',
    'loss-events': 'risks',
    'risk-appetite': 'risks',
    'risk-matrix-config': 'risks',
    risks: 'risks',
    policies: 'policies',
    processes: 'processes',
    reports: 'reports',
    tests: 'tests',
    'vendor-assessment-reviews': 'vendors',
    'vendor-assessment-templates': 'vendors',
    'vendor-extractions': 'vendors',
    'vendor-proposals': 'vendors',
    vendors: 'vendors',
};

/** Deeper paths governed by a different resource than their first segment. */
const SUB_PATH_RESOURCES: ReadonlyArray<{ prefix: string; resource: string }> = [
    { prefix: 'admin/identity-reconciliation', resource: 'identity_reconciliation' },
];

const READ_METHODS = new Set(['GET', 'HEAD']);

/** The resource a tenant API path belongs to, or null when it maps to none. */
export function apiKeyPathResource(pathname: string): string | null {
    const match = /^\/api\/t\/[^/]+\/(.+)$/.exec(pathname);
    if (!match) return null;
    const rest = match[1].replace(/\/+$/, '');
    for (const { prefix, resource } of SUB_PATH_RESOURCES) {
        if (rest === prefix || rest.startsWith(`${prefix}/`)) return resource;
    }
    const first = rest.split('/')[0];
    return Object.prototype.hasOwnProperty.call(API_KEY_PATH_RESOURCES, first)
        ? API_KEY_PATH_RESOURCES[first]
        : null;
}

export type ApiKeyPathRefusal =
    | { reason: 'unmapped_path'; resource: null }
    | { reason: 'no_scope_on_resource' | 'read_only_scope'; resource: string };

/** Why a key with these scopes may not make this request, or null when it may. */
export function apiKeyPathRefusal(
    scopes: readonly string[],
    method: string,
    pathname: string,
): ApiKeyPathRefusal | null {
    if (scopes.includes('*')) return null;
    const resource = apiKeyPathResource(pathname);
    if (!resource) return { reason: 'unmapped_path', resource: null };
    const actions = scopes
        .filter((s) => s.startsWith(`${resource}:`))
        .map((s) => s.slice(resource.length + 1));
    if (actions.length === 0) return { reason: 'no_scope_on_resource', resource };
    if (READ_METHODS.has(method.toUpperCase())) return null;
    return actions.some((a) => a !== 'read') ? null : { reason: 'read_only_scope', resource };
}

const REFUSAL_MESSAGE: Record<ApiKeyPathRefusal['reason'], string> = {
    unmapped_path: 'This API key cannot call this endpoint: it is available only to keys with full access (*).',
    no_scope_on_resource: 'This API key has no scope for this resource.',
    read_only_scope: 'This API key may only read this resource.',
};

/** Refuse, with an `AUTHZ_DENIED` row, a key request outside its scopes. */
export async function assertApiKeyMayReachPath(
    ctx: RequestContext,
    surface: { method: string; path: string },
): Promise<void> {
    if (!ctx.apiKeyId) return;
    const refusal = apiKeyPathRefusal(ctx.apiKeyScopes ?? [], surface.method, surface.path);
    if (!refusal) return;
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'TenantApiKey',
            entityId: ctx.apiKeyId,
            action: 'AUTHZ_DENIED',
            details: `API key refused for ${surface.method} ${surface.path}: outside its scopes`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'api_key_path_scope',
                reason: refusal.reason,
                resource: refusal.resource,
                apiKeyId: ctx.apiKeyId,
                method: surface.method,
                path: surface.path,
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId, reason: refusal.reason },
        });
    } catch (err) {
        logger.warn('audit: failed to record API-key path-scope AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
    }
    throw forbidden(REFUSAL_MESSAGE[refusal.reason]);
}
