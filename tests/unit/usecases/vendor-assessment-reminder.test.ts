/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/vendor-assessment-reminder.ts` —
 * admin-triggered reminder for in-flight vendor assessments.
 *
 * Wave-9 / stage-3g branch coverage. The function has 5 distinct
 * reject paths that each block a different misconfiguration:
 *   - assessment not in tenant → notFound
 *   - status not SENT/IN_PROGRESS → badRequest
 *   - missing respondent email → badRequest
 *   - external token expired → badRequest
 *   - missing vendor or template → badRequest
 * Plus the happy path + audit emission.
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];
const enqueueCalls: any[] = [];

jest.mock('@/app-layer/policies/vendor.policies', () => ({
    assertCanRunAssessment: jest.fn(() => policyCalls.push('run')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn(async (_db: any, args: any) => {
        enqueueCalls.push(args);
        return { id: 'notif-1' };
    }),
}));

jest.mock('@/env', () => ({
    env: { APP_URL: 'https://test.local/' },
}));

const tenantDb: any = {
    vendorAssessment: { findFirst: jest.fn(), update: jest.fn(async () => ({})) },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { sendAssessmentReminder } from '@/app-layer/usecases/vendor-assessment-reminder';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    enqueueCalls.length = 0;
    tenantDb.vendorAssessment.findFirst.mockReset();
    tenantDb.vendorAssessment.update.mockClear();
    (enqueueEmail as jest.Mock).mockClear();
    (enqueueEmail as jest.Mock).mockImplementation(async (_db: any, args: any) => {
        enqueueCalls.push(args);
        return { id: 'notif-1' };
    });
});

const ctx = makeRequestContext('ADMIN');

const futureExpiry = new Date(Date.now() + 86_400_000);
const pastExpiry = new Date('2020-01-01');

function happyAssessment(overrides: Partial<any> = {}) {
    return {
        id: 'a-1',
        tenantId: 'tenant-1',
        status: 'SENT',
        respondentEmail: 'vendor@example.com',
        externalAccessTokenExpiresAt: futureExpiry,
        vendor: { name: 'Acme Inc.' },
        templateVersion: { name: 'Security Q3' },
        requestedBy: { name: 'Alice' },
        ...overrides,
    };
}

describe('sendAssessmentReminder', () => {
    it('throws notFound when the assessment is foreign to the tenant', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        await expect(sendAssessmentReminder(ctx, 'a-foreign')).rejects.toThrow(/assessment not found/i);
        expect(enqueueEmail).not.toHaveBeenCalled();
    });

    it('REJECTS reminders for terminal statuses (DRAFT/COMPLETED/etc.)', async () => {
        // Only SENT and IN_PROGRESS can be reminded — keeps the
        // reminder UX away from completed/archived assessments.
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ status: 'COMPLETED' }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/cannot send a reminder.*COMPLETED/i);
        expect(enqueueEmail).not.toHaveBeenCalled();
    });

    it('REJECTS when the assessment has no respondent email on file', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ respondentEmail: null }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/no respondent email/i);
    });

    it('REJECTS when the external access token has expired', async () => {
        // Compliance-critical: a reminder cannot revive an expired
        // assessment link. The admin must send a NEW assessment to
        // mint a fresh token.
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ externalAccessTokenExpiresAt: pastExpiry }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/token has expired/i);
    });

    it('REJECTS when externalAccessTokenExpiresAt is null', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ externalAccessTokenExpiresAt: null }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/token has expired/i);
    });

    it('REJECTS when vendor relation is missing (invariant violation)', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ vendor: null }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/missing vendor or template/i);
    });

    it('REJECTS when templateVersion relation is missing', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ templateVersion: null }),
        );
        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/missing vendor or template/i);
    });

    it('enqueues the email + emits the audit on happy path', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(happyAssessment());

        const result = await sendAssessmentReminder(ctx, 'a-1');

        expect(result.notificationQueued).toBe(true);
        expect(result.expiresAt).toBe(futureExpiry);
        expect(enqueueCalls).toHaveLength(1);
        expect(enqueueCalls[0]).toMatchObject({
            type: 'VENDOR_ASSESSMENT_REMINDER',
            toEmail: 'vendor@example.com',
            entityId: 'a-1',
        });
        expect(enqueueCalls[0].payload).toMatchObject({
            vendorName: 'Acme Inc.',
            templateName: 'Security Q3',
            inviterName: 'Alice',
        });
        expect(auditCalls[0].action).toBe('VENDOR_ASSESSMENT_REMINDER_SENT');
    });

    it('handles null requestedBy.name (the `?? undefined` branch)', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ requestedBy: null }),
        );
        const result = await sendAssessmentReminder(ctx, 'a-1');
        expect(result.notificationQueued).toBe(true);
        expect(enqueueCalls[0].payload.inviterName).toBeUndefined();
    });

    it('IN_PROGRESS status is also accepted (status guard branch coverage)', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(
            happyAssessment({ status: 'IN_PROGRESS' }),
        );
        const result = await sendAssessmentReminder(ctx, 'a-1');
        expect(result.notificationQueued).toBe(true);
    });

    it('returns notificationQueued=false when enqueueEmail returns null', async () => {
        // The implementation surfaces null as queued=false (the
        // dedup path returns null — same-day re-clicks).
        (enqueueEmail as jest.Mock).mockResolvedValueOnce(null);
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(happyAssessment());

        const result = await sendAssessmentReminder(ctx, 'a-1');
        expect(result.notificationQueued).toBe(false);
    });
});

// ─── #4650: a reminder carries a fresh link ────────────────────────────

describe('sendAssessmentReminder issues a fresh link (#4650)', () => {
    const { createHash } = jest.requireActual('crypto') as typeof import('crypto');

    it('links with a new key, and stores only its hash in place of the old one', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(happyAssessment());

        await sendAssessmentReminder(ctx, 'a-1');

        const url = new URL(enqueueCalls[0].payload.responseUrl);
        expect(url.origin + url.pathname).toBe('https://test.local/vendor-assessment/a-1');
        const raw = url.searchParams.get('t');
        expect(raw).toMatch(/^[A-Za-z0-9_-]{40,}$/);

        expect(tenantDb.vendorAssessment.update).toHaveBeenCalledTimes(1);
        const update = tenantDb.vendorAssessment.update.mock.calls[0][0];
        expect(update.where).toEqual({ id: 'a-1', tenantId: ctx.tenantId });
        // The stored value is the hash of the emailed key, never the key.
        expect(update.data).toEqual({ externalAccessTokenHash: createHash('sha256').update(raw!).digest('hex') });
        // The expiry is untouched: a reminder never extends access.
        expect(update.data).not.toHaveProperty('externalAccessTokenExpiresAt');

        expect(auditCalls[0].detailsJson.after).toMatchObject({ linkReissued: true, notificationQueued: true });
    });

    it('keeps the old key when nothing was sent, so the vendor is never left with only a dead link', async () => {
        (enqueueEmail as jest.Mock).mockResolvedValueOnce(null);
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(happyAssessment());

        await sendAssessmentReminder(ctx, 'a-1');

        expect(tenantDb.vendorAssessment.update).not.toHaveBeenCalled();
        expect(auditCalls[0].detailsJson.after).toMatchObject({ linkReissued: false, notificationQueued: false });
    });

    it('refuses a revoked link before sending or rotating anything', async () => {
        tenantDb.vendorAssessment.findFirst.mockResolvedValueOnce(happyAssessment({ revokedAt: new Date() }));

        await expect(sendAssessmentReminder(ctx, 'a-1')).rejects.toThrow(/revoked/i);
        expect(enqueueCalls).toHaveLength(0);
        expect(tenantDb.vendorAssessment.update).not.toHaveBeenCalled();
    });
});
