/**
 * Clear a false-positive malware quarantine — admin API.
 *
 *   POST /api/t/:tenantSlug/admin/files/:fileId/clear-quarantine
 *     Body: { "reason": "<human justification>" }
 *
 * The only in-app path back from a terminal `scanStatus: INFECTED`.
 * Without it a single bad ClamAV signature update bricks an evidence
 * library until a DBA intervenes.
 *
 * Gated on `admin.tenant_lifecycle` — the OWNER-only key ADMIN is
 * explicitly DENIED by the role model in `src/lib/permissions.ts`.
 * Returning suspected malware to circulation sits with tenant
 * deletion and DEK rotation, not with evidence editing. Do not
 * weaken this to `admin.manage`.
 *
 * Tight rate limit (`API_KEY_CREATE_LIMIT` — 5/hr) for the same
 * reason the DEK-rotation route carries one: a legitimate operator
 * clears a handful of files after a bad signature, and the cap turns
 * a compromised OWNER session into a slow drip rather than a library
 * -wide un-quarantine.
 *
 * The audit row (`FILE_QUARANTINE_CLEARED`) is written by the usecase
 * BEFORE the state transition — see `usecases/file-quarantine.ts`.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { jsonResponse } from '@/lib/api-response';
import {
    clearFileQuarantine,
    MIN_QUARANTINE_CLEAR_REASON,
    MAX_QUARANTINE_CLEAR_REASON,
} from '@/app-layer/usecases/file-quarantine';

const ClearQuarantineSchema = z.object({
    reason: z
        .string()
        .min(MIN_QUARANTINE_CLEAR_REASON)
        .max(MAX_QUARANTINE_CLEAR_REASON),
});

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; fileId: string }>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, { params }, ctx) => {
            const body = ClearQuarantineSchema.parse(await req.json());
            const result = await clearFileQuarantine(ctx, {
                fileId: params.fileId,
                reason: body.reason,
            });
            return jsonResponse(result);
        },
    ),
    {
        rateLimit: {
            config: API_KEY_CREATE_LIMIT,
            scope: 'file-quarantine-clear',
        },
    },
);
