/**
 * `publicBaseUrl` must prefer the CONFIGURED origin over the request's.
 *
 * The bug this pins: behind Caddy, `req.nextUrl.host` is the app's own bind
 * address, so the admin Integrations page rendered its webhook endpoint as
 * `https://0.0.0.0:3000/api/integrations/webhooks/{provider}` while `APP_URL`
 * was set correctly. An operator pasting that into a provider's webhook
 * config gets an address that resolves to nothing, and the integration fails
 * silently.
 */
import type { NextRequest } from 'next/server';

const mockEnv: { APP_URL?: string; NODE_ENV?: string } = {};
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));
const warn = jest.fn();
jest.mock('@/lib/observability', () => ({
    logger: {
        warn: (...args: unknown[]) => warn(...args),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

import { publicBaseUrl } from '@/lib/http/public-base-url';

/** A request as it arrives behind a reverse proxy: internal bind address. */
const behindProxy = (): Pick<NextRequest, 'nextUrl'> =>
    ({ nextUrl: new URL('http://0.0.0.0:3000/api/t/acme/admin/integrations') }) as unknown as Pick<
        NextRequest,
        'nextUrl'
    >;

describe('publicBaseUrl', () => {
    beforeEach(() => {
        delete mockEnv.APP_URL;
        mockEnv.NODE_ENV = 'test';
        warn.mockClear();
    });

    it('uses APP_URL, not the proxied request host — the reported bug', () => {
        mockEnv.APP_URL = 'https://app.inflect.bg';
        const base = publicBaseUrl(behindProxy());
        expect(base).toBe('https://app.inflect.bg');
        // The exact string an operator would have copied into a provider.
        expect(`${base}/api/integrations/webhooks/github`).toBe(
            'https://app.inflect.bg/api/integrations/webhooks/github',
        );
        expect(base).not.toContain('0.0.0.0');
    });

    it('strips trailing slashes so callers can append a path', () => {
        mockEnv.APP_URL = 'https://app.inflect.bg///';
        expect(`${publicBaseUrl(behindProxy())}/api/scim/v2`).toBe(
            'https://app.inflect.bg/api/scim/v2',
        );
    });

    it('falls back to the request origin when APP_URL is unset', () => {
        // Development convenience: no configured origin, so the request is all
        // there is. Correct there, and the reason the bug was invisible locally.
        expect(publicBaseUrl(behindProxy())).toBe('http://0.0.0.0:3000');
    });

    it('warns when it has to fall back in production', () => {
        mockEnv.NODE_ENV = 'production';
        publicBaseUrl(behindProxy());
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/APP_URL is unset in production/);
    });

    it('does not warn when APP_URL is set in production', () => {
        mockEnv.NODE_ENV = 'production';
        mockEnv.APP_URL = 'https://app.inflect.bg';
        publicBaseUrl(behindProxy());
        expect(warn).not.toHaveBeenCalled();
    });
});
