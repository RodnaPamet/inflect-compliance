/**
 * The two calendar API routes — the first executing tests either has had.
 *
 * Both were 100% regex-over-source before this: nothing called them, so
 * nothing checked that the query parser rejects a bad range, that the badge's
 * `days` bound is enforced, that the permission gate actually denies, or that
 * the `scope` contract the badge publishes survives a refactor.
 *
 * These drive the REAL route exports with `getTenantCtx` and the usecase
 * mocked, so what is under test is the route's own behaviour: parsing,
 * gating, and the response shape it promises.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const getEventsMock = jest.fn();
const getBadgeCountMock = jest.fn();
const auditDeniedMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/compliance-calendar', () => {
    const actual = jest.requireActual('@/app-layer/usecases/compliance-calendar');
    return {
        __esModule: true,
        // The baseline permission list is REAL — mocking it would let the
        // route's gate pass against a list that no longer matches the sources.
        CALENDAR_BASELINE_PERMISSIONS: actual.CALENDAR_BASELINE_PERMISSIONS,
        getComplianceCalendarEvents: (...a: unknown[]) => getEventsMock(...a),
        getMyUpcomingTaskCount: (...a: unknown[]) => getBadgeCountMock(...a),
    };
});

// The denial path writes a hash-chained AUTHZ_DENIED row; stub the write, keep
// the gate.
jest.mock('@/lib/audit', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => auditDeniedMock(...a),
}));

import { GET as calendarGET } from '@/app/api/t/[tenantSlug]/calendar/route';
import { GET as countGET } from '@/app/api/t/[tenantSlug]/calendar/upcoming-count/route';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

function ctxFor(role: Role) {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

/** A caller holding NO view permissions at all — the scopeless-API-key shape. */
function ctxWithNoPermissions() {
    const base = ctxFor('READER');
    const stripped = JSON.parse(JSON.stringify(base.appPermissions));
    for (const domain of Object.keys(stripped)) {
        for (const flag of Object.keys(stripped[domain])) stripped[domain][flag] = false;
    }
    return { ...base, appPermissions: stripped };
}

const ROUTE_ARGS = { params: Promise.resolve({ tenantSlug: 'acme' }) };

const CALENDAR_RESPONSE = {
    events: [],
    counts: { total: 0, partial: false },
    truncation: { capped: false, sources: [], perSourceLimit: 500, totalCap: 5000, totalCapped: false },
    omittedSources: [],
    failedSources: [],
    todayYmd: '2026-06-01',
    range: { from: '2026-05-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
};

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(ctxFor('ADMIN'));
    getEventsMock.mockResolvedValue(CALENDAR_RESPONSE);
    getBadgeCountMock.mockResolvedValue(7);
});

function req(url: string) {
    return new NextRequest(new URL(url));
}

describe('GET /calendar', () => {
    it('forwards the parsed range to the usecase', async () => {
        const res = await calendarGET(
            req('https://x.test/api/t/acme/calendar?from=2026-05-01&to=2026-07-01') as never,
            ROUTE_ARGS as never,
        );
        expect(res.status).toBe(200);
        const arg = getEventsMock.mock.calls[0][1];
        // Parsed into Dates, not passed through as the raw strings.
        expect(arg.from).toBeInstanceOf(Date);
        expect(arg.to).toBeInstanceOf(Date);
    });

    it('passes category + type filters through', async () => {
        await calendarGET(
            req('https://x.test/api/t/acme/calendar?from=2026-05-01&to=2026-07-01&categories=risk,control') as never,
            ROUTE_ARGS as never,
        );
        const arg = getEventsMock.mock.calls[0][1];
        expect(arg.categories).toEqual(expect.arrayContaining(['risk', 'control']));
    });

    it('rejects a request with no range rather than defaulting one', async () => {
        // A silent default would make an unbounded aggregation the easiest
        // thing to trigger by accident. `withApiErrorHandling` turns the
        // validation throw into a 4xx response, so assert the STATUS — a
        // `.rejects` assertion here would fail for the wrong reason.
        const res = await calendarGET(
            req('https://x.test/api/t/acme/calendar') as never,
            ROUTE_ARGS as never,
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(getEventsMock).not.toHaveBeenCalled();
    });

    it('denies a caller holding none of the baseline view permissions', async () => {
        // The scopeless-API-key case: without this gate such a caller reads
        // the whole tenant deadline stream across every domain.
        getTenantCtxMock.mockResolvedValue(ctxWithNoPermissions());
        const res = await calendarGET(
            req('https://x.test/api/t/acme/calendar?from=2026-05-01&to=2026-07-01') as never,
            ROUTE_ARGS as never,
        );
        expect(res.status).toBe(403);
        expect(getEventsMock).not.toHaveBeenCalled();
    });

    it('returns the response verbatim, including the partial-result fields', async () => {
        getEventsMock.mockResolvedValue({
            ...CALENDAR_RESPONSE,
            failedSources: ['risk'],
            counts: { total: 0, partial: true },
        });
        const res = await calendarGET(
            req('https://x.test/api/t/acme/calendar?from=2026-05-01&to=2026-07-01') as never,
            ROUTE_ARGS as never,
        );
        const body = await res.json();
        // The route must not sanitise these away — a dropped `failedSources`
        // turns a partial answer back into a silently complete-looking one.
        expect(body.failedSources).toEqual(['risk']);
        expect(body.counts.partial).toBe(true);
        expect(body.todayYmd).toBe('2026-06-01');
    });
});

describe('GET /calendar/upcoming-count', () => {
    it('publishes the scope contract, not a bare number', async () => {
        const res = await countGET(
            req('https://x.test/api/t/acme/calendar/upcoming-count') as never,
            ROUTE_ARGS as never,
        );
        const body = await res.json();
        expect(body.count).toBe(7);
        // These three exist so the badge and the tenant-wide page it links to
        // can be RECONCILED rather than silently disagree. The divergence is
        // intended; the contract is what makes it legible.
        expect(body.scope).toBe('my_open_tasks');
        expect(body.includesOverdue).toBe(true);
        expect(body.windowDays).toBeNull();
    });

    it('forwards a valid horizon', async () => {
        await countGET(
            req('https://x.test/api/t/acme/calendar/upcoming-count?days=7') as never,
            ROUTE_ARGS as never,
        );
        expect(getBadgeCountMock.mock.calls[0][1]).toMatchObject({ horizonDays: 7 });
    });

    it('rejects a horizon outside the accepted bound', async () => {
        const res = await countGET(
            req('https://x.test/api/t/acme/calendar/upcoming-count?days=999') as never,
            ROUTE_ARGS as never,
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(getBadgeCountMock).not.toHaveBeenCalled();
    });

    it('gates on tasks.view — a caller without it is denied, not told "nothing due"', async () => {
        // Returning 0 to an unauthorized caller would be a quiet lie.
        getTenantCtxMock.mockResolvedValue(ctxWithNoPermissions());
        const res = await countGET(
            req('https://x.test/api/t/acme/calendar/upcoming-count') as never,
            ROUTE_ARGS as never,
        );
        expect(res.status).toBe(403);
        expect(getBadgeCountMock).not.toHaveBeenCalled();
    });
});
