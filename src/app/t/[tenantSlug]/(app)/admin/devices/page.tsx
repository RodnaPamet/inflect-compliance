import { listDevices } from '@/app-layer/usecases/device';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { DevicesClient, type DeviceRow } from './DevicesClient';

export const dynamic = 'force-dynamic';

/**
 * Device inventory (PR-5) — Server Component. Managed endpoints with per-device
 * posture. Devices are part of the people layer (personnel.view).
 *
 * Gated here, before the read (`admin.view` + `personnel.view`): the admin
 * layout is a client component and cannot keep this page's rows out of the
 * payload. See `../_lib/admin-page-requirements.ts`.
 */
export default async function DevicesPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const gate = await gateAdminPage('/admin/devices', params);
    if (!gate.allowed) return gate.forbidden;
    const rows = (await listDevices(gate.ctx)) as unknown as DeviceRow[];
    return <DevicesClient initialRows={JSON.parse(JSON.stringify(rows))} />;
}
