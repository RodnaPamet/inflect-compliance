/**
 * Epic B — `GET /api/org/[orgSlug]/audit-log` route contract.
 *
 * Mocks org-context + the listing usecase. Asserts:
 *   - 403 when caller lacks `canManageMembers` (ORG_READER)
 *   - 200 + correct shape for ORG_ADMIN
 *   - cursor + limit + action query params propagate to the usecase
 *   - invalid action / limit produces 400
 */
import { NextRequest } from 'next/server';

const getOrgCtxMock = jest.fn();
const listOrgAuditMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: (...a: unknown[]) => getOrgCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/org-audit', () => ({
    __esModule: true,
    listOrgAudit: (...a: unknown[]) => listOrgAuditMock(...a),
}));

import { GET } from '@/app/api/org/[orgSlug]/audit-log/route';

function ctxFor(canManageMembers: boolean) {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: canManageMembers ? 'ORG_ADMIN' : 'ORG_READER',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: canManageMembers,
            canExportReports: true,
            canManageTenants: canManageMembers,
            canManageMembers,
        },
    };
}

function makeRequest(qs: string = ''): NextRequest {
    const url = `http://localhost/api/org/acme-org/audit-log${qs}`;
    return new NextRequest(url, { method: 'GET' });
}

beforeEach(() => {
    getOrgCtxMock.mockReset();
    listOrgAuditMock.mockReset();
});

describe('GET /api/org/[orgSlug]/audit-log', () => {
    it('returns 200 + listing payload for ORG_ADMIN', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        listOrgAuditMock.mockResolvedValue({
            rows: [{ id: 'oa-1', action: 'ORG_MEMBER_ADDED' }],
            nextCursor: 'cursor-abc',
        });

        const res = await GET(makeRequest(), { params: Promise.resolve({ orgSlug: 'acme-org' }) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows).toHaveLength(1);
        expect(body.nextCursor).toBe('cursor-abc');
    });

    it('returns 403 when caller lacks canManageMembers', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(false));

        const res = await GET(makeRequest(), { params: Promise.resolve({ orgSlug: 'acme-org' }) });
        expect(res.status).toBe(403);
        expect(listOrgAuditMock).not.toHaveBeenCalled();
    });

    it('propagates cursor + limit + action query params to the usecase', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        listOrgAuditMock.mockResolvedValue({ rows: [], nextCursor: null });

        await GET(
            makeRequest('?cursor=abc&limit=5&action=ORG_MEMBER_REMOVED'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(listOrgAuditMock).toHaveBeenCalledTimes(1);
        const args = listOrgAuditMock.mock.calls[0][1];
        expect(args.cursor).toBe('abc');
        expect(args.limit).toBe(5);
        expect(args.action).toBe('ORG_MEMBER_REMOVED');
    });

    it('rejects unknown action with 400', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));

        const res = await GET(
            makeRequest('?action=NOT_A_REAL_ACTION'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
        expect(listOrgAuditMock).not.toHaveBeenCalled();
    });

    it('rejects non-numeric limit with 400', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));

        const res = await GET(
            makeRequest('?limit=abc'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
        expect(listOrgAuditMock).not.toHaveBeenCalled();
    });

    it('treats missing query params as defaults (no filter, default limit)', async () => {
        getOrgCtxMock.mockResolvedValue(ctxFor(true));
        listOrgAuditMock.mockResolvedValue({ rows: [], nextCursor: null });

        await GET(makeRequest(), { params: Promise.resolve({ orgSlug: 'acme-org' }) });
        const args = listOrgAuditMock.mock.calls[0][1];
        expect(args.cursor).toBeNull();
        expect(args.limit).toBeUndefined();
        expect(args.action).toBeUndefined();
    });
});
