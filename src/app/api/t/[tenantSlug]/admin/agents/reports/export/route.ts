/**
 * `POST /api/t/:slug/admin/agents/reports/export` — file the pack as evidence.
 *
 * POST, and the sibling `…/reports` is GET, for a reason that is not ceremony:
 * that route writes NOTHING so an assessor can re-run it without changing what
 * it describes, and this one writes a permanent, retained record every time it
 * is called. Same data, opposite contract; a `?export=1` on the GET would have
 * put an irreversible side effect behind a URL a browser may prefetch.
 *
 * ## Permission
 *
 * `admin.agent_registry`, matched by the existing
 * `^…/admin\/agents(\/.*)?$` catch-all in `route-permissions.ts` — the rules are
 * path-only, so they gate POST exactly as they gate GET, and this route needs no
 * new entry. The usecase additionally requires `evidence.edit`, which is the
 * evidence library's own rule; see its header for why both are asserted there
 * rather than one here and one deep inside `createEvidence`.
 *
 * ## Why not reuse `createEvidence`
 *
 * That usecase rejects `type: 'FILE'` and is shaped around a person filling in a
 * form — owner, folder, control links, DRAFT status. The pack is generated, is
 * APPROVED on arrival because no person drafted it, carries a retention horizon
 * the library's default would not give it, and attaches to no control. Passing
 * it through the form-shaped path would have meant a second call to fix up four
 * fields, with a window in which a filed pack had no retention at all.
 */
import { NextRequest } from 'next/server';

import { exportAgentGovernancePack } from '@/app-layer/usecases/agent-governance-pack-export';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _routeArgs, ctx) => {
        const rawDays = req.nextUrl.searchParams.get('days');
        // Same handling as the GET: absent means the usecase's default, present
        // and unparseable means `NaN` and a refusal, never a silent fallback to
        // a window the caller did not ask for.
        const windowDays = rawDays === null ? undefined : Number(rawDays);

        const result = await exportAgentGovernancePack(ctx, { windowDays });
        return jsonResponse(result, { status: 201 });
    }),
);
