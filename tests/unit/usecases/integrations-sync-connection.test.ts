/**
 * `syncConnection` — the "Sync now" button behind the admin integrations page.
 *
 * It had no unit coverage at all (lines 469-514 of `integrations.ts`), which is
 * most of why that file sits below its function-coverage floor. It is also the
 * usecase that sits on a documented seam, so the assertions here are about
 * WHICH collaborator it calls and WHICH rows it selects, not about counts.
 *
 * THE SEAM. CLAUDE.md records it: `runIdentitySync` enumerates the directory;
 * `runIdentitySyncJob` enumerates AND THEN reconciles `IdentityAccountLink`
 * rows. This usecase calls the former, so a manual sync fills the roster and
 * creates NO links — and the next leaver pass then refuses `NO_FRESH_LINKS`.
 * That is deliberate, it surprises people, and "any new caller that needs links
 * must go through the job, or the seam moves". A test that pins which of the
 * two is called is the only thing standing between that note and a well-meant
 * one-word edit.
 */

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({
    registry: {
        getProvider: jest.fn(),
        resolveByAutomationKey: jest.fn(),
        getWebhookProvider: jest.fn(),
        listProviders: jest.fn().mockReturnValue([]),
        listAllAutomationKeys: jest.fn().mockReturnValue([]),
    },
}));
jest.mock('@/app-layer/integrations/types', () => ({
    parseAutomationKey: jest.fn(),
    isScheduledCheckProvider: jest.fn(() => true),
}));
jest.mock('@/lib/security/encryption', () => ({
    encryptField: jest.fn((s: string) => `ENC(${s})`),
    decryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/prisma', () => ({
    prisma: { integrationWebhookEvent: { create: jest.fn(), update: jest.fn() } },
}));
jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRunIdentitySync = jest.fn();
const mockRunIdentitySyncJob = jest.fn();
jest.mock('@/app-layer/usecases/identity-sync', () => ({
    runIdentitySync: (...a: unknown[]) => mockRunIdentitySync(...a),
    // Present but unused, on purpose: the assertion that the JOB is NOT called
    // is only meaningful if calling it were possible.
    runIdentitySyncJob: (...a: unknown[]) => mockRunIdentitySyncJob(...a),
}));

import { syncConnection } from '@/app-layer/usecases/integrations';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

/**
 * `syncConnection` opens three separate transactions in order: the connection
 * lookup, the control query, then one per control inside
 * `runAutomationForControl`. Queueing the first two and letting the rest fall
 * through to a rejecting default keeps each test's fixture to what it is
 * actually about.
 */
function seed(opts: {
    connection: unknown;
    controls?: Array<{ id: string }>;
}) {
    const controlFindMany = jest.fn().mockResolvedValue(opts.controls ?? []);
    const connectionFindFirst = jest.fn().mockResolvedValue(opts.connection);
    mockRunInTx.mockImplementation(async (_ctx, fn) =>
        fn({
            integrationConnection: { findFirst: connectionFindFirst },
            control: { findMany: controlFindMany },
        } as never),
    );
    return { connectionFindFirst, controlFindMany };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunIdentitySync.mockResolvedValue({ status: 'PASSED', upserted: 11, deprovisioned: 0 });
});

describe('syncConnection — lookup', () => {
    it('refuses a connection outside the tenant', async () => {
        const { connectionFindFirst } = seed({ connection: null });
        await expect(
            syncConnection(makeRequestContext('ADMIN', { tenantId: 'tenant-Z' }), 'other-tenants-id'),
        ).rejects.toThrow(/Connection not found or disabled/);
        expect(connectionFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'other-tenants-id', tenantId: 'tenant-Z', isEnabled: true },
            }),
        );
    });

    // `isEnabled: true` is in the WHERE clause, not checked after the read, so a
    // disabled connection is indistinguishable from a missing one — deliberately.
    // Dropping it would let "Sync now" reach a directory the operator has
    // explicitly turned off, which is the one thing disabling is for.
    it('treats a DISABLED connection as not found', async () => {
        const { connectionFindFirst } = seed({ connection: null });
        await expect(syncConnection(makeRequestContext('ADMIN'), 'c1'))
            .rejects.toThrow(/not found or disabled/);
        const where = connectionFindFirst.mock.calls[0][0].where;
        expect(where.isEnabled).toBe(true);
    });
});

describe('syncConnection — the identity seam', () => {
    // The load-bearing one. See the file docstring.
    it('calls runIdentitySync, NOT runIdentitySyncJob, for an identity provider', async () => {
        seed({ connection: { id: 'c1', provider: 'entra-id', name: 'Corp' } });

        const out = await syncConnection(makeRequestContext('ADMIN', { tenantId: 't-1' }), 'c1');

        expect(mockRunIdentitySync).toHaveBeenCalledWith({ tenantId: 't-1', connectionId: 'c1' });
        // The job is what reconciles IdentityAccountLink rows. A manual sync
        // deliberately does not, so the next leaver pass refuses NO_FRESH_LINKS
        // until the 03:00 job runs. Swapping these would move the seam silently.
        expect(mockRunIdentitySyncJob).not.toHaveBeenCalled();
        expect(out.identity).toEqual({ status: 'PASSED', upserted: 11, deprovisioned: 0 });
    });

    it.each([['okta'], ['google-workspace'], ['entra-id'], ['active-directory']])(
        'runs the directory sync for %s',
        async (provider) => {
            seed({ connection: { id: 'c1', provider, name: 'dir' } });
            await syncConnection(makeRequestContext('ADMIN'), 'c1');
            expect(mockRunIdentitySync).toHaveBeenCalled();
        },
    );

    it('reports identity as null for a non-identity provider', async () => {
        seed({ connection: { id: 'c1', provider: 'datadog', name: 'prod' } });
        const out = await syncConnection(makeRequestContext('ADMIN'), 'c1');
        expect(mockRunIdentitySync).not.toHaveBeenCalled();
        // null, not absent: the admin surface distinguishes "this provider has
        // no directory" from "the sync produced nothing".
        expect(out).toHaveProperty('identity', null);
    });
});

describe('syncConnection — control selection and tallying', () => {
    it('selects only controls wired to THIS provider, bounded', async () => {
        const { controlFindMany } = seed({
            connection: { id: 'c1', provider: 'datadog', name: 'prod' },
        });
        await syncConnection(makeRequestContext('ADMIN', { tenantId: 't-9' }), 'c1');

        const args = controlFindMany.mock.calls[0][0];
        // The prefix is what scopes the blast radius. A regression to an
        // unfiltered query would run EVERY automated control in the tenant on
        // one button press.
        expect(args.where).toMatchObject({
            tenantId: 't-9',
            deletedAt: null,
            automationKey: { startsWith: 'datadog.' },
        });
        expect(args.take).toBe(200);
    });

    it('records a per-control failure as ERROR and keeps going', async () => {
        // `runAutomationForControl` is the real implementation here; with the
        // registry mocked to resolve nothing it throws, which is exactly the
        // arm under test — one bad control must not abort the batch.
        seed({
            connection: { id: 'c1', provider: 'datadog', name: 'prod' },
            controls: [{ id: 'ctl-1' }, { id: 'ctl-2' }, { id: 'ctl-3' }],
        });

        const out = await syncConnection(makeRequestContext('ADMIN'), 'c1');

        expect(out.checks).toHaveLength(3);
        expect(out.checks.map((c) => c.controlId)).toEqual(['ctl-1', 'ctl-2', 'ctl-3']);
        expect(out.counts).toEqual({ total: 3, passed: 0, failed: 0, error: 3 });
    });

    it('returns an empty tally when no control is wired to the provider', async () => {
        seed({ connection: { id: 'c1', provider: 'datadog', name: 'prod' }, controls: [] });
        const out = await syncConnection(makeRequestContext('ADMIN'), 'c1');
        expect(out.checks).toEqual([]);
        expect(out.counts).toEqual({ total: 0, passed: 0, failed: 0, error: 0 });
        expect(out.connectionId).toBe('c1');
        expect(out.provider).toBe('datadog');
    });
});
