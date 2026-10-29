/**
 * `/api/t/:slug/admin/agents/discovered` — the discovered agents a person can
 * pick from (#4472).
 *
 * GET only, read-only. The list behind the discovered-agent review's start
 * form on `/agents/runs`: newest seen first, bounded, with `truncated` saying
 * when more exist. See `listDiscoveredAgentOptions` for what each row carries.
 *
 * ## Permission
 *
 * The INVENTORY READ (#3710): the read-only `admin.agent_registry_view`, or the
 * register key whose holders always could — the gate the harness-scans list
 * and the `get_discovered_agent` tool take, so a run started from a row of this
 * list can read the row it was started with. A literal `requirePermission`
 * here so a refusal writes the hash-chained `AUTHZ_DENIED` row; the usecase
 * asserts the same keys as its floor. Its rule in `route-permissions.ts` sits
 * above the register's catch-all, and `discovered` is listed in
 * `AGENT_ADMIN_API_STATIC_SEGMENTS`, so the edge does not mistake it for an
 * agent id.
 *
 * At the edge this is an admin path: OWNER and ADMIN, and AI_ADMIN on the agent
 * paths. It is NOT one of the AUDITOR inventory reads
 * (`AUDITOR_ADMIN_READ_PATHS`) — the picker it serves is offered only to a
 * person who may start a run, which an AUDITOR may not.
 */
import { NextRequest } from 'next/server';

import { listDiscoveredAgentOptions } from '@/app-layer/usecases/discovered-agent-list';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' },
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await listDiscoveredAgentOptions(ctx)),
    ),
);
