/**
 * Coverage wave E — `src/app-layer/jobs/vendor-monitoring.ts`.
 *
 * The daily sweep. The behaviours worth locking are the resilience ones:
 * a single vendor's provider failure must not sink the sweep, and a failing
 * reassessment reminder must not either — both are caught, counted, and the
 * job still reports success. The kill-switch short-circuit is pinned too,
 * since an air-gapped deployment depends on it doing no I/O at all.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// runJob is a pass-through wrapper here — the wrapper's own behaviour is
// covered by the job-runner's tests, not re-litigated per job.
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => unknown) => fn()),
}));

const vendorMonitor = { findMany: jest.fn() };
jest.mock('@/lib/prisma', () => ({ prisma: { vendorMonitor } }));

const runVendorMonitor = jest.fn();
jest.mock('@/app-layer/usecases/vendor-monitoring', () => ({
    runVendorMonitor: (...a: unknown[]) => runVendorMonitor(...a),
}));

const runVendorReassessmentReminder = jest.fn();
jest.mock('@/app-layer/usecases/vendor-reassessment-reminder', () => ({
    runVendorReassessmentReminder: (...a: unknown[]) =>
        runVendorReassessmentReminder(...a),
}));

import { runVendorMonitoringJob } from '@/app-layer/jobs/vendor-monitoring';

const NOW = new Date('2026-07-01T00:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    vendorMonitor.findMany.mockResolvedValue([]);
    runVendorMonitor.mockResolvedValue({ eventsCreated: 0, findingsCreated: 0 });
    runVendorReassessmentReminder.mockResolvedValue({ reminded: 0 });
});

describe('runVendorMonitoringJob — kill switch', () => {
    it('does no work when VENDOR_MONITOR_ENABLED=0', async () => {
        mockEnv.VENDOR_MONITOR_ENABLED = '0';

        const res = await runVendorMonitoringJob();

        expect(res.scanned).toBe(0);
        expect(res.actioned).toBe(0);
        expect(res.result.details).toEqual({ disabled: true });
        expect(vendorMonitor.findMany).not.toHaveBeenCalled();
        expect(runVendorMonitor).not.toHaveBeenCalled();
        expect(runVendorReassessmentReminder).not.toHaveBeenCalled();
    });

    it('runs normally for any other value', async () => {
        mockEnv.VENDOR_MONITOR_ENABLED = '1';
        await runVendorMonitoringJob();
        expect(vendorMonitor.findMany).toHaveBeenCalled();
    });
});

describe('runVendorMonitoringJob — monitor selection', () => {
    it('selects only enabled monitors, bounded', async () => {
        await runVendorMonitoringJob();
        const arg = vendorMonitor.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ enabled: true });
        expect(arg.take).toBe(5000);
        expect(arg.select).toEqual({ tenantId: true, vendorId: true });
    });

    it('scopes by tenantId when supplied', async () => {
        await runVendorMonitoringJob({ tenantId: 't-1' });
        expect(vendorMonitor.findMany.mock.calls[0][0].where).toEqual({
            enabled: true,
            tenantId: 't-1',
        });
    });

    it('scopes by vendorId when supplied', async () => {
        await runVendorMonitoringJob({ vendorId: 'v-1' });
        expect(vendorMonitor.findMany.mock.calls[0][0].where).toEqual({
            enabled: true,
            vendorId: 'v-1',
        });
    });

    it('scopes by both together', async () => {
        await runVendorMonitoringJob({ tenantId: 't-1', vendorId: 'v-1' });
        expect(vendorMonitor.findMany.mock.calls[0][0].where).toEqual({
            enabled: true,
            tenantId: 't-1',
            vendorId: 'v-1',
        });
    });
});

describe('runVendorMonitoringJob — sweep', () => {
    const monitors = [
        { tenantId: 't-1', vendorId: 'v-1' },
        { tenantId: 't-2', vendorId: 'v-2' },
    ];

    it('runs the monitor once per row with a system context', async () => {
        vendorMonitor.findMany.mockResolvedValue(monitors);

        const res = await runVendorMonitoringJob({ now: NOW });

        expect(runVendorMonitor).toHaveBeenCalledTimes(2);
        const [ctx, args] = runVendorMonitor.mock.calls[0];
        expect(ctx.tenantId).toBe('t-1');
        expect(ctx.userId).toBe('system');
        expect(ctx.role).toBe('ADMIN');
        expect(ctx.permissions.canExport).toBe(false);
        expect(args).toEqual({ vendorId: 'v-1', now: NOW });
        expect(res.scanned).toBe(2);
    });

    it('counts a vendor as actioned when it created events or findings', async () => {
        vendorMonitor.findMany.mockResolvedValue(monitors);
        runVendorMonitor
            .mockResolvedValueOnce({ eventsCreated: 1, findingsCreated: 0 })
            .mockResolvedValueOnce({ eventsCreated: 0, findingsCreated: 0 });

        expect((await runVendorMonitoringJob()).actioned).toBe(1);
    });

    it('counts findings-only as actioned too', async () => {
        vendorMonitor.findMany.mockResolvedValue([monitors[0]]);
        runVendorMonitor.mockResolvedValue({ eventsCreated: 0, findingsCreated: 3 });
        expect((await runVendorMonitoringJob()).actioned).toBe(1);
    });

    it('keeps sweeping when one vendor throws, and records the error count', async () => {
        vendorMonitor.findMany.mockResolvedValue(monitors);
        runVendorMonitor
            .mockRejectedValueOnce(new Error('provider down'))
            .mockResolvedValueOnce({ eventsCreated: 1, findingsCreated: 0 });

        const res = await runVendorMonitoringJob();

        expect(runVendorMonitor).toHaveBeenCalledTimes(2);
        expect(res.scanned).toBe(2);
        expect(res.actioned).toBe(1);
        expect(res.result.details).toMatchObject({ errored: 1 });
        expect(res.result.success).toBe(true);
    });

    it('handles a non-Error throw from a vendor', async () => {
        vendorMonitor.findMany.mockResolvedValue([monitors[0]]);
        runVendorMonitor.mockRejectedValue('a bare string');

        const res = await runVendorMonitoringJob();
        expect(res.result.details).toMatchObject({ errored: 1 });
    });

    it('defaults `now` when not supplied', async () => {
        vendorMonitor.findMany.mockResolvedValue([monitors[0]]);
        await runVendorMonitoringJob();
        expect(runVendorMonitor.mock.calls[0][1].now).toBeInstanceOf(Date);
    });
});

describe('runVendorMonitoringJob — reassessment reminder', () => {
    it('runs the reminder and folds its count into actioned', async () => {
        runVendorReassessmentReminder.mockResolvedValue({ reminded: 4 });

        const res = await runVendorMonitoringJob({ tenantId: 't-1', now: NOW });

        expect(runVendorReassessmentReminder).toHaveBeenCalledWith({
            tenantId: 't-1',
            now: NOW,
        });
        expect(res.result.details).toMatchObject({ reminded: 4 });
        // itemsActioned is the sweep's actioned count plus the reminders.
        expect(res.result.itemsActioned).toBe(4);
        // …but the returned `actioned` is the vendor-sweep figure only.
        expect(res.actioned).toBe(0);
    });

    it('survives a failing reminder without failing the job', async () => {
        runVendorReassessmentReminder.mockRejectedValue(new Error('db down'));

        const res = await runVendorMonitoringJob();

        expect(res.result.success).toBe(true);
        expect(res.result.details).toMatchObject({ reminded: 0 });
    });
});

describe('runVendorMonitoringJob — result envelope', () => {
    it('reports the job name, timestamps, and a non-negative duration', async () => {
        const res = await runVendorMonitoringJob();
        expect(res.result.jobName).toBe('vendor-monitoring');
        expect(res.result.jobRunId).toEqual(expect.any(String));
        expect(res.result.itemsSkipped).toBe(0);
        expect(res.result.durationMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(res.result.startedAt)).not.toBeNaN();
        expect(Date.parse(res.result.completedAt)).not.toBeNaN();
    });
});
