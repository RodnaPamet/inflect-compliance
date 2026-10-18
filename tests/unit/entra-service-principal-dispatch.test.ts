/**
 * #3671 — the usecase behind the service-principal endpoint.
 *
 * It refuses on configuration and on the principal's own facts, never on who
 * is asking, and it READS before it WRITES: every refusal below asserts the
 * PATCH was never called, because a refusal computed after the request is a
 * refusal that already leaked.
 */
const resolveMock = jest.fn();
jest.mock('@/app-layer/usecases/entra-grant-dispatch', () => ({
    ...jest.requireActual('@/app-layer/usecases/entra-grant-dispatch'),
    resolveEntraEntitlementConnection: (...a: unknown[]) => resolveMock(...a),
}));

const readSpMock = jest.fn();
const disableSpMock = jest.fn();
jest.mock('@/app-layer/integrations/providers/entra-id/service-principal', () => ({
    ...jest.requireActual('@/app-layer/integrations/providers/entra-id/service-principal'),
    createEntraServicePrincipalClient: () => ({
        readServicePrincipal: (id: string) => readSpMock(id),
        disableServicePrincipal: (id: string) => disableSpMock(id),
    }),
}));

const findFirstMock = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ integrationConnection: { findFirst: findFirstMock } }),
    ),
}));

import {
    describeServicePrincipalConnectionRefusal,
    disableServicePrincipal,
    endpointBindingRefusal,
    readServicePrincipalState,
} from '@/app-layer/usecases/entra-service-principal-dispatch';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-A' });
const SP = '9f1c2b7e-4a3d-4c1e-8b2f-6d5e4c3b2a19';
const CLIENT = '0a1b2c3d-1111-2222-3333-444455556666';

const enabled = {
    id: SP,
    appId: 'ffffffff-1111-2222-3333-444455556666',
    displayName: 'billing-agent',
    accountEnabled: true,
    servicePrincipalType: 'Application',
    appOwnerOrganizationId: '5c459bc6-0000-4000-8000-000000000001',
};

beforeEach(() => {
    jest.clearAllMocks();
    resolveMock.mockResolvedValue({
        state: 'ok',
        connection: { tenantId: 't', clientId: CLIENT, clientSecret: 's' },
    });
    readSpMock.mockResolvedValue(enabled);
    disableSpMock.mockResolvedValue(undefined);
});

describe('disableServicePrincipal', () => {
    it('reads, then disables an enabled customer principal', async () => {
        await expect(disableServicePrincipal(ctx, { servicePrincipalId: SP })).resolves.toEqual({ ok: true });
        expect(readSpMock).toHaveBeenCalledWith(SP);
        expect(disableSpMock).toHaveBeenCalledWith(SP);
        expect(readSpMock.mock.invocationCallOrder[0]).toBeLessThan(
            disableSpMock.mock.invocationCallOrder[0],
        );
    });

    it.each([
        ['already disabled', { ...enabled, accountEnabled: false }, 'already disabled'],
        ['the connection\'s own principal', { ...enabled, appId: CLIENT }, 'authenticates as'],
        [
            'a Microsoft first-party principal',
            { ...enabled, appOwnerOrganizationId: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a' },
            'first-party',
        ],
    ])('refuses %s IN-BAND and sends no PATCH', async (_label, state, sentence) => {
        readSpMock.mockResolvedValue(state);
        const out = await disableServicePrincipal(ctx, { servicePrincipalId: SP });
        expect(out.ok).toBe(false);
        expect(out.ok === false ? out.refused : '').toContain(sentence);
        expect(disableSpMock).not.toHaveBeenCalled();
    });

    it('refuses a principal the directory does not hold, and sends no PATCH', async () => {
        readSpMock.mockResolvedValue(null);
        const out = await disableServicePrincipal(ctx, { servicePrincipalId: SP });
        expect(out.ok === false && out.refused).toMatch(/no service principal with that id/);
        expect(disableSpMock).not.toHaveBeenCalled();
    });

    it('refuses a malformed id before resolving a connection — no database, no key material', async () => {
        const out = await disableServicePrincipal(ctx, { servicePrincipalId: 'not-a-guid' });
        expect(out.ok === false && out.refused).toMatch(/directory object id/);
        expect(resolveMock).not.toHaveBeenCalled();
        expect(readSpMock).not.toHaveBeenCalled();
    });

    it.each([
        [{ kind: 'no_connection' }, 'No enabled Entra ID connection'],
        [{ kind: 'ambiguous', count: 2 }, '2 enabled Entra ID connections'],
        [{ kind: 'secret_unavailable', detail: 'x' }, 'could not be decrypted'],
        [{ kind: 'incomplete_config', missing: ['clientSecret'] }, 'missing clientSecret'],
    ])('a connection refusal (%o) is its own sentence and sends nothing', async (refusal, sentence) => {
        resolveMock.mockResolvedValue({ state: 'refused', refusal });
        const out = await disableServicePrincipal(ctx, { servicePrincipalId: SP });
        expect(out.ok === false ? out.refused : '').toContain(sentence);
        expect(readSpMock).not.toHaveBeenCalled();
        expect(disableSpMock).not.toHaveBeenCalled();
    });

    it('a Graph failure on the PATCH THROWS — the dispatch settles that INDETERMINATE, not FAILED', async () => {
        disableSpMock.mockRejectedValue(new Error('Entra service principal disable failed (503)'));
        await expect(disableServicePrincipal(ctx, { servicePrincipalId: SP })).rejects.toThrow(/503/);
    });

    it('the connection refusal sentences never speak of assigning access', () => {
        // The resolution is shared with the grant; its copy is not.
        const s = describeServicePrincipalConnectionRefusal({ kind: 'no_connection' });
        expect(s).toContain('service principal');
        expect(s).not.toContain('assign access');
    });
});

describe('readServicePrincipalState', () => {
    it('answers the principal', async () => {
        await expect(readServicePrincipalState(ctx, { servicePrincipalId: SP })).resolves.toEqual({
            ok: true,
            servicePrincipal: enabled,
        });
        expect(disableSpMock).not.toHaveBeenCalled();
    });

    it('refuses in-band when the directory holds no such principal', async () => {
        readSpMock.mockResolvedValue(null);
        const out = await readServicePrincipalState(ctx, { servicePrincipalId: SP });
        expect(out.ok).toBe(false);
    });
});

describe('endpointBindingRefusal — one connection per endpoint', () => {
    it.each([
        'https://app.example.test/api/mcp/entra-service-principal',
        'https://app.example.test/api/mcp/entra-service-principal/',
    ])('accepts a connection configured for this endpoint (%s)', async (url) => {
        findFirstMock.mockResolvedValue({ configJson: { url } });
        await expect(endpointBindingRefusal(ctx, 'conn-1')).resolves.toBeNull();
    });

    it.each([
        ['the grant endpoint', { url: 'https://app.example.test/api/mcp/entra-grant' }],
        ['a lookalike path', { url: 'https://app.example.test/api/mcp/entra-service-principal-x' }],
        ['no URL', {}],
        ['an unparseable URL', { url: 'not a url' }],
    ])('refuses a connection configured for %s', async (_label, configJson) => {
        findFirstMock.mockResolvedValue({ configJson });
        await expect(endpointBindingRefusal(ctx, 'conn-1')).resolves.toMatch(/not configured to call/);
    });

    it('refuses a connection it cannot find in this tenant', async () => {
        findFirstMock.mockResolvedValue(null);
        await expect(endpointBindingRefusal(ctx, 'conn-1')).resolves.toMatch(/not configured to call/);
    });
});
