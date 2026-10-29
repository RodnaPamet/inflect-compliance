/**
 * The personnel roster read says when it is cut, and filters in the query
 * (#4470).
 *
 * Before: `listEmployees` took 500 rows and returned them as if they were the
 * roster. The admin Personnel page then printed "500 people in the roster" for
 * a roster of 2,000, and its status filter ran over those 500 in the browser,
 * so "Terminated" could miss every leaver past the cap.
 *
 * What is pinned here:
 *   · the read takes one row PAST the cap, so a roster of exactly 500 and one
 *     of 501 are told apart, and `truncated` is a fact the read observed;
 *   · `total` is exact on both sides of the cap;
 *   · several statuses and a search reach the query, so a filtered view is
 *     answered from the whole roster;
 *   · `GET /personnel` forwards a repeated `status` and returns the envelope.
 */
const mockDb = {
    employee: { findMany: jest.fn(), count: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { makeRequestContext } from '../helpers/make-context';
import { listEmployees } from '@/app-layer/usecases/personnel';
import { PERSONNEL_ROSTER_CAP } from '@/lib/personnel-roster';

const ctx = makeRequestContext('ADMIN');

/** `n` roster rows, in the shape the read selects. */
function people(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        id: `e-${i}`,
        fullName: `Person ${i}`,
        workEmail: `p${i}@acme.test`,
        status: 'ACTIVE',
        department: null,
        jobTitle: null,
        managerEmployeeId: null,
        source: 'HRIS',
        startDate: null,
    }));
}

/** The `findMany` argument of the one read. */
function readArgs() {
    expect(mockDb.employee.findMany).toHaveBeenCalledTimes(1);
    return mockDb.employee.findMany.mock.calls[0][0];
}

beforeEach(() => {
    mockDb.employee.findMany.mockReset();
    mockDb.employee.count.mockReset();
});

describe('the cap is observed, not guessed', () => {
    it('reads one row past the cap', async () => {
        mockDb.employee.findMany.mockResolvedValue(people(3));
        await listEmployees(ctx);
        expect(readArgs().take).toBe(PERSONNEL_ROSTER_CAP + 1);
    });

    it('a roster that fits is not truncated, and is counted by its rows', async () => {
        mockDb.employee.findMany.mockResolvedValue(people(3));
        await expect(listEmployees(ctx)).resolves.toMatchObject({ truncated: false, total: 3 });
        expect(mockDb.employee.count).not.toHaveBeenCalled();
    });

    it('a roster of exactly the cap is whole', async () => {
        mockDb.employee.findMany.mockResolvedValue(people(PERSONNEL_ROSTER_CAP));
        const roster = await listEmployees(ctx);
        expect(roster.truncated).toBe(false);
        expect(roster.employees).toHaveLength(PERSONNEL_ROSTER_CAP);
        expect(roster.total).toBe(PERSONNEL_ROSTER_CAP);
    });

    it('one past the cap is truncated, returns the cap, and counts the rest', async () => {
        mockDb.employee.findMany.mockResolvedValue(people(PERSONNEL_ROSTER_CAP + 1));
        mockDb.employee.count.mockResolvedValue(2000);
        const roster = await listEmployees(ctx);
        expect(roster.truncated).toBe(true);
        expect(roster.employees).toHaveLength(PERSONNEL_ROSTER_CAP);
        // The header's number: the roster, not the page of it.
        expect(roster.total).toBe(2000);
        // Counted under the SAME filter the rows were read with.
        expect(mockDb.employee.count).toHaveBeenCalledWith({ where: readArgs().where });
    });
});

describe('filters reach the query', () => {
    it('several statuses become one IN, unknown ones dropped', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);
        await listEmployees(ctx, { status: ['TERMINATED', 'BOGUS', 'LEAVE'] });
        expect(readArgs().where).toEqual({ tenantId: ctx.tenantId, status: { in: ['TERMINATED', 'LEAVE'] } });
    });

    it('a single status is still accepted', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);
        await listEmployees(ctx, { status: 'TERMINATED' });
        expect(readArgs().where.status).toEqual({ in: ['TERMINATED'] });
    });

    it('no known status means no status filter, as before', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);
        await listEmployees(ctx, { status: ['BOGUS'] });
        expect(readArgs().where).toEqual({ tenantId: ctx.tenantId });
    });

    it('a search matches name or email, trimmed', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);
        await listEmployees(ctx, { search: '  ada ' });
        expect(readArgs().where.OR).toEqual([
            { fullName: { contains: 'ada', mode: 'insensitive' } },
            { workEmail: { contains: 'ada', mode: 'insensitive' } },
        ]);
    });

    it('a blank search is no search', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);
        await listEmployees(ctx, { search: '   ' });
        expect(readArgs().where.OR).toBeUndefined();
    });
});

describe('GET /personnel', () => {
    // The route's own gate is `requirePermission('personnel.view')`, held by
    // the coverage guardrails; what is under test here is what it forwards.
    it('forwards a repeated status and answers the roster envelope', async () => {
        jest.resetModules();
        const list = jest.fn(async () => ({ employees: [], truncated: true, total: 900 }));
        jest.doMock('@/app-layer/usecases/personnel', () => ({
            listEmployees: list,
            createEmployee: jest.fn(),
            CreateEmployeeSchema: {},
        }));
        jest.doMock('@/lib/security/permission-middleware', () => ({
            requirePermission: (_key: string, handler: unknown) => handler,
        }));
        jest.doMock('@/lib/errors/api', () => ({ withApiErrorHandling: (handler: unknown) => handler }));
        const { GET } = await import('@/app/api/t/[tenantSlug]/personnel/route');

        const res = await (GET as unknown as (r: NextRequest, a: unknown, c: unknown) => Promise<Response>)(
            new NextRequest('https://x/api/t/acme/personnel?status=TERMINATED&status=LEAVE&q=ada'),
            {},
            ctx,
        );

        expect(list).toHaveBeenCalledWith(ctx, { status: ['TERMINATED', 'LEAVE'], search: 'ada' });
        await expect(res.json()).resolves.toEqual({ employees: [], truncated: true, total: 900 });
    });
});
