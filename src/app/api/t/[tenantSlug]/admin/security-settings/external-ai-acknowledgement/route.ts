import { NextRequest } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { setExternalAiBusinessDataAcknowledgement } from '@/app-layer/usecases/tenant-security-settings';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

/**
 * RECORD OR WITHDRAW THE BUSINESS-DATA TRANSFER ACKNOWLEDGEMENT (M5, #3872).
 *
 * A run that reads an ERP's rows and hands them to a model provider outside the
 * deployment is a data transfer. `external-residency-gate.ts` refuses such a
 * run unless this is recorded, and this is the only route that records it.
 *
 * ── WHY A SEPARATE ROUTE RATHER THAN A FIELD ON THE SETTINGS PUT ────────────
 *
 * The acknowledgement is not a configuration value an admin tunes; it is a
 * dated act with an author. Putting it in the settings patch body would let it
 * be set as a side effect of saving an unrelated form, and the audit row would
 * then say somebody accepted a data transfer when what they did was change a
 * session cap.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 *
 * `admin.manage`, the same key as both siblings on this row, because this
 * accepts the consequence of the `aiResidency` choice the sibling PUT writes.
 * The usecase ADDITIONALLY requires a person: a credential, an agent or a job
 * cannot accept a transfer on a company's behalf, and `*`-scoped API keys
 * exist. That check lives in the usecase so no other path to the same columns
 * can bypass it — the same placement the agent-enforcement sibling argues for.
 */
const BodySchema = z
    .object({
        // Explicit in both directions. A body of `{}` meaning "withdraw" would
        // make an empty or malformed request revoke a tenant's consent, which is
        // a side effect no caller asked for.
        acknowledged: z.boolean(),
    })
    .strict();

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = BodySchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            throw badRequest('Send { "acknowledged": true } to record the acknowledgement, or false to withdraw it.');
        }
        return jsonResponse(await setExternalAiBusinessDataAcknowledgement(ctx, parsed.data));
    }),
);
