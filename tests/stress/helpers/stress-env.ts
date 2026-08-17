/**
 * Shared environment for the integrations stress suite.
 *
 * ## Why this suite exists separately from tests/load/
 *
 * `tests/load/` is k6 over HTTP and covers no integration surface. Everything
 * the integrations hardening fixed lives BELOW the HTTP boundary — a deadline on
 * a hung socket, a throttle absorbed or deferred, a lease reaped, a multi-run
 * resume pass that must not deprovision its own earlier runs. None of that is
 * reachable by driving requests at the app.
 *
 * ## The transport decision, and why it is a real socket
 *
 * Every provider takes an injectable `deps.fetchImpl`, which makes a fake fetch
 * the obvious choice — and the wrong one. `http-resilience.ts` resolves
 * `opts.fetchImpl ?? boundedFetch`, so injecting a bare fake at the provider
 * REPLACES both hardened layers. The bounded-fetch guard says so out loud: "a
 * test that passes its own fetch SHOULD bypass the deadline."
 *
 * So the harness injects a COMPOSED REAL STACK — `createResilientFetch` over
 * `createBoundedFetch` — which swaps only the module singletons' baked-in
 * production constants for short ones. Every line of both modules still runs,
 * and `createBoundedFetch` still calls the free global `fetch` against a real
 * `node:http` server, with real `AbortSignal.timeout` / `AbortSignal.any`.
 *
 * The decisive reason a socket beats a stub is TIMERS, not sockets. Every
 * DB-backed scenario runs inside `runInTenantContext`'s Prisma interactive
 * transaction, whose 5 s expiry is server-side wall clock —
 * `jest.advanceTimersByTimeAsync` cannot move it. Measured: a 9 s hang expires
 * the transaction and persists nothing. Fake timers were never available here,
 * which removes the stub's only advantage.
 *
 * ## Budgets are short by injection, never by waiting
 *
 * `SYNC_LOCK_TTL_MS` is 30 minutes and `MAX_ABSORBED_RETRY_AFTER_MS` is 60 s.
 * Nothing here waits for either: `acquireSyncLock` takes a `ttlMs`, and
 * `createResilientFetch` takes `maxAbsorbedRetryAfterMs` + an injected
 * `sleepImpl`. A suite that actually slept would be deleted the first time
 * someone ran it in a hurry.
 *
 * @see tests/stress/README.md
 */
import { getTestDatabaseUrl, prismaTestClient } from '../../helpers/db';
import { createResilientFetch } from '@/app-layer/integrations/http-resilience';
import { createBoundedFetch } from '@/app-layer/integrations/bounded-fetch';

/**
 * Volume multiplier. 1 locally, 10 in the scheduled workflow.
 *
 * Scales row counts, never timeouts — a scaled timeout would make the
 * thresholds mean different things in the two environments.
 */
export const STRESS_SCALE = Number(process.env.STRESS_SCALE ?? '1') || 1;

/**
 * Hard ceiling on concurrent tenant drivers.
 *
 * MEASURED, not chosen: `PrismaPg` is constructed with a connection string
 * only, so the pg pool defaults to `max: 10`, and each in-flight tenant holds
 * one connection for its entire enumeration (the whole usecase is one
 * interactive transaction). At 10 concurrent, every driver fails with a pool
 * timeout. `?connection_limit=N` is a no-op under the driver adapter.
 *
 * 8 leaves headroom for the harness's own queries.
 */
export const CONCURRENCY_CAP = 8;

/**
 * Assert the database is reachable, LOUDLY.
 *
 * Deliberately not `DB_AVAILABLE ? describe : describe.skip`: in a blocking
 * scheduled job, a skipped suite reads green with zero tests run — the exact
 * "a check that did not run looks like one that passed" failure this suite is
 * supposed to catch elsewhere.
 */
export function requireStressDb(): void {
    const testUrl = getTestDatabaseUrl();
    if (!testUrl) {
        throw new Error(
            'stress suite requires a database. Set DATABASE_URL_TEST / DATABASE_URL. ' +
                'This suite fails rather than skips: a skipped blocking job reads as green.',
        );
    }

    // The app's prisma singleton reads DATABASE_URL; `prismaTestClient()` reads
    // DATABASE_URL_TEST. These scenarios drive the REAL usecase, so the app
    // singleton does the writing and the harness does the reading — if the two
    // point at different databases, every assertion fails with "Can't reach
    // database server" or, worse, silently reads an empty table.
    //
    // Asserted here so the failure names itself. `npm run stress` and the
    // workflow both set DATABASE_URL to the test database for this reason.
    const appUrl = process.env.DATABASE_URL ?? '';
    const norm = (u: string) => u.replace(/\?.*$/, '').replace(/\/$/, '');
    if (norm(appUrl) !== norm(testUrl)) {
        throw new Error(
            'stress suite DB mismatch — the app singleton and the harness would use different databases.\n' +
                `  DATABASE_URL      (app writes here):    ${norm(appUrl) || '(unset)'}\n` +
                `  getTestDatabaseUrl() (harness reads):   ${norm(testUrl)}\n` +
                'Run via `npm run stress`, which points DATABASE_URL at the test database.',
        );
    }
}

/**
 * The composed real stack, with short budgets.
 *
 * `sleepImpl` records instead of sleeping, so backoff is asserted rather than
 * waited out. `rand` is fixed so jittered backoff is deterministic.
 */
export function shortStack(opts: {
    deadlineMs: number;
    maxAbsorbedRetryAfterMs: number;
    maxAttempts?: number;
}): { fetchImpl: typeof fetch; slept: number[] } {
    const slept: number[] = [];
    const fetchImpl = createResilientFetch({
        // The real bounded fetch, with a short deadline. Still calls the global
        // `fetch`, so the deadline and the abort are real.
        fetchImpl: createBoundedFetch(opts.deadlineMs),
        maxAbsorbedRetryAfterMs: opts.maxAbsorbedRetryAfterMs,
        ...(opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {}),
        sleepImpl: async (ms: number) => {
            slept.push(ms);
        },
        rand: () => 0.5,
    });
    return { fetchImpl, slept };
}

/** A fresh tenant-scoped Prisma client for harness setup/teardown. */
export function stressPrisma() {
    return prismaTestClient();
}

/**
 * Tear down a tenant's rows.
 *
 * `AuditLog` and `TenantMembership` carry triggers (`IMMUTABLE_AUDIT_LOG`,
 * `tenant_membership_last_owner_guard`) that turn an ordinary `deleteMany` into
 * "suite failed to run". The replica-mode transaction is the repo's established
 * way past that; `resetDatabase()` truncates no integration table, so this is
 * hand-rolled per tenant.
 */
export async function teardownTenant(
    prisma: ReturnType<typeof prismaTestClient>,
    tenantId: string,
    userIds: string[] = [],
): Promise<void> {
    await prisma.connectedIdentityAccount.deleteMany({ where: { tenantId } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId } });
    await prisma.integrationSyncMapping.deleteMany({ where: { tenantId } });
    await prisma.evidence.deleteMany({ where: { tenantId } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId } });
    await prisma.$transaction(async (tx: { $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<unknown> }) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
    });
    if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

/** Emit a trend number for the artifact. Never asserted — see README §thresholds. */
export function recordTrend(label: string, value: number, unit: string): void {
    console.log(`[stress] ${label}=${value}${unit}`);
}
