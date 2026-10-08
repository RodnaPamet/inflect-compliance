/**
 * Step 5a — the role-by-action table for the access-review surface.
 *
 * This is the acceptance test for the first hardening item: *every allow and
 * deny outcome is identical to before, and every deny now writes
 * `AUTHZ_DENIED`.*
 *
 * ─── THE ORACLE IS THE OLD MECHANISM, NOT A SECOND COPY OF THE NEW TABLE ──
 *
 * The obvious way to test "unchanged" is to write down the expected matrix and
 * compare the grants to it. That proves only that two literals in the same diff
 * agree — if I mis-derived the matrix, both are wrong together and the test is
 * [[a-control-that-cannot-express-failure]].
 *
 * So the expectation is DERIVED from `computePermissions`, the coarse
 * role-ladder function that gated these routes before Step 5a and which this
 * diff does not touch:
 *
 *     access_reviews.view    must equal  canRead    (was assertCanRead)
 *     access_reviews.create  must equal  canAdmin   (was assertCanAdmin)
 *     access_reviews.close   must equal  canAdmin   (was assertCanAdmin)
 *     access_reviews.decide  must equal  canRead    (was assertCanRead, with
 *                                                    the reviewer rule left
 *                                                    inside the usecase)
 *
 * If someone later "tightens" `decide` to OWNER/ADMIN, this fails — which is
 * the point. That change would strip the verb from every EDITOR, AUDITOR and
 * READER who is the assigned reviewer of a campaign, and it would look like a
 * hardening in review.
 */

// ─── Mocks (declared before imports — Jest hoists `jest.mock` calls) ───

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: (...args: unknown[]) => mockAppendAuditEntry(...args),
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));

// `@/lib/observability/logger` is a BARREL, and a partial mock of a barrel is
// the trap: the missing export does not fail at import, it throws
// "is not a function" from whichever code path happens to reach it. Here only
// the DENIAL path calls `extractErrorMeta` (via withApiErrorHandling), so the
// allow cases all passed while every deny case died before its assertion.
// Mock every value export, not the ones this file happens to think about.
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() },
    log: jest.fn(),
    createChildLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    extractErrorMeta: (err: unknown) => ({
        name: (err as Error)?.name,
        message: (err as Error)?.message,
    }),
    pinoInstance: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/lib/observability/list-page-metrics', () => ({
    recordListPageRowCount: jest.fn(),
}));

// The usecases are stubbed so this suite measures the ROUTE gate and nothing
// below it. Each stub records that it ran, which is how "allowed" is observed.
const ran = jest.fn();
jest.mock('@/app-layer/usecases/access-review', () => ({
    listAccessReviews: (...a: unknown[]) => { ran('listAccessReviews'); void a; return Promise.resolve([]); },
    createAccessReview: () => { ran('createAccessReview'); return Promise.resolve({ accessReviewId: 'r1', snapshotCount: 1 }); },
    getAccessReviewWithActivity: () => { ran('getAccessReviewWithActivity'); return Promise.resolve({ id: 'r1' }); },
    getAccessReview: () => { ran('getAccessReview'); return Promise.resolve({ id: 'r1', scope: 'ALL_USERS' }); },
    closeAccessReview: () => { ran('closeAccessReview'); return Promise.resolve({ accessReviewId: 'r1' }); },
    submitDecision: () => { ran('submitDecision'); return Promise.resolve({ decisionId: 'd1' }); },
}));
jest.mock('@/app-layer/usecases/access-review-connected', () => ({
    createConnectedAccessReview: () => { ran('createConnectedAccessReview'); return Promise.resolve({ accessReviewId: 'r1', snapshotCount: 2 }); },
    listConnectedDecisions: () => { ran('listConnectedDecisions'); return Promise.resolve([]); },
    submitConnectedDecision: () => { ran('submitConnectedDecision'); return Promise.resolve({ decisionId: 'd1', decision: 'CONFIRM' }); },
    closeConnectedAccessReview: () => { ran('closeConnectedAccessReview'); return Promise.resolve({ accessReviewId: 'r1', executed: 2, remediationTasks: 0 }); },
}));

import type { Role } from '@prisma/client';
import { getPermissionsForRole, PERMISSION_SCHEMA } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import { hasPermission } from '@/lib/security/permission-middleware';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import type { RequestContext } from '@/app-layer/types';

import { GET as LIST, POST as CREATE } from '@/app/api/t/[tenantSlug]/access-reviews/route';
import { POST as CREATE_CONNECTED } from '@/app/api/t/[tenantSlug]/access-reviews/connected/route';
import { GET as DETAIL } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/route';
import { POST as CLOSE } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/close/route';
import { PUT as DECIDE } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/route';
import { GET as LIST_CONNECTED } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/connected-decisions/route';
import { POST as DECIDE_CONNECTED } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/connected-decisions/[decisionId]/route';

const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const;

function makeCtx(role: Role): RequestContext {
    // `permissions` comes from the REAL computePermissions so the fixture
    // cannot drift from the ladder the oracle reads.
    return {
        requestId: 'req-5a',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    } as RequestContext;
}

function makeReq(method: string, path: string, body: unknown = {}) {
    return {
        method,
        nextUrl: { pathname: path },
        // `withApiErrorHandling` reads `x-request-id` off the request, so a
        // bare object without `headers` fails before authorisation is reached
        // — which would have made every allow case look like a denial.
        headers: new Headers(),
        json: () => Promise.resolve(body),
    } as unknown as import('next/server').NextRequest;
}

// ─── 1. The grants reproduce the pre-key outcomes ───

describe('Step 5a — access_reviews grants reproduce the pre-key caller sets', () => {
    it.each(ROLES)('%s: view and decide track canRead; create and close track canAdmin', (role) => {
        const before = computePermissions(role);
        const now = getPermissionsForRole(role);

        expect(now.access_reviews.view).toBe(before.canRead);
        expect(now.access_reviews.decide).toBe(before.canRead);
        expect(now.access_reviews.create).toBe(before.canAdmin);
        expect(now.access_reviews.close).toBe(before.canAdmin);
    });

    it('the ladder actually discriminates, so the assertions above have teeth', () => {
        // A positive control. If canRead and canAdmin were equal for every
        // role, the four assertions above would pass under any grant table.
        const read = ROLES.map((r) => computePermissions(r).canRead);
        const admin = ROLES.map((r) => computePermissions(r).canAdmin);
        expect(read).toEqual([true, true, true, true, true]);
        expect(admin).toEqual([true, true, false, false, false]);
        expect(read).not.toEqual(admin);
    });

    it('is reachable through hasPermission under its dotted wire name', () => {
        expect(hasPermission(getPermissionsForRole('READER'), 'access_reviews.view')).toBe(true);
        expect(hasPermission(getPermissionsForRole('READER'), 'access_reviews.create')).toBe(false);
        expect(hasPermission(getPermissionsForRole('OWNER'), 'access_reviews.close')).toBe(true);
    });

    it('is declared in PERMISSION_SCHEMA so the custom-role editor can express it', () => {
        expect(PERMISSION_SCHEMA.access_reviews).toEqual(['view', 'create', 'decide', 'close']);
    });
});

// ─── 2. Route → key resolution, which is where ORDER is load-bearing ───

describe('Step 5a — every access-review route resolves to its intended key', () => {
    const T = '/api/t/acme/access-reviews';
    const CASES: ReadonlyArray<[string, string, string]> = [
        ['GET', T, 'access_reviews.view'],
        ['POST', T, 'access_reviews.create'],
        ['POST', `${T}/connected`, 'access_reviews.create'],
        ['GET', `${T}/r1`, 'access_reviews.view'],
        ['POST', `${T}/r1/close`, 'access_reviews.close'],
        ['PUT', `${T}/r1/decisions/d1`, 'access_reviews.decide'],
        ['GET', `${T}/r1/connected-decisions`, 'access_reviews.view'],
        ['POST', `${T}/r1/connected-decisions/d1`, 'access_reviews.decide'],
        ['GET', `${T}/r1/evidence`, 'access_reviews.view'],
    ];

    it.each(CASES)('%s %s → %s', (method, path, key) => {
        expect(resolveRoutePermission(path, method)?.permission).toBe(key);
    });

    it('the connected CREATE is not swallowed by the detail VIEW pattern', () => {
        // `^…/access-reviews/[^/]+$` matches `/access-reviews/connected`
        // perfectly well. `resolveRoutePermission` returns the FIRST match, so
        // if the two rules are ever reordered this POST silently becomes a
        // read-gated create. That is the one failure the table above would
        // still catch but nobody would read as an ordering bug, so it is
        // called out by name.
        expect(resolveRoutePermission(`${T}/connected`, 'POST')?.permission)
            .toBe('access_reviews.create');
        expect(resolveRoutePermission(`${T}/connected`, 'POST')?.permission)
            .not.toBe('access_reviews.view');
    });
});

// ─── 3. Allow and deny at the real route, and the denial audit ───

type Case = {
    name: string;
    call: () => Promise<unknown>;
    key: 'view' | 'create' | 'decide' | 'close';
};

const T = '/api/t/acme/access-reviews';

function cases(): Case[] {
    return [
        { name: 'GET /access-reviews', key: 'view', call: () => LIST(makeReq('GET', T), { params: Promise.resolve({ tenantSlug: 'acme' }) } as never) },
        { name: 'POST /access-reviews', key: 'create', call: () => CREATE(makeReq('POST', T, { name: 'Q4', reviewerUserId: 'u1' }), { params: Promise.resolve({ tenantSlug: 'acme' }) } as never) },
        { name: 'POST /access-reviews/connected', key: 'create', call: () => CREATE_CONNECTED(makeReq('POST', `${T}/connected`, { name: 'Q4', reviewerUserId: 'u1' }), { params: Promise.resolve({ tenantSlug: 'acme' }) } as never) },
        { name: 'GET /access-reviews/:id', key: 'view', call: () => DETAIL(makeReq('GET', `${T}/r1`), { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'r1' }) } as never) },
        { name: 'POST /access-reviews/:id/close', key: 'close', call: () => CLOSE(makeReq('POST', `${T}/r1/close`), { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'r1' }) } as never) },
        { name: 'PUT /access-reviews/:id/decisions/:did', key: 'decide', call: () => DECIDE(makeReq('PUT', `${T}/r1/decisions/d1`, { decision: 'CONFIRM' }), { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'r1', decisionId: 'd1' }) } as never) },
        { name: 'GET /access-reviews/:id/connected-decisions', key: 'view', call: () => LIST_CONNECTED(makeReq('GET', `${T}/r1/connected-decisions`), { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'r1' }) } as never) },
        { name: 'POST /access-reviews/:id/connected-decisions/:did', key: 'decide', call: () => DECIDE_CONNECTED(makeReq('POST', `${T}/r1/connected-decisions/d1`, { decision: 'CONFIRM' }), { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'r1', decisionId: 'd1' }) } as never) },
    ];
}

describe('Step 5a — the real routes allow and deny exactly as the ladder did', () => {
    beforeEach(() => {
        mockGetTenantCtx.mockReset();
        mockAppendAuditEntry.mockReset();
        ran.mockReset();
        mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
    });

    for (const role of ROLES) {
        for (const c of cases()) {
            it(`${role} — ${c.name}`, async () => {
                mockGetTenantCtx.mockResolvedValue(makeCtx(role));
                const granted = getPermissionsForRole(role).access_reviews[c.key];

                // `withApiErrorHandling` CONVERTS the thrown AppError into a
                // 403 Response rather than rethrowing, so the observable
                // outcome is a status code, not a rejection. Asserting the
                // status is also the stronger claim: it is what a caller sees.
                const res = (await c.call()) as Response;

                if (granted) {
                    expect(res.status).toBeLessThan(400);
                    expect(ran).toHaveBeenCalled();
                    // An allowed request writes no denial row.
                    expect(mockAppendAuditEntry).not.toHaveBeenCalled();
                } else {
                    expect(res.status).toBe(403);
                    // The usecase must never have been reached.
                    expect(ran).not.toHaveBeenCalled();
                    // EXACTLY ONE denial row: a second gate one layer down
                    // would make the trail count refusals rather than attempts.
                    expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
                    const call = mockAppendAuditEntry.mock.calls[0] ?? [];
                    expect(JSON.stringify(call)).toContain('AUTHZ_DENIED');
                }
            });
        }
    }

    it('denials really did occur for the non-admin roles — a count, not a vibe', () => {
        // Guards against the whole block above silently becoming all-allow:
        // 3 non-admin roles x 3 admin-gated cases (2 create + 1 close) = 9.
        const denied = ROLES.flatMap((role) =>
            cases().filter((c) => !getPermissionsForRole(role).access_reviews[c.key]),
        );
        expect(denied).toHaveLength(9);
    });
});
