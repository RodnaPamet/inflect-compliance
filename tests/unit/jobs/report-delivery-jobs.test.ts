/**
 * Unit coverage for `src/app-layer/jobs/report-delivery-jobs.ts`.
 *
 * Mocks the prisma singleton, the risk-report usecases, and permissions.
 * Branches:
 *   - no due schedules → all counts 0.
 *   - schedule whose tenant has no admin → buildCtx null → skipped (continue),
 *     no generate, but nextRunAt still NOT updated (continue skips update).
 *   - happy path → generated++, delivered++ (sent>0), pushed++ (spItemId truthy).
 *   - email sent=0 → not counted as delivered; sharePoint null → not pushed.
 *   - generateReport throws → failed++ + still advances nextRunAt.
 *   - asRecipients filters non-strings / non-arrays.
 *   - format fallback (null → 'PDF') + template name fallback.
 */
const prismaMock = {
    reportSchedule: { findMany: jest.fn(), update: jest.fn() },
    tenantMembership: { findFirst: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock }));

const riskReport = {
    generateReport: jest.fn(),
    deliverReportByEmail: jest.fn(),
    deliverReportToSharePoint: jest.fn(),
    computeNextRun: jest.fn(() => new Date('2026-07-01T00:00:00Z')),
};
jest.mock('@/app-layer/usecases/risk-report', () => riskReport);

jest.mock('@/lib/permissions', () => ({
    getPermissionsForRole: () => ({
        risks: { view: true, edit: true }, admin: { manage: true },
        audits: { view: true }, reports: { export: true },
    }),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runReportDelivery, REPORT_DELIVERY_PRINCIPAL } from '@/app-layer/jobs/report-delivery-jobs';
import type { ReportDeliveryPayload } from '@/app-layer/jobs/types';

const payload = {} as ReportDeliveryPayload;

function schedule(over: Record<string, unknown> = {}) {
    return {
        id: 's1', tenantId: 't1', templateId: 'tmpl1', format: 'PDF', cadence: 'WEEKLY',
        parametersJson: { foo: 'bar' }, recipientsJson: ['a@x.io'],
        sharePointDriveId: 'drive', sharePointFolderId: 'folder', template: { name: 'Weekly' },
        // Attribution: the run records who authored the schedule.
        createdByUserId: 'author-1',
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.tenantMembership.findFirst.mockResolvedValue({ userId: 'u1', role: 'ADMIN' });
    riskReport.generateReport.mockResolvedValue({ id: 'run1' });
    riskReport.deliverReportByEmail.mockResolvedValue(1);
    riskReport.deliverReportToSharePoint.mockResolvedValue('sp-item-1');
});

it('returns zeros when nothing is due', async () => {
    prismaMock.reportSchedule.findMany.mockResolvedValue([]);
    const res = await runReportDelivery(payload);
    expect(res).toEqual({ due: 0, generated: 0, delivered: 0, pushed: 0, failed: 0 });
});

it('happy path counts generated/delivered/pushed and advances nextRunAt', async () => {
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule()]);
    const res = await runReportDelivery(payload);
    expect(res).toEqual({ due: 1, generated: 1, delivered: 1, pushed: 1, failed: 0 });
    expect(prismaMock.reportSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 's1' } }),
    );
    // format default + parameters passed through, and the run is attributed to
    // the SCHEDULE'S AUTHOR rather than to a borrowed admin identity.
    expect(riskReport.generateReport).toHaveBeenCalledWith(
        expect.anything(), 'tmpl1', { foo: 'bar' }, 'PDF',
        { requestedBy: 'author-1' },
    );
});

it('executes as a synthetic system principal, never a borrowed admin', async () => {
    // The job used to run every schedule as the tenant's OLDEST ACTIVE
    // OWNER/ADMIN — a privilege escalation on a weekly cadence, and an audit
    // trail that named someone who had never seen the export.
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule()]);
    await runReportDelivery(payload);
    const ctx = riskReport.generateReport.mock.calls[0][0];
    expect(ctx.userId).toBe(REPORT_DELIVERY_PRINCIPAL);
    // And it may not act as an admin, nor widen a schedule's own destination.
    expect(ctx.permissions.canAdmin).toBe(false);
    expect(ctx.appPermissions.admin.manage).toBe(false);
    expect(ctx.appPermissions.reports.schedule_external).toBe(false);
});

it('attributes the run to null when the schedule predates author tracking', async () => {
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule({ createdByUserId: null })]);
    await runReportDelivery(payload);
    expect(riskReport.generateReport).toHaveBeenCalledWith(
        expect.anything(), 'tmpl1', { foo: 'bar' }, 'PDF', { requestedBy: null },
    );
});

it('still runs — and still advances nextRunAt — for a tenant with no active admin', async () => {
    // This test previously asserted the STARVATION bug: with no ACTIVE
    // OWNER/ADMIN, buildCtx returned null and the loop `continue`d BEFORE the
    // nextRunAt advance, so every one of that tenant's schedules stayed
    // `lte: now` and was re-selected in the take:1000 window on every daily run,
    // forever, crowding out real work.
    //
    // The synthetic system principal has no such dependency, so there is no
    // longer a tenant that cannot produce a context.
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule()]);
    prismaMock.tenantMembership.findFirst.mockResolvedValue(null);
    const res = await runReportDelivery(payload);
    expect(res.generated).toBe(1);
    expect(prismaMock.reportSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 's1' } }),
    );
});

it('does not count delivery when email sent=0 and sharePoint null', async () => {
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule({ recipientsJson: 'not-an-array', format: null, template: null })]);
    riskReport.deliverReportByEmail.mockResolvedValue(0);
    riskReport.deliverReportToSharePoint.mockResolvedValue(null);
    const res = await runReportDelivery(payload);
    expect(res).toEqual({ due: 1, generated: 1, delivered: 0, pushed: 0, failed: 0 });
    // asRecipients on a non-array → []
    expect(riskReport.deliverReportByEmail).toHaveBeenCalledWith(
        expect.anything(), { id: 'run1' }, [], 'Risk report',
    );
    // format fallback to 'PDF' (parametersJson carries through unchanged)
    expect(riskReport.generateReport).toHaveBeenCalledWith(
        expect.anything(), 'tmpl1', { foo: 'bar' }, 'PDF', { requestedBy: 'author-1' },
    );
});

it('counts a failure but still advances nextRunAt', async () => {
    // parametersJson null → the `?? {}` fallback branch.
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule({ parametersJson: null })]);
    riskReport.generateReport.mockRejectedValue(new Error('boom'));
    const res = await runReportDelivery(payload);
    expect(res.failed).toBe(1);
    expect(res.generated).toBe(0);
    expect(prismaMock.reportSchedule.update).toHaveBeenCalled();
});

it('filters non-string recipients via asRecipients', async () => {
    prismaMock.reportSchedule.findMany.mockResolvedValue([schedule({ recipientsJson: ['ok@x.io', 5, null, 'two@x.io'] })]);
    await runReportDelivery(payload);
    expect(riskReport.deliverReportByEmail).toHaveBeenCalledWith(
        expect.anything(), { id: 'run1' }, ['ok@x.io', 'two@x.io'], 'Weekly',
    );
});
