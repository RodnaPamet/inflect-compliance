/**
 * `POST /api/t/:slug/admin/agents/assurance-checks` — schedule the four agent
 * assurance checks the register's Assurance section reads (#5014): one daily
 * control-test plan per check, on the control that discharges the OWASP Agentic
 * risk it evidences.
 *
 * Body `{ apply, controls? }`. `apply: false` is the dry run: it reports each
 * check's plan and control and writes nothing. Both answer 200 with the
 * usecase's result, a named refusal included (`{ ok: false, refusal, detail }`),
 * because a refusal here answers "can these be scheduled yet?", not a failure
 * of the request. A refusal a usecase raises while applying is thrown and
 * answered as that usecase's error.
 *
 * `admin.agent_registry`, the key the `admin/agents(/.*)?` rule records and the
 * key the register's writes take. The usecase also asks `tests.create`, which
 * the two test-plan writes take.
 */
import type { NextRequest } from 'next/server';

import { setUpAgentAssuranceChecks } from '@/app-layer/usecases/agent-assurance-checks-setup';
import { AgentAssuranceChecksSetupSchema } from '@/app-layer/schemas/agent-assurance-checks.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { parseJsonBody } from '@/lib/validation/route';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('admin.agent_registry', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, AgentAssuranceChecksSetupSchema);
        return jsonResponse(await setUpAgentAssuranceChecks(ctx, { apply: body.apply, controls: body.controls }));
    }),
);
