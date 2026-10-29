/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks that
 * mirror the Prisma transaction client; per-line typing has poor
 * cost/benefit in a test file (see tests/unit/usecases/task.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/incident.ts (#4463).
 *
 *   1. createIncident stores the full detection timestamp it is given and
 *      refuses one in the future (past a small clock-skew allowance) — it is
 *      the clock every NIS2 Article 23 deadline is counted from.
 *   2. markReportable counts the three deadlines from that stored instant,
 *      so a detection at 14:37 is due its early warning at 14:37 next day.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/IncidentRepository', () => ({
    IncidentRepository: {
        nextReference: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        getById: jest.fn(),
        addTimelineEntry: jest.fn(),
        createNotifications: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { runInTenantContext } from '@/lib/db-context';
import { IncidentRepository } from '@/app-layer/repositories/IncidentRepository';
import { createIncident, markReportable } from '@/app-layer/usecases/incident';
import { DETECTED_AT_FUTURE_TOLERANCE_MS } from '@/lib/incidents/detected-at';
import { makeRequestContext } from '../../helpers/make-context';

const mockRun = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const repo = IncidentRepository as jest.Mocked<typeof IncidentRepository>;

const fakeDb = {
    tenantMembership: { findFirst: jest.fn() },
    incidentNotification: { updateMany: jest.fn() },
};

const admin = makeRequestContext('ADMIN', { tenantId: 'tenant-A', userId: 'admin-1' });

beforeEach(() => {
    jest.clearAllMocks();
    mockRun.mockImplementation(async (_ctx: any, fn: any) => fn(fakeDb));
    fakeDb.tenantMembership.findFirst.mockResolvedValue({ id: 'm-1' });
    repo.nextReference.mockResolvedValue('INC-2026-001');
    repo.create.mockImplementation(async (_db: any, _ctx: any, data: any) => ({
        id: 'inc_1',
        title: data.title,
        ...data,
    }));
    repo.update.mockResolvedValue({ id: 'inc_1' } as any);
});

const base = { title: 'Ransomware', severity: 'HIGH' as const, incidentType: 'RANSOMWARE' as const };

describe('createIncident — the detection time', () => {
    it('stores the full timestamp it is given, not the day', async () => {
        await createIncident(admin, { ...base, detectedAt: '2026-10-29T14:37:00.000Z' });
        const data = repo.create.mock.calls[0][2] as any;
        expect((data.detectedAt as Date).toISOString()).toBe('2026-10-29T14:37:00.000Z');
    });

    it('refuses a detection time in the future, and writes nothing', async () => {
        const later = new Date(Date.now() + DETECTED_AT_FUTURE_TOLERANCE_MS + 60_000);
        await expect(
            createIncident(admin, { ...base, detectedAt: later.toISOString() }),
        ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/future/i) });
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts a time just ahead of the server clock (a device clock running fast)', async () => {
        const slightlyAhead = new Date(Date.now() + 60_000);
        await createIncident(admin, { ...base, detectedAt: slightlyAhead.toISOString() });
        expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('defaults to now when no detection time is sent', async () => {
        const before = Date.now();
        await createIncident(admin, base);
        const data = repo.create.mock.calls[0][2] as any;
        expect((data.detectedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
        expect((data.detectedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    });
});

describe('markReportable — the deadlines follow the real detection time', () => {
    it('counts 24h / 72h / 1 month from the stored instant', async () => {
        repo.getById.mockResolvedValue({
            id: 'inc_1',
            reference: 'INC-2026-001',
            phase: 'DETECTION',
            detectedAt: new Date('2026-10-29T14:37:00.000Z'),
        } as any);

        await markReportable(admin, 'inc_1', { reportable: true });

        const deadlines = repo.createNotifications.mock.calls[0][3] as Array<{ kind: string; dueAt: Date }>;
        expect(deadlines.map((d) => [d.kind, d.dueAt.toISOString()])).toEqual([
            ['EARLY_WARNING_24H', '2026-10-30T14:37:00.000Z'],
            ['DETAILED_72H', '2026-11-01T14:37:00.000Z'],
            ['FINAL_1MONTH', '2026-11-29T14:37:00.000Z'],
        ]);
    });
});
