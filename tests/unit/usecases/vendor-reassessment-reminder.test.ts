/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for the vendor reassessment reminder cron
 * (Audit S6, 2026-05-22).
 */
const findManyMock = jest.fn();
const notificationCreateMock = jest.fn();
const vendorUpdateMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        vendor: { findMany: findManyMock, update: vendorUpdateMock },
        notification: { create: notificationCreateMock },
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
    vendorUpdateMock.mockReset();
});

describe('runVendorReassessmentReminder', () => {
    it('returns zero when no overdue vendors', async () => {
        findManyMock.mockResolvedValueOnce([]);
        const out = await runVendorReassessmentReminder();
        expect(out).toEqual({ reminded: 0 });
        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(vendorUpdateMock).not.toHaveBeenCalled();
    });

    it('queries OFFBOARDED vendors excluded + non-deleted + past-due', async () => {
        findManyMock.mockResolvedValueOnce([]);
        const now = new Date('2026-05-24T00:00:00Z');
        await runVendorReassessmentReminder({ now });
        const call = findManyMock.mock.calls[0][0];
        expect(call.where.deletedAt).toBeNull();
        expect(call.where.status).toEqual({ not: 'OFFBOARDED' });
        expect(call.where.nextReviewAt).toEqual({ not: null, lt: now });
    });

    it('fires one notification per overdue vendor with an owner', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'AWS', ownerUserId: 'u1', tenant: { slug: 'acme' } },
            { id: 'v2', tenantId: 't1', name: 'Stripe', ownerUserId: 'u2', tenant: { slug: 'acme' } },
        ]);
        notificationCreateMock.mockResolvedValue({ id: 'n' });
        vendorUpdateMock.mockResolvedValue({});
        const out = await runVendorReassessmentReminder();
        expect(out.reminded).toBe(2);
        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        const first = notificationCreateMock.mock.calls[0][0].data;
        expect(first.userId).toBe('u1');
        expect(first.type).toBe('VENDOR_REVIEW_DUE');
        expect(first.title).toContain('AWS');
        // Inside the workspace — a bare `/vendors/<id>` 404'd from the bell (#4128).
        expect(first.linkUrl).toBe('/t/acme/vendors/v1');
        expect(findManyMock.mock.calls[0][0].select.tenant).toEqual({ select: { slug: true } });
    });

    it('skips notification when vendor has no owner — still bumps nextReviewAt', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'Acme', ownerUserId: null },
        ]);
        vendorUpdateMock.mockResolvedValue({});
        const out = await runVendorReassessmentReminder();
        expect(out.reminded).toBe(1);
        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(vendorUpdateMock).toHaveBeenCalledTimes(1);
    });

    it('bumps nextReviewAt forward by the cadence (default 365 days)', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V', ownerUserId: 'u1' },
        ]);
        notificationCreateMock.mockResolvedValue({ id: 'n' });
        vendorUpdateMock.mockResolvedValue({});
        const now = new Date('2026-05-24T00:00:00Z');
        await runVendorReassessmentReminder({ now });
        const upd = vendorUpdateMock.mock.calls[0][0];
        expect(upd.where.id).toBe('v1');
        const next = upd.data.nextReviewAt as Date;
        // 365 days later
        const expected = new Date(now);
        expected.setDate(expected.getDate() + 365);
        expect(Math.abs(next.getTime() - expected.getTime())).toBeLessThan(1000);
    });

    it('respects custom cadenceDays', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V', ownerUserId: 'u1' },
        ]);
        notificationCreateMock.mockResolvedValue({ id: 'n' });
        vendorUpdateMock.mockResolvedValue({});
        const now = new Date('2026-05-24T00:00:00Z');
        await runVendorReassessmentReminder({ now, cadenceDays: 90 });
        const next = vendorUpdateMock.mock.calls[0][0].data.nextReviewAt as Date;
        const expected = new Date(now);
        expected.setDate(expected.getDate() + 90);
        expect(Math.abs(next.getTime() - expected.getTime())).toBeLessThan(1000);
    });

    it('per-vendor failure does not sink the sweep', async () => {
        findManyMock.mockResolvedValueOnce([
            { id: 'v1', tenantId: 't1', name: 'V1', ownerUserId: 'u1' },
            { id: 'v2', tenantId: 't1', name: 'V2', ownerUserId: 'u2' },
        ]);
        // First vendor's notification.create throws; second succeeds.
        notificationCreateMock
            .mockRejectedValueOnce(new Error('FK violation — u1 deleted'))
            .mockResolvedValueOnce({ id: 'n' });
        vendorUpdateMock.mockResolvedValue({});
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
