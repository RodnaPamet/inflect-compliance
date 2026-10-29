/**
 * The connect wizard's mint is the api-keys route, with its gate and its limit
 * (Step 3a, #4155).
 *
 * The wizard adds no minting path. It POSTs to `/admin/api-keys`, the route the
 * api-keys page uses, so the request it builds must pass exactly what that page's
 * request passes. Driven through the REAL route handler with the body the wizard
 * builds (`connectKeyScopes` over a set of grants):
 *
 *   • a holder of `admin.manage` reaches `createApiKey` with that body,
 *     unchanged: the agent binding, the ceiling and the grants' scopes;
 *   • a person without it is refused 403, with the `AUTHZ_DENIED` row
 *     `requirePermission` writes, and `createApiKey` is never called;
 *   • the sixth mint in the window is refused 429: `API_KEY_CREATE_LIMIT`, the
 *     key-creation budget, not the default mutation budget.
 */
import { NextRequest } from 'next/server';
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

const createApiKeyMock = jest.fn();
jest.mock('@/app-layer/usecases/api-keys', () => ({
    createApiKey: (...a: unknown[]) => createApiKeyMock(...a),
    listApiKeys: jest.fn(),
}));

const auditMock = jest.fn(async (..._a: unknown[]) => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
// Strict, so an audit export the route reaches that this fixture forgot fails
// loudly rather than resolving to undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...a: unknown[]) => auditMock(...a),
        appendAuditEntry: (...a: unknown[]) => auditMock(...a),
    }),
);

import { POST } from '@/app/api/t/[tenantSlug]/admin/api-keys/route';
import { connectKeyScopes } from '@/lib/agentic/connect-wizard';
import { API_KEY_CREATE_LIMIT, clearAllRateLimits } from '@/lib/security/rate-limit';
import { makeRequestContext } from '../helpers/make-context';

type RoutePost = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;
const post = POST as unknown as RoutePost;

/** The body the wizard sends for an agent at L2 granted these tools. */
const WIZARD_BODY = {
    name: 'Risk reviewer connector',
    scopes: connectKeyScopes(['list_risks', 'propose_risks']),
    expiresAt: null,
    agentId: 'agent-1',
    maxAutonomyLevel: 2,
};

const mint = () =>
    post(
        new NextRequest('https://app.example.io/api/t/acme/admin/api-keys', {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(WIZARD_BODY),
        }),
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );

beforeEach(() => {
    getTenantCtxMock.mockReset().mockResolvedValue(makeRequestContext('ADMIN', { tenantSlug: 'acme' }));
    createApiKeyMock.mockReset().mockResolvedValue({ id: 'key-1', plaintext: 'iflk_x' });
    auditMock.mockClear();
});

describe('the wizard\'s mint, through the api-keys route', () => {
    it('reaches createApiKey with the wizard\'s body, unchanged', async () => {
        const res = await mint();
        expect(res.status).toBe(201);
        expect(createApiKeyMock).toHaveBeenCalledTimes(1);
        expect(createApiKeyMock.mock.calls[0][1]).toEqual(WIZARD_BODY);
        expect(WIZARD_BODY.scopes).toEqual(['mcp:propose', 'mcp:read', 'risks:read']);
    });

    it('is refused without admin.manage, with an AUTHZ_DENIED row, and mints nothing', async () => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext('EDITOR', { tenantSlug: 'acme' }));
        const res = await mint();
        expect(res.status).toBe(403);
        expect(createApiKeyMock).not.toHaveBeenCalled();
        expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTHZ_DENIED' }));
    });
});

describe('the key-creation budget', () => {
    const ORIGINAL = process.env.RATE_LIMIT_ENABLED;
    beforeEach(() => {
        process.env.RATE_LIMIT_ENABLED = '1';
        clearAllRateLimits();
    });
    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.RATE_LIMIT_ENABLED;
        else process.env.RATE_LIMIT_ENABLED = ORIGINAL;
        clearAllRateLimits();
    });

    it('refuses the mint after API_KEY_CREATE_LIMIT, not the default mutation budget', async () => {
        for (let i = 0; i < API_KEY_CREATE_LIMIT.maxAttempts; i++) {
            expect((await mint()).status).toBe(201);
        }
        expect((await mint()).status).toBe(429);
        expect(createApiKeyMock).toHaveBeenCalledTimes(API_KEY_CREATE_LIMIT.maxAttempts);
    });
});
