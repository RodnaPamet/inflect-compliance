/**
 * GAP-13: /api/health must reflect Redis health.
 *
 * Confirms the legacy /api/health endpoint pings Redis and reports
 * unhealthy when Redis is down. Mirrors /api/readyz semantics so an
 * operator pointing legacy probes at /api/health doesn't get a
 * misleading "healthy" reading while Redis is broken.
 */
export {};

// ─── Mocks (declared before requires) ───────────────────────────────

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    })),
}));

const pingMock = jest.fn();
jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => ({ ping: pingMock })),
}));

// Helper — clear and re-import the route module so each test runs
// against a fresh Prisma + Redis mock state. NextRequest isn't
// needed; the GET handler accepts no arguments.
function loadRouteFresh() {
    jest.resetModules();
    // Re-apply mocks after resetModules (they're hoisted but reset
    // wipes the registry).
    jest.doMock('@prisma/client', () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        })),
    }));
    jest.doMock('@/lib/redis', () => ({
        getRedis: jest.fn(() => ({ ping: pingMock })),
    }));

    return require('@/app/api/health/route');
}

describe('GET /api/health (GAP-13: Redis ping must affect status)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('returns 200 + healthy when Redis PINGs PONG', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockResolvedValue('PONG');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('healthy');
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.redis.status).toBe('ok');
        expect(body.checks.redis.error).toBeUndefined();
    });

    it('returns 503 + degraded when Redis ping throws (Redis is down)', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.status).toBe('degraded');
        expect(body.checks.redis.status).toBe('error');
        // Sanity: error string is generic — no host/port/password leakage.
        expect(body.checks.redis.error).toBe('Ping failed');
        expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
        expect(JSON.stringify(body)).not.toContain('localhost:6379');
    });

    it('returns 503 + degraded when Redis ping returns a non-PONG value', async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        pingMock.mockResolvedValue('UNEXPECTED');
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.status).toBe('degraded');
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.redis.error).toBe('Unexpected ping response');
    });

    it('returns 503 + Not configured under NODE_ENV=production when REDIS_URL is unset', async () => {
        // GAP-13 — env validation should already refuse to boot in
        // this state. The endpoint check is defense-in-depth for the
        // SKIP_ENV_VALIDATION=1 escape hatch.
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        delete process.env.REDIS_URL;
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.status).toBe('degraded');
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.redis.error).toBe('Not configured');
    });

    it('returns 200 + healthy under NODE_ENV=development when REDIS_URL is unset', async () => {
        // Dev/test ergonomics: a contributor running the app without
        // local Redis should not see a red probe.
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        delete process.env.REDIS_URL;
        const { GET } = loadRouteFresh();

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('healthy');
        expect(body.checks.redis.status).toBe('ok');
    });
});

describe('GET /api/health names the build that is serving (#4477)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        pingMock.mockResolvedValue('PONG');
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('reports the commit the image was built from', async () => {
        process.env.BUILD_SHA = '3f6d83150b9c4e2a7d1e';
        const body = await (await loadRouteFresh().GET()).json();
        expect(body.version).toBe('3f6d83150b9c4e2a7d1e');
    });

    it("reports 'dev' outside a published image, and for the empty value an unset build argument leaves", async () => {
        delete process.env.BUILD_SHA;
        expect((await (await loadRouteFresh().GET()).json()).version).toBe('dev');
        process.env.BUILD_SHA = '';
        expect((await (await loadRouteFresh().GET()).json()).version).toBe('dev');
    });
});
