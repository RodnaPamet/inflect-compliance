/**
 * `GET /api/t/:tenantSlug/incidents` — the Incidents register's list read
 * (#4463).
 *
 * It returned the repository's default 200 most recently detected incidents
 * as a bare array, so a larger register stopped silently and the page's KPI
 * cards counted only those 200. It now follows the PR-5 backfill-cap shape:
 * read one past `LIST_BACKFILL_CAP`, answer `{ rows, truncated }`, and carry
 * `kpiCounts` counted over every incident rather than over `rows`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const listIncidentsMock = jest.fn(async (_ctx: unknown, _opts?: { take?: number }) => [] as unknown[]);
const listIncidentKpiCountsMock = jest.fn(async (_ctx: unknown) => ({
    total: 0,
    open: 0,
    reportable: 0,
    deadlinesDueOrOverdue: 0,
}));
jest.mock('@/app-layer/usecases/incident', () => ({
    listIncidents: (ctx: unknown, opts?: { take?: number }) => listIncidentsMock(ctx, opts),
    listIncidentKpiCounts: (ctx: unknown) => listIncidentKpiCountsMock(ctx),
    createIncident: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/incidents/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { LIST_BACKFILL_CAP } from '@/lib/list-backfill-cap';

const ctx = {
    requestId: 'req-1',
    userId: 'reader-1',
    tenantId: 'tenant-A',
    role: 'READER',
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
    appPermissions: getPermissionsForRole('READER'),
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `inc_${i}` }));

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(ctx);
    listIncidentsMock.mockReset();
    listIncidentKpiCountsMock.mockClear();
});

async function get() {
    const res = await GET(new NextRequest('http://localhost/api/t/acme/incidents', { method: 'GET' }), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
    return { status: res.status, body: await res.json() };
}

describe('GET /incidents reads one past the backfill cap', () => {
    it('asks for LIST_BACKFILL_CAP + 1 rows, so "exactly the cap" and "more" differ', async () => {
        listIncidentsMock.mockResolvedValue(rows(3));
        await get();
        expect(listIncidentsMock).toHaveBeenCalledWith(ctx, { take: LIST_BACKFILL_CAP + 1 });
    });

    it('reports truncated, and returns the cap, when there are more incidents than it', async () => {
        listIncidentsMock.mockResolvedValue(rows(LIST_BACKFILL_CAP + 1));
        const { status, body } = await get();
        expect(status).toBe(200);
        expect(body.truncated).toBe(true);
        expect(body.rows).toHaveLength(LIST_BACKFILL_CAP);
    });

    it('reports not truncated when the register fits', async () => {
        listIncidentsMock.mockResolvedValue(rows(LIST_BACKFILL_CAP));
        const { body } = await get();
        expect(body.truncated).toBe(false);
        expect(body.rows).toHaveLength(LIST_BACKFILL_CAP);
    });

    it('carries the KPI counts from the aggregate read, not a count of the rows', async () => {
        listIncidentsMock.mockResolvedValue(rows(LIST_BACKFILL_CAP + 1));
        listIncidentKpiCountsMock.mockResolvedValue({
            total: 7200,
            open: 6100,
            reportable: 310,
            deadlinesDueOrOverdue: 12,
        });
        const { body } = await get();
        expect(listIncidentKpiCountsMock).toHaveBeenCalledWith(ctx);
        expect(body.kpiCounts).toEqual({
            total: 7200,
            open: 6100,
            reportable: 310,
            deadlinesDueOrOverdue: 12,
        });
    });
});
