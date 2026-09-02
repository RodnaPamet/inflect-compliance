/**
 * #2197 — the route body schema is the ONLY validation on the process-map
 * write path, and until this file nothing pinned it.
 *
 * Those handlers moved from `withValidatedBody` to `parseJsonBody` because
 * `requirePermission` occupies the third argument slot `withValidatedBody`
 * hands the body in. The swap is correct, but it is a validation-helper change
 * on ten handlers — and unlike the BIA usecases, which re-parse defensively
 * (`createBia` → `CreateBiaSchema.parse(rawInput)`), the process-map usecases
 * take typed input and hand it straight to the repository:
 * `saveProcessMap` → `ProcessMapRepository.replaceGraph(db, ctx, id, { nodes,
 * edges, expectedVersion })`.
 *
 * Measured before this file existed: replacing
 * `parseJsonBody(req, SaveProcessMapSchema)` with `req.json()` in the PUT left
 * **532 tests green**, including the census, the denial-audit rows,
 * `api-permission-coverage`, `p1-optimistic-concurrency`, `p5b-diff-restore`
 * and the schema's own unit tests. A later "simplify" or a bad rebase could
 * drop the schema and nothing would say so.
 *
 * These are BEHAVIOURAL rather than a `expect(src).toMatch(/parseJsonBody/)`
 * source pin. The neighbouring `p5b-diff-restore` guard uses the source form,
 * and it would catch a deletion of the identifier — but not a swap to a
 * different schema, and raw-text guard assertions are their own recorded
 * defect class (#2246). What matters is that a malformed body is REFUSED, not
 * which helper refuses it.
 */
import { NextRequest } from 'next/server';

const mockCtx = {
    requestId: 'r1', userId: 'u1', tenantId: 't1', role: 'ADMIN' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true },
    appPermissions: {},
    tenant: { id: 't1', slug: 'acme' },
};

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn(async () => mockCtx),
    getLegacyCtx: jest.fn(async () => mockCtx),
}));

// The gate must not be what produces the 400 — mock it through so the parse is
// unambiguously the thing under test.
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: unknown) => handler,
}));

const saveProcessMap = jest.fn(async () => ({ id: 'p1' }));
const createProcessMap = jest.fn(async () => ({ id: 'p1' }));
jest.mock('@/app-layer/usecases/process-map', () => ({
    saveProcessMap: (...a: unknown[]) => saveProcessMap(...(a as [])),
    createProcessMap: (...a: unknown[]) => createProcessMap(...(a as [])),
    setProcessMapStatus: jest.fn(),
    setProcessMapCanvasMode: jest.fn(),
    deleteProcessMap: jest.fn(),
    getProcessMap: jest.fn(),
    listProcessMaps: jest.fn(),
}));

function post(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function put(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('#2197 — the process-map routes still validate their body', () => {
    beforeEach(() => jest.clearAllMocks());

    it('PUT refuses a graph whose nodes are not an array, and does not reach the usecase', async () => {
        const { PUT } = await import('@/app/api/t/[tenantSlug]/processes/[id]/route');
        const res = await PUT(
            put('http://x/api/t/acme/processes/p1', { nodes: 'not-an-array', edges: [] }),
            { params: Promise.resolve({ tenantSlug: 'acme', id: 'p1' }) } as never,
        );
        expect(res.status).toBe(400);
        // The half that matters: unvalidated `nodes` would otherwise reach
        // `ProcessMapRepository.replaceGraph` unchecked.
        expect(saveProcessMap).not.toHaveBeenCalled();
    });

    it('PUT refuses a missing graph entirely', async () => {
        const { PUT } = await import('@/app/api/t/[tenantSlug]/processes/[id]/route');
        const res = await PUT(
            put('http://x/api/t/acme/processes/p1', { name: 'only a name' }),
            { params: Promise.resolve({ tenantSlug: 'acme', id: 'p1' }) } as never,
        );
        expect(res.status).toBe(400);
        expect(saveProcessMap).not.toHaveBeenCalled();
    });

    it('POST refuses an empty name — the schema says min(1)', async () => {
        const { POST } = await import('@/app/api/t/[tenantSlug]/processes/route');
        const res = await POST(
            post('http://x/api/t/acme/processes', { name: '' }),
            { params: Promise.resolve({ tenantSlug: 'acme' }) } as never,
        );
        expect(res.status).toBe(400);
        expect(createProcessMap).not.toHaveBeenCalled();
    });

    it('ACCEPTS a well-formed body — the refusals above are not a broken route', async () => {
        // Without this the three negatives are satisfied by a handler that
        // rejects everything, which would be a worse bug than the one guarded.
        const { PUT } = await import('@/app/api/t/[tenantSlug]/processes/[id]/route');
        const res = await PUT(
            put('http://x/api/t/acme/processes/p1', { nodes: [], edges: [] }),
            { params: Promise.resolve({ tenantSlug: 'acme', id: 'p1' }) } as never,
        );
        expect(res.status).toBe(200);
        expect(saveProcessMap).toHaveBeenCalled();
    });
});
