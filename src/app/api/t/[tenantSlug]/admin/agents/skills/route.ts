/**
 * `/api/t/:slug/admin/agents/skills` — the skill corpus a Flue agent can load.
 *
 * ## Why this is tenant-scoped but not tenant-specific
 *
 * The corpus ships with the product: six reviewed Markdown documents on disk,
 * identical for every tenant. The route is still tenant-scoped and permission
 * gated because WHO MAY SEE IT is a tenant question — the list is what an
 * agent is taught, and the plan's reason for surfacing it at all is that "the
 * list is itself an audit artifact: what did the agent know is a question an
 * assessor asks."
 *
 * ## What it deliberately does NOT claim
 *
 * It does not say which skills THIS agent loaded. An agent does not declare
 * skills; a workflow definition does, and a run loads what its definition
 * asked for. Returning a per-agent subset would mean inventing a binding that
 * does not exist, so the response names the corpus and the client says plainly
 * that a run loads only what its workflow declares.
 *
 * ## Why `admin.agent_registry`
 *
 * The same blast-radius argument `external-tools/route.ts` makes: a skill is
 * instruction text delivered to a model, and it is tenant-wide rather than
 * per-agent, so it sits in the registry class rather than the per-agent
 * `agent_tool_exposure` one. The gate lives at the ROUTE, where a denial
 * writes a hash-chained `AUTHZ_DENIED` row.
 */
import { NextRequest } from 'next/server';

import { listAgentSkills } from '@/app-layer/usecases/agent-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, _c, ctx) => {
        return jsonResponse(listAgentSkills(ctx));
    }),
);
