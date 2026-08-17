/**
 * Tier H — the HTTP hardening, against a REAL socket.
 *
 * This is the file that justifies the whole suite. Every assertion here drives
 * `runIdentitySync` through the real `OktaProvider`, the real
 * `createResilientFetch`, and the real `createBoundedFetch`, against a real
 * `node:http` server that hangs, throttles, or rejects.
 *
 * The alternative — injecting a fake at `deps.fetchImpl` — would replace both
 * hardened layers outright. The bounded-fetch guard states that explicitly: "a
 * test that passes its own fetch SHOULD bypass the deadline." So a suite built
 * that way would report green about behaviour it never executed, which is worse
 * than no suite.
 *
 * Every assertion is an integer count or a row state. The one timing bound
 * (elapsed < 4000 ms against a measured 3075 ms) exists only to catch "the
 * deadline stopped firing", where the failure is an order of magnitude, not a
 * few percent.
 *
 * @see tests/stress/README.md
 */
import { randomUUID } from 'node:crypto';
import { FakeOktaServer } from './helpers/fake-okta-server';
import {
    requireStressDb,
    shortStack,
    stressPrisma,
    teardownTenant,
    recordTrend,
} from './helpers/stress-env';
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import { OktaProvider } from '@/app-layer/integrations/providers/okta';
import { MAX_HTTP_ATTEMPTS } from '@/app-layer/integrations/http-resilience';

jest.setTimeout(120_000);

/** Deadline per request. 1000ms, not 200 — a 2-vCPU runner's GC pauses reach the low hundreds. */
const DEADLINE_MS = 1_000;

const prisma = stressPrisma();
const TAG = `stressh${Date.now().toString(36)}`;
const TENANT_ID = `t-${TAG}`;

let server: FakeOktaServer;
let connectionId: string;

async function seedConnection(orgUrl: string, userCount = 1): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: TENANT_ID,
            provider: 'okta',
            name: `okta-${randomUUID().slice(0, 8)}`,
            isEnabled: true,
            configJson: {
                orgUrl,
                apiToken: 'stress-token',
                // MANDATORY. The default is 'true', which fans /factors + /roles
                // per account — and every one of those calls sits inside a bare
                // `catch {}` in the provider, so an injected 401/429/timeout is
                // SWALLOWED and the sync still reports PASSED. Leaving it on
                // would make several assertions below silently vacuous.
                enrichPerUser: 'false',
            },
            secretEncrypted: null,
        },
        select: { id: true },
    });
    void userCount;
    return conn.id;
}

/** Drive one sync through the real stack with short budgets. */
async function syncWith(opts: { maxAbsorbedRetryAfterMs: number; maxAttempts?: number }) {
    const { fetchImpl, slept } = shortStack({
        deadlineMs: DEADLINE_MS,
        maxAbsorbedRetryAfterMs: opts.maxAbsorbedRetryAfterMs,
        ...(opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {}),
    });
    const provider = new OktaProvider({ fetchImpl });
    const startedAt = Date.now();
    const result = await runIdentitySync({ tenantId: TENANT_ID, connectionId, provider });
    return { result, slept, elapsedMs: Date.now() - startedAt };
}

const connRow = () =>
    prisma.integrationConnection.findUnique({
        where: { id: connectionId },
        select: { authFailedAt: true, authFailureReason: true, syncCursor: true, syncPassStartedAt: true },
    });

beforeAll(async () => {
    requireStressDb();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `stress ${TAG}`, slug: TAG },
    });
});

afterAll(async () => {
    await teardownTenant(prisma, TENANT_ID);
    await prisma.$disconnect();
});

beforeEach(async () => {
    server = new FakeOktaServer({ userCount: 1 });
    await server.start();
    connectionId = await seedConnection(server.orgUrl);
});

afterEach(async () => {
    await server.stop();
    await prisma.connectedIdentityAccount.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId: TENANT_ID } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
});

describe('a healthy provider syncs through the real stack', () => {
    it('sanity — the harness reaches a real socket and completes', async () => {
        // Without this, every assertion below could be passing because the
        // provider never issued a request at all.
        const { result } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(result.status).toBe('PASSED');
        expect(result.upserted).toBe(1);
        expect(server.count('/api/v1/users')).toBe(1);
    });
});

describe('a black-holed provider is bounded, and releases its socket', () => {
    it('THRESHOLD 1+2 — the deadline fires and attempts are capped', async () => {
        server.setMode({ kind: 'hang' });

        const { result, elapsedMs } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(result.status).toBe('ERROR');
        expect(result.errorMessage).toMatch(new RegExp(`exceeded ${DEADLINE_MS}ms`));
        // A timeout is retryable, so the classification must NOT suppress the
        // queue retry — a transiently slow directory deserves another attempt.
        expect(result.noRetry).toBe(false);
        expect(server.count('/api/v1/users')).toBe(MAX_HTTP_ATTEMPTS);

        // Order-of-magnitude bound. Measured ~3× DEADLINE_MS; this only breaches
        // if the deadline stops firing altogether.
        expect(elapsedMs).toBeLessThan(4_000);
        recordTrend('hung_provider_settle_ms', elapsedMs, 'ms');
    });

    it('THRESHOLD 3 — the abort actually releases the connection', async () => {
        // The one property a stubbed fetch cannot establish. "One hung provider
        // holds a worker slot" is the failure this area exists to prevent, so
        // the release is the half that matters.
        server.setMode({ kind: 'hang' });

        await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(server.observedDisconnects).toBeGreaterThanOrEqual(MAX_HTTP_ATTEMPTS);
        expect(server.inFlight).toBe(0);
    });
});

describe('throttling defers instead of amplifying', () => {
    it('THRESHOLD 4 — a throttle beyond the absorb budget ends the tick, once', async () => {
        // THE headline regression. Before the hardening, a 429 surfaced as a
        // generic failure and the queue re-ran the whole sync three times in
        // ~35s — answering a throttle with three more full enumerations.
        server.setMode({ kind: 'throttle', retryAfter: '600' });

        const { result, slept } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(server.count('/api/v1/users')).toBe(1); // did NOT hammer
        expect(slept).toEqual([]); //                     did NOT idle a worker
        expect(result.status).toBe('ERROR');
        expect(result.noRetry).toBe(true); //              queue must not re-run it
    });

    it('THRESHOLD 5 — a throttle within budget is absorbed and retried', async () => {
        // `Retry-After` delta-seconds is integer-only, so the smallest
        // absorbable value is 1000ms. maxAbsorbed MUST exceed 1000 or this
        // takes the defer branch — the recon's proposed 500 was wrong, and this
        // assertion is what catches that class of mistake.
        server.setModeForNext({ kind: 'throttle', retryAfter: '1' }, 1);

        const { result, slept } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(server.count('/api/v1/users')).toBe(2); // absorbed, then retried
        expect(slept).toEqual([1_000]); //                honoured Retry-After exactly
        expect(result.status).toBe('PASSED');
    });
});

describe('a rejected credential is marked; a missing resource is not', () => {
    it('THRESHOLD 7 — 401 marks the connection and stops retrying', async () => {
        server.setMode({ kind: 'unauth' });

        const { result } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(server.count('/api/v1/users')).toBe(1); // no retry on a bad credential
        expect(result.status).toBe('ERROR');
        expect(result.noRetry).toBe(true);

        const row = await connRow();
        expect(row?.authFailedAt).not.toBeNull();
        expect(String(row?.authFailureReason)).toContain('401');
        // The scrub: the reason is persisted and rendered, so no query string.
        expect(String(row?.authFailureReason)).not.toContain('apiToken');
    });

    it('THRESHOLD 8 — 404 does NOT accuse the credential', async () => {
        // A deleted group must not raise a "credential revoked" banner in front
        // of an admin whose credential is fine.
        server.setMode({ kind: 'notFound' });

        const { result } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(server.count('/api/v1/users')).toBe(1);
        expect(result.status).toBe('ERROR');
        expect(result.noRetry).toBe(true);

        const row = await connRow();
        expect(row?.authFailedAt).toBeNull();
    });

    it('a later success CLEARS a stale mark', async () => {
        // The load-bearing half of credential health: a banner that survives the
        // fix trains people to ignore it.
        server.setMode({ kind: 'unauth' });
        await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });
        expect((await connRow())?.authFailedAt).not.toBeNull();

        server.setMode({ kind: 'ok' });
        const { result } = await syncWith({ maxAbsorbedRetryAfterMs: 1_500 });

        expect(result.status).toBe('PASSED');
        expect((await connRow())?.authFailedAt).toBeNull();
        expect((await connRow())?.authFailureReason).toBeNull();
    });
});
