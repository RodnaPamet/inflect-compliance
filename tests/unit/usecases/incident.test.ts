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
 *   3. create and update store an owner only when they are an ACTIVE member
 *      of the tenant — `Incident.ownerUserId` has no relation to check it.
 *   4. The timeline entries the usecase writes name severities, types,
 *      phases, notification kinds and forensic categories by their labels,
 *      never by enum code — people read them on the incident's Timeline tab.
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
        getNotification: jest.fn(),
        updateNotification: jest.fn(),
        evidenceExists: jest.fn(),
        linkEvidence: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { runInTenantContext } from '@/lib/db-context';
import { IncidentRepository } from '@/app-layer/repositories/IncidentRepository';
import {
    advancePhase,
    createIncident,
    linkEvidence,
    markReportable,
    submitNotification,
    updateIncident,
} from '@/app-layer/usecases/incident';
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

describe('the incident owner must be an active member of the tenant', () => {
    const membershipQuery = (userId: string) => ({
        where: { userId, tenantId: 'tenant-A', status: 'ACTIVE' },
        select: { id: true },
    });

    it('createIncident refuses an owner who is not an active member, and writes nothing', async () => {
        fakeDb.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(
            createIncident(admin, { ...base, ownerUserId: 'stranger-9' }),
        ).rejects.toMatchObject({ status: 400, message: 'Owner must be an active member of this tenant' });
        expect(fakeDb.tenantMembership.findFirst).toHaveBeenCalledWith(membershipQuery('stranger-9'));
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('createIncident stores an owner who is an active member', async () => {
        await createIncident(admin, { ...base, ownerUserId: 'member-2' });
        expect(fakeDb.tenantMembership.findFirst).toHaveBeenCalledWith(membershipQuery('member-2'));
        expect((repo.create.mock.calls[0][2] as any).ownerUserId).toBe('member-2');
    });

    it('createIncident asks nothing when no owner is named', async () => {
        await createIncident(admin, base);
        expect(fakeDb.tenantMembership.findFirst).not.toHaveBeenCalled();
        expect((repo.create.mock.calls[0][2] as any).ownerUserId).toBeNull();
    });

    it('updateIncident refuses an owner who is not an active member, and writes nothing', async () => {
        fakeDb.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(
            updateIncident(admin, 'inc_1', { ownerUserId: 'stranger-9' }),
        ).rejects.toMatchObject({ status: 400, message: 'Owner must be an active member of this tenant' });
        expect(fakeDb.tenantMembership.findFirst).toHaveBeenCalledWith(membershipQuery('stranger-9'));
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('updateIncident stores an owner who is an active member', async () => {
        repo.update.mockResolvedValue({ id: 'inc_1', reference: 'INC-2026-001' } as any);
        await updateIncident(admin, 'inc_1', { ownerUserId: 'member-2' });
        expect((repo.update.mock.calls[0][3] as any).ownerUserId).toBe('member-2');
    });

    it('updateIncident clears the owner without a membership check', async () => {
        repo.update.mockResolvedValue({ id: 'inc_1', reference: 'INC-2026-001' } as any);
        await updateIncident(admin, 'inc_1', { ownerUserId: null });
        expect(fakeDb.tenantMembership.findFirst).not.toHaveBeenCalled();
        expect((repo.update.mock.calls[0][3] as any).ownerUserId).toBeNull();
    });
});

describe('timeline entries name things by label, never by enum code', () => {
    const entries = () => repo.addTimelineEntry.mock.calls.map((c) => (c[2] as any).entry as string);
    const CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b(LOW|MEDIUM|HIGH|CRITICAL|RANSOMWARE|DETECTION|CLASSIFICATION|REPORTABLE)\b/;
    const stored = {
        id: 'inc_1',
        reference: 'INC-2026-001',
        phase: 'DETECTION',
        detectedAt: new Date('2026-10-29T14:37:00.000Z'),
        reportedAt: null,
    };

    it('creation', async () => {
        await createIncident(admin, { ...base, incidentType: 'DATA_BREACH' });
        expect(entries()).toEqual(['Incident INC-2026-001 opened (severity High, type Data breach).']);
    });

    it('phase advance', async () => {
        repo.getById.mockResolvedValue(stored as any);
        await advancePhase(admin, 'inc_1', {});
        expect(entries()).toEqual(['Phase advanced Detection → Classification.']);
    });

    it('marking reportable', async () => {
        repo.getById.mockResolvedValue(stored as any);
        await markReportable(admin, 'inc_1', { reportable: true });
        expect(entries()[0]).toMatch(/^Marked reportable under NIS2 Article 23/);
        expect(entries()[0]).not.toMatch(CODE);
    });

    it('filing a notification', async () => {
        repo.getById.mockResolvedValue(stored as any);
        repo.getNotification.mockResolvedValue({ id: 'n-1' } as any);
        await submitNotification(admin, 'inc_1', {
            kind: 'EARLY_WARNING_24H',
            reportText: 'Filed with the CSIRT.',
            submissionRef: 'CCB-2026-0042',
        });
        expect(entries()).toEqual(['Filed the 24-hour early warning (ref CCB-2026-0042).']);
    });

    it('linking forensic evidence', async () => {
        repo.getById.mockResolvedValue(stored as any);
        repo.evidenceExists.mockResolvedValue(true as any);
        repo.linkEvidence.mockResolvedValue({ id: 'link-1' } as any);
        await linkEvidence(admin, 'inc_1', { evidenceId: 'ev-1', forensicCategory: 'SYSTEM_LOGS' });
        expect(entries()).toEqual(['Linked forensic evidence (System & application logs).']);
    });
});
