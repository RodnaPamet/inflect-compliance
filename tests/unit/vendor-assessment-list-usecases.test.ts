/**
 * `listReviewableAssessments` + `listVendorAssessments`.
 *
 * Both exports had NO unit coverage — only the DB-backed
 * `tests/integration/vendor-assessment-lifecycle.test.ts` reached
 * `listVendorAssessments`, and nothing reached the reviewer queue at all.
 * That is most of why `vendor-assessment-review.ts` sits low on FUNCTION
 * coverage rather than on a scatter of missed conditionals.
 *
 * Each of these is a read surface whose ORDER and FIELD PRECEDENCE are the
 * product behaviour, and both have already regressed once in exactly those
 * two places — see the comments in the usecase. So the assertions here are
 * about ordering and precedence, not about row counts.
 */

const mockTx = {
    vendorAssessment: { findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

import {
    listReviewableAssessments,
    listVendorAssessments,
} from '@/app-layer/usecases/vendor-assessment-review';
import { runInTenantContext } from '@/lib/db-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

function makeCtx(opts: { canRead?: boolean; tenantId?: string } = {}) {
    return {
        requestId: 'r-1',
        userId: 'u-1',
        tenantId: opts.tenantId ?? 'tenant-1',
        role: 'READER' as const,
        permissions: {
            canRead: opts.canRead ?? true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as never,
    };
}

const iso = (s: string) => new Date(s);

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.vendorAssessment.findMany.mockReset();
    mockTx.vendorAssessment.findMany.mockResolvedValue([]);
});

describe('listReviewableAssessments', () => {
    it('refuses without canRead, before opening a transaction', async () => {
        await expect(listReviewableAssessments(makeCtx({ canRead: false })))
            .rejects.toThrow(/Read access required/);
        // The throw alone does not say the read was skipped.
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    // The queue is the reviewer's actionable backlog. A DRAFT or SENT
    // assessment appearing here is an item nobody can act on, and the
    // `templateVersionId: { not: null }` clause is what keeps legacy rows
    // — which `getReviewView` refuses to open — out of a list that links
    // straight to it.
    it('asks only for reviewable statuses, and only for G-3 rows', async () => {
        await listReviewableAssessments(makeCtx({ tenantId: 'tenant-X' }));
        const where = mockTx.vendorAssessment.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({
            tenantId: 'tenant-X',
            templateVersionId: { not: null },
            status: { in: ['SUBMITTED', 'REVIEWED', 'CLOSED'] },
        });
    });

    it('bounds the read and orders submittedAt descending at the DB', async () => {
        await listReviewableAssessments(makeCtx());
        const args = mockTx.vendorAssessment.findMany.mock.calls[0][0];
        expect(args.take).toBe(200);
        expect(args.orderBy).toEqual({ submittedAt: 'desc' });
    });

    // The partition is the point of the function: SUBMITTED rises to the
    // top because it is the only actionable state, and WITHIN each
    // partition the DB's submittedAt-desc order has to survive. A
    // `.sort()` by status would satisfy "submitted first" while quietly
    // reordering the rest, which is why both halves are asserted.
    it('lifts SUBMITTED to the top while preserving order within each partition', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            { id: 'c1', vendorId: 'v1', status: 'CLOSED', score: 1, riskRating: 'LOW', submittedAt: iso('2026-05-04'), reviewedAt: null, vendor: { name: 'C One' } },
            { id: 's1', vendorId: 'v2', status: 'SUBMITTED', score: 2, riskRating: 'HIGH', submittedAt: iso('2026-05-03'), reviewedAt: null, vendor: { name: 'S One' } },
            { id: 'r1', vendorId: 'v3', status: 'REVIEWED', score: 3, riskRating: 'LOW', submittedAt: iso('2026-05-02'), reviewedAt: iso('2026-05-05'), vendor: { name: 'R One' } },
            { id: 's2', vendorId: 'v4', status: 'SUBMITTED', score: 4, riskRating: 'LOW', submittedAt: iso('2026-05-01'), reviewedAt: null, vendor: { name: 'S Two' } },
        ]);

        const out = await listReviewableAssessments(makeCtx());

        expect(out.map((r) => r.id)).toEqual(['s1', 's2', 'c1', 'r1']);
    });

    it('serialises dates to ISO and keeps nulls null', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            { id: 'a1', vendorId: 'v1', status: 'SUBMITTED', score: null, riskRating: null, submittedAt: iso('2026-05-03T10:00:00Z'), reviewedAt: null, vendor: { name: 'Acme' } },
        ]);
        const [row] = await listReviewableAssessments(makeCtx());
        expect(row.submittedAt).toBe('2026-05-03T10:00:00.000Z');
        expect(row.reviewedAt).toBeNull();
    });

    // A row whose vendor relation did not load must not render "undefined"
    // in the reviewer's vendor column.
    it('falls back to an empty vendor name rather than undefined', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            { id: 'a1', vendorId: 'v1', status: 'SUBMITTED', score: null, riskRating: null, submittedAt: null, reviewedAt: null, vendor: null },
        ]);
        const [row] = await listReviewableAssessments(makeCtx());
        expect(row.vendorName).toBe('');
    });
});

describe('listVendorAssessments', () => {
    const row = (over: Record<string, unknown> = {}) => ({
        id: 'a1',
        status: 'SENT',
        score: null,
        riskRating: null,
        startedAt: null,
        sentAt: iso('2026-05-01T09:00:00Z'),
        submittedAt: null,
        reviewedAt: null,
        closedAt: null,
        respondentEmail: 'ops@vendor.example',
        externalAccessTokenExpiresAt: null,
        revokedAt: null,
        template: null,
        templateVersion: null,
        ...over,
    });

    it('refuses without canRead, before opening a transaction', async () => {
        await expect(listVendorAssessments(makeCtx({ canRead: false }), 'v1'))
            .rejects.toThrow(/Read access required/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('scopes the read to the tenant AND the vendor', async () => {
        await listVendorAssessments(makeCtx({ tenantId: 'tenant-Y' }), 'vendor-9');
        const args = mockTx.vendorAssessment.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-Y', vendorId: 'vendor-9' });
        expect(args.take).toBe(200);
    });

    // The usecase comment records that this ordered by `startedAt` once, and
    // that it drifts from how the activation gate, getVendorMetrics and the
    // dashboard buckets all define "the latest assessment"
    // (`createdAt desc take 1`). Pinned so the top of this list stays the
    // row those surfaces are reasoning about.
    it('orders by createdAt, not startedAt', async () => {
        await listVendorAssessments(makeCtx(), 'v1');
        expect(mockTx.vendorAssessment.findMany.mock.calls[0][0].orderBy)
            .toEqual({ createdAt: 'desc' });
    });

    // G-3 rows carry `templateId = null` and name the template through
    // `templateVersion`, so the precedence is not cosmetic: reversing these
    // two would show the legacy name on every migrated row, and `null` only
    // when neither exists.
    it('prefers the templateVersion name over the legacy template name', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            row({ template: { name: 'Legacy SIG' }, templateVersion: { name: 'SIG Lite v3' } }),
        ]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        expect(out.templateName).toBe('SIG Lite v3');
    });

    it('falls back to the legacy template name when there is no version', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            row({ template: { name: 'Legacy SIG' }, templateVersion: null }),
        ]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        expect(out.templateName).toBe('Legacy SIG');
    });

    it('reports null when neither template is present', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([row()]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        expect(out.templateName).toBeNull();
    });

    // Without these two the surface cannot tell a link sent this morning
    // from one that died three weeks ago — both rendered as "Outstanding,
    // awaiting response" with a Resend button and nothing between them.
    it('surfaces the invite expiry and revocation timestamps', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            row({
                externalAccessTokenExpiresAt: iso('2026-04-10T00:00:00Z'),
                revokedAt: iso('2026-04-12T00:00:00Z'),
            }),
        ]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        expect(out.inviteExpiresAt).toBe('2026-04-10T00:00:00.000Z');
        expect(out.inviteRevokedAt).toBe('2026-04-12T00:00:00.000Z');
    });

    it('keeps a live, never-revoked invite as nulls rather than dropping the fields', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([row()]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        // Present-and-null, not absent: the client distinguishes "no expiry
        // recorded" from a missing key.
        expect(out).toHaveProperty('inviteExpiresAt', null);
        expect(out).toHaveProperty('inviteRevokedAt', null);
    });

    it('serialises every lifecycle timestamp it carries', async () => {
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            row({
                status: 'CLOSED',
                startedAt: iso('2026-05-01T00:00:00Z'),
                submittedAt: iso('2026-05-02T00:00:00Z'),
                reviewedAt: iso('2026-05-03T00:00:00Z'),
                closedAt: iso('2026-05-04T00:00:00Z'),
            }),
        ]);
        const [out] = await listVendorAssessments(makeCtx(), 'v1');
        expect(out).toMatchObject({
            startedAt: '2026-05-01T00:00:00.000Z',
            sentAt: '2026-05-01T09:00:00.000Z',
            submittedAt: '2026-05-02T00:00:00.000Z',
            reviewedAt: '2026-05-03T00:00:00.000Z',
            closedAt: '2026-05-04T00:00:00.000Z',
        });
    });
});
