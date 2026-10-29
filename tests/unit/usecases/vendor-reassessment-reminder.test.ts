/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for the vendor reassessment reminder cron
 * (Audit S6, 2026-05-22).
 */
const findManyMock = jest.fn();
const notificationCreateMock = jest.fn();
// Present so a write to the vendor row — which this sweep must never make
// (#4462) — is observed rather than thrown as "not a function".
const vendorUpdateMock = jest.fn();
const vendorUpdateManyMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        vendor: { findMany: findManyMock, update: vendorUpdateMock, updateMany: vendorUpdateManyMock },
        notification: { createMany: notificationCreateMock },
    },
}));
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: any) => fn()),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runVendorReassessmentReminder } from '@/app-layer/usecases/vendor-reassessment-reminder';

beforeEach(() => {
    findManyMock.mockReset();
    notificationCreateMock.mockReset();
    notificationCreateMock.mockResolvedValue({ count: 1 });
    vendorUpdateMock.mockReset();
    vendorUpdateManyMock.mockReset();
});

const DUE = new Date('2026-05-01T09:30:00Z');

describe('runVendorReassessmentReminder', () => {
    it('returns zero when no overdue vendors', async () => {
        findManyMock.mockResolvedValueOnce([]);
        const out = await runVendorReassessmentReminder();
        expect(out).toEqual({ reminded: 0 });
        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(vendorUpdateMock).not.toHaveBeenCalled();
    });

    it('queries OFFBOARDED vendors excluded + non-deleted + past-due + owned', async () => {
        findManyMock.mockResolvedValueOnce([]);
        const now = new Date('2026-05-24T00:00:00Z');
        await runVendorReassessmentReminder({ now });
        const call = findManyMock.mock.calls[0][0];
        expect(call.where.deletedAt).toBeNull();
        expect(call.where.status).toEqual({ not: 'OFFBOARDED' });
        expect(call.where.nextReviewAt).toEqual({ not: null, lt: now });
        // Only an owner is reminded by this sweep (see the docstring for
        // where an owner-less vendor's overdue review goes).
        expect(call.where.ownerUserId).toEqual({ not: null });
        expect(call.select.nextReviewAt).toBe(true);
    });

    it('fires one notification per overdue vendor with an owner', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'AWS', ownerUserId: 'u1', nextReviewAt: DUE, tenant: { slug: 'acme' } },
            { id: 'v2', tenantId: 't1', name: 'Stripe', ownerUserId: 'u2', nextReviewAt: DUE, tenant: { slug: 'acme' } },
        ]);
        const out = await runVendorReassessmentReminder();
        expect(out.reminded).toBe(2);
        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        const first = notificationCreateMock.mock.calls[0][0].data[0];
        expect(first.userId).toBe('u1');
        expect(first.type).toBe('VENDOR_REVIEW_DUE');
        expect(first.title).toContain('AWS');
        // Inside the workspace — a bare `/vendors/<id>` 404'd from the bell (#4128).
        expect(first.linkUrl).toBe('/t/acme/vendors/v1');
        expect(findManyMock.mock.calls[0][0].select.tenant).toEqual({ select: { slug: true } });
    });

    // #4462 — the sweep used to set nextReviewAt = now + 365 days for every
    // overdue vendor, owner or not, with no audit row. Every "overdue"
    // surface reads `nextReviewAt < now` after this 02:00 run, so a vendor
    // read overdue for at most a day. A vendor now stays overdue until a
    // review completes; this sweep only reminds.
    it('leaves an overdue vendor overdue — the review date is never moved', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V', ownerUserId: 'u1', nextReviewAt: DUE, tenant: { slug: 'acme' } },
        ]);
        await runVendorReassessmentReminder({ now: new Date('2026-05-24T00:00:00Z') });
        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        expect(vendorUpdateMock).not.toHaveBeenCalled();
        expect(vendorUpdateManyMock).not.toHaveBeenCalled();
    });

    it('reminds once per (vendor, owner, overdue date): the key names the due date, not today', async () => {
        const v = { id: 'v1', tenantId: 't1', name: 'V', ownerUserId: 'u1', nextReviewAt: DUE, tenant: { slug: 'acme' } };
        findManyMock.mockResolvedValue([v]);

        await runVendorReassessmentReminder({ now: new Date('2026-05-24T02:00:00Z') });
        await runVendorReassessmentReminder({ now: new Date('2026-05-25T02:00:00Z') });

        const writes = notificationCreateMock.mock.calls.map((c) => c[0]);
        // Both nights ask for the SAME key — so the second is absorbed by the
        // unique index rather than written — and both say so.
        expect(writes.map((w) => w.data[0].dedupeKey)).toEqual([
            't1:VENDOR_REVIEW_DUE:v1:u1:2026-05-01',
            't1:VENDOR_REVIEW_DUE:v1:u1:2026-05-01',
        ]);
        expect(writes.every((w) => w.skipDuplicates === true)).toBe(true);
    });

    it('counts only what it wrote: an already-reminded date is not reminded again', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V', ownerUserId: 'u1', nextReviewAt: DUE, tenant: { slug: 'acme' } },
        ]);
        notificationCreateMock.mockResolvedValueOnce({ count: 0 });
        const out = await runVendorReassessmentReminder();
        expect(out.reminded).toBe(0);
    });

    it('a new owner, or a new due date, is a new reminder', async () => {
        const base = { id: 'v1', tenantId: 't1', name: 'V', tenant: { slug: 'acme' } };
        findManyMock.mockResolvedValueOnce([
            { ...base, ownerUserId: 'u2', nextReviewAt: DUE },
            { ...base, id: 'v2', ownerUserId: 'u1', nextReviewAt: new Date('2026-05-20T00:00:00Z') },
        ]);
        await runVendorReassessmentReminder();
        expect(notificationCreateMock.mock.calls.map((c) => c[0].data[0].dedupeKey)).toEqual([
            't1:VENDOR_REVIEW_DUE:v1:u2:2026-05-01',
            't1:VENDOR_REVIEW_DUE:v2:u1:2026-05-20',
        ]);
    });

    it('per-vendor failure does not sink the sweep', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V1', ownerUserId: 'u1', nextReviewAt: DUE },
            { id: 'v2', tenantId: 't1', name: 'V2', ownerUserId: 'u2', nextReviewAt: DUE },
        ]);
        // First vendor's notification write throws; second succeeds.
        notificationCreateMock
            .mockRejectedValueOnce(new Error('FK violation — u1 deleted'))
            .mockResolvedValueOnce({ count: 1 });
        const out = await runVendorReassessmentReminder();
        // Only the second succeeded; first failed at notification step.
        expect(out.reminded).toBe(1);
    });

    it('scopes to one tenant when tenantId is provided', async () => {
        findManyMock.mockResolvedValueOnce([]);
        await runVendorReassessmentReminder({ tenantId: 't-42' });
        const call = findManyMock.mock.calls[0][0];
        expect(call.where.tenantId).toBe('t-42');
    });
});
