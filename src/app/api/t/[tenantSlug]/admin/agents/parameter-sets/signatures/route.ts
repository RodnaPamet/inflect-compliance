/**
 * `/api/t/:slug/admin/agents/parameter-sets/signatures` — one human's signature
 * on a pending template edit (#3051 step 5b).
 *
 * ## Why signing is its own route rather than a fifth verb on the collection
 *
 * The parent collection already spends GET / POST / PATCH / PUT on list, save,
 * propose and approve, and the reason it spends a verb per act is stated there:
 * the two privileged acts must be distinguishable in the access log and in
 * `requirePermission`'s audit row without parsing the body. Signing is a THIRD
 * privileged act, and it is the one the four-eyes rule is made of — so it gets
 * its own path for the same reason, rather than a discriminator in a shared
 * POST.
 *
 * ## Signing is not approving
 *
 * POST here records that this human has read the pending edit and accepts it.
 * It does not promote anything: the pending values stay pending and the agent
 * keeps dispatching what is in force. Promotion is still `PUT` on the parent
 * collection, and the database refuses it until the signatures are there.
 *
 * ## The key is the parent's, deliberately
 *
 * `admin.agent_registry`, resolved through the existing `admin/agents(/.*)?`
 * rule in `ROUTE_PERMISSIONS` — no new rule, so there is no second place for
 * the mapping to drift. A parameter set is keyed by (tenant, tool, label) and
 * not by agent, so signing an edit to one touches what EVERY agent granted that
 * tool will send: the tenant-wide class the parent route argues for.
 *
 * It is deliberately NOT a narrower key than the parent's. A tenant that can
 * propose an edit but not sign one has a queue nobody can clear, and the thing
 * that makes the second signature meaningful is that it is a different PERSON —
 * which the database enforces — not a different permission.
 */
import { NextRequest } from 'next/server';

import { signParameterChange } from '@/app-layer/usecases/external-tool-parameters';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await signParameterChange(ctx, await req.json()));
    }),
);
