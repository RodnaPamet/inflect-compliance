/**
 * Fan-out determinism and failure isolation, over real rows.
 *
 * `enqueue` is mocked — deliberately, and this is the one tier where mocking is
 * right. The property under test is what the DISPATCHER produces (which job ids,
 * how many, and whether one throw drops the rest), not whether BullMQ stores
 * them. Standing up Redis to assert our own loop would add a flake source and
 * prove nothing extra.
 *
 * What is NOT mocked is the database. `drainPages` cursor-paginates real
 * `IntegrationConnection` rows in pages of `DRAIN_PAGE_SIZE`, and the bug it
 * replaced was a `take: 1000` that silently dropped every connection past the
 * cap while logging a clean success. Asserting over fewer rows than one page
 * would miss exactly that.
 *
 * `now` is passed explicitly into `dispatchJobId`. A run straddling a UTC bucket
 * boundary would otherwise produce two ids for one connection and flake — the
 * kind of 1-in-N-runs failure that gets a blocking suite disabled.
 *
 * @see tests/stress/README.md
 */
import { randomUUID } from 'node:crypto';
import { requireStressDb, stressPrisma, teardownTenant, STRESS_SCALE, recordTrend } from './helpers/stress-env';
import { DRAIN_PAGE_SIZE } from '@/app-layer/jobs/drain-pages';
import { dispatchJobId, fanOut, DAILY_BUCKET_MS } from '@/app-layer/jobs/fan-out';

jest.setTimeout(180_000);

/** More than two pages, so cursor pagination is genuinely exercised. */
const CONNECTIONS = DRAIN_PAGE_SIZE * 2 + 37 * STRESS_SCALE;

const prisma = stressPrisma();
const TAG = `stressf${Date.now().toString(36)}`;
const TENANT_ID = `t-${TAG}`;

beforeAll(async () => {
    requireStressDb();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `stress ${TAG}`, slug: TAG },
    });

    // createMany so seeding thousands of rows is one statement, not N.
    await prisma.integrationConnection.createMany({
        data: Array.from({ length: CONNECTIONS }, (_, i) => ({
            tenantId: TENANT_ID,
            provider: 'okta',
            name: `okta-${String(i).padStart(6, '0')}-${randomUUID().slice(0, 6)}`,
            isEnabled: true,
            configJson: { orgUrl: 'https://acme.okta.com', apiToken: 'x' },
        })),
    });
});

afterAll(async () => {
    await teardownTenant(prisma, TENANT_ID);
    await prisma.$disconnect();
});

/** Cursor-paginate this tenant's connections the way the dispatchers do. */
async function drainConnections(): Promise<Array<{ id: string; tenantId: string }>> {
    const out: Array<{ id: string; tenantId: string }> = [];
    let cursor: string | undefined;
    for (;;) {
        // guardrail-allow: n+1 — cursor pagination over one result set, not a per-row read
        const page = await prisma.integrationConnection.findMany({
            where: { tenantId: TENANT_ID, isEnabled: true },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;
        out.push(...page);
        if (page.length < DRAIN_PAGE_SIZE) break;
        cursor = page[page.length - 1].id;
    }
    return out;
}

describe('the fan-out reaches every connection, exactly once per bucket', () => {
    it('sanity — pagination actually spans more than one page', () => {
        // Asserting over a single page would miss the take-cap bug this
        // replaced, and the whole file would be vacuous at scale.
        expect(CONNECTIONS).toBeGreaterThan(DRAIN_PAGE_SIZE * 2);
    });

    it('THRESHOLD 19 — one distinct jobId per connection, stable across re-dispatch', async () => {
        // The bug: no jobId at all, so any dispatcher retry queued a second
        // full sync for every connection.
        const started = Date.now();
        const connections = await drainConnections();
        expect(connections).toHaveLength(CONNECTIONS);

        const now = Date.parse('2026-08-17T03:00:00Z');
        const ids = new Set<string>();
        const RE_DISPATCHES = 5;

        for (let run = 0; run < RE_DISPATCHES; run++) {
            const r = await fanOut(
                connections,
                'stress',
                (c) => ({ connectionId: c.id }),
                async (c) => {
                    ids.add(dispatchJobId('identity-sync', c.id, DAILY_BUCKET_MS, now));
                },
            );
            expect(r).toEqual({ dispatched: CONNECTIONS, failed: 0 });
        }

        // Five dispatches, still one id per connection — that is the dedupe.
        expect(ids.size).toBe(CONNECTIONS);
        recordTrend('fanout_dispatch_ms', Date.now() - started, 'ms');
    });

    it('THRESHOLD 20 — the next bucket produces fresh ids, so tomorrow runs', async () => {
        // The failure direction that is WORSE than duplication: an id that
        // outlives its schedule interval makes the next legitimate run a silent
        // no-op, and a sync that stops running looks exactly like a sync with
        // nothing to do.
        const connections = await drainConnections();
        const today = Date.parse('2026-08-17T03:00:00Z');
        const tomorrow = today + DAILY_BUCKET_MS;

        const ids = new Set<string>();
        for (const when of [today, tomorrow]) {
            for (const c of connections) {
                ids.add(dispatchJobId('identity-sync', c.id, DAILY_BUCKET_MS, when));
            }
        }

        expect(ids.size).toBe(CONNECTIONS * 2);
    });
});

describe('one bad enqueue does not drop the rest of the fan-out', () => {
    it('THRESHOLD 21 — failures are isolated and counted, and the totals reconcile', async () => {
        // Before isolation, one `enqueue` throw aborted the loop: every
        // connection after it was silently never dispatched, and the completion
        // log still read like a clean run.
        const connections = await drainConnections();
        const FAILURES = 50;
        const doomed = new Set(connections.slice(0, FAILURES).map((c) => c.id));
        const seen: string[] = [];

        const r = await fanOut(
            connections,
            'stress',
            (c) => ({ connectionId: c.id }),
            async (c) => {
                seen.push(c.id);
                if (doomed.has(c.id)) throw new Error('redis unreachable');
            },
        );

        // Every connection was ATTEMPTED — the loop did not abort at the first
        // throw, which is the actual regression.
        expect(seen).toHaveLength(CONNECTIONS);
        expect(r.failed).toBe(FAILURES);
        expect(r.dispatched).toBe(CONNECTIONS - FAILURES);
        // The counters must account for everything; a gap would mean silent loss.
        expect(r.dispatched + r.failed).toBe(CONNECTIONS);
    });

    it('total failure is distinguishable from an empty run', async () => {
        // The dispatchers throw only on (failed > 0 && dispatched === 0). An
        // empty input is a legitimate clean no-op and must not look the same.
        const connections = await drainConnections();

        const allFailed = await fanOut(connections, 'stress', () => ({}), async () => {
            throw new Error('down');
        });
        expect(allFailed).toEqual({ dispatched: 0, failed: CONNECTIONS });

        const empty = await fanOut([], 'stress', () => ({}), async () => undefined);
        expect(empty).toEqual({ dispatched: 0, failed: 0 });
    });
});

describe('the queue-retry bypass survives the job boundary', () => {
    it('THRESHOLD 22 — a rate-limited failure reaches the registry as noRetry', async () => {
        // The classification exists only to stop BullMQ answering a throttle
        // with three more full syncs. It has to survive the usecase's own catch,
        // the job wrapper, and makeResult — and each of those dropped it at some
        // point during development.
        const { executorRegistry } = await import('@/app-layer/jobs/executor-registry');
        const { IntegrationRateLimitedError } = await import('@/app-layer/integrations/http-resilience');

        const reg = executorRegistry as unknown as {
            register(n: string, fn: () => Promise<unknown>): void;
            execute(n: string, p: unknown): Promise<{ success: boolean; noRetry?: boolean }>;
        };
        const name = `stress-throttled-${randomUUID().slice(0, 8)}`;
        reg.register(name, async () => {
            throw new IntegrationRateLimitedError('https://acme.okta.com/api/v1/users', 600_000);
        });

        const result = await reg.execute(name, {});

        expect(result.success).toBe(false); // still a recorded failure
        expect(result.noRetry).toBe(true); //  but not re-run immediately
    });
});
