/**
 * Epic 47.1 — `GET /api/t/[tenantSlug]/traceability/graph`.
 *
 * Mocks `getTenantCtx` + the `getTraceabilityGraph` usecase.
 * Asserts:
 *   - 200 + payload returned on the happy path
 *   - `kinds=` query param parses correctly and is forwarded
 *   - unknown `kinds=` values are dropped (not 400)
 *   - 403 when the policy denies (no role)
 *   - structural fields present on payload (nodes / edges /
 *     categories / meta)
 */

import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const getGraphMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/traceability-graph', () => ({
    __esModule: true,
    getTraceabilityGraph: (...a: unknown[]) => getGraphMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/traceability/graph/route';
import { forbidden } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

function ctxFor(role: Role | null) {
    return {
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'req',
        tenantSlug: 'acme',
        role,
        permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        appPermissions: role ? getPermissionsForRole(role) : undefined,
    };
}

function makeRequest(qs: string = ''): NextRequest {
    return new NextRequest(
        `http://localhost/api/t/acme/traceability/graph${qs}`,
        { method: 'GET' },
    );
}

const samplePayload = {
    nodes: [
        {
            id: 'c1',
            kind: 'control',
            label: 'A.5.1',
            secondary: 'Policies',
            badge: 'IMPLEMENTED',
            href: '/t/acme/controls/c1',
        },
        {
            id: 'r1',
            kind: 'risk',
            label: 'Phishing',
            secondary: 'tech',
            badge: 'OPEN',
            href: '/t/acme/risks/r1',
        },
    ],
    edges: [
        {
            id: 'l1',
            source: 'c1',
            target: 'r1',
            relation: 'mitigates',
            qualifier: null,
        },
    ],
    categories: [
        { kind: 'control', label: 'Control', pluralLabel: 'Controls', color: 'brand', count: 1 },
        { kind: 'risk', label: 'Risk', pluralLabel: 'Risks', color: 'rose', count: 1 },
    ],
    meta: {
        truncated: false,
        droppedNodeCount: 0,
        nodeCap: null,
        appliedFilters: {},
    },
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getGraphMock.mockReset();
});

describe('GET /api/t/[tenantSlug]/traceability/graph', () => {
    it('returns 200 + the typed graph payload on the happy path', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockResolvedValue(samplePayload);

        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(samplePayload);
        expect(body.nodes).toHaveLength(2);
        expect(body.edges).toHaveLength(1);
        expect(body.categories).toHaveLength(2);
        expect(body.meta).toBeDefined();
    });

    it('parses and forwards the kinds= filter', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockResolvedValue(samplePayload);

        await GET(makeRequest('?kinds=control,risk'), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        expect(getGraphMock).toHaveBeenCalledTimes(1);
        const opts = getGraphMock.mock.calls[0][1];
        expect(opts.filters.kinds).toEqual(['control', 'risk']);
    });

    it('drops unknown kind values silently (no 400)', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockResolvedValue(samplePayload);

        const res = await GET(makeRequest('?kinds=control,frobnicator,risk'), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        expect(res.status).toBe(200);
        const opts = getGraphMock.mock.calls[0][1];
        expect(opts.filters.kinds).toEqual(['control', 'risk']);
    });

    it('forwards focusId + focusRadius', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockResolvedValue(samplePayload);

        await GET(makeRequest('?focusId=c1&focusRadius=2'), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        const opts = getGraphMock.mock.calls[0][1];
        expect(opts.filters.focusId).toBe('c1');
        expect(opts.filters.focusRadius).toBe(2);
    });

    it('rejects out-of-range focusRadius (drops it)', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockResolvedValue(samplePayload);

        await GET(makeRequest('?focusId=c1&focusRadius=99'), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        const opts = getGraphMock.mock.calls[0][1];
        // Out-of-range radius is silently dropped — focusId still
        // forwarded.
        expect(opts.filters.focusRadius).toBeUndefined();
        expect(opts.filters.focusId).toBe('c1');
    });

    it('returns 403 when the usecase denies on permissions', async () => {
        // The usecase is mocked here — this asserts the route's error
        // MAPPING, not the gate. The real refusal now comes from
        // `assertAnyDomainViewable` for a caller who can view none of the
        // graph's five kinds; `tests/integration/traceability-graph-usecase`
        // covers that behaviour against a real DB.
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getGraphMock.mockRejectedValue(
            forbidden(
                'You do not have permission to view any entities in the traceability graph.',
            ),
        );

        const res = await GET(makeRequest(), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });
        expect(res.status).toBe(403);
    });
});
