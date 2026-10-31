import { listDevices } from '@/app-layer/usecases/device';
import { DEVICE_LIST_CAP } from '@/lib/device-list';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** PR-5 — device inventory. Devices are part of the people layer → personnel.view. */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.view', async (_req, _routeArgs, ctx) => {
        const all = await listDevices(ctx);
        return jsonResponse({ devices: all.slice(0, DEVICE_LIST_CAP), truncated: all.length > DEVICE_LIST_CAP });
    }),
);
