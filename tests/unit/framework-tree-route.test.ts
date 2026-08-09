/**
 * Epic 46 — `GET /api/t/[tenantSlug]/frameworks/[frameworkKey]/tree`.
 *
 * Mocks `getTenantCtx` + the `getFrameworkTree` usecase. Asserts:
 *   - 200 + correct payload shape on the happy path
 *   - the `version` query param is forwarded to the usecase
 *   - 403 when the caller has no role on the tenant
 *     (`assertCanViewFrameworks` rejects)
 *   - 404 when the underlying framework key is unknown
 *
 * Mirrors the route-test pattern at `tests/unit/audit-trail-org-route.test.ts`.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const getFrameworkTreeMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/framework', () => ({
    __esModule: true,
    getFrameworkTree: (...a: unknown[]) => getFrameworkTreeMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/tree/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { forbidden, notFound } from '@/lib/errors/types';
import type { Role } from '@prisma/client';

function ctxFor(role: Role | null) {
    return {
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'req-test',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: role ? getPermissionsForRole(role) : undefined,
    };
}

function makeRequest(qs: string = ''): NextRequest {
    const url = `http://localhost/api/t/acme/frameworks/ISO27001/tree${qs}`;
    return new NextRequest(url, { method: 'GET' });
}

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getFrameworkTreeMock.mockReset();
});

describe('GET /api/t/[tenantSlug]/frameworks/[frameworkKey]/tree', () => {
    const samplePayload = {
        framework: {
            id: 'fw-1',
            key: 'ISO27001',
            name: 'ISO 27001',
            version: '2022',
            kind: 'ISO_STANDARD',
            description: null,
        },
        nodes: [
            {
                id: 'section:fw-1:theme:ORG:0',
                kind: 'section',
                label: 'ORGANIZATIONAL',
                title: 'ORGANIZATIONAL',
                description: null,
                descendantCount: 1,
                childCount: 1,
                hasChildren: true,
                children: [
                    {
                        id: 'req-5.1',
                        kind: 'requirement',
                        label: '5.1',
                        title: 'Policies',
                        description: null,
                        code: '5.1',
                        sortOrder: 1,
                        descendantCount: 0,
                        childCount: 0,
                        hasChildren: false,
                        children: [],
                    },
                ],
            },
        ],
        totals: { sections: 1, requirements: 1, maxDepth: 1 },
    };

    it('returns 200 + the tree payload on the happy path', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getFrameworkTreeMock.mockResolvedValue(samplePayload);

        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(samplePayload);
        expect(getFrameworkTreeMock).toHaveBeenCalledTimes(1);
        expect(getFrameworkTreeMock.mock.calls[0][1]).toBe('ISO27001');
        expect(getFrameworkTreeMock.mock.calls[0][2]).toBeUndefined();
    });

    it('forwards complianceStatus + statusCounts on payload nodes (Epic 46.3)', async () => {
        // The route is a passthrough — assert that whatever the
        // usecase returns lands on the wire intact, including the
        // new compliance fields. Catches a future serialisation
        // regression that strips unknown keys.
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        const decorated = {
            ...samplePayload,
            nodes: [
                {
                    ...samplePayload.nodes[0],
                    complianceStatus: 'partial',
                    statusCounts: {
                        compliant: 1,
                        partial: 0,
                        gap: 0,
                        na: 0,
                        unknown: 0,
                    },
                    children: samplePayload.nodes[0].children.map((c) => ({
                        ...c,
                        complianceStatus: 'compliant',
                        statusCounts: {
                            compliant: 1,
                            partial: 0,
                            gap: 0,
                            na: 0,
                            unknown: 0,
                        },
                    })),
                },
            ],
        };
        getFrameworkTreeMock.mockResolvedValue(decorated);
        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
        });
        const body = await res.json();
        expect(body.nodes[0].complianceStatus).toBe('partial');
        expect(body.nodes[0].statusCounts.compliant).toBe(1);
        expect(body.nodes[0].children[0].complianceStatus).toBe('compliant');
    });

    it('forwards the `version` query param to the usecase', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getFrameworkTreeMock.mockResolvedValue(samplePayload);

        await GET(makeRequest('?version=2022'), {
            params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
        });
        expect(getFrameworkTreeMock.mock.calls[0][2]).toBe('2022');
    });

    it('returns 403 when the policy assertion rejects (no role)', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        // The route doesn't call the policy directly — it calls the
        // usecase, which calls the policy. Throw the same canonical
        // `forbidden(...)` AppError so the wrapper maps it to 403.
        getFrameworkTreeMock.mockRejectedValue(forbidden('Authentication required'));

        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
        });
        expect(res.status).toBe(403);
    });

    it('returns 404 when the framework key is unknown', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getFrameworkTreeMock.mockRejectedValue(notFound('Framework not found'));

        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme', frameworkKey: 'no-such-fw' }),
        });
        expect(res.status).toBe(404);
    });
});
