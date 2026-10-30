/**
 * The workspace's own email carries its sender and compliance BCC, and stops
 * when the workspace switches email notifications off (#4469).
 *
 * Owner decision (2026-10-29): the weekly compliance digest and scheduled risk
 * reports follow the same rules as the outbox. Before it, only `processOutbox`
 * applied the tenant's sender and BCC; the digest called `sendEmail` bare, so
 * it went out from the deployment sender, uncopied, to a workspace that had
 * switched email off. The risk-report half of the decision is asserted in
 * `tests/unit/risk-report-branches.test.ts`, beside that usecase's own mocks.
 *
 * The digest is driven END TO END through `runComplianceDigest` with a mocked
 * client, so what is asserted is the message handed to the mailer — not that
 * the job imports a helper.
 */
const prisma = {
    tenant: { findMany: jest.fn() },
    tenantNotificationSettings: { findUnique: jest.fn() },
    complianceSnapshot: { findFirst: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
};
const sendEmail = jest.fn(async (..._a: unknown[]) => undefined);

jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma, default: prisma }));
jest.mock('@/lib/mailer', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

import {
    resolveTenantEmailEnvelope,
    tenantEmailEnvelope,
} from '@/app-layer/notifications/settings';
import { runComplianceDigest } from '@/app-layer/jobs/compliance-digest';
import { UNCONFIGURED_SENDER, deploymentSenderAddress } from '@/lib/email/sender-identity';

type Db = Parameters<typeof resolveTenantEmailEnvelope>[0];

const SETTINGS_ON = {
    enabled: true,
    defaultFromName: 'Acme GRC',
    defaultFromEmail: 'grc@acme.test',
    complianceMailbox: 'archive@acme.test',
    mutedInAppTypes: [],
};

const SNAPSHOT = {
    snapshotDate: new Date('2026-10-26T05:00:00Z'),
    controlCoverageBps: 7500,
    controlsImplemented: 30,
    controlsApplicable: 40,
    risksTotal: 12,
    risksOpen: 5,
    risksCritical: 0,
    risksHigh: 2,
    evidenceOverdue: 0,
    evidenceDueSoon7d: 0,
    policiesOverdueReview: 0,
    tasksOpen: 8,
    tasksOverdue: 0,
    findingsOpen: 3,
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findMany.mockResolvedValue([{ id: 't1', name: 'Acme', slug: 'acme' }]);
    prisma.complianceSnapshot.findFirst.mockResolvedValue(SNAPSHOT);
    prisma.tenantMembership.findMany.mockResolvedValue([
        { user: { email: 'admin1@acme.test' } },
        { user: { email: 'admin2@acme.test' } },
    ]);
});

describe('tenantEmailEnvelope — the one definition', () => {
    it('formats the sender and carries the compliance mailbox as BCC', () => {
        expect(tenantEmailEnvelope(SETTINGS_ON)).toEqual({
            from: 'Acme GRC <grc@acme.test>',
            bcc: 'archive@acme.test',
        });
    });

    it('carries no BCC when no compliance mailbox is set', () => {
        expect(tenantEmailEnvelope({ ...SETTINGS_ON, complianceMailbox: null }).bcc).toBeUndefined();
        expect(tenantEmailEnvelope({ ...SETTINGS_ON, complianceMailbox: '' }).bcc).toBeUndefined();
    });
});

describe('resolveTenantEmailEnvelope', () => {
    const dbWith = (row: unknown): Db =>
        ({ tenantNotificationSettings: { findUnique: async () => row } }) as unknown as Db;

    it('is null when the workspace has switched email off', async () => {
        expect(await resolveTenantEmailEnvelope(dbWith({ ...SETTINGS_ON, enabled: false }), 't1')).toBeNull();
    });

    it('is the workspace envelope when email is on', async () => {
        expect(await resolveTenantEmailEnvelope(dbWith(SETTINGS_ON), 't1')).toEqual({
            from: 'Acme GRC <grc@acme.test>',
            bcc: 'archive@acme.test',
        });
    });

    it('a workspace with no settings row sends, from the deployment sender, uncopied', async () => {
        const original = process.env.SMTP_FROM;
        process.env.SMTP_FROM = 'ops@example-verified.test';
        try {
            const envelope = await resolveTenantEmailEnvelope(dbWith(null), 't1');
            expect(envelope).toEqual({
                from: `Inflect Compliance <${deploymentSenderAddress()}>`,
                bcc: undefined,
            });
            expect(envelope?.from).not.toContain(UNCONFIGURED_SENDER);
        } finally {
            if (original === undefined) delete process.env.SMTP_FROM;
            else process.env.SMTP_FROM = original;
        }
    });

    it('a failed read throws rather than defaulting to "send"', async () => {
        const db = {
            tenantNotificationSettings: { findUnique: async () => { throw new Error('db down'); } },
        } as unknown as Db;
        await expect(resolveTenantEmailEnvelope(db, 't1')).rejects.toThrow('db down');
    });
});

describe('the weekly compliance digest', () => {
    it('sends nothing, and reads no snapshot, when email notifications are off', async () => {
        prisma.tenantNotificationSettings.findUnique.mockResolvedValue({ ...SETTINGS_ON, enabled: false });

        const { result } = await runComplianceDigest();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(prisma.complianceSnapshot.findFirst).not.toHaveBeenCalled();
        expect(result.itemsActioned).toBe(0);
        expect(result.itemsSkipped).toBe(1);
    });

    it('is suppressed for a manual re-run with recipient overrides too', async () => {
        prisma.tenantNotificationSettings.findUnique.mockResolvedValue({ ...SETTINGS_ON, enabled: false });

        await runComplianceDigest({ recipientOverrides: ['someone@acme.test'] });

        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('carries the workspace sender and compliance BCC on every message when on', async () => {
        prisma.tenantNotificationSettings.findUnique.mockResolvedValue(SETTINGS_ON);

        const { result } = await runComplianceDigest();

        expect(result.itemsActioned).toBe(1);
        expect(sendEmail).toHaveBeenCalledTimes(2);
        for (const [msg] of sendEmail.mock.calls) {
            expect(msg).toMatchObject({
                from: 'Acme GRC <grc@acme.test>',
                bcc: 'archive@acme.test',
            });
        }
        expect(sendEmail.mock.calls.map(([m]) => (m as { to: string }).to).sort())
            .toEqual(['admin1@acme.test', 'admin2@acme.test']);
    });

    it('sends nothing when the settings read fails', async () => {
        prisma.tenantNotificationSettings.findUnique.mockRejectedValue(new Error('db down'));

        const { result } = await runComplianceDigest();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(result.itemsSkipped).toBe(1);
    });
});
