/**
 * `runInTenantJobContext` — the door a background job goes through to get the
 * same RLS posture an API request gets for free.
 *
 * ## The gap it closes
 *
 * `runJob` binds the OBSERVABILITY request context. The Prisma extensions read
 * the AUDIT context. Two AsyncLocalStorage stores, no bridge, and nothing in a
 * job's shape makes the difference visible — so a job carrying a perfectly
 * good `tenantId` still issues every statement with `getAuditContext()`
 * undefined: no `app_user` role switch, no `app.tenant_id`, RLS enforcing
 * nothing, and a `missing_tenant_context` warn per write.
 *
 * That was observed in production on `av-rescan`, three times, one per
 * `updateMany`.
 *
 * ## The trap next to the fix
 *
 * The reflexive repair is `runWithAuditContext({ tenantId, source: 'job' })`.
 * `'job'` is a `KEK_BYPASS_SOURCES` label: it silences the tripwire AND stops
 * the encryption middleware resolving the tenant DEK, so `v2:` ciphertext
 * decrypts to `null` on read and new writes get sealed under the global KEK.
 * Both failures are silent. The last block below is the one that matters —
 * it pins the refusal, so the mistake cannot be made quietly.
 *
 * The mock client is a ledger, not a stub: it records the exact SQL the
 * transaction issues, so "RLS was engaged" is asserted positively rather than
 * inferred from the absence of a warning.
 */
import { runInTenantJobContext } from '@/lib/db-context';
import { KEK_BYPASS_SOURCES, isKekBypassSource } from '@/lib/db/kek-bypass-sources';
import { getAuditContext } from '@/lib/audit-context';
import type { PrismaClient } from '@prisma/client';

// ─── A recording transaction client ─────────────────────────────────

const statements: string[] = [];
const params: unknown[][] = [];

/**
 * `$executeRaw` is called as a TAGGED TEMPLATE by the code under test, so the
 * mock receives `(strings, ...values)` — reassembling the two halves is what
 * lets the assertions read the literal SQL and the bound tenant id separately.
 */
function makeTx() {
    return {
        $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            statements.push(strings.join('?').replace(/\s+/g, ' ').trim());
            params.push(values);
            return 1;
        }),
    };
}

let tx = makeTx();
const txOptionsSeen: Array<Record<string, unknown> | undefined> = [];

const mockPrisma = {
    $transaction: jest.fn(
        async (fn: (t: unknown) => Promise<unknown>, options?: Record<string, unknown>) => {
            txOptionsSeen.push(options);
            return fn(tx);
        },
    ),
} as unknown as PrismaClient;

beforeEach(() => {
    statements.length = 0;
    params.length = 0;
    txOptionsSeen.length = 0;
    tx = makeTx();
    jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════
// RLS is actually engaged
// ════════════════════════════════════════════════════════════════════

describe('runInTenantJobContext binds the database-level tenant context', () => {
    it('drops to app_user and sets app.tenant_id before the callback runs', async () => {
        let sqlAtCallbackTime: string[] = [];

        await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async () => {
                sqlAtCallbackTime = [...statements];
                return 'ok';
            },
            { customPrisma: mockPrisma },
        );

        // Ordering is the point: a `SET LOCAL` issued after the first data
        // statement would leave that statement running as the superuser.
        expect(sqlAtCallbackTime).toHaveLength(2);
        expect(sqlAtCallbackTime[0]).toBe('SET LOCAL ROLE app_user');
        expect(sqlAtCallbackTime[1]).toContain("set_config('app.tenant_id'");
        expect(params[1][0]).toBe('tenant-a');
    });

    it('returns the callback result and hands it the transaction client', async () => {
        const seen: unknown[] = [];
        const result = await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async (db) => {
                seen.push(db);
                return { rows: 4 };
            },
            { customPrisma: mockPrisma },
        );

        expect(result).toEqual({ rows: 4 });
        expect(seen[0]).toBe(tx);
    });

    it('forwards timeout / maxWait to the transaction, and omits them otherwise', async () => {
        await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async () => null,
            { customPrisma: mockPrisma },
        );
        expect(txOptionsSeen[0]).toEqual({});

        await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async () => null,
            { customPrisma: mockPrisma, timeout: 15_000, maxWait: 4_000 },
        );
        expect(txOptionsSeen[1]).toEqual({ timeout: 15_000, maxWait: 4_000 });
    });
});

// ════════════════════════════════════════════════════════════════════
// The audit context the Prisma extensions actually read
// ════════════════════════════════════════════════════════════════════

describe('runInTenantJobContext binds the audit context the extensions read', () => {
    it('carries the tenant, the actor and the job name into the store', async () => {
        let seen: ReturnType<typeof getAuditContext>;

        await runInTenantJobContext(
            {
                tenantId: 'tenant-a',
                source: 'av-rescan',
                actorUserId: 'user-operator',
                requestId: 'run-77',
            },
            async () => {
                seen = getAuditContext();
            },
            { customPrisma: mockPrisma },
        );

        expect(seen).toEqual({
            tenantId: 'tenant-a',
            actorUserId: 'user-operator',
            requestId: 'run-77',
            source: 'av-rescan',
        });
    });

    it('does not leak the context past the callback', async () => {
        await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async () => undefined,
            { customPrisma: mockPrisma },
        );

        expect(getAuditContext()).toBeUndefined();
    });

    it('falls back to a job-shaped requestId when the trigger had none', async () => {
        let seen: ReturnType<typeof getAuditContext>;

        await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'av-rescan' },
            async () => {
                seen = getAuditContext();
            },
            { customPrisma: mockPrisma },
        );

        expect(seen?.requestId).toBe('job:av-rescan');
        // The same value reaches `app.request_id`, so a log line and the row's
        // correlation id agree.
        expect(params[1][1]).toBe('job:av-rescan');
    });
});

// ════════════════════════════════════════════════════════════════════
// The refusal — this is the block that earns the helper
// ════════════════════════════════════════════════════════════════════

describe('runInTenantJobContext refuses a label that would disable the tenant DEK', () => {
    it.each([...KEK_BYPASS_SOURCES])('rejects source %s', async (source) => {
        await expect(
            runInTenantJobContext(
                { tenantId: 'tenant-a', source },
                async () => 'never',
                { customPrisma: mockPrisma },
            ),
        ).rejects.toThrow(/refuses source/);

        // Refused BEFORE anything reached the database — a helper that threw
        // after opening the transaction would still have side effects.
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(statements).toEqual([]);
    });

    it('accepts a job name that merely resembles one', async () => {
        // Guard against a substring check creeping in: 'job-runner' is not
        // 'job', and refusing it would push its author towards 'api'.
        const result = await runInTenantJobContext(
            { tenantId: 'tenant-a', source: 'job-runner' },
            async () => 'ran',
            { customPrisma: mockPrisma },
        );
        expect(result).toBe('ran');
    });

    it('refuses a job with no tenant, pointing at the cross-tenant helper', async () => {
        await expect(
            runInTenantJobContext(
                { tenantId: '', source: 'av-rescan' },
                async () => 'never',
                { customPrisma: mockPrisma },
            ),
        ).rejects.toThrow(/cross-tenant-sweep/);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════
// The shared list itself
// ════════════════════════════════════════════════════════════════════

describe('KEK_BYPASS_SOURCES is the one list three call sites read', () => {
    it('holds exactly the three tenant-less labels', () => {
        // A fourth entry silently widens what the encryption middleware treats
        // as "no tenant DEK expected" — every ciphertext under that source
        // reads back null. It is an architectural decision, not a routine one.
        expect([...KEK_BYPASS_SOURCES].sort()).toEqual(['job', 'seed', 'system']);
    });

    it('does not treat an absent source as a bypass', () => {
        // An absent source means nobody declared anything, which is exactly
        // the case the RLS tripwire exists to shout about. Reading it as a
        // bypass would silence the warning that found this bug.
        expect(isKekBypassSource(undefined)).toBe(false);
        expect(isKekBypassSource(null)).toBe(false);
        expect(isKekBypassSource('')).toBe(false);
        expect(isKekBypassSource('job')).toBe(true);
    });

    it('agrees with the automation dispatcher that already dodged this trap', async () => {
        const { AUTOMATION_DISPATCH_SOURCE } = await import(
            '@/app-layer/automation/tenant-dek-read'
        );
        // `tenant-dek-read.ts` exists because the automation dispatchers hit
        // the read half of this trap in production — the middleware handed
        // back raw ciphertext for `AutomationRule.webhookSecretEncrypted` and
        // it was used as the outbound HMAC key. Its escape hatch has to keep
        // agreeing with the list, or it silently stops working.
        expect(isKekBypassSource(AUTOMATION_DISPATCH_SOURCE)).toBe(false);
    });
});
