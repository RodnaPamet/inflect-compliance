/**
 * `calendar-push-tenant` visits every live connection of a workspace, one
 * person at a time, and ONE PERSON'S FAILURE NEVER STOPS THE NEXT (#5937
 * step 2).
 *
 * The per-person work (`pushOneConnection`) is stubbed so each person can be
 * made to fail a different way; what is real is the job's loop and
 * `runUserPushGuarded`, which turns a refused token into a revoked connection
 * and a throttle into "try tomorrow".
 */
const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { userCalendarConnection: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

const updateMany = jest.fn(async () => ({ count: 1 }));
const jobContexts: Array<{ tenantId: string; source: string }> = [];
jest.mock('@/lib/db-context', () => ({
    runInTenantJobContext: (job: { tenantId: string; source: string }, cb: (db: unknown) => unknown) => {
        jobContexts.push(job);
        return cb({
            tenant: { findUnique: async () => ({ defaultLocale: 'bg' }) },
            userCalendarConnection: { updateMany: (...a: unknown[]) => updateMany(...(a as [])) },
        });
    },
    runInTenantContext: () => {
        throw new Error('the job never runs in a request context');
    },
}));

import { runCalendarPushTenant } from '@/app-layer/jobs/calendar-push';
import { IntegrationAuthError, IntegrationRateLimitedError } from '@/app-layer/integrations/http-resilience';
import { isKekBypassSource } from '@/lib/db/kek-bypass-sources';

const conn = (userId: string, provider = 'google-calendar') => ({ id: `c-${userId}`, userId, provider });

beforeEach(() => {
    jest.clearAllMocks();
    jobContexts.length = 0;
});

describe('one person failing does not stop the batch', () => {
    it('visits everyone, and counts each outcome', async () => {
        findMany.mockResolvedValue([conn('boom'), conn('throttled'), conn('revoked', 'outlook-calendar'), conn('ok'), conn('quiet')]);
        const push = jest.fn(async (_run: unknown, identity: { userId: string }) => {
            switch (identity.userId) {
                case 'boom': throw new Error('a bug');
                case 'throttled': throw new IntegrationRateLimitedError('https://x', 60_000, 429);
                case 'revoked': throw new IntegrationAuthError(400, 'https://login.microsoftonline.com/x/oauth2/v2.0/token');
                case 'ok': return { kind: 'pushed' as const, changed: true, inserted: 1, patched: 0, deleted: 0, deferred: 0, failures: 0 };
                default: return { kind: 'pushed' as const, changed: false, inserted: 0, patched: 0, deleted: 0, deferred: 0, failures: 0 };
            }
        });

        const out = await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });

        expect(push.mock.calls.map((c) => (c[1] as { userId: string }).userId)).toEqual(['boom', 'throttled', 'revoked', 'ok', 'quiet']);
        expect(out.outcomes).toEqual({ pushed: 1, 'nothing-to-do': 1, revoked: 1, throttled: 1, failed: 1 });
        expect(out.pushed).toBe(1);
    });

    it('a refused token revokes THAT connection only — token destroyed, the row kept', async () => {
        findMany.mockResolvedValue([conn('revoked', 'outlook-calendar'), conn('ok')]);
        const push = jest.fn(async (_run: unknown, identity: { userId: string }) => {
            if (identity.userId === 'revoked') throw new IntegrationAuthError(401, 'https://graph.microsoft.com/v1.0/me/events');
            return { kind: 'pushed' as const, changed: false, inserted: 0, patched: 0, deleted: 0, deferred: 0, failures: 0 };
        });
        await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });

        expect(updateMany).toHaveBeenCalledTimes(1);
        const [{ where, data }] = updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
        expect(where).toEqual({ tenantId: 't1', userId: 'revoked', provider: 'outlook-calendar' });
        expect(data).toMatchObject({ tokenEncrypted: '', revokedReason: expect.stringMatching(/withdrawn/) });
    });

    it('a throttle revokes nothing', async () => {
        findMany.mockResolvedValue([conn('throttled')]);
        const push = jest.fn(async () => { throw new IntegrationRateLimitedError('https://x', 60_000, 429); });
        await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe('what every person\'s push is given', () => {
    it('the workspace language, read once, and a tenant context that resolves the DEK', async () => {
        findMany.mockResolvedValue([conn('a'), conn('b')]);
        const push = jest.fn(async (..._args: unknown[]) => ({ kind: 'skipped' as const }));
        await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });

        expect(push.mock.calls.map((c) => c[2])).toEqual([
            { locale: 'bg', publicOrigin: null },
            { locale: 'bg', publicOrigin: null },
        ]);
        // The job's OWN source: a bypass label would hand back ciphertext.
        expect(jobContexts.every((j) => j.tenantId === 't1' && j.source === 'calendar-push')).toBe(true);
        expect(isKekBypassSource('calendar-push')).toBe(false);
    });

    it('the public origin comes from APP_URL, never a request', async () => {
        process.env.APP_URL = 'https://app.example.test';
        try {
            findMany.mockResolvedValue([conn('a')]);
            const push = jest.fn(async (..._args: unknown[]) => ({ kind: 'skipped' as const }));
            await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });
            expect(push.mock.calls[0][2]).toEqual({ locale: 'bg', publicOrigin: 'https://app.example.test' });
        } finally {
            delete process.env.APP_URL;
        }
    });

    it('a workspace with no live connection does no work at all', async () => {
        findMany.mockResolvedValue([]);
        const push = jest.fn();
        const out = await runCalendarPushTenant({ tenantId: 't1' }, { push: push as never });
        expect(push).not.toHaveBeenCalled();
        expect(jobContexts).toEqual([]);
        expect(out.connections).toBe(0);
    });
});
