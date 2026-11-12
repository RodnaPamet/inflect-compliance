/**
 * A tenant's billing plan is set by the platform operator, never by the
 * tenant (owner decision 2026-11-12). The tenant-facing route that let an
 * OWNER set ENTERPRISE on their own workspace is gone; the platform-admin
 * route needs the platform key before it reads anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const mockSetPlan = jest.fn();
jest.mock('@/app-layer/usecases/tenant-lifecycle', () => ({
    setTenantPlanAsPlatform: (...a: unknown[]) => mockSetPlan(...a),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/tenants/[slug]/plan/route';

const KEY = 'platform-key-for-tests-0123456789abcdef'; // pragma: allowlist secret — test-only placeholder

function req(headers: Record<string, string>, body: unknown = { plan: 'PRO' }) {
    return new NextRequest('http://localhost/api/admin/tenants/acme/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}
const params = { params: Promise.resolve({ slug: 'acme' }) };

beforeEach(() => {
    mockSetPlan.mockReset();
    mockSetPlan.mockResolvedValue({ fromPlan: 'FREE', toPlan: 'PRO', direction: 'upgraded' });
    process.env.PLATFORM_ADMIN_API_KEY = KEY;
});

describe('setting a tenant plan', () => {
    it('the tenant-facing route no longer exists', () => {
        const tenantRoute = path.join(process.cwd(), 'src/app/api/t/[tenantSlug]/admin/billing/plan/route.ts');
        expect(fs.existsSync(tenantRoute)).toBe(false);
    });

    it('refuses without the platform key, reading nothing', async () => {
        const res = await POST(req({}), params);
        expect(res.status).toBeGreaterThanOrEqual(401);
        expect(mockSetPlan).not.toHaveBeenCalled();
    });

    it('refuses a wrong platform key', async () => {
        const res = await POST(req({ 'x-platform-admin-key': 'wrong' }), params);
        expect(res.status).toBeGreaterThanOrEqual(401);
        expect(mockSetPlan).not.toHaveBeenCalled();
    });

    it('sets the plan with the platform key', async () => {
        const res = await POST(req({ 'x-platform-admin-key': KEY }), params);
        expect(res.status).toBe(200);
        expect(mockSetPlan).toHaveBeenCalledWith({ tenantSlug: 'acme', plan: 'PRO' });
    });
});
