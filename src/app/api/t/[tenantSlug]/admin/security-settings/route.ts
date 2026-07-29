import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import {
    getTenantSecurityConfig,
    updateTenantSecurityConfig,
} from '@/app-layer/usecases/tenant-security-settings';
import { UpdateTenantSecuritySettingsInput } from '@/app-layer/schemas/tenant-security-settings.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * Tenant security settings — the configuration surface for the Epic C.3/C.4
 * and AI-governance features that previously had consumers but no writer.
 *
 *   - GET — current values. The audit-stream HMAC secret is NEVER returned;
 *     the payload exposes `hasAuditStreamSecret` instead.
 *   - PUT — patch-shaped. Any subset of fields can land; absent keys are left
 *     alone and explicit `null` clears. That is what lets this route coexist
 *     with `PUT /security/mfa/policy`, which writes the same row.
 *
 * Both methods gate on `admin.manage`, matching the sibling admin config
 * routes (`admin/risk-matrix-config`). Reads are admin-only rather than
 * member-visible because the row carries the session cap and the presence of
 * an outbound streaming endpoint.
 */

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) =>
        jsonResponse(await getTenantSecurityConfig(ctx)),
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const raw = await req.json().catch(() => ({}));
        const parsed = UpdateTenantSecuritySettingsInput.safeParse(raw);
        if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
        }
        return jsonResponse(await updateTenantSecurityConfig(ctx, parsed.data));
    }),
);
