/**
 * #2501 — where the two syncs open transactions, and what is inside them.
 *
 * ═══ WHY A FAKE TRANSACTION RUNNER AND NOT A PASSTHROUGH MOCK ═══
 *
 * Every existing unit test in this area mocks `runInTenantContext` as
 * `(ctx, fn) => fn(mockDb)` — one shared db object, handed to every caller,
 * alive forever. That mock is INCAPABLE of showing the defect this file
 * exists for: it has no notion of a transaction beginning, ending, or being
 * rolled back, so the code under test behaved identically whether the
 * provider's HTTPS read sat inside the transaction or outside it, and
 * identically whether the catch's ERROR write landed on a live client or on
 * one Prisma had already closed.
 *
 * So the runner here models the two properties that actually matter:
 *
 *   1. NESTING IS OBSERVABLE. `openDepth` counts transactions currently in
 *      flight, so "the provider read happens with none open" is an assertion
 *      rather than a hope.
 *   2. A CLIENT DIES WITH ITS TRANSACTION. Each call gets its OWN handle, and
 *      using a handle after its callback has settled throws — which is what
 *      Prisma does. Under the old shape the catch wrote its ERROR row on
 *      exactly such a handle, and the row never existed.
 *
 * The closed-handle detector is itself proved by a positive control below,
 * because a detector that cannot fire would make every one of these pass.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (ctx: unknown, fn: (db: unknown) => unknown, options?: unknown) =>
        fakeRunInTenantContext(fn, options),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(() => '{}'),
    encryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncTruncated: jest.fn(),
    recordIdentityDeprovisioned: jest.fn(),
    recordDeprovisionRefused: jest.fn(),
}));

import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { runIdentitySync } from '@/app-layer/usecases/identity-sync';
import {
    SYNC_BOOKKEEPING_TX_TIMEOUT_MS,
    SYNC_UPSERT_CHUNK_SIZE,
    SYNC_WRITE_TX_TIMEOUT_MS,
} from '@/app-layer/integrations/sync-transaction';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';
import type { NormalizedIdentityAccount } from '@/app-layer/integrations/providers/identity/types';

const NOW = new Date('2026-09-12T03:00:00.000Z');

// ── The fake transaction runner ──────────────────────────────────────────

interface TxRecord {
    index: number;
    timeout: number | undefined;
    settled: boolean;
}

interface OpLog {
    tx: number;
    model: string;
    op: string;
    args: Record<string, unknown> | undefined;
}

/** Models and operations the two syncs reach for. */
const MODEL_OPS: Record<string, string[]> = {
    integrationConnection: ['findFirst', 'update', 'updateMany', 'count'],
    integrationExecution: ['create', 'update'],
    employee: ['upsert', 'findMany', 'update', 'updateMany'],
    connectedIdentityAccount: ['upsert', 'count', 'updateMany'],
};

/** What each operation resolves to, overridable per test. */
type Behaviour = (args: Record<string, unknown> | undefined) => unknown;

let txs: TxRecord[] = [];
let ops: OpLog[] = [];
let openDepth = 0;
let behaviours: Record<string, Behaviour> = {};
/** Set by the closed-handle guard. A non-null value fails the run loudly. */
let closedHandleUse: string | null = null;

function defaultBehaviour(key: string): unknown {
    switch (key) {
        case 'integrationConnection.findFirst':
            return { id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null };
        case 'integrationExecution.create':
            return { id: 'exec-1' };
        case 'employee.findMany':
            return [];
        case 'employee.updateMany':
        case 'connectedIdentityAccount.updateMany':
        case 'integrationConnection.updateMany':
            return { count: 0 };
        case 'connectedIdentityAccount.count':
            return 0;
        default:
            return {};
    }
}

function makeHandle(rec: TxRecord): Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>> {
    const handle: Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>> = {};
    for (const [model, opNames] of Object.entries(MODEL_OPS)) {
        handle[model] = {};
        for (const op of opNames) {
            const key = `${model}.${op}`;
            handle[model][op] = async (args?: Record<string, unknown>) => {
                if (rec.settled) {
                    // THE DEFECT, MODELLED. Prisma throws when a transaction
                    // client is used after its transaction ended — which is
                    // exactly what the old catch did with its ERROR write.
                    closedHandleUse = `${key} on tx#${rec.index}, which had already settled`;
                    throw new Error(`Transaction already closed: ${key}`);
                }
                ops.push({ tx: rec.index, model, op, args });
                const b = behaviours[key];
                return b ? b(args) : defaultBehaviour(key);
            };
        }
    }
    return handle;
}

async function fakeRunInTenantContext(fn: (db: unknown) => unknown, options?: unknown): Promise<unknown> {
    const rec: TxRecord = {
        index: txs.length,
        timeout: (options as { timeout?: number } | undefined)?.timeout,
        settled: false,
    };
    txs.push(rec);
    openDepth += 1;
    try {
        return await fn(makeHandle(rec));
    } finally {
        rec.settled = true;
        openDepth -= 1;
    }
}

beforeEach(() => {
    txs = [];
    ops = [];
    openDepth = 0;
    behaviours = {};
    closedHandleUse = null;
});

afterEach(() => {
    // Guards every test in the file at once: no arm may write on a dead client.
    expect(closedHandleUse).toBeNull();
});

// ── Fixtures ─────────────────────────────────────────────────────────────

function emp(i: number): NormalizedEmployee {
    return { externalId: `e${i}`, fullName: `Person ${i}`, workEmail: `p${i}@acme.test`, status: 'ACTIVE', managerEmail: null, startDate: null, endDate: null };
}

function acct(i: number): NormalizedIdentityAccount {
    return { externalUserId: `u${i}`, email: `u${i}@acme.test`, status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, onPremisesSyncEnabled: null, groups: [], lastActiveAt: NOW };
}

/** Records `openDepth` at the moment the provider is asked for the roster. */
function hrisProvider(roster: NormalizedEmployee[], seen: { depth: number[]; runningTxSettled: boolean[] }, runningTx: () => number) {
    return {
        listEmployees: jest.fn(async () => {
            seen.depth.push(openDepth);
            seen.runningTxSettled.push(txs[runningTx()]?.settled ?? false);
            return { employees: roster, complete: true, resumeToken: null };
        }),
    };
}

function identityProvider(accounts: NormalizedIdentityAccount[], seen: { depth: number[]; runningTxSettled: boolean[] }, runningTx: () => number) {
    return {
        listAccounts: jest.fn(async () => {
            seen.depth.push(openDepth);
            seen.runningTxSettled.push(txs[runningTx()]?.settled ?? false);
            return { accounts, complete: true, resumeToken: null };
        }),
    };
}

/** Index of the transaction that created the RUNNING execution row. */
function runningRowTx(): number {
    const create = ops.find((o) => o.model === 'integrationExecution' && o.op === 'create');
    return create ? create.tx : -1;
}

const upsertsPerTx = (model: string): number[] => {
    const counts = new Map<number, number>();
    for (const o of ops) {
        if (o.model === model && o.op === 'upsert') counts.set(o.tx, (counts.get(o.tx) ?? 0) + 1);
    }
    return [...counts.values()];
};

// ── The detector's own positive control ──────────────────────────────────

describe('the closed-handle detector can actually fire', () => {
    it('throws when a transaction client is used after its transaction ended', async () => {
        // Without this, every assertion in this file would be satisfied by a
        // runner that simply never notices — the "green certifies nothing"
        // shape. Proved here, then relied on by the `afterEach` above.
        let escaped: { integrationExecution: { update: (a?: Record<string, unknown>) => Promise<unknown> } } | null = null;
        await fakeRunInTenantContext(async (db) => {
            escaped = db as typeof escaped;
        });
        await expect(escaped!.integrationExecution.update({ where: { id: 'x' } })).rejects.toThrow(/Transaction already closed/);
        expect(closedHandleUse).toMatch(/already settled/);
        // Consumed deliberately: this test PROVES the tripwire, so its own
        // trip must not fail the shared afterEach.
        closedHandleUse = null;
    });
});

// ── hris-sync ────────────────────────────────────────────────────────────

describe('runHrisSync opens the right transactions', () => {
    it('reads the roster with NO transaction open, after the RUNNING row has committed', async () => {
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };
        const provider = hrisProvider([emp(1)], seen, runningRowTx);

        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PASSED');
        // POSITIVE CONTROL. An empty `seen.depth` would satisfy every
        // `.every(...)` below, so assert the provider was reached at all.
        expect(provider.listEmployees).toHaveBeenCalledTimes(1);
        expect(seen.depth).toEqual([0]);
        // And the run's own evidence is already on disk by then — that is the
        // half that makes a blown provider read survivable.
        expect(seen.runningTxSettled).toEqual([true]);
    });

    it('chunks the upserts, one bounded transaction each', async () => {
        const roster = Array.from({ length: SYNC_UPSERT_CHUNK_SIZE + 1 }, (_, i) => emp(i));
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };

        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: hrisProvider(roster, seen, runningRowTx) });

        expect(r.upserted).toBe(SYNC_UPSERT_CHUNK_SIZE + 1);
        const perTx = upsertsPerTx('employee');
        expect(perTx).toEqual([SYNC_UPSERT_CHUNK_SIZE, 1]);
        expect(Math.max(...perTx)).toBeLessThanOrEqual(SYNC_UPSERT_CHUNK_SIZE);
    });

    it('gives every transaction an explicit budget — none inherits Prisma\'s 5 s default', async () => {
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };
        await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: hrisProvider([emp(1)], seen, runningRowTx) });

        expect(txs.length).toBeGreaterThan(0); // positive control
        expect(txs.filter((t) => t.timeout === undefined)).toEqual([]);
        for (const t of txs) {
            expect([SYNC_BOOKKEEPING_TX_TIMEOUT_MS, SYNC_WRITE_TX_TIMEOUT_MS]).toContain(t.timeout);
        }
    });

    it('a blown WRITE budget leaves an ERROR execution row behind', async () => {
        // The observable the issue is named for. Under the old single
        // transaction this row did not exist: the RUNNING row rolled back with
        // the failure, and the catch's own update ran on the closed client, so
        // the run's only trace was an ABSENCE — identical to a dispatcher that
        // never fired.
        behaviours['employee.upsert'] = () => {
            throw new Error('Transaction API error: Transaction already closed: Could not perform operation (P2028)');
        };
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };

        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: hrisProvider([emp(1)], seen, runningRowTx) });

        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toMatch(/P2028/);
        // A blown budget is transient — the queue must be free to retry it,
        // unlike the deterministic truncation arms.
        expect(r.noRetry).toBeUndefined();
        const errorWrite = ops.find((o) => o.model === 'integrationExecution' && o.op === 'update' && (o.args?.data as { status?: string } | undefined)?.status === 'ERROR');
        expect(errorWrite).toBeDefined();
        // Written by a DIFFERENT transaction from the one that died.
        const failedTx = ops.filter((o) => o.model === 'employee' && o.op === 'upsert').at(-1)?.tx;
        expect(errorWrite!.tx).not.toBe(failedTx);
        expect(txs[errorWrite!.tx].timeout).toBe(SYNC_BOOKKEEPING_TX_TIMEOUT_MS);
    });
});

// ── identity-sync ────────────────────────────────────────────────────────

describe('runIdentitySync opens the right transactions', () => {
    beforeEach(() => {
        behaviours['integrationConnection.findFirst'] = () => ({ id: 'conn-1', provider: 'okta', configJson: {}, secretEncrypted: null, isEnabled: true, syncCursor: null, syncPassStartedAt: null });
    });

    it('enumerates the directory with NO transaction open, after the RUNNING row has committed', async () => {
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };
        const provider = identityProvider([acct(1)], seen, runningRowTx);

        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PASSED');
        expect(provider.listAccounts).toHaveBeenCalledTimes(1); // positive control
        expect(seen.depth).toEqual([0]);
        expect(seen.runningTxSettled).toEqual([true]);
    });

    it('chunks the upserts, one bounded transaction each', async () => {
        const accounts = Array.from({ length: SYNC_UPSERT_CHUNK_SIZE + 1 }, (_, i) => acct(i));
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };

        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: identityProvider(accounts, seen, runningRowTx) });

        expect(r.upserted).toBe(SYNC_UPSERT_CHUNK_SIZE + 1);
        expect(upsertsPerTx('connectedIdentityAccount')).toEqual([SYNC_UPSERT_CHUNK_SIZE, 1]);
    });

    it('measures and applies the deprovision reconcile inside ONE transaction', async () => {
        // The grouping that had to survive the split. The rails judge a COUNT
        // and then act on it; across two transactions a row could change
        // status in between, so the number an operator is shown would describe
        // a different set from the one that was swept.
        behaviours['connectedIdentityAccount.count'] = (args) =>
            (args?.where as { syncedAt?: unknown } | undefined)?.syncedAt !== undefined ? 3 : 100;
        behaviours['connectedIdentityAccount.updateMany'] = () => ({ count: 3 });
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };

        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: identityProvider([acct(1)], seen, runningRowTx) });

        expect(r.deprovisioned).toBe(3);
        const counts = ops.filter((o) => o.model === 'connectedIdentityAccount' && o.op === 'count');
        const sweep = ops.find((o) => o.model === 'connectedIdentityAccount' && o.op === 'updateMany');
        expect(counts).toHaveLength(2); // positive control — both rails measured
        expect(sweep).toBeDefined();
        expect(new Set([...counts.map((c) => c.tx), sweep!.tx]).size).toBe(1);
        // The cursor clear rides along, so a swept pass can never be resumed.
        const cursorClear = ops.find(
            (o) => o.model === 'integrationConnection' && o.op === 'updateMany' && (o.args?.data as { syncCursor?: unknown } | undefined)?.syncCursor === null,
        );
        expect(cursorClear?.tx).toBe(sweep!.tx);
    });

    it('a blown WRITE budget leaves an ERROR execution row behind', async () => {
        behaviours['connectedIdentityAccount.upsert'] = () => {
            throw new Error('Transaction API error: Transaction already closed (P2028)');
        };
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };

        const r = await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: identityProvider([acct(1)], seen, runningRowTx) });

        expect(r.status).toBe('ERROR');
        expect(r.noRetry).toBeUndefined();
        const errorWrite = ops.find((o) => o.model === 'integrationExecution' && o.op === 'update' && (o.args?.data as { status?: string } | undefined)?.status === 'ERROR');
        expect(errorWrite).toBeDefined();
        const failedTx = ops.filter((o) => o.model === 'connectedIdentityAccount' && o.op === 'upsert').at(-1)?.tx;
        expect(errorWrite!.tx).not.toBe(failedTx);
    });

    it('gives every transaction an explicit budget', async () => {
        const seen = { depth: [] as number[], runningTxSettled: [] as boolean[] };
        await runIdentitySync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: identityProvider([acct(1)], seen, runningRowTx) });

        expect(txs.length).toBeGreaterThan(0);
        expect(txs.filter((t) => t.timeout === undefined)).toEqual([]);
    });
});
