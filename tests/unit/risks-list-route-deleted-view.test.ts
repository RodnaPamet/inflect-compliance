/**
 * `GET /api/t/:tenantSlug/risks?includeDeleted=true` — the deleted-risks read.
 *
 * Two route-level claims, the same two the Controls twin carries (#4275):
 *
 *   1. The list's filters and search reach the deleted read. The branch used
 *      to call `listRisksWithDeleted(ctx)` with nothing, so every filter was
 *      dropped there.
 *   2. The branch is gated `admin.manage` as well as `risks.view`, like the
 *      Restore and Purge routes. It was `risks.view` alone, so a refusal came
 *      from the usecase's `assertCanAdmin` and wrote no AUTHZ_DENIED row.
 */
import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row a middleware refusal writes. `strictMock`: `@/lib/audit`
// is a guarded barrel, so an export this fixture forgot fails loudly.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

const mockListRisksWithDeleted = jest.fn(async (_ctx: unknown, _filters?: unknown) => [] as unknown[]);
const mockListRisks = jest.fn(async () => [] as unknown[]);
jest.mock('@/app-layer/usecases/risk', () => ({
    listRisks: () => mockListRisks(),
    listRisksPaginated: jest.fn(),
    createRisk: jest.fn(),
    listRiskKpiCounts: jest.fn(async () => ({})),
    listRisksWithDeleted: (ctx: unknown, filters?: unknown) => mockListRisksWithDeleted(ctx, filters),
}));

const mockGetRiskStaleness = jest.fn(async () => ({ staleRisks: [{ riskId: 'r-stale' }] }));
jest.mock('@/app-layer/usecases/risk-staleness', () => ({
    getRiskStaleness: () => mockGetRiskStaleness(),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/risks/route';
import { getPermissionsForRole } from '@/lib/permissions';

const ownerCtx = {
    requestId: 'req-1',
    userId: 'owner-1',
    tenantId: 'tenant-A',
    role: 'OWNER',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

/** A custom role on an ADMIN base with `admin.manage` switched off. */
const adminWithoutManage = {
    ...ownerCtx,
    userId: 'custom-1',
    role: 'ADMIN',
    appPermissions: {
        ...getPermissionsForRole('ADMIN'),
        admin: { ...getPermissionsForRole('ADMIN').admin, manage: false },
    },
};

function get(qs: string) {
    return GET(new NextRequest(`http://localhost/api/t/acme/risks${qs}`, { method: 'GET' }), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
}

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(ownerCtx);
    mockListRisksWithDeleted.mockClear();
    mockListRisks.mockClear();
    mockGetRiskStaleness.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
});

describe('GET /risks?includeDeleted=true — filters', () => {
    it('forwards the list filters and search to the deleted read', async () => {
        const res = await get(
            '?includeDeleted=true&q=phishing&status=OPEN,MITIGATING&category=Operational' +
                '&ownerUserId=u-1&treatment=MITIGATE&scoreMin=5&cell=L3xI4&quantified=yes&stale=true',
        );
        expect(res.status).toBe(200);
        expect(mockListRisks).not.toHaveBeenCalled();
        expect(mockListRisksWithDeleted).toHaveBeenCalledTimes(1);
        const [calledCtx, filters] = mockListRisksWithDeleted.mock.calls[0];
        expect(calledCtx).toBe(ownerCtx);
        expect(filters).toMatchObject({
            q: 'phishing',
            status: 'OPEN,MITIGATING',
            category: 'Operational',
            ownerUserId: 'u-1',
            treatment: 'MITIGATE',
            scoreMin: 5,
            cell: 'L3xI4',
            quantified: 'yes',
            // `stale=true` resolves to the stale-risk id set, as on the live list.
            idIn: ['r-stale'],
        });
    });
});

describe('GET /risks?includeDeleted=true — gated admin.manage at the route', () => {
    it('refuses a caller without admin.manage with a 403 and an AUTHZ_DENIED row', async () => {
        getTenantCtxMock.mockResolvedValue(adminWithoutManage);
        const res = await get('?includeDeleted=true&stale=true');
        expect(res.status).toBe(403);
        // Refused before any read — including the staleness scan.
        expect(mockListRisksWithDeleted).not.toHaveBeenCalled();
        expect(mockGetRiskStaleness).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
        });
        // A generic refusal: the key is not echoed to the client.
        expect(JSON.stringify(await res.json())).not.toContain('admin.manage');
    });

    it('a READER is refused the same way', async () => {
        getTenantCtxMock.mockResolvedValue({
            ...ownerCtx,
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: getPermissionsForRole('READER'),
        });
        const res = await get('?includeDeleted=true');
        expect(res.status).toBe(403);
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('the live list is NOT gated admin.manage — the same caller still reads it', async () => {
        getTenantCtxMock.mockResolvedValue(adminWithoutManage);
        const res = await get('?status=OPEN');
        expect(res.status).toBe(200);
        expect(mockListRisks).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});
