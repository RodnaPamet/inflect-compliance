/* eslint-disable @typescript-eslint/no-explicit-any -- fakeDb shims mirror
 * runtime Prisma contracts; per-line typing has poor cost/benefit in test
 * files (codebase convention — see tests/unit/usecases/due-planning.test.ts). */
/**
 * List USECASES validate enum filters instead of casting them.
 *
 * The repository-layer half of this bug was fixed first (see
 * `tests/unit/repositories/list-filter-enum-validation.test.ts`), but four
 * list usecases assemble their own `where` clause rather than delegating to a
 * repository, so the same cast survived there:
 *
 *     where.status = filters.status as TestPlanStatus;                  // ✗
 *     ...(opts.status ? { status: opts.status as never } : {})          // ✗
 *
 * The cast only satisfies the compiler. Prisma still validates at query time
 * and throws `PrismaClientValidationError` on both shapes the UI produces —
 * a comma-joined multi-select (`?status=ACTIVE,PAUSED`, which is exactly what
 * a `multiple: true` facet serialises to via `toApiSearchParams`) and a status
 * belonging to another entity's enum, carried over on a shared `status` key.
 * `PrismaClientValidationError` has no mapping in `src/lib/errors/types.ts`,
 * so it fell through to a **500**; and because these pages read the same
 * filters in their Server Component, it took the whole section down with
 * "Something went wrong" rather than failing one fetch.
 *
 * `GET /api/t/{slug}/tests/plans?status=ACTIVE,PAUSED` was the live one.
 *
 * Each case asserts the two halves of the fix at the usecase boundary:
 *
 *   1. a valid multi-select reaches Prisma as `{ in: [...] }` — the shape
 *      Prisma accepts — never as one comma-joined literal;
 *   2. an unknown member never reaches Prisma at all; it throws a 400-shaped
 *      error before the query is built.
 */

// Both `runInTenantContext` seams — `due-planning` uses the `@/lib/db-context`
// re-export, the other three import from the middleware module directly.
// Both modules keep their real exports — `src/lib/prisma.ts` builds its
// extended client from `withRlsTripwireExtension`, so a wholesale module
// replacement breaks the import graph before a single test runs.
jest.mock('@/lib/db-context', () => {
    const fn = jest.fn();
    return {
        ...jest.requireActual('@/lib/db-context'),
        runInTenantContext: fn,
        runInTenantReadContext: fn,
    };
});
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { listAllTestPlans } from '@/app-layer/usecases/due-planning';
import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { listTenantFrameworkDeltas } from '@/app-layer/usecases/framework-delta';
import { listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { runInTenantContext as runViaDbContext } from '@/lib/db-context';
import { runInTenantContext as runViaRls } from '@/lib/db/rls-middleware';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

const mockDbContext = runViaDbContext as jest.MockedFunction<any>;
const mockRls = runViaRls as jest.MockedFunction<any>;

beforeEach(() => {
    jest.clearAllMocks();
});

/**
 * Stub the tenant-context seam with a fake `db` exposing one model's
 * `findMany`, and hand back the spy so the `where` can be inspected.
 */
function arrange(seam: jest.MockedFunction<any>, model: string) {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = { [model]: { findMany } } as any;
    seam.mockImplementation(async (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db));
    return findMany;
}

/** The `where` clause the usecase handed to Prisma. */
function capturedWhere(findMany: jest.Mock): any {
    expect(findMany).toHaveBeenCalledTimes(1);
    return findMany.mock.calls[0]![0].where;
}

interface Case {
    /** Human label for the test name. */
    name: string;
    /** Which `runInTenantContext` import the usecase reaches for. */
    seam: () => jest.MockedFunction<any>;
    /** Prisma model key on the fake db. */
    model: string;
    /** Invoke the list usecase with a raw `status` off the query string. */
    list: (status?: string) => Promise<unknown>;
    /** Two REAL members of the enum, comma-joined by the UI's multi-select. */
    validPair: [string, string];
    /** A value that is NOT a member of this enum. */
    invalid: string;
    /** Fragment of the expected 400 message. */
    label: string;
    /** The route that reaches this usecase with an unvalidated string. */
    route: string;
    /**
     * What `where.status` must be when the caller supplies NO filter.
     *
     * Undefined for every listing but one. `listAgentProposals` names the
     * REVIEWABLE set even with no filter, because the review queue must never
     * be able to return a QUARANTINED proposal — not through an absent
     * parameter, and not through `?status=QUARANTINED` either (that is a 400,
     * asserted by the invalid-member case above, since QUARANTINED is not in
     * the vocabulary this listing parses against).
     */
    absentStatus?: unknown;
}

const CASES: Case[] = [
    {
        name: 'listAllTestPlans',
        seam: () => mockDbContext,
        model: 'controlTestPlan',
        list: (status) => listAllTestPlans(ctx, status === undefined ? {} : { status }),
        validPair: ['ACTIVE', 'PAUSED'],
        // A ControlStatus / VendorStatus, not a TestPlanStatus.
        invalid: 'IMPLEMENTED',
        label: 'test plan status',
        route: 'GET /api/t/:slug/tests/plans?status=',
    },
    {
        name: 'listAgentProposals',
        seam: () => mockRls,
        model: 'agentProposal',
        list: (status) => listAgentProposals(ctx, status === undefined ? {} : { status }),
        validPair: ['PENDING', 'ACCEPTED'],
        invalid: 'ACTIVE',
        label: 'proposal status',
        route: 'GET /api/t/:slug/agent-proposals?status=',
        absentStatus: { in: ['PENDING', 'ACCEPTED', 'REJECTED', 'EDITED'] },
    },
    {
        name: 'listTenantFrameworkDeltas',
        seam: () => mockRls,
        model: 'tenantFrameworkDelta',
        list: (status) => listTenantFrameworkDeltas(ctx, status === undefined ? {} : { status }),
        validPair: ['NEW', 'REVIEWED'],
        invalid: 'ACTIVE',
        label: 'framework delta status',
        route: 'GET /api/t/:slug/framework-updates?status=',
    },
    {
        name: 'listWorkflowRuns',
        seam: () => mockRls,
        model: 'workflowRun',
        list: (status) => listWorkflowRuns(ctx, status === undefined ? {} : { status }),
        validPair: ['RUNNING', 'COMPLETED'],
        invalid: 'ACTIVE',
        label: 'workflow run status',
        route: 'GET /api/t/:slug/agent-runs?status=',
    },
];

describe.each(CASES)(
    '$name — enum filters are validated, not cast',
    ({ seam, model, list, validPair, invalid, label, route, absentStatus }) => {
        it('passes a single valid member through as a scalar', async () => {
            const findMany = arrange(seam(), model);
            await list(validPair[0]);
            expect(capturedWhere(findMany).status).toBe(validPair[0]);
        });

        it(`expands a comma-joined multi-select into an \`in\` filter (${route}${'…'})`, async () => {
            const findMany = arrange(seam(), model);
            const joined = `${validPair[0]},${validPair[1]}`;

            // The bug: this used to reach Prisma as one literal string and
            // 500 the page. It must return rows instead.
            await expect(list(joined)).resolves.toEqual([]);

            const where = capturedWhere(findMany);
            expect(where.status).toEqual({ in: [validPair[0], validPair[1]] });
            expect(where.status).not.toBe(joined);
        });

        it('rejects an unknown member with a 400 before touching Prisma', async () => {
            const findMany = arrange(seam(), model);

            await expect(list(invalid)).rejects.toMatchObject({ status: 400 });
            await expect(list(invalid)).rejects.toThrow(
                new RegExp(`Invalid ${label} "${invalid}"`),
            );
            // Never reached the database — a 500 was the old outcome.
            expect(findMany).not.toHaveBeenCalled();
        });

        it('rejects a mixed list containing one unknown member', async () => {
            const findMany = arrange(seam(), model);
            await expect(list(`${validPair[0]},${invalid}`)).rejects.toMatchObject({
                status: 400,
            });
            expect(findMany).not.toHaveBeenCalled();
        });

        it('still scopes to the tenant and applies the declared default when absent', async () => {
            const findMany = arrange(seam(), model);
            await list(undefined);
            const where = capturedWhere(findMany);
            expect(where.tenantId).toBe(ctx.tenantId);
            expect(where.status).toEqual(absentStatus);
        });

        it('tolerates duplicates and whitespace in the multi-select', async () => {
            const findMany = arrange(seam(), model);
            await list(` ${validPair[0]} , ${validPair[1]}, ${validPair[0]} `);
            expect(capturedWhere(findMany).status).toEqual({
                in: [validPair[0], validPair[1]],
            });
        });
    },
);
