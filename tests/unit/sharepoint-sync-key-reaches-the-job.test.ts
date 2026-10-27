/**
 * The API key a "Sync now" request was made with reaches the job (#4386).
 *
 * The route checks the key — `requirePermission('evidence.upload')` resolves a
 * context from it — and then queued a payload naming only `actorUserId`. The
 * worker rebuilt that user's whole membership, so a key scoped to
 * `evidence:read` had the sync re-import evidence because its CREATOR could,
 * and a key revoked while the job sat in the queue did not stop it.
 *
 * The worker's half is in `sharepoint-delta-sync-initiator-custom-role`. This
 * is the other half, and the one that cannot be seen from there: whether the
 * route hands the job the id at all. Mirrors
 * `evidence-import-metadata-reaches-job`, the same seam for #4369.
 */
// Typed with the parameters the route passes, so `calls[0][1]` below is the
// payload and not an element of an empty tuple.
const enqueueMock = jest.fn(
    async (_name: string, _payload: Record<string, unknown>, _opts?: unknown) => ({ id: 'job-1' }),
);
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (name: string, payload: Record<string, unknown>, opts?: unknown) =>
        enqueueMock(name, payload, opts),
}));

/** The context the permission middleware resolves — session or key. */
let currentCtx: Record<string, unknown> = {};
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (_key: string, handler: (req: unknown, routeArgs: unknown, ctx: unknown) => unknown) =>
        (req: unknown, routeArgs: unknown) =>
            handler(req, routeArgs, currentCtx),
}));

jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (fn: (...a: unknown[]) => unknown) => fn,
}));

jest.mock('@/lib/api-response', () => ({
    jsonResponse: (body: unknown, init?: unknown) => ({ body, init }),
}));

import { POST } from '@/app/api/t/[tenantSlug]/integrations/sharepoint/sync/route';

const SESSION_CTX = {
    tenantId: 'tenant-A',
    userId: 'u1',
    requestId: 'req-1',
};

const request = () =>
    ({ json: async () => ({ connectionId: 'conn-1' }) }) as unknown as Request;

const enqueuedPayload = () => enqueueMock.mock.calls[0][1];

beforeEach(() => {
    jest.clearAllMocks();
    currentCtx = { ...SESSION_CTX };
});

describe('the "Sync now" route hands the job the key it was called with', () => {
    it('carries the key id of a key-authenticated request, so the worker acts as the key', async () => {
        currentCtx = { ...SESSION_CTX, apiKeyId: 'key-1', apiKeyScopes: ['evidence:write'] };

        await POST(request() as never, { params: Promise.resolve({ tenantSlug: 'acme' }) } as never);

        expect(enqueuedPayload()).toMatchObject({
            tenantId: 'tenant-A',
            connectionId: 'conn-1',
            actorUserId: 'u1',
            apiKeyId: 'key-1',
            triggeredBy: 'manual',
        });
    });

    it('carries no key id for a session request, so the payload is the one it always was', async () => {
        await POST(request() as never, { params: Promise.resolve({ tenantSlug: 'acme' }) } as never);

        expect(enqueuedPayload()).not.toHaveProperty('apiKeyId');
        expect(enqueuedPayload()).toMatchObject({ actorUserId: 'u1', triggeredBy: 'manual' });
    });
});
