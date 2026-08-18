/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for OAuth token refresh logic.
 */
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';
import {
    isTokenExpired,
    refreshGoogleToken,
    refreshMicrosoftToken,
    refreshAccessToken,
} from '@/lib/auth/refresh';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
    mockFetch.mockReset();
    process.env.GOOGLE_CLIENT_ID = 'test-google-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'; // pragma: allowlist secret -- test fixture for OAuth refresh flow
    process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
    process.env.MICROSOFT_TENANT_ID = 'test-tenant';
});

describe('isTokenExpired', () => {
    it('returns true when token is expired', () => {
        const pastTimestamp = Math.floor(Date.now() / 1000) - 100;
        expect(isTokenExpired(pastTimestamp)).toBe(true);
    });

    it('returns true when token expires within skew window (60s)', () => {
        const nearExpiry = Math.floor(Date.now() / 1000) + 30; // 30s from now
        expect(isTokenExpired(nearExpiry)).toBe(true);
    });

    it('returns false when token has time remaining beyond skew', () => {
        const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour
        expect(isTokenExpired(futureTimestamp)).toBe(false);
    });
});

describe('refreshGoogleToken', () => {
    it('successfully refreshes a Google token', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-google-access-token', // pragma: allowlist secret -- mock OAuth response
                expires_in: 3600,
            }),
        });

        const result = await refreshGoogleToken('google-refresh-token');

        expect(result.accessToken).toBe('new-google-access-token');
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(result.refreshToken).toBeUndefined(); // Google doesn't always rotate

        // Verify correct endpoint was called
        expect(mockFetch).toHaveBeenCalledWith(
            'https://oauth2.googleapis.com/token',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('handles refresh token rotation (new refresh_token returned)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-access',
                refresh_token: 'new-refresh-rotated',
                expires_in: 3600,
            }),
        });

        const result = await refreshGoogleToken('old-refresh-token');

        expect(result.accessToken).toBe('new-access');
        expect(result.refreshToken).toBe('new-refresh-rotated');
    });

    it('classifies a 401 as an auth failure rather than an anonymous Error', async () => {
        // This assertion changed deliberately. These refreshes used to call the
        // bare global `fetch`, so a genuine 401 came back as a plain Error
        // reading "Google token refresh failed: 401" — indistinguishable, to any
        // caller, from a network blip. `markAuthFailure` branches on
        // `instanceof IntegrationAuthError`, so a revoked refresh token could
        // never mark the connection.
        //
        // Routing through resilientFetch means 401/403 are classified before the
        // `!response.ok` line is reached. The message is now produced by
        // IntegrationAuthError, whose URL is scrubbed by safeUrl — worth keeping
        // in mind if the assertion is ever tightened, because a token endpoint's
        // query string must never end up in a persisted failure reason.
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'invalid_grant',
        });

        const err = await refreshGoogleToken('bad-token').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IntegrationAuthError);
        expect((err as Error).message).not.toMatch(/bad-token/);
    });

    it('leaves a 400 as a generic failure, since OAuth 400s are not all credential errors', async () => {
        // 400 is in none of resilientFetch's status sets, so the Response passes
        // through and the function's own `!response.ok` throw still runs. That
        // is intentional: RFC 6749 signals several NON-credential conditions
        // with 400 (invalid_request, unsupported_grant_type), and promoting all
        // of them to an auth failure would mark healthy connections as revoked.
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            text: async () => 'invalid_request',
        });

        const err = await refreshGoogleToken('bad-token').catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(IntegrationAuthError);
        expect((err as Error).message).toContain('Google token refresh failed: 400');
    });
});

describe('refreshMicrosoftToken', () => {
    it('successfully refreshes a Microsoft token', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-ms-access-token', // pragma: allowlist secret -- mock OAuth response
                expires_in: 3600,
            }),
        });

        const result = await refreshMicrosoftToken('ms-refresh-token');

        expect(result.accessToken).toBe('new-ms-access-token');
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

        // Verify correct tenant-specific endpoint
        expect(mockFetch).toHaveBeenCalledWith(
            'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('handles refresh token rotation for Microsoft', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'new-access',
                refresh_token: 'rotated-ms-refresh',
                expires_in: 3600,
            }),
        });

        const result = await refreshMicrosoftToken('old-token');
        expect(result.refreshToken).toBe('rotated-ms-refresh');
    });

    it('throws on Microsoft refresh failure', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            text: async () => 'invalid_grant',
        });

        await expect(refreshMicrosoftToken('bad-token')).rejects.toThrow(
            'Microsoft token refresh failed: 400'
        );
    });
});

describe('refreshAccessToken', () => {
    it('routes to Google refresh for google provider', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'google-token',
                expires_in: 3600,
            }),
        });

        const result = await refreshAccessToken('google', 'refresh');
        expect(result.accessToken).toBe('google-token');
    });

    it('routes to Microsoft refresh for microsoft-entra-id provider', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                access_token: 'ms-token',
                expires_in: 3600,
            }),
        });

        const result = await refreshAccessToken('microsoft-entra-id', 'refresh');
        expect(result.accessToken).toBe('ms-token');
    });

    it('throws for unsupported provider', async () => {
        await expect(refreshAccessToken('github', 'refresh')).rejects.toThrow(
            'Token refresh not supported for provider: github'
        );
    });
});
