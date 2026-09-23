/**
 * The two behavioural halves of "a Flue guard verdict reaches its controls":
 * which status a verdict settles to, and whether the breaker's count can see a
 * block that produced no proposal.
 *
 * `executeFlueRun` itself cannot be imported under this project (`@flue/runtime`
 * is ESM-only), and its wiring is pinned in
 * `tests/guards/flue-guard-outcome-has-arms.test.ts`. What CAN be run is the
 * two functions that own the decisions, and those are the ones a reader would
 * get wrong.
 */
const runUpdate = jest.fn(async (_a: unknown): Promise<unknown> => ({}));
const proposalCount = jest.fn(async (_a: unknown): Promise<number> => 0);
const stepCount = jest.fn(async (_a: unknown): Promise<number> => 0);
const breakerUpdateMany = jest.fn(async (_a: unknown): Promise<unknown> => ({ count: 0 }));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ workflowRun: { update: runUpdate } })),
}));
// BOTH shapes. `circuit-breaker-store` takes the DEFAULT export
// (`import prisma from '@/lib/prisma'`), and a named-only mock leaves it
// `undefined` — which does not fail loudly, because `latchOnGuardBlock`
// swallows its own errors and answers `{ blocksInWindow: 0 }`. A broken mock
// and a genuinely quiet window are then indistinguishable, so the assertions
// below would have passed against nothing had they expected zero.
jest.mock('@/lib/prisma', () => {
    // PERMISSIVE for every model except the three under test.
    //
    // Latching the breaker calls `notifyBreakerTrip`, which reads further
    // tables — so a mock listing only the tables this test asserts on crashes
    // the moment the trip case actually works. The Proxy keeps the assertions
    // narrow without making the happy path unreachable.
    const named = {
        agentProposal: { count: (a: unknown) => proposalCount(a) },
        workflowStep: { count: (a: unknown) => stepCount(a) },
        agentCircuitBreaker: { updateMany: (a: unknown) => breakerUpdateMany(a) },
    } as Record<string, unknown>;
    const permissive = () =>
        new Proxy(
            {},
            {
                get: () => async () => null,
            },
        );
    // BOTH shapes. `circuit-breaker-store` takes the DEFAULT export
    // (`import prisma from '@/lib/prisma'`), and a named-only mock leaves it
    // `undefined` — which does not fail loudly, because `latchOnGuardBlock`
    // swallows its own errors and answers `{ blocksInWindow: 0 }`. A broken
    // mock and a genuinely quiet window are then indistinguishable, so the
    // assertions below would have passed against nothing had they expected zero.
    const client = new Proxy(named, {
        get: (t, k: string) => (k in t ? t[k] : permissive()),
    });
    return { __esModule: true, default: client, prisma: client };
});
const appendAuditEntry = jest.fn(async () => undefined);
// `@/lib/audit` is the barrel `run-settlement` takes `appendAuditEntry` from.
// Mocked to the ONE export used here: the module's other exports reach the
// hash chain and the Prisma client, and a test about run status has no business
// loading either.
jest.mock('@/lib/audit', () => ({ appendAuditEntry: () => appendAuditEntry() }));
// `circuit-breaker-store` takes its logger from the leaf, not the barrel.
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { haltRunAtGuard } from '@/lib/agentic/drivers/run-settlement';
import { latchOnGuardBlock } from '@/lib/agentic/circuit-breaker-store';
import { GUARD_BLOCK_TRIP_THRESHOLD } from '@/lib/agentic/circuit-breaker';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const dataOf = (call: number) => (runUpdate.mock.calls[call][0] as { data: Record<string, unknown> }).data;

beforeEach(() => {
    jest.clearAllMocks();
    proposalCount.mockResolvedValue(0);
    stepCount.mockResolvedValue(0);
    breakerUpdateMany.mockResolvedValue({ count: 0 });
});

describe('which status a verdict settles to', () => {
    it('a BLOCK aborts, and stamps the run finished', async () => {
        const status = await haltRunAtGuard(ctx, 'run-1', 'QUARANTINED', ['egress.pii']);
        expect(status).toBe('ABORTED');
        expect(dataOf(0)).toMatchObject({ status: 'ABORTED' });
        expect(dataOf(0).completedAt).toBeInstanceOf(Date);
    });

    it('a FLAG awaits approval, and does NOT stamp it finished', async () => {
        // The half a reader gets wrong. A run waiting on a human is not
        // complete, and the reaper leaves AWAITING_APPROVAL alone however old
        // it is — which only makes sense if `completedAt` is absent.
        const status = await haltRunAtGuard(ctx, 'run-2', 'FLAGGED', ['injection.instruction']);
        expect(status).toBe('AWAITING_APPROVAL');
        expect(dataOf(0)).toMatchObject({ status: 'AWAITING_APPROVAL' });
        expect(dataOf(0).completedAt).toBeUndefined();
    });

    it('neither settles FAILED — nothing went wrong with the engine', async () => {
        for (const v of ['QUARANTINED', 'FLAGGED'] as const) {
            runUpdate.mockClear();
            await haltRunAtGuard(ctx, 'run-3', v, []);
            expect(dataOf(0).status).not.toBe('FAILED');
        }
    });

    it('the message names the rules, and survives having none', async () => {
        await haltRunAtGuard(ctx, 'run-4', 'QUARANTINED', ['egress.secret', 'egress.pii']);
        expect(dataOf(0).errorMessage).toContain('egress.secret, egress.pii');
        runUpdate.mockClear();
        // An outcome that blocked without naming a rule must still produce a
        // readable message rather than an empty parenthesis.
        await haltRunAtGuard(ctx, 'run-5', 'QUARANTINED', []);
        expect(dataOf(0).errorMessage).toContain('no rule ids recorded');
    });
});

describe('the breaker can count a block that produced no proposal', () => {
    it('sums both populations', async () => {
        proposalCount.mockResolvedValue(1);
        stepCount.mockResolvedValue(2);
        const out = await latchOnGuardBlock('t1', 'agent-1', new Date());
        expect(out.blocksInWindow).toBe(3);
    });

    it('trips on step blocks ALONE — the Flue case, and the whole point', async () => {
        // Before this, a Flue agent could be blocked any number of times and
        // the count stayed at zero because it writes no proposals.
        proposalCount.mockResolvedValue(0);
        stepCount.mockResolvedValue(GUARD_BLOCK_TRIP_THRESHOLD);
        breakerUpdateMany.mockResolvedValue({ count: 1 });

        const out = await latchOnGuardBlock('t1', 'agent-1', new Date());
        expect(out.blocksInWindow).toBe(GUARD_BLOCK_TRIP_THRESHOLD);
        expect(out.latched).toBe(true);
    });

    it('stays shut below the threshold, so the sum is a threshold and not a trigger', async () => {
        proposalCount.mockResolvedValue(0);
        stepCount.mockResolvedValue(GUARD_BLOCK_TRIP_THRESHOLD - 1);
        const out = await latchOnGuardBlock('t1', 'agent-1', new Date());
        expect(out.latched).toBe(false);
        expect(breakerUpdateMany).not.toHaveBeenCalled();
    });

    it('scopes the step count to this agent and this window', async () => {
        const now = new Date();
        await latchOnGuardBlock('t1', 'agent-7', now);
        const where = (stepCount.mock.calls[0][0] as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({
            tenantId: 't1',
            guardVerdict: 'QUARANTINED',
            run: { agentId: 'agent-7' },
        });
        expect(where.at).toBeDefined();
    });
});
