/**
 * GET /api/admin/diagnostics — gated by the PLATFORM key, not a tenant role.
 *
 * The route previously resolved `getLegacyCtx(req)` and checked
 * `ctx.permissions.canAdmin`. That reads as "admin only", but `getLegacyCtx`
 * builds the context from the CALLER'S OWN `session.tenantId` — so the check
 * asked "are you an admin of your own tenant?", and every yes, in any tenant,
 * returned the same server-wide payload.
 *
 * The payload has no tenant dimension: Node version, platform, NODE_ENV,
 * release version, heap usage, log level, and which observability backends are
 * wired. There is no reading under which one tenant's admin is more entitled
 * to it than another's — which is the tell that a tenant role was the wrong
 * axis entirely.
 *
 * These tests pin the axis, not the mechanism: what must stay true is that
 * holding a tenant role is not sufficient, and that the payload never grows a
 * secret.
 */
const verifyPlatformApiKey = jest.fn<void, [unknown]>();

jest.mock('@/lib/auth/platform-admin', () => {
    class PlatformAdminError extends Error {
        constructor(
            public readonly status: number,
            message: string,
        ) {
            super(message);
            this.name = 'PlatformAdminError';
        }
    }
    return {
        PlatformAdminError,
        verifyPlatformApiKey: (...a: unknown[]) => verifyPlatformApiKey(...(a as [unknown])),
    };
});
jest.mock('@/lib/observability/instrumentation', () => ({ isTelemetryInitialized: () => true }));
jest.mock('@/lib/observability/sentry', () => ({ isSentryInitialized: () => false }));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/admin/diagnostics/route';
import { PlatformAdminError } from '@/lib/auth/platform-admin';

// A real NextRequest, not a hand-rolled stand-in: `withApiErrorHandling` reads
// `req.nextUrl.pathname` for its correlation fields, so a bare `Request` makes
// the wrapper throw before the handler runs — which reads as the handler being
// broken.
const req = () => new NextRequest('http://localhost/api/admin/diagnostics', { method: 'GET' });

beforeEach(() => {
    jest.clearAllMocks();
    verifyPlatformApiKey.mockReturnValue(undefined);
});

describe('the tenant-role path is gone', () => {
    it('does not consult the caller\'s tenant context at all', () => {
        // The load-bearing assertion, and the reason it is a source check: a
        // handler that still imported getLegacyCtx could pass every
        // behavioural test below by calling it and ignoring the answer, then
        // regain the old semantics in one line.
        //
        // Read the CODE, not the file. The route's header comment explains at
        // length what it used to do, naming `getLegacyCtx` and
        // `permissions.canAdmin` — so a bare `expect(src).not.toMatch(...)`
        // over the whole file fails on the explanation of the fix. Strip
        // comments first, or the assertion is about prose.
        const raw: string = require('node:fs').readFileSync(
            require('node:path').resolve(__dirname, '../../src/app/api/admin/diagnostics/route.ts'),
            'utf8',
        );
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

        expect(code).not.toMatch(/getLegacyCtx/);
        expect(code).not.toMatch(/permissions\.canAdmin/);
        expect(code).toMatch(/verifyPlatformApiKey/);
        // And the stripper really did leave code behind — an over-eager regex
        // that emptied the string would pass both negatives above.
        expect(code).toMatch(/export const GET/);
    });

    it('serves the payload when the platform key verifies', async () => {
        const res = await GET(req(), { params: Promise.resolve({}) } as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.service.name).toBeDefined();
        expect(body.runtime.nodeVersion).toBe(process.version);
    });

    it('refuses when the key does not match, and does not serve a partial payload', async () => {
        verifyPlatformApiKey.mockImplementation(() => {
            throw new PlatformAdminError(401, 'Unauthorized');
        });
        const res = await GET(req(), { params: Promise.resolve({}) } as never);
        expect(res.status).toBe(401);
        expect(await res.json()).not.toHaveProperty('runtime');
    });
});

describe('a 503 is not a 401', () => {
    it('preserves "not configured" instead of collapsing it to "wrong key"', async () => {
        // verifyPlatformApiKey throws 503 when PLATFORM_ADMIN_API_KEY is unset
        // and 401 when it merely mismatches. Flattening both to 401 would tell
        // an operator their key is wrong when the deployment has none set —
        // sending them to rotate a credential that does not exist.
        verifyPlatformApiKey.mockImplementation(() => {
            throw new PlatformAdminError(503, 'Platform admin API not configured');
        });
        const res = await GET(req(), { params: Promise.resolve({}) } as never);
        expect(res.status).toBe(503);
    });
});

describe('the payload still exposes no secrets', () => {
    it('reports whether Sentry is configured as a boolean, never the DSN', async () => {
        const prev = process.env.SENTRY_DSN;
        process.env.SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/1234567';
        try {
            const res = await GET(req(), { params: Promise.resolve({}) } as never);
            const body = await res.json();
            expect(body.observability.sentryConfigured).toBe(true);
            expect(JSON.stringify(body)).not.toContain('ingest.sentry.io');
            expect(JSON.stringify(body)).not.toContain('publickey');
        } finally {
            if (prev === undefined) delete process.env.SENTRY_DSN;
            else process.env.SENTRY_DSN = prev;
        }
    });
});
