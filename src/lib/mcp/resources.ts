/**
 * MCP resources — read-only grounding context.
 *
 * Resources let an agent reference stable structure without a tool round-trip
 * per lookup:
 *   - `inflect://frameworks` — the framework catalogue;
 *   - `inflect://frameworks/<key>/requirements` — one per installable
 *     framework: the requirement tree + this tenant's coverage of it.
 *
 * Every resource read rides the SAME chain as a tool: the `mcp:read`
 * capability gate (applied by the route), the shared invocation gate, a resource
 * scope, and an existing read usecase that owns RLS + its own permission check.
 * No resource reads Prisma directly.
 *
 * ## The second door
 *
 * `/api/mcp` has two doors — `tools/call` and `resources/read` — and until this
 * change only one of them was fully gated. Resources were protected by
 * `enforceApiKeyScope` ALONE: a throw that wrote no `AUTHZ_DENIED` row, applied
 * no allowlist, and consulted no ceiling. Both now enter through
 * `authorizeResourceRead`, so a resource refusal audits exactly like a tool
 * refusal and the audience, liveness and autonomy checks apply here too.
 *
 * Resources take the audience name `MCP_RESOURCES_AUDIENCE` rather than a tool
 * name, because they have no entries in the grantable catalogue. That gives the
 * RFC 8693 property its teeth in both directions: a token minted for `list_risks`
 * cannot read a resource, and a token minted for resources cannot call a tool.
 *
 * The deny-by-default EXPOSURE allowlist still does not apply here, and the
 * reason is that there is nothing for it to name — see `authorizeResourceRead`.
 */
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { listFrameworks, listInstallableFrameworks } from '@/app-layer/usecases/framework';
import { computeCoverage } from '@/app-layer/usecases/framework/coverage';
import { badRequest, isAppError } from '@/lib/errors/types';

import { authorizeResourceRead, denyToolCall, type McpInvocation } from './authorize';
import { MCP_RESOURCES_AUDIENCE } from './token-exchange';
import type { McpResourceDescriptor, McpResourceContents } from './protocol';

const FRAMEWORKS_URI = 'inflect://frameworks';
const REQ_PREFIX = 'inflect://frameworks/';
const REQ_SUFFIX = '/requirements';

/**
 * List available resources for the tenant: the framework catalogue plus a
 * requirement-tree resource per installable framework.
 *
 * Enumerating frameworks reads global catalogue data, still gated by the
 * usecase's `assertCanViewFrameworks` — but as of 2026-08-23 that policy reads
 * `appPermissions.frameworks.view` rather than merely checking the role
 * exists, so "any `mcp:read` reader passes" is no longer true. A key needs
 * `frameworks:read` alongside `mcp:read`: `scopesToPermissions` maps `mcp:read`
 * to an EMPTY action list, so it confers no resource permission on its own.
 * That is the documented model — `mcp:read` gates the surface, a resource scope
 * gates the data.
 *
 * The per-framework tenant COVERAGE is separately gated on read (below).
 */
export async function listMcpResources(inv: McpInvocation): Promise<McpResourceDescriptor[]> {
    await authorizeResourceRead(inv);
    const frameworks = await listInstallableFrameworks(inv.ctx);
    const resources: McpResourceDescriptor[] = [
        {
            uri: FRAMEWORKS_URI,
            name: 'Frameworks',
            description:
                'The compliance frameworks available in this workspace (name, ' +
                'version, kind, requirement + pack counts). Grounding for reasoning ' +
                'about coverage and gaps.',
            mimeType: 'application/json',
        },
    ];
    for (const f of frameworks) {
        resources.push({
            uri: `${REQ_PREFIX}${f.key}${REQ_SUFFIX}`,
            name: `${f.name} — requirements`,
            description: `The requirement tree for ${f.name} and this tenant's coverage of it.`,
            mimeType: 'application/json',
        });
    }
    return resources;
}

/**
 * Read an MCP resource. Enforces the resource scope, then delegates to an
 * existing usecase (RLS + permission inside). Throws `badRequest` for an
 * unknown uri, `forbidden` (via `enforceApiKeyScope`) for a missing scope.
 */
export async function readMcpResource(
    inv: McpInvocation,
    uri: string,
): Promise<McpResourceContents> {
    const ctx = inv.ctx;
    await authorizeResourceRead(inv);

    if (uri === FRAMEWORKS_URI) {
        await assertFrameworkScope(inv, uri);
        const frameworks = await listFrameworks(ctx);
        return jsonContents(uri, frameworks);
    }

    if (uri.startsWith(REQ_PREFIX) && uri.endsWith(REQ_SUFFIX)) {
        await assertFrameworkScope(inv, uri);
        const key = uri.slice(REQ_PREFIX.length, uri.length - REQ_SUFFIX.length);
        if (!key) throw badRequest(`Invalid framework requirements uri: ${uri}`);
        const coverage = await computeCoverage(ctx, key);
        return jsonContents(uri, {
            framework: coverage.framework,
            summary: {
                total: coverage.total,
                mapped: coverage.mapped,
                unmapped: coverage.unmapped,
                coveragePercent: coverage.coveragePercent,
            },
            bySection: coverage.bySection,
        });
    }

    throw badRequest(`Unknown MCP resource: ${uri}`);
}

/**
 * The credential's resource scope, refused with the SAME one hash-chained row a
 * tool's scope refusal writes. Previously this was a bare `enforceApiKeyScope`
 * throw and left no trace: an agent probing the resources surface for reach it
 * did not have produced a 403 and nothing an operator could later find.
 *
 * The message comes from `enforceApiKeyScope` unchanged — it names scopes the
 * caller already holds, which is safe and is the actionable half.
 */
async function assertFrameworkScope(inv: McpInvocation, uri: string): Promise<void> {
    try {
        enforceApiKeyScope(inv.ctx, 'frameworks', 'read');
    } catch (err) {
        if (!isAppError(err)) throw err;
        await denyToolCall(inv.ctx, 'scope_denied', {
            tool: MCP_RESOURCES_AUDIENCE,
            agentId: inv.agentId,
            message: err.message,
            extra: { resource: 'frameworks', action: 'read', uri },
        });
    }
}

function jsonContents(uri: string, data: unknown): McpResourceContents {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}
