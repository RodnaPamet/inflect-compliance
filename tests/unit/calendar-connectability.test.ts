/**
 * #5937 step 4 — whether each calendar provider can be connected, read by the
 * Connect control from `GET /calendar/connections` and enforced by
 * `POST /calendar/connect` with the SAME rule.
 *
 * Each reason is driven through both routes: the read reports it, and the
 * connect refuses with it (`details.reason`), so the page can never offer a
 * button the server would refuse. The connection's own state — a person's
 * disconnect told apart from a refused token — is the server's to decide too.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling:
        (handler: (req: unknown, route: unknown) => Promise<Response>) => async (req: unknown, route: unknown) => {
            try {
                return await handler(req, route);
            } catch (err) {
                const { toApiErrorResponse } = jest.requireActual('@/lib/errors/types');
                const { payload, status } = toApiErrorResponse(err, 'req-1');
                return Response.json(payload, { status });
            }
        },
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requireAnyPermission:
        (_keys: unknown, handler: (req: unknown, route: unknown, ctx: unknown) => unknown) =>
        (req: unknown, route: unknown) =>
            handler(req, route, { tenantId: 't1', userId: 'u1', requestId: 'r1' }),
}));

type Consent = { provider: string; granted: boolean; revokedAt: Date | null; externalTenantId: string | null };
let consents: Consent[] = [];
const getConsentStates = jest.fn(async () => consents);
jest.mock('@/app-layer/usecases/tenant-calendar-consent', () => ({
    getConsentStates: (...a: unknown[]) => getConsentStates(...(a as [])),
    requiresAdminConsent: (p: string) => p === 'outlook-calendar',
}));

let connections: Array<Record<string, unknown>> = [];
jest.mock('@/app-layer/usecases/user-calendar-connection', () => ({
    ...jest.requireActual('@/app-layer/usecases/user-calendar-connection'),
    listCalendarConnections: async () => connections,
}));
jest.mock('@/app-layer/usecases/calendar-push-person', () => ({
    DISCONNECTED_REASON: 'disconnected by user',
    DISCONNECTED_WITH_REMAINDER_REASON: 'disconnected by user; some events could not be removed from the calendar',
    disconnectCalendar: jest.fn(),
}));

import { GET } from '@/app/api/t/[tenantSlug]/calendar/connections/route';
import { POST as CONNECT } from '@/app/api/t/[tenantSlug]/calendar/connect/route';
import { CALENDAR_CONNECT_OUTCOMES, CALENDAR_PROVIDERS } from '@/app-layer/usecases/user-calendar-connection';
import {
    CALENDAR_CONNECT_REFUSALS,
    CALENDAR_CONNECTION_STATES,
} from '@/app-layer/usecases/calendar-connectability';
import {
    OUTCOME_COPY,
    PROVIDER_NAME_KEY,
    REFUSAL_KEY,
    STATE_LABEL_KEY,
} from '@/app/t/[tenantSlug]/(app)/calendar/_components/connect/connect-copy';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const GRANTED: Consent = { provider: 'outlook-calendar', granted: true, revokedAt: null, externalTenantId: 'contoso-tid' };

beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    consents = [GRANTED];
    connections = [];
    getConsentStates.mockClear();
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

async function read(): Promise<{
    connections: Array<Record<string, unknown>>;
    providers: Array<{ provider: string; connectable: boolean; refusal: string | null }>;
}> {
    const res = await (GET as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
        new NextRequest('http://app.test/api/t/acme/calendar/connections'),
        { params: Promise.resolve({ tenantSlug: 'acme' }) },
    );
    expect(res.status).toBe(200);
    return res.json();
}

async function connect(provider: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await (CONNECT as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(
        new NextRequest(`http://app.test/api/t/acme/calendar/connect?provider=${provider}`, { method: 'POST' }),
        { params: { tenantSlug: 'acme' } },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const providerOf = (body: Awaited<ReturnType<typeof read>>, p: string) => body.providers.find((x) => x.provider === p);
const reasonOf = (body: Record<string, unknown>) =>
    ((body.error as { details?: { reason?: string } } | undefined)?.details?.reason) ?? null;

describe('the read reports every provider, connectable when nothing stands in the way', () => {
    it('both providers, in CALENDAR_PROVIDERS order, connectable with the consent granted', async () => {
        const body = await read();
        expect(body.providers).toEqual(
            CALENDAR_PROVIDERS.map((provider) => ({ provider, connectable: true, refusal: null })),
        );
        const res = await connect('outlook-calendar');
        expect(res.status).toBe(200);
        // Sent to the directory the organisation consent was granted in.
        expect(String(res.body.authorizeUrl)).toContain('/contoso-tid/');
    });
});

describe('NOT_CONFIGURED — this deployment has no OAuth client for the provider', () => {
    it.each([
        ['google-calendar', 'GOOGLE_CLIENT_ID', ''],
        ['google-calendar', 'GOOGLE_CLIENT_SECRET', '   '],
        ['google-calendar', 'GOOGLE_CLIENT_ID', 'your-google-client-id'],
        ['outlook-calendar', 'MICROSOFT_CLIENT_ID', 'REPLACE_ME_MICROSOFT_CLIENT_ID'],
        ['outlook-calendar', 'MICROSOFT_CLIENT_SECRET', ''],
    ] as const)('%s with %s = %p', async (provider, key, value) => {
        process.env[key] = value;
        const body = await read();
        expect(providerOf(body, provider)).toEqual({ provider, connectable: false, refusal: 'NOT_CONFIGURED' });
        // The other provider is not affected.
        const other = CALENDAR_PROVIDERS.find((p) => p !== provider)!;
        expect(providerOf(body, other)?.connectable).toBe(true);

        const res = await connect(provider);
        expect(res.status).toBe(409);
        expect(reasonOf(res.body)).toBe('NOT_CONFIGURED');
        expect(res.body.authorizeUrl).toBeUndefined();
    });

    it('is asked before the consent: an unconfigured Outlook reads no consent at all', async () => {
        process.env.MICROSOFT_CLIENT_ID = '';
        consents = [];
        const body = await read();
        expect(providerOf(body, 'outlook-calendar')?.refusal).toBe('NOT_CONFIGURED');
        expect(getConsentStates).not.toHaveBeenCalled();
    });
});

describe('Microsoft without the organisation consent', () => {
    it('ADMIN_CONSENT_NOT_GRANTED when nobody has authorised it', async () => {
        consents = [{ provider: 'outlook-calendar', granted: false, revokedAt: null, externalTenantId: null }];
        const body = await read();
        expect(providerOf(body, 'outlook-calendar')).toEqual({
            provider: 'outlook-calendar',
            connectable: false,
            refusal: 'ADMIN_CONSENT_NOT_GRANTED',
        });
        const res = await connect('outlook-calendar');
        expect(res.status).toBe(403);
        expect(reasonOf(res.body)).toBe('ADMIN_CONSENT_NOT_GRANTED');
    });

    it('ADMIN_CONSENT_WITHDRAWN when it was authorised and then withdrawn', async () => {
        consents = [{ provider: 'outlook-calendar', granted: false, revokedAt: new Date(), externalTenantId: 'x' }];
        const body = await read();
        expect(providerOf(body, 'outlook-calendar')?.refusal).toBe('ADMIN_CONSENT_WITHDRAWN');
        const res = await connect('outlook-calendar');
        expect(res.status).toBe(403);
        expect(reasonOf(res.body)).toBe('ADMIN_CONSENT_WITHDRAWN');
    });

    it('Google is never held by Microsoft\'s consent', async () => {
        consents = [];
        const body = await read();
        expect(providerOf(body, 'google-calendar')).toEqual({ provider: 'google-calendar', connectable: true, refusal: null });
        expect((await connect('google-calendar')).status).toBe(200);
    });
});

describe('each connection carries the state the control words', () => {
    const base = {
        id: 'c1',
        provider: 'google-calendar',
        connectedAt: new Date('2026-11-01'),
        revokedAt: null,
        revokedReason: null,
        lastPushedAt: null,
        scopesGranted: [],
        disconnectRequestedAt: null,
        undeletedEventCount: 0,
    };

    it.each([
        ['live', 'CONNECTED', {}],
        ['a disconnect still removing events', 'DISCONNECTING', { disconnectRequestedAt: new Date() }],
        ['disconnected by the person', 'DISCONNECTED', { revokedAt: new Date(), revokedReason: 'disconnected by user' }],
        [
            'disconnected with events left behind',
            'DISCONNECTED',
            {
                revokedAt: new Date(),
                revokedReason: 'disconnected by user; some events could not be removed from the calendar',
                undeletedEventCount: 3,
            },
        ],
        [
            'a token the provider refused',
            'STOPPED',
            { revokedAt: new Date(), revokedReason: 'Access was withdrawn at the provider (HTTP 401). Reconnect to resume.' },
        ],
        ['revoked with no reason recorded', 'STOPPED', { revokedAt: new Date() }],
    ] as const)('%s → %s', async (_label, state, patch) => {
        connections = [{ ...base, ...patch }];
        const body = await read();
        expect(body.connections).toHaveLength(1);
        expect(body.connections[0].state).toBe(state);
        // Never a token, whatever the state.
        expect(JSON.stringify(body)).not.toMatch(/token/i);
    });
});

describe('the Connect control words every value the server can send', () => {
    // `satisfies Record<…>` in connect-copy.ts holds the types; this holds the
    // runtime sets equal, and every key worded in both languages.
    const lookup = (catalogue: Record<string, unknown>, key: string) =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            catalogue.calendarConnect,
        );

    it('the same sets as the server', () => {
        expect(Object.keys(OUTCOME_COPY).sort()).toEqual([...CALENDAR_CONNECT_OUTCOMES].sort());
        expect(Object.keys(REFUSAL_KEY).sort()).toEqual([...CALENDAR_CONNECT_REFUSALS].sort());
        expect(Object.keys(STATE_LABEL_KEY).sort()).toEqual([...CALENDAR_CONNECTION_STATES].sort());
        expect(Object.keys(PROVIDER_NAME_KEY).sort()).toEqual([...CALENDAR_PROVIDERS].sort());
    });

    it.each([
        ['en', en],
        ['bg', bg],
    ] as const)('every key resolves in %s', (_lang, catalogue) => {
        const keys = [
            ...Object.values(OUTCOME_COPY).map((c) => c.key),
            ...Object.values(REFUSAL_KEY),
            ...Object.values(STATE_LABEL_KEY),
            ...Object.values(PROVIDER_NAME_KEY),
        ];
        for (const key of keys) expect([key, typeof lookup(catalogue, key)]).toEqual([key, 'string']);
    });
});
