/**
 * `POST /api/t/:slug/access-reviews/legacy` — the HTTP entrance to
 * `createLegacyAccessReview`, which had none.
 *
 * Driven through the REAL route export, with the REAL `withApiErrorHandling`,
 * `requirePermission` and `parseJsonBody`. Only three things are stubbed:
 * `getTenantCtx` (it needs a browser session), the audit append (so a denial
 * row can be counted), and the usecase (so this file measures the ROUTE and
 * nothing below it; the usecase's own rules are tested against a real database
 * in `tests/integration/legacy-access-review.test.ts` and, through this route,
 * in `tests/integration/legacy-access-review-route.test.ts`).
 *
 * What the route must do, and nothing more: refuse a caller without
 * `access_reviews.create` before anything else happens; refuse a body it does
 * not take; hand everything else to the usecase and return what it returns;
 * and let the usecase's refusals reach the caller with their status and code.
 */
import { strictMock } from '../helpers/strict-mock';

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();
const mockCreateLegacy = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

// A guarded barrel: `strictMock`, never a bare subset factory (see
// tests/guards/partial-mock-of-a-guarded-barrel.test.ts).
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (...args: unknown[]) => mockAppendAuditEntry(...args),
        appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
    }),
);

// The logger is a barrel too; the denial path reaches `extractErrorMeta`.
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

// The REAL module with its one writer replaced, so `LEGACY_CAMPAIGN_REFUSALS`
// below is the usecase's own list rather than a copy that could drift from it.
jest.mock('@/app-layer/usecases/access-review-legacy', () => ({
    ...jest.requireActual('@/app-layer/usecases/access-review-legacy'),
    createLegacyAccessReview: (...args: unknown[]) => mockCreateLegacy(...args),
}));

import type { NextRequest } from 'next/server';
import type { Role } from '@prisma/client';

import { POST } from '@/app/api/t/[tenantSlug]/access-reviews/legacy/route';
import { LEGACY_CAMPAIGN_REFUSALS } from '@/app-layer/usecases/access-review-legacy';
import { badRequest, forbidden } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';

const PATH = '/api/t/acme/access-reviews/legacy';

const BODY = {
    name: 'Q4 ledger recertification',
    connectionId: 'conn-legacy-1',
    reviewerUserId: 'u-rev',
};

/** What the usecase returns — the route must hand it back unchanged. */
const CREATED = {
    accessReviewId: 'ar-legacy-1',
    snapshotId: 'snap-1',
    executionId: 'exec-1',
    subjectCount: 3,
    snapshotTruncated: false,
    populationCoverage: 'UNKNOWN',
    findingCounts: { PRIVILEGED: 1 },
};

/** A request whose body is `raw` verbatim, so malformed JSON can be sent. */
function rawReq(raw: string): NextRequest {
    return {
        method: 'POST',
        nextUrl: { pathname: PATH },
        // `withApiErrorHandling` reads `x-request-id`; without headers the
        // request fails before authorisation is reached.
        headers: new Headers(),
        json: () => Promise.resolve().then(() => JSON.parse(raw) as unknown),
    } as unknown as NextRequest;
}

const req = (body: unknown) => rawReq(JSON.stringify(body));

const call = (r: NextRequest) =>
    POST(r, { params: Promise.resolve({ tenantSlug: 'acme' }) } as never) as Promise<Response>;

const denials = () =>
    mockAppendAuditEntry.mock.calls.filter((c) => JSON.stringify(c).includes('AUTHZ_DENIED'));

beforeEach(() => {
    mockGetTenantCtx.mockReset();
    mockAppendAuditEntry.mockReset();
    mockCreateLegacy.mockReset();
    mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN'));
    mockCreateLegacy.mockResolvedValue(CREATED);
});

describe('an authorised caller gets the campaign the usecase created', () => {
    it.each(['OWNER', 'ADMIN'] as const)('%s → 201 with the usecase result, verbatim', async (role) => {
        const ctx = makeRequestContext(role);
        mockGetTenantCtx.mockResolvedValue(ctx);

        const res = await call(req(BODY));

        expect(res.status).toBe(201);
        expect(await res.json()).toEqual(CREATED);
        expect(mockCreateLegacy).toHaveBeenCalledTimes(1);
        // The context the gate resolved, and the parsed body — nothing added,
        // nothing chosen by the route.
        expect(mockCreateLegacy).toHaveBeenCalledWith(ctx, BODY);
        expect(denials()).toHaveLength(0);
    });

    it('forwards the optional fields, with the dates parsed', async () => {
        await call(req({
            ...BODY,
            description: 'Quarterly',
            dueAt: '2026-11-30T00:00:00.000Z',
            periodStartAt: '2026-07-01T00:00:00.000Z',
            periodEndAt: '2026-09-30T00:00:00.000Z',
        }));

        const input = mockCreateLegacy.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(input.description).toBe('Quarterly');
        expect(input.dueAt).toEqual(new Date('2026-11-30T00:00:00.000Z'));
        expect(input.periodStartAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
        expect(input.periodEndAt).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    });
});

describe('a caller without access_reviews.create is refused before anything else', () => {
    it.each(['EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'] as const)('%s → 403, one AUTHZ_DENIED row, usecase never reached', async (role) => {
        expect(getPermissionsForRole(role as Role).access_reviews.create).toBe(false);
        mockGetTenantCtx.mockResolvedValue(makeRequestContext(role));

        const res = await call(req(BODY));

        expect(res.status).toBe(403);
        expect(mockCreateLegacy).not.toHaveBeenCalled();
        expect(denials()).toHaveLength(1);
    });

    it('it is the KEY that gates, not the role: an ADMIN whose custom role withholds create is refused', async () => {
        const base = getPermissionsForRole('ADMIN');
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('ADMIN', {
            appPermissions: { ...base, access_reviews: { ...base.access_reviews, create: false } },
        }));

        const res = await call(req(BODY));

        expect(res.status).toBe(403);
        expect(mockCreateLegacy).not.toHaveBeenCalled();
        expect(denials()).toHaveLength(1);
    });

    it('is refused even with a body the schema would reject — authorisation runs first', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('READER'));

        const res = await call(req({ scope: 'LEGACY_APP' }));

        expect(res.status).toBe(403);
        expect(denials()).toHaveLength(1);
    });
});

describe('a body the route does not take is a 400, and the usecase is never reached', () => {
    it.each([
        ['no connectionId', { name: 'Q4', reviewerUserId: 'u-rev' }],
        ['no reviewer', { name: 'Q4', connectionId: 'conn-legacy-1' }],
        ['an empty name', { ...BODY, name: '' }],
        ['a connectionId past its bound', { ...BODY, connectionId: 'c'.repeat(65) }],
        ['a date that is not one', { ...BODY, dueAt: 'next Tuesday' }],
        // `.strict()`: a caller who names a key the route does not take is told
        // so rather than having it dropped. The scope, the subjects and the
        // coverage come from the usecase and the snapshot, never the body.
        ['a scope', { ...BODY, scope: 'LEGACY_APP' }],
        ['a subject list', { ...BODY, subjects: ['jsmith'] }],
        ['a coverage claim', { ...BODY, populationCoverage: 'VERIFIED' }],
    ])('%s → 400 VALIDATION_ERROR', async (_label, body) => {
        const res = await call(req(body));

        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
        expect(mockCreateLegacy).not.toHaveBeenCalled();
    });

    it('malformed JSON → 400', async () => {
        const res = await call(rawReq('{"name": "Q4",'));

        expect(res.status).toBe(400);
        expect(mockCreateLegacy).not.toHaveBeenCalled();
    });
});

describe("the usecase's own refusals reach the caller with their status and code", () => {
    it('the usecase declares the five refusals this block walks', () => {
        // The denominator: an empty list would make the `it.each` below vacuous.
        expect([...LEGACY_CAMPAIGN_REFUSALS].sort()).toEqual([
            'NOT_RECONCILED', 'NO_SNAPSHOT', 'NO_SUBJECTS', 'SNAPSHOT_INCOMPLETE', 'SNAPSHOT_STALE',
        ]);
    });

    it.each([...LEGACY_CAMPAIGN_REFUSALS])('%s → 400, the code in the message', async (code) => {
        // The shape `refuse()` in the usecase throws.
        mockCreateLegacy.mockRejectedValue(badRequest(`${code}: refused for the test`));

        const res = await call(req(BODY));

        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toBe(`${code}: refused for the test`);
    });

    it("the usecase's own gate (assertCanAdmin) surfaces as 403", async () => {
        mockCreateLegacy.mockRejectedValue(forbidden('Admin access required'));

        const res = await call(req(BODY));

        expect(res.status).toBe(403);
        // No AUTHZ_DENIED from the route: the route's key was held.
        expect(denials()).toHaveLength(0);
    });
});

describe('the route resolves to the key it names', () => {
    it('POST /access-reviews/legacy → access_reviews.create, not the detail VIEW key', () => {
        expect(resolveRoutePermission(PATH, 'POST')?.permission).toBe('access_reviews.create');
    });
});
