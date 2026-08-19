/**
 * The outbox claims a row before sending it, and scopes to one tenant when asked.
 *
 * ═══ THE BUG ═══
 *
 * processOutbox selected PENDING rows, sent the email, and only then wrote
 * `status: 'SENT'` — with `update({ where: { id } })`, no state predicate at
 * all. That is not a late claim, it is no claim: two overlapping passes both
 * selected the row, both sent, and both wrote SENT successfully while each
 * counted sent++. The row showed a single SENT and the stats looked clean, so
 * the only evidence was in the SMTP provider's log.
 *
 * The window is real — the 06:00 evidence-expiry job overlapping an admin
 * pressing "Process Outbox", or the documented 5-minute outbox cron overlapping
 * either — and at real SMTP latency a 200-row batch is tens of seconds wide.
 */
const prisma = {
    notificationOutbox: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
};
const sendEmail = jest.fn(async () => undefined);
const getTenantNotificationSettings = jest.fn(async () => ({
    enabled: true,
    defaultFromName: 'Inflect',
    defaultFromEmail: 'no-reply@inflect.test',
    complianceMailbox: 'compliance@acme.test',
}));

jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma, default: prisma }));
jest.mock('@/lib/mailer', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }));
jest.mock('@/app-layer/notifications/settings', () => ({
    getTenantNotificationSettings: (...a: unknown[]) => getTenantNotificationSettings(...(a as [])),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { processOutbox } from '@/app-layer/notifications/processOutbox';

const row = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    tenantId: 't1',
    toEmail: 'user@acme.test',
    subject: 'Evidence expiring',
    bodyText: 'body',
    bodyHtml: null,
    attempts: 0,
    dedupeKey: 'dk-1',
    ...over,
});

/** The write that claims the row — an attempts increment predicated on PENDING. */
function claimCalls() {
    return prisma.notificationOutbox.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.data?.attempts?.increment === 1,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    prisma.notificationOutbox.findMany.mockResolvedValue([row()]);
    prisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sendEmail.mockResolvedValue(undefined as never);
});

describe('the claim precedes the send', () => {
    it('claims before sendEmail is called', async () => {
        const seq: string[] = [];
        prisma.notificationOutbox.updateMany.mockImplementation(async (a: any) => {
            seq.push(a.data?.attempts?.increment ? 'claim' : `mark:${a.data?.status}`);
            return { count: 1 };
        });
        sendEmail.mockImplementation(async () => { seq.push('send'); return undefined as never; });

        await processOutbox();
        expect(seq[0]).toBe('claim');
        expect(seq.indexOf('send')).toBeGreaterThan(0);
    });

    it('the claim is predicated on PENDING *and* the attempts value it read', async () => {
        // attempts is the optimistic-concurrency token: the claim only matches
        // while the row still holds the value this pass selected.
        await processOutbox();
        expect(claimCalls()[0][0].where).toMatchObject({ id: 'o1', status: 'PENDING', attempts: 0 });
    });

    it('losing the claim sends NOTHING', async () => {
        // The concurrent-pass case. This is the whole point of the fix.
        prisma.notificationOutbox.updateMany.mockResolvedValueOnce({ count: 0 });
        const res = await processOutbox();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(res.sent).toBe(0);
        expect(res.skipped).toBe(1);
    });

    it('a lost claim is not counted as a failure', async () => {
        // Another pass owning the row is normal operation, not an error — and
        // counting it as failed would make a healthy overlap look like an
        // outage on the admin page.
        prisma.notificationOutbox.updateMany.mockResolvedValueOnce({ count: 0 });
        expect((await processOutbox()).failed).toBe(0);
    });
});

describe('attempts is incremented once, atomically', () => {
    it('uses an increment, never a stale absolute value', async () => {
        // `attempts: row.attempts + 1` was a read-modify-write: two failing
        // passes both wrote 1, burning one unit of a three-attempt budget
        // instead of two, so a hard-failing address got extra real deliveries.
        await processOutbox();
        expect(claimCalls()[0][0].data).toEqual({ attempts: { increment: 1 } });
    });

    it('the failure path does NOT increment a second time', async () => {
        sendEmail.mockRejectedValue(new Error('smtp down'));
        await processOutbox();

        const increments = prisma.notificationOutbox.updateMany.mock.calls.filter(
            (c: any[]) => c[0]?.data?.attempts !== undefined,
        );
        expect(increments).toHaveLength(1);
    });

    it('marks FAILED once the claimed attempt reaches maxAttempts', async () => {
        prisma.notificationOutbox.findMany.mockResolvedValue([row({ attempts: 2 })]);
        sendEmail.mockRejectedValue(new Error('smtp down'));

        const res = await processOutbox({ maxAttempts: 3 });
        const mark = prisma.notificationOutbox.updateMany.mock.calls.at(-1)![0];
        expect(mark.data.status).toBe('FAILED');
        expect(res.failed).toBe(1);
    });

    it('leaves it PENDING for a retry below the ceiling', async () => {
        sendEmail.mockRejectedValue(new Error('transient'));
        const res = await processOutbox({ maxAttempts: 3 });
        const mark = prisma.notificationOutbox.updateMany.mock.calls.at(-1)![0];
        expect(mark.data.status).toBe('PENDING');
        expect(res.skipped).toBe(1);
    });
});

describe('completing writes cannot clobber another actor', () => {
    it('the SENT mark is predicated on PENDING', async () => {
        await processOutbox();
        const mark = prisma.notificationOutbox.updateMany.mock.calls.at(-1)![0];
        expect(mark.data.status).toBe('SENT');
        expect(mark.where).toMatchObject({ id: 'o1', status: 'PENDING' });
    });

    it('the failure mark is predicated on PENDING too', async () => {
        sendEmail.mockRejectedValue(new Error('x'));
        await processOutbox();
        expect(prisma.notificationOutbox.updateMany.mock.calls.at(-1)![0].where).toMatchObject({
            id: 'o1',
            status: 'PENDING',
        });
    });

    it('never uses the unpredicated update() that caused this', async () => {
        await processOutbox();
        expect(prisma.notificationOutbox.update).not.toHaveBeenCalled();
    });
});

describe('tenant scoping', () => {
    it('scopes the drain when a tenant is named', async () => {
        // Without this a tenant ADMIN pressing "Process Outbox" on their own
        // settings page sends every OTHER tenant's queued mail.
        await processOutbox({ tenantId: 't1' });
        expect(prisma.notificationOutbox.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1' });
    });

    it('stays global when no tenant is named — the scheduled jobs need that', async () => {
        await processOutbox();
        expect(prisma.notificationOutbox.findMany.mock.calls[0][0].where.tenantId).toBeUndefined();
    });
});

describe('a tenant with notifications disabled is skipped before any claim', () => {
    it('does not burn an attempt on a row it will not send', async () => {
        getTenantNotificationSettings.mockResolvedValue({
            enabled: false,
            defaultFromName: 'x',
            defaultFromEmail: 'x@y.z',
            complianceMailbox: null,
        } as never);

        const res = await processOutbox();
        expect(claimCalls()).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(res.skipped).toBe(1);
    });
});
