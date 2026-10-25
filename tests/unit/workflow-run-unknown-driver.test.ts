/**
 * A RUN THIS BUILD CANNOT NAME THE ENGINE OF (#4241).
 *
 * `WorkflowRun.driver` is the Prisma enum `AgentDriverMode`. Across a rollback
 * past a third engine, rows hold a value this build's client was not generated
 * with, and the client does not return it: its data mapper throws
 * `Value 'X' not found in enum 'AgentDriverMode'` and the whole operation fails.
 * Before the fix that took down the run store the driver reads its own run
 * through, the run list, the run page, every `update` that returns the row
 * (settling a run FAILED, an operator's abort) and the two capture usecases
 * that select the column.
 *
 * ═══ THE DOUBLE, AND WHY IT IS THE POINT ═══
 *
 * #4224 survived its unit suite because that suite's double RETURNED the
 * unknown string — the one thing the real client will not do. The double here
 * does what the real client does instead: it THROWS the mapper's error whenever
 * the call's shape would return `driver`, and answers only when the call
 * selects around it or omits it. So every test below fails on the code before
 * the fix, for the reason production failed, rather than for a missing export.
 *
 * The rule it applies is Prisma's: a `select` returns only what it names; with
 * no `select`, every scalar comes back unless `omit` removes it; and only a
 * label the client was not generated with fails to map. The real-client
 * measurement is `tests/integration/workflow-run-unknown-driver.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

const UNKNOWN = 'TEST_UNKNOWN_DRIVER';
const RUN_ID = 'run-unknown-1';

type Args = {
    select?: Record<string, unknown>;
    omit?: Record<string, unknown>;
    include?: Record<string, unknown>;
    data?: Record<string, unknown>;
};

/** Would the real client's result for these args carry `driver`? */
function returnsDriver(args: Args | undefined): boolean {
    if (args?.select) return Boolean(args.select.driver);
    return args?.omit?.driver !== true;
}

function mapperError(): Error {
    return new Error(`Value '${UNKNOWN}' not found in enum 'AgentDriverMode'`);
}

let stored: Record<string, unknown>;

/** The labels this build's client was generated with. */
const GENERATED_LABELS = new Set(['STATIC', 'FLUE']);

/** The row the client would hand back for these args — scalars, then relations. */
function project(row: Record<string, unknown>, args: Args | undefined): Record<string, unknown> {
    // Only a value the client was NOT generated with fails, and only when the
    // result carries it — a known engine maps happily, which is why the known
    // cases below pass before the fix and after it alike.
    if (returnsDriver(args) && !GENERATED_LABELS.has(String(row.driver))) throw mapperError();
    let out: Record<string, unknown>;
    if (args?.select) {
        out = Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k]]));
    } else {
        out = Object.fromEntries(Object.entries(row).filter(([k]) => !args?.omit?.[k]));
    }
    for (const rel of Object.keys(args?.include ?? {})) {
        out[rel] = rel === '_count' ? { proposals: 0 } : [];
    }
    return out;
}

const findFirst = jest.fn(async (args: Args) => project(stored, args));
const findMany = jest.fn(async (args: Args) => [project(stored, args)]);
const update = jest.fn(async (args: Args) => {
    // The statement RUNS — Prisma maps the RETURNING row afterwards, which is
    // why an unqualified update failed after doing its work.
    stored = { ...stored, ...args.data };
    return project(stored, args);
});
/** `SELECT "driver"::text` — the database does the cast, so the bytes arrive. */
const queryRaw = jest.fn(async (..._a: unknown[]) => [{ id: RUN_ID, driver: stored.driver }]);
const aiDecisionUpdateMany = jest.fn(async () => ({ count: 0 }));

const mockDb = {
    workflowRun: { findFirst, findMany, update },
    aiDecisionLog: { updateMany: aiDecisionUpdateMany },
    $queryRaw: queryRaw,
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
// `strictMock`: `@/lib/audit` is a guarded barrel (partial-mock-of-a-guarded-barrel),
// so an export this fixture forgot fails loudly rather than resolving undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => undefined),
        appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain', auditId: 'a' })),
    }),
);
jest.mock('@/app-layer/ai/decision-log', () => ({
    ...jest.requireActual('@/app-layer/ai/decision-log'),
    recordDecisionOutcome: jest.fn(async () => 0),
}));

import { getRunRow } from '@/lib/agentic/drivers/run-store';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import {
    abortWorkflowRun,
    getWorkflowRun,
    listWorkflowRuns,
} from '@/app-layer/usecases/workflow-runs';
import {
    captureReviewAttribution,
    REVIEW_WORKFLOW_KEY,
} from '@/app-layer/usecases/agent-harness-attribution';
import {
    captureAuditNarrative,
    NARRATIVE_WORKFLOW_KEY,
} from '@/app-layer/usecases/audit-workpaper-narrative';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function storedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: RUN_ID,
        tenantId: ctx.tenantId,
        workflowKey: 'posture-review',
        status: 'RUNNING',
        driver: UNKNOWN,
        stepCount: 2,
        costTokens: 40,
        contextJson: null,
        contextHash: null,
        mountedSkills: [],
        completedAt: null,
        startedAt: new Date('2026-10-25T08:00:00Z'),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    stored = storedRun();
});

describe('the double is faithful (control)', () => {
    it('an unqualified read of the stored row throws the mapper error, as the real client does', async () => {
        // Without this, every passing test below would be consistent with a
        // double that never throws — the exact hole #4224 fell through.
        await expect(mockDb.workflowRun.findFirst({})).rejects.toThrow(/not found in enum 'AgentDriverMode'/);
        await expect(mockDb.workflowRun.update({ data: {} })).rejects.toThrow(/not found in enum/);
    });

    it('…and a known engine maps, so the double does not refuse everything', async () => {
        stored = storedRun({ driver: 'STATIC' });
        await expect(mockDb.workflowRun.findFirst({})).resolves.toMatchObject({ driver: 'STATIC' });
    });
});

describe('the driver can still read and settle its own run', () => {
    it('the run store reads the row', async () => {
        const run = await getRunRow(ctx, RUN_ID);
        expect(run).toMatchObject({ id: RUN_ID, costTokens: 40, status: 'RUNNING' });
        expect(run).not.toHaveProperty('driver');
    });

    it('failRun settles it — the write lands and its returned row maps', async () => {
        await expect(failRun(ctx, RUN_ID, 'stopped')).resolves.toBe('FAILED');
        expect(stored).toMatchObject({ status: 'FAILED', errorMessage: 'stopped' });
    });

    it('an operator can abort it', async () => {
        await expect(abortWorkflowRun(ctx, RUN_ID)).resolves.toBeUndefined();
        expect(stored.status).toBe('ABORTED');
    });
});

describe('the run list and the run page answer, and say the engine is unrecognised', () => {
    it('getWorkflowRun returns the run with its engine read as text and coerced', async () => {
        const run = await getWorkflowRun(ctx, RUN_ID);
        expect(run).toMatchObject({ id: RUN_ID, driver: 'UNRECOGNISED', steps: [], proposals: [] });
    });

    it('getWorkflowRun reports a known engine as itself', async () => {
        stored = storedRun({ driver: 'FLUE' });
        expect((await getWorkflowRun(ctx, RUN_ID)).driver).toBe('FLUE');
    });

    it('listWorkflowRuns returns every row, with one text read for the page', async () => {
        const runs = await listWorkflowRuns(ctx, {});
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ id: RUN_ID, driver: 'UNRECOGNISED', _count: { proposals: 0 } });
        expect(queryRaw).toHaveBeenCalledTimes(1);
    });
});

describe('the captures refuse by name rather than throw', () => {
    it('the review attribution capture', async () => {
        stored = storedRun({
            workflowKey: REVIEW_WORKFLOW_KEY,
            status: 'COMPLETED',
            completedAt: new Date('2026-10-25T09:00:00Z'),
        });
        await expect(captureReviewAttribution(ctx, RUN_ID)).resolves.toMatchObject({
            outcome: 'UNRECOGNISED_ENGINE',
        });
    });

    it('the audit narrative capture', async () => {
        stored = storedRun({ workflowKey: NARRATIVE_WORKFLOW_KEY, status: 'COMPLETED' });
        await expect(captureAuditNarrative(ctx, RUN_ID)).resolves.toMatchObject({
            outcome: 'UNRECOGNISED_ENGINE',
        });
    });

    it('a STATIC run is still NOT_A_MODEL_RUN — the new outcome is for the unknown only', async () => {
        stored = storedRun({ workflowKey: NARRATIVE_WORKFLOW_KEY, status: 'COMPLETED', driver: 'STATIC' });
        await expect(captureAuditNarrative(ctx, RUN_ID)).resolves.toMatchObject({ outcome: 'NOT_A_MODEL_RUN' });
    });
});
