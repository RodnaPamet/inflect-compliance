/**
 * "Sign Out Other Sessions" and "Revoke All" are told which session is making
 * the request — the JWT's `userSessionId` — so they can keep it (#4117).
 *
 * The usecases decide what to do with the id (session-security.test.ts). What
 * this file pins is the wiring: the routes read the id from the verified
 * session token, never from the request body, and hand it over; and
 * `currentSessionIdOf` answers null for a request with no session token.
 */

const mockGetTenantCtx = jest.fn();
const mockRevokeOtherSessions = jest.fn();
const mockRevokeAllTenantSessions = jest.fn();
const mockGetToken = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/app-layer/usecases/session-security', () => ({
    revokeOtherSessions: (...args: unknown[]) => mockRevokeOtherSessions(...args),
    revokeAllTenantSessions: (...args: unknown[]) => mockRevokeAllTenantSessions(...args),
}));

jest.mock('next-auth/jwt', () => ({
    getToken: (...args: unknown[]) => mockGetToken(...args),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: jest.fn(),
    appendAuditEntry: jest.fn(),
}));

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));

import { POST as revokeCurrent } from '@/app/api/t/[tenantSlug]/security/sessions/revoke-current/route';
import { POST as revokeAll } from '@/app/api/t/[tenantSlug]/security/sessions/revoke-all/route';
import { currentSessionIdOf } from '@/lib/security/session-tracker';
import { makeRequestContext } from '../../helpers/make-context';

function makeReq(path: string, body: unknown = {}) {
    return {
        method: 'POST',
        url: `https://app.example.com/api/t/acme/security/sessions/${path}`,
        headers: new Headers(),
        nextUrl: {
            pathname: `/api/t/acme/security/sessions/${path}`,
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: new URLSearchParams(),
        },
        json: async () => body,
    } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN', { tenantSlug: 'acme' }));
    mockRevokeOtherSessions.mockResolvedValue({ userId: 'user-1', currentSessionKept: true, sessionsRevoked: 2 });
    mockRevokeAllTenantSessions.mockResolvedValue({ usersAffected: 4, currentSessionKept: true });
});

describe('the routes hand the usecase the session making the request', () => {
    it('Sign Out Other Sessions passes the token’s userSessionId and reports that it was kept', async () => {
        mockGetToken.mockResolvedValue({ sub: 'user-1', userSessionId: 'sess-current' });

        // A body naming another session is ignored: the id comes from the token.
        const res = await revokeCurrent(makeReq('revoke-current', { sessionId: 'sess-forged' }), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });

        expect(res.status).toBe(200);
        expect(mockRevokeOtherSessions).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'sess-current');
        expect(await res.json()).toMatchObject({ currentSessionKept: true, sessionsRevoked: 2 });
    });

    it('Revoke All passes it too', async () => {
        mockGetToken.mockResolvedValue({ sub: 'user-1', userSessionId: 'sess-current' });

        const res = await revokeAll(makeReq('revoke-all'), { params: Promise.resolve({ tenantSlug: 'acme' }) });

        expect(res.status).toBe(200);
        expect(mockRevokeAllTenantSessions).toHaveBeenCalledWith(expect.anything(), 'sess-current');
        expect(await res.json()).toMatchObject({ usersAffected: 4, currentSessionKept: true });
    });
});

describe('currentSessionIdOf', () => {
    it.each([
        ['no session token', null],
        ['a token minted without a session row id', { sub: 'user-1' }],
        ['an empty id', { sub: 'user-1', userSessionId: '' }],
    ])('is null for %s', async (_label, token) => {
        mockGetToken.mockResolvedValue(token);
        expect(await currentSessionIdOf(makeReq('revoke-current'))).toBeNull();
    });

    it('is null when the token cannot be read, rather than throwing', async () => {
        mockGetToken.mockRejectedValue(new Error('JWEDecryptionFailed'));
        expect(await currentSessionIdOf(makeReq('revoke-current'))).toBeNull();
    });
});
