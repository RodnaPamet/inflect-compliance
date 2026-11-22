/**
 * #3671 — the Graph client for one service principal, and the refusals that
 * stop a disable before it is sent.
 *
 * Three properties carry the weight:
 *
 *   1. THE WRITE CHANGES ONE FIELD. The PATCH body is exactly
 *      `{ accountEnabled: false }` — a disable that also cleared credentials or
 *      owners would be a larger, irreversible act wearing this one's name.
 *   2. A REFUSED DISABLE SENDS NOTHING. `disableRefusal` is pure and runs
 *      before any request; the fetch double counts calls, and a bad id refuses
 *      with zero Graph requests made.
 *   3. THE CONNECTION'S OWN PRINCIPAL IS REFUSED. `writer.ts` explains why the
 *      user-disable writer's self-account rail is cosmetic for an app-only
 *      credential; for a principal disable it is not, and this is the test that
 *      says so.
 */
import {
    createEntraServicePrincipalClient,
    disableRefusal,
    MICROSOFT_FIRST_PARTY_TENANT_IDS,
    type ServicePrincipalState,
} from '@/app-layer/integrations/providers/entra-id/service-principal';
import { IntegrationTerminalError } from '@/app-layer/integrations/http-resilience';

const SP = '9f1c2b7e-4a3d-4c1e-8b2f-6d5e4c3b2a19';
const CLIENT = '0a1b2c3d-1111-2222-3333-444455556666';
const CONNECTION = {
    tenantId: '5c459bc6-0000-4000-8000-000000000001',
    clientId: CLIENT,
    clientSecret: 'secret-value',
};

const state = (over: Partial<ServicePrincipalState> = {}): ServicePrincipalState => ({
    id: SP,
    appId: 'ffffffff-1111-2222-3333-444455556666',
    displayName: 'billing-agent',
    accountEnabled: true,
    servicePrincipalType: 'Application',
    appOwnerOrganizationId: CONNECTION.tenantId,
    ...over,
});

/**
 * A double that fails the way the REAL transport fails (#5311).
 *
 * `recordingFetch` below RETURNS whatever status it is given. `resilientFetch`
 * does not: it classifies 404 as terminal (`TERMINAL_STATUS`) and THROWS
 * `IntegrationTerminalError` before the caller sees a response. So a test built
 * on the forgiving double certifies a path production never takes — which is
 * exactly how the 404 handling here stayed broken while a green test said
 * otherwise.
 */
function throwingFetch(status: number) {
    const impl = (async (url: unknown) => {
        const u = String(url);
        if (u.includes('/oauth2/v2.0/token')) {
            return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        throw new IntegrationTerminalError(status, u);
    }) as unknown as typeof fetch;
    return impl;
}

function recordingFetch(reply: { status: number; body?: unknown }) {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/oauth2/v2.0/token')) {
            return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        calls.push({
            url: u,
            method: String(init?.method ?? 'GET'),
            body: typeof init?.body === 'string' ? init.body : null,
        });
        if (reply.status === 204) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(reply.body ?? {}), {
            status: reply.status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

describe('disableRefusal — every case is decided before a request exists', () => {
    it('admits an enabled, customer-owned principal that is not the connection itself', () => {
        expect(disableRefusal(state(), { clientId: CLIENT })).toBeNull();
    });

    it('refuses a principal that is already disabled, because nothing would change', () => {
        expect(disableRefusal(state({ accountEnabled: false }), { clientId: CLIENT })).toMatch(
            /already disabled/,
        );
    });

    it('refuses when the directory did not say whether it is enabled — absence is not false', () => {
        expect(disableRefusal(state({ accountEnabled: null }), { clientId: CLIENT })).toMatch(
            /did not report whether/,
        );
    });

    it('refuses the principal this connection authenticates as, across case', () => {
        const self = state({ appId: CLIENT.toUpperCase() });
        expect(disableRefusal(self, { clientId: CLIENT })).toMatch(/authenticates as/);
    });

    it.each([...MICROSOFT_FIRST_PARTY_TENANT_IDS])(
        'refuses a Microsoft first-party principal owned by %s',
        (owner) => {
            expect(
                disableRefusal(state({ appOwnerOrganizationId: owner.toUpperCase() }), {
                    clientId: CLIENT,
                }),
            ).toMatch(/first-party/);
        },
    );

    it('admits a THIRD-PARTY vendor principal — an agent supplied by a vendor is still an agent', () => {
        const vendor = state({ appOwnerOrganizationId: '11111111-2222-4333-8444-555555555555' });
        expect(disableRefusal(vendor, { clientId: CLIENT })).toBeNull();
    });
});

describe('readServicePrincipal', () => {
    it('reads a closed $select by object id and maps every field', async () => {
        const f = recordingFetch({
            status: 200,
            body: {
                id: SP.toUpperCase(),
                appId: 'ffffffff-1111-2222-3333-444455556666',
                displayName: 'billing-agent',
                accountEnabled: true,
                servicePrincipalType: 'Application',
                appOwnerOrganizationId: CONNECTION.tenantId,
            },
        });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        const got = await client.readServicePrincipal(SP);
        expect(got).toEqual(state());
        expect(f.calls).toHaveLength(1);
        const url = new URL(f.calls[0].url);
        expect(url.hostname).toBe('graph.microsoft.com');
        expect(url.pathname).toBe(`/v1.0/servicePrincipals/${SP}`);
        expect(url.searchParams.get('$select')).toBe(
            'id,appId,displayName,accountEnabled,servicePrincipalType,appOwnerOrganizationId',
        );
        expect(f.calls[0].method).toBe('GET');
    });

    it('answers null on a RETURNED 404 — the injected-transport case', async () => {
        // Kept, but it is not the production path: this double returns the
        // status, and `resilientFetch` throws it. The test below is the one
        // that covers what actually happens. (#5311)
        const f = recordingFetch({ status: 404, body: { error: { code: 'Request_ResourceNotFound' } } });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        expect(await client.readServicePrincipal(SP)).toBeNull();
    });

    it('answers null on a THROWN terminal 404 — what resilientFetch actually does (#5311)', async () => {
        // The real transport classifies 404 as terminal and throws before this
        // function sees a response, so the status check alone was unreachable
        // in production. A principal deleted from Entra — the ordinary state for
        // an orphaned agent — therefore propagated a throw instead of the null
        // this function is declared to return, and the external-write dispatch
        // settled an INDETERMINATE row for a human rather than taking the
        // NOT_FOUND refusal that exists for it.
        const client = createEntraServicePrincipalClient({
            connection: CONNECTION,
            doFetch: throwingFetch(404),
        });
        expect(await client.readServicePrincipal(SP)).toBeNull();
    });

    it('does NOT swallow a thrown terminal status that is not 404', async () => {
        // The other side: 403 is the classifier's auth verdict and must keep
        // propagating. Returning null for it would report "no such principal"
        // for a permission problem — a wrong fact, and one that would make the
        // orphan pass silently skip a principal it cannot read.
        const client = createEntraServicePrincipalClient({
            connection: CONNECTION,
            doFetch: throwingFetch(403),
        });
        await expect(client.readServicePrincipal(SP)).rejects.toThrow(/terminally \(403\)/);
    });

    it('maps a missing accountEnabled to null, never to false', async () => {
        const f = recordingFetch({ status: 200, body: { id: SP } });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        expect((await client.readServicePrincipal(SP))?.accountEnabled).toBeNull();
    });

    it('throws on any other failure, quoting the Graph code and never the message', async () => {
        const f = recordingFetch({
            status: 403,
            body: { error: { code: 'Authorization_RequestDenied', message: `no access to ${SP}` } },
        });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        const err = await client.readServicePrincipal(SP).then(
            () => null,
            (e: Error) => e,
        );
        expect(err?.message).toContain('Authorization_RequestDenied');
        expect(err?.message).not.toContain(SP);
    });
});

describe('disableServicePrincipal', () => {
    it('PATCHes exactly accountEnabled:false on the principal, and nothing else', async () => {
        const f = recordingFetch({ status: 204 });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        await client.disableServicePrincipal(SP);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].method).toBe('PATCH');
        expect(new URL(f.calls[0].url).pathname).toBe(`/v1.0/servicePrincipals/${SP}`);
        expect(JSON.parse(f.calls[0].body ?? 'null')).toEqual({ accountEnabled: false });
    });

    it('refuses an id that is not a GUID and sends NOTHING — it is spliced into a path', async () => {
        const f = recordingFetch({ status: 204 });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        await expect(client.disableServicePrincipal('../users/someone')).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
    });

    it('throws on a refused PATCH so the dispatch can settle it INDETERMINATE, not FAILED', async () => {
        const f = recordingFetch({ status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
        const client = createEntraServicePrincipalClient({ connection: CONNECTION, doFetch: f.impl });
        await expect(client.disableServicePrincipal(SP)).rejects.toThrow(/Authorization_RequestDenied/);
    });
});
