/**
 * The per-request raise of an API key's coarse tier (#5306 item 3, owner
 * decision 2026-11-14).
 *
 * An `admin:*` key's scope-derived tier is EDITOR, so it passed
 * `requirePermission('admin.manage')` on `POST /admin/api-keys` and was then
 * refused by the usecase's `assertCanAdmin`. The tier stays EDITOR as the key's
 * baseline; behind a granular gate it has PASSED, the request is raised to the
 * lowest built-in role holding that key. Asserted against the real route
 * handlers, the real `requirePermission` and the real policies:
 *
 *   1. an `admin:*` key passes `POST /admin/api-keys` end to end;
 *   2. the same key is still refused on the coarse-only `GET /audit-log/verify`;
 *   3. a session user's context reaches the handler unchanged;
 *   4. a key whose scopes do not grant the route's key is refused, unraised;
 *   5. a read-class grant (`admin:read` → `admin.view`) raises nothing, so a
 *      look-only key cannot pass the `assertCanWrite` behind an `admin.view`
 *      route such as a run's abort;
 *   6. an agent-bound key keeps the tier its principal narrowed it to;
 *   7. the raise is per request: the resolved context is never mutated.
 */
import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const auditSpy = jest.fn(async (_entry: unknown) => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => auditSpy(entry),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

/**
 * The usecase's own authority check is the real policy; only the database
 * write behind it is replaced, so a pass here is the policy passing.
 */
const createApiKeyMock = jest.fn();
jest.mock('@/app-layer/usecases/api-keys', () => ({
    listApiKeys: jest.fn(async () => []),
    createApiKey: (ctx: unknown, input: unknown) => createApiKeyMock(ctx, input),
}));

const verifyTenantChainMock = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/audit/verify', () => ({
    verifyTenantChain: (...a: unknown[]) => verifyTenantChainMock(...(a as [])),
}));

import { NextRequest } from 'next/server';

import { POST as createKeyRoute } from '@/app/api/t/[tenantSlug]/admin/api-keys/route';
import { GET as verifyChainRoute } from '@/app/api/t/[tenantSlug]/audit-log/verify/route';
import { assertCanManageMembers } from '@/app-layer/policies/admin.policies';
import { keyAuthorityFromScopes } from '@/lib/auth/api-key-auth';
import { lowestBuiltInRoleHolding, raiseApiKeyCoarseTier } from '@/lib/security/api-key-coarse-raise';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

type Route = (req: NextRequest, a: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;

/** A key context exactly as `finaliseApiKeyAuth` mints it for these scopes. */
function keyCtx(scopes: string[], extra: Partial<RequestContext> = {}): RequestContext {
    const { role, permissions, appPermissions } = keyAuthorityFromScopes(scopes);
    return {
        requestId: 'req-key',
        userId: 'creator-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions,
        appPermissions,
        apiKeyId: 'key-1',
        apiKeyScopes: scopes,
        apiKeyMaxAutonomy: null,
        ...extra,
    };
}

async function postCreateKey(ctx: RequestContext): Promise<Response> {
    getTenantCtxMock.mockResolvedValue(ctx);
    return (createKeyRoute as unknown as Route)(
        new NextRequest('http://localhost/api/t/acme/admin/api-keys', {
            method: 'POST',
            body: JSON.stringify({ name: 'ci', scopes: ['risks:read'] }),
            headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );
}

async function getVerify(ctx: RequestContext): Promise<Response> {
    getTenantCtxMock.mockResolvedValue(ctx);
    return (verifyChainRoute as unknown as Route)(
        new NextRequest('http://localhost/api/t/acme/audit-log/verify'),
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );
}

const permissionDenials = () =>
    auditSpy.mock.calls
        .map(([e]) => e as { action?: string; entity?: string })
        .filter((e) => e.action === 'AUTHZ_DENIED' && e.entity === 'Permission');

beforeEach(() => {
    jest.clearAllMocks();
    createApiKeyMock.mockImplementation(async (ctx: RequestContext) => {
        assertCanManageMembers(ctx);
        return { id: 'new-key', role: ctx.role };
    });
});

describe('the baseline the raise starts from', () => {
    it('an admin:* key still resolves to EDITOR from its scopes alone', () => {
        expect(keyAuthorityFromScopes(['admin:*']).role).toBe('EDITOR');
        expect(keyAuthorityFromScopes(['admin:write']).role).toBe('ADMIN');
    });

    it('the lowest built-in role holding admin.manage is ADMIN', () => {
        expect(lowestBuiltInRoleHolding(['admin.manage'], 'all')).toBe('ADMIN');
    });
});

describe('POST /admin/api-keys — admin.manage, then assertCanAdmin', () => {
    it('an admin:* key passes both gates', async () => {
        const res = await postCreateKey(keyCtx(['admin:*']));
        expect(res.status).toBe(201);
        expect(createApiKeyMock).toHaveBeenCalledTimes(1);
        const seen = createApiKeyMock.mock.calls[0][0] as RequestContext;
        expect(seen.role).toBe('ADMIN');
        expect(seen.permissions).toEqual({
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        });
        // The granular reach is the key's own, untouched.
        expect(seen.appPermissions).toEqual(keyAuthorityFromScopes(['admin:*']).appPermissions);
        expect(seen.apiKeyId).toBe('key-1');
        expect(permissionDenials()).toHaveLength(0);
    });

    it('a key whose scopes do not grant admin.manage is refused, and nothing is raised', async () => {
        const res = await postCreateKey(keyCtx(['risks:write', 'admin:read']));
        expect(res.status).toBe(403);
        expect(createApiKeyMock).not.toHaveBeenCalled();
        expect(permissionDenials()).toHaveLength(1);
    });

    it('a session user reaches the handler with the context it resolved to', async () => {
        // An EDITOR session whose granular set (say, a custom role) carries
        // admin.manage: the raise is for keys only, so the coarse check still
        // refuses it exactly as before.
        const session = makeRequestContext('EDITOR', {
            appPermissions: getPermissionsForRole('ADMIN'),
        });
        const res = await postCreateKey(session);
        expect(res.status).toBe(403);
        expect(createApiKeyMock).toHaveBeenCalledTimes(1);
        expect(createApiKeyMock.mock.calls[0][0]).toBe(session);
    });
});

describe('GET /audit-log/verify — a coarse-only route with no granular gate', () => {
    it('still refuses an admin:* key', async () => {
        const res = await getVerify(keyCtx(['admin:*']));
        expect(res.status).toBe(403);
        expect(verifyTenantChainMock).not.toHaveBeenCalled();
    });

    it('admits an admin:write key, whose baseline is already ADMIN', async () => {
        const res = await getVerify(keyCtx(['admin:write']));
        expect(res.status).toBe(200);
    });
});

describe('raiseApiKeyCoarseTier', () => {
    it('raises from a write-class grant the request passed', () => {
        const ctx = keyCtx(['admin:*']);
        const raised = raiseApiKeyCoarseTier(ctx, ['admin.manage'], 'all');
        expect(raised.role).toBe('ADMIN');
        expect(raised.permissions.canAdmin).toBe(true);
    });

    it('raises nothing from a read-class grant: admin:read on an admin.view route stays READER', () => {
        const ctx = keyCtx(['admin:read']);
        const raised = raiseApiKeyCoarseTier(ctx, ['admin.view', 'admin.agent_registry_view'], 'any');
        expect(raised).toBe(ctx);
        expect(raised.permissions.canWrite).toBe(false);
    });

    it('does not raise admin:* on its read-class admin.view grant either', () => {
        const ctx = keyCtx(['admin:*']);
        expect(raiseApiKeyCoarseTier(ctx, ['admin.view'], 'all')).toBe(ctx);
    });

    it('raises nothing for a key that did not pass', () => {
        const ctx = keyCtx(['risks:write']);
        expect(raiseApiKeyCoarseTier(ctx, ['admin.manage'], 'all')).toBe(ctx);
    });

    it('raises nothing in all-mode when one key was not passed', () => {
        const ctx = keyCtx(['admin:*']);
        expect(raiseApiKeyCoarseTier(ctx, ['admin.manage', 'incidents.manage'], 'all')).toBe(ctx);
    });

    it('never lowers: a key already at ADMIN is returned unchanged', () => {
        const ctx = keyCtx(['admin:write']);
        expect(raiseApiKeyCoarseTier(ctx, ['admin.manage'], 'all')).toBe(ctx);
    });

    it('a READER-baseline admin-class scope is raised on its own key', () => {
        const ctx = keyCtx(['incidents:admin']);
        expect(ctx.role).toBe('READER');
        const raised = raiseApiKeyCoarseTier(ctx, ['incidents.manage'], 'all');
        expect(raised.role).toBe('ADMIN');
    });

    it('leaves a session context untouched', () => {
        const session = makeRequestContext('EDITOR', { appPermissions: getPermissionsForRole('ADMIN') });
        expect(raiseApiKeyCoarseTier(session, ['admin.manage'], 'all')).toBe(session);
    });

    it('leaves an agent-bound key at the tier its principal narrowed it to', () => {
        const ctx = keyCtx(['admin:*'], { agentId: 'agent-1' });
        expect(raiseApiKeyCoarseTier(ctx, ['admin.manage'], 'all')).toBe(ctx);
    });

    it('is per request: the resolved context is not mutated', () => {
        const ctx = keyCtx(['admin:*']);
        const snapshot = JSON.parse(JSON.stringify(ctx));
        const raised = raiseApiKeyCoarseTier(ctx, ['admin.manage'], 'all');
        expect(raised).not.toBe(ctx);
        expect(JSON.parse(JSON.stringify(ctx))).toEqual(snapshot);
    });
});
