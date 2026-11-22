/**
 * The Entra provisioner sends a write ONCE (#5097).
 *
 * It defaulted every call, `POST /users` included, to the retrying
 * `resilientFetch`. A 5xx on the create was retried: the first attempt may
 * already have made the account, the second came back "already exists", and
 * the create was reported REFUSED while an account stood in the customer's
 * directory, with nothing pointing at it.
 *
 * Writes now go through the bounded, non-retrying transport and a lost answer
 * is INDETERMINATE; reads keep the retrying one. Both transports are mocked
 * here so the test holds which one each kind of call reaches.
 */
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/providers/entra-id/index', () => ({
    getEntraAccessToken: jest.fn(async () => 'token-abc'),
}));

const mockResilient = jest.fn();
const mockBounded = jest.fn();
jest.mock('@/app-layer/integrations/http-resilience', () => ({
    ...jest.requireActual('@/app-layer/integrations/http-resilience'),
    resilientFetch: (...a: unknown[]) => mockResilient(...a),
}));
jest.mock('@/app-layer/integrations/bounded-fetch', () => ({
    ...jest.requireActual('@/app-layer/integrations/bounded-fetch'),
    createBoundedFetch: () => (...a: unknown[]) => mockBounded(...a),
}));

import { createEntraIdProvisioner } from '@/app-layer/integrations/providers/entra-id/provisioner';

const OPTED_IN = { tenantId: 't-1', clientId: 'c-1', clientSecret: 's-1', joinerWritesEnabled: true };

function reply(status: number, body?: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as unknown as Response;
}

beforeEach(() => {
    jest.clearAllMocks();
    // The Temporary Access Pass preflight is a READ.
    mockResilient.mockResolvedValue(reply(200, { id: 'TemporaryAccessPass', state: 'enabled' }));
});

it('sends POST /users through the bounded transport, never the retrying one', async () => {
    mockBounded.mockResolvedValue(reply(201, { id: 'new-1' }));
    const p = createEntraIdProvisioner({ connection: OPTED_IN });

    const r = await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });

    expect(r.kind).toBe('applied');
    expect(mockBounded).toHaveBeenCalledTimes(1);
    expect(mockBounded.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    for (const [, init] of mockResilient.mock.calls) {
        expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
});

it('reports a create whose answer was lost as INDETERMINATE, not REFUSED', async () => {
    mockBounded.mockRejectedValue(new Error('timed out after 30000ms'));
    const p = createEntraIdProvisioner({ connection: OPTED_IN });

    const r = await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });

    expect(r.kind).toBe('indeterminate');
    expect(mockBounded).toHaveBeenCalledTimes(1);
});

it('reports a lost group add and a lost credential as INDETERMINATE too', async () => {
    mockBounded.mockRejectedValue(new Error('socket hang up'));
    const p = createEntraIdProvisioner({ connection: OPTED_IN });
    const ID = '00000000-0000-4000-8000-00000000000a';

    expect((await p.assignGroup(ID, 'group-1')).kind).toBe('indeterminate');
    expect((await p.issueCredential(ID)).kind).toBe('indeterminate');
});
