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
 * capability gate (applied by the route), a resource scope enforced here, and
 * an existing read usecase that owns RLS + its own permission check. No
 * resource reads Prisma directly.
 */
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { listFrameworks, listInstallableFrameworks } from '@/app-layer/usecases/framework';
import { computeCoverage } from '@/app-layer/usecases/framework/coverage';
import { badRequest } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

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
export async function listMcpResources(ctx: RequestContext): Promise<McpResourceDescriptor[]> {
    const frameworks = await listInstallableFrameworks(ctx);
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
    ctx: RequestContext,
    uri: string,
): Promise<McpResourceContents> {
    if (uri === FRAMEWORKS_URI) {
        enforceApiKeyScope(ctx, 'frameworks', 'read');
        const frameworks = await listFrameworks(ctx);
        return jsonContents(uri, frameworks);
    }

    if (uri.startsWith(REQ_PREFIX) && uri.endsWith(REQ_SUFFIX)) {
        enforceApiKeyScope(ctx, 'frameworks', 'read');
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

function jsonContents(uri: string, data: unknown): McpResourceContents {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}
