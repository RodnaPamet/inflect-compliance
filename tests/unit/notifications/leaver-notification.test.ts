/**
 * The leaver notification: who hears about a disable, and — the harder half —
 * who does not.
 *
 * The tests that matter most here are the SILENT ones. A channel that fires on
 * normal operation (a tenant sitting in DRY_RUN, a re-run over an estate that
 * is already offboarded correctly) gets filtered into a folder nobody opens,
 * and takes the INDETERMINATE message down with it. So every "nothing was
 * enqueued" assertion below is protecting the one message a human must read.
 *
 * Nothing here reaches a network, an LDAP server or a database: the Prisma
 * surface is a plain object, and the templates are exercised for real so the
 * assertions are about rendered text rather than about the shape of a call.
 */
const db = {
    tenantNotificationSettings: { findUnique: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    tenant: { findUnique: jest.fn() },
    notificationOutbox: { create: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
const notifMetric = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordLeaverNotification: (...a: unknown[]) => notifMetric(...a),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    buildLeaverAudienceBook,
    notifyLeaverOutcome,
    planLeaverNotifications,
} from '@/app-layer/notifications/leaver';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });

interface CreatedRow {
    type: string;
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    dedupeKey: string;
}

/** Everything the outbox was asked to write in this test. */
function created(): CreatedRow[] {
    return db.notificationOutbox.create.mock.calls.map(
        (c) => (c[0] as { data: CreatedRow }).data,
    );
}

function linkRow(over: Record<string, unknown> = {}) {
    return {
        id: 'link-1',
        employee: {
            id: 'emp-1',
            fullName: 'Dana Okafor',
            workEmail: 'dana@acme.test',
            manager: { id: 'emp-9', fullName: 'Sam Reid', workEmail: 'sam@acme.test' },
        },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // No compliance mailbox by default — the OWNER/ADMIN fallback is the shape
    // every tenant starts in.
    db.tenantNotificationSettings.findUnique.mockResolvedValue({ complianceMailbox: null });
    db.tenantMembership.findMany.mockResolvedValue([
        { user: { email: 'it@acme.test', name: 'IT Desk' } },
    ]);
    db.identityAccountLink.findMany.mockResolvedValue([linkRow()]);
    db.tenant.findUnique.mockResolvedValue({ slug: 'acme' });
    db.notificationOutbox.create.mockImplementation(async (args: { data: CreatedRow }) => ({
        id: 'outbox-1',
        ...args.data,
    }));
});

async function book() {
    return buildLeaverAudienceBook(ctx, ['link-1']);
}

// ─── The routing table ───

describe('planLeaverNotifications', () => {
    it('notifies both audiences when the disable actually happened', () => {
        expect(planLeaverNotifications('DISABLED', true)).toEqual({
            it: 'IDENTITY_LEAVER_DISABLED',
            manager: 'IDENTITY_LEAVER_DISABLED',
        });
    });

    it('notifies both audiences when the outcome is unknown — the one a human must act on', () => {
        expect(planLeaverNotifications('INDETERMINATE', true)).toEqual({
            it: 'IDENTITY_LEAVER_UNCONFIRMED',
            manager: 'IDENTITY_LEAVER_UNCONFIRMED',
        });
    });

    it.each(['REFUSED_TARGET', 'FAILED', 'REFUSED_PROTECTED'] as const)(
        'tells IT but not the manager about %s — the account is live and only an operator can fix it',
        (outcome) => {
            expect(planLeaverNotifications(outcome, false)).toEqual({
                it: 'IDENTITY_LEAVER_NEEDS_ACTION',
                manager: null,
            });
        },
    );

    it('says nothing about REFUSED_MODE — normal for every tenant climbing the ladder', () => {
        expect(planLeaverNotifications('REFUSED_MODE', false)).toEqual({ it: null, manager: null });
    });

    it('says nothing about DRY_RUN — nothing happened, by design', () => {
        expect(planLeaverNotifications('DRY_RUN', false)).toEqual({ it: null, manager: null });
    });

    it('says nothing about an ordinary already-disabled account', () => {
        expect(planLeaverNotifications('ALREADY_DISABLED', false)).toEqual({
            it: null,
            manager: null,
        });
    });

    it('DOES speak when an already-disabled read reconciled an unconfirmed write', () => {
        // The journal id is the only signal separating steady state from
        // "we just answered a question somebody was sent away to investigate".
        expect(planLeaverNotifications('ALREADY_DISABLED', true)).toEqual({
            it: 'IDENTITY_LEAVER_DISABLED',
            manager: 'IDENTITY_LEAVER_DISABLED',
        });
    });
});

// ─── Audience resolution ───

describe('buildLeaverAudienceBook', () => {
    it('does NOT let a compliance mailbox displace the admin fan-out', async () => {
        db.tenantNotificationSettings.findUnique.mockResolvedValue({
            complianceMailbox: 'security@acme.test',
        });
        const b = await book();
        // processOutbox already Bccs complianceMailbox on every message — the
        // field's only operator-facing label is literally "Compliance Mailbox
        // (BCC)". Routing here INSTEAD of the admins would mail the queue twice
        // and every administrator not at all.
        expect(b.it.map((r) => r.email)).toEqual(['it@acme.test']);
        expect(b.it.map((r) => r.email)).not.toContain('security@acme.test');
        expect(db.tenantMembership.findMany).toHaveBeenCalled();
    });

    it('falls back to the compliance mailbox only when no admin has an address', async () => {
        db.tenantNotificationSettings.findUnique.mockResolvedValue({
            complianceMailbox: 'security@acme.test',
        });
        db.tenantMembership.findMany.mockResolvedValue([]);
        const b = await book();
        // A Bcc needs a row and a row needs a To, so with no fan-out the
        // mailbox is the only way the message exists at all.
        expect(b.it).toEqual([{ email: 'security@acme.test', name: 'security' }]);
    });

    it('orders the admin fan-out, so the capped recipient set cannot drift between passes', async () => {
        await book();
        expect(db.tenantMembership.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    });

    it('falls back to OWNER and ADMIN, not ADMIN alone', async () => {
        await book();
        const where = db.tenantMembership.findMany.mock.calls[0][0].where;
        expect(where.role.in).toEqual(expect.arrayContaining(['OWNER', 'ADMIN']));
    });

    it('resolves the manager through the link', async () => {
        const b = await book();
        expect(b.byLink.get('link-1')?.manager).toEqual({
            email: 'sam@acme.test',
            name: 'Sam Reid',
        });
    });

    it('yields no manager when managerEmployeeId is null', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: null,
                },
            }),
        ]);
        const b = await book();
        expect(b.byLink.get('link-1')?.manager).toBeNull();
        expect(b.byLink.get('link-1')?.workerName).toBe('Dana Okafor');
    });

    it('refuses a self-managing employee as their own manager', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: { id: 'emp-1', fullName: 'Dana Okafor', workEmail: 'dana@acme.test' },
                },
            }),
        ]);
        expect((await book()).byLink.get('link-1')?.manager).toBeNull();
    });

    it('refuses a manager whose mailbox is the leaver&apos;s own', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'Dana@Acme.test',
                    manager: { id: 'emp-9', fullName: 'Shared Box', workEmail: 'dana@acme.test' },
                },
            }),
        ]);
        expect((await book()).byLink.get('link-1')?.manager).toBeNull();
    });

    it('does not mail a manager who is themselves TERMINATED', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: {
                        id: 'emp-9',
                        fullName: 'Sam Reid',
                        workEmail: 'sam@acme.test',
                        // An earlier pass already disabled this mailbox.
                        status: 'TERMINATED',
                    },
                },
            }),
        ]);
        expect((await book()).byLink.get('link-1')?.manager).toBeNull();
    });

    it('still mails a manager who is OFFBOARDING — they are working their notice', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: {
                        id: 'emp-9',
                        fullName: 'Sam Reid',
                        workEmail: 'sam@acme.test',
                        status: 'OFFBOARDING',
                    },
                },
            }),
        ]);
        expect((await book()).byLink.get('link-1')?.manager?.email).toBe('sam@acme.test');
    });

    it('does not mail a manager this very batch is offboarding', async () => {
        // A team wound down together offboards its lead in the same run. The
        // mail would land in a mailbox this pass is closing.
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                id: 'link-1',
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: { id: 'emp-9', fullName: 'Sam Reid', workEmail: 'sam@acme.test' },
                },
            }),
            linkRow({
                id: 'link-2',
                employee: {
                    id: 'emp-9',
                    fullName: 'Sam Reid',
                    workEmail: 'sam@acme.test',
                    manager: null,
                },
            }),
        ]);
        const b = await buildLeaverAudienceBook(ctx, ['link-1', 'link-2']);
        expect(b.byLink.get('link-1')?.manager).toBeNull();
    });

    it('uses the request context slug without a lookup when it has one', async () => {
        const slugged = makeRequestContext('ADMIN', { tenantId: 't1', tenantSlug: 'from-ctx' });
        const b = await buildLeaverAudienceBook(slugged, ['link-1']);
        expect(b.tenantSlug).toBe('from-ctx');
        expect(db.tenant.findUnique).not.toHaveBeenCalled();
    });
});

// ─── What actually gets enqueued ───

describe('notifyLeaverOutcome', () => {
    it('enqueues one IT mail and one manager mail on a real disable', async () => {
        const result = await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
            occurredAt: new Date('2026-08-20T09:00:00Z'),
        });

        expect(result).toEqual({ enqueued: 2, failed: 0, silent: false });
        const rows = created();
        expect(rows.map((r) => r.toEmail).sort()).toEqual(['it@acme.test', 'sam@acme.test']);
        expect(rows.every((r) => r.type === 'IDENTITY_LEAVER_DISABLED')).toBe(true);
    });

    it('gives IT the journal reference and a plain-language way to reverse it', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });
        const it = created().find((r) => r.toEmail === 'it@acme.test');
        expect(it?.bodyText).toContain('jrnl-77');
        expect(it?.bodyText).toContain('To reverse this');
        // The reversal instruction must not invent a screen that would 404.
        expect(it?.bodyText).toContain('no self-service');
        // The one link it does carry points at a page that exists.
        expect(it?.bodyText).toContain('/t/acme/admin/integrations/identity-accounts');
    });

    it('gives the manager no admin link — they are usually not a member here', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });
        const mgr = created().find((r) => r.toEmail === 'sam@acme.test');
        expect(mgr?.bodyText).not.toContain('/t/acme/');
        expect(mgr?.bodyHtml).not.toContain('href');
        expect(mgr?.bodyText).toContain('Dana Okafor');
    });

    it('carries the ambiguity of an unconfirmed write to both audiences intact', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'INDETERMINATE',
            reason: 'ETIMEDOUT contacting graph.microsoft.com',
            journalId: 'jrnl-88',
        });
        const rows = created();
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.type === 'IDENTITY_LEAVER_UNCONFIRMED')).toBe(true);
        const it = rows.find((r) => r.toEmail === 'it@acme.test');
        expect(it?.bodyText).toContain('did not report');
        expect(it?.bodyText).toContain('ETIMEDOUT');
        const mgr = rows.find((r) => r.toEmail === 'sam@acme.test');
        // The manager must not be told it worked, and must not be told it failed.
        expect(mgr?.bodyText).toContain('may have');
        expect(mgr?.bodyText).not.toContain('has been disabled');
    });

    it.each(['REFUSED_TARGET', 'FAILED', 'REFUSED_PROTECTED'] as const)(
        'routes %s to IT only',
        async (outcome) => {
            const result = await notifyLeaverOutcome(ctx, await book(), {
                linkId: 'link-1',
                provider: 'entra-id',
                outcome,
                reason: 'the write was refused before it reached the directory',
            });
            expect(result.enqueued).toBe(1);
            const rows = created();
            expect(rows[0].toEmail).toBe('it@acme.test');
            expect(rows[0].type).toBe('IDENTITY_LEAVER_NEEDS_ACTION');
            expect(rows[0].bodyText).toContain('still live');
        },
    );

    it('omits the journal reference from a refusal that never journalled', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'REFUSED_TARGET',
            reason: 'mastered on-premises',
        });
        // Quoting a reference that does not exist sends an operator looking for
        // a record nobody can find.
        expect(created()[0].bodyText).not.toContain('Journal reference');
    });

    it.each(['REFUSED_MODE', 'DRY_RUN'] as const)(
        'stays completely silent on %s',
        async (outcome) => {
            const result = await notifyLeaverOutcome(ctx, await book(), {
                linkId: 'link-1',
                provider: 'entra-id',
                outcome,
                reason: 'leaver writes are switched off for this tenant',
            });
            expect(result).toEqual({ enqueued: 0, failed: 0, silent: true });
            expect(db.notificationOutbox.create).not.toHaveBeenCalled();
        },
    );

    it('stays silent on an ordinary already-disabled account', async () => {
        const result = await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'ALREADY_DISABLED',
        });
        expect(result.silent).toBe(true);
        expect(db.notificationOutbox.create).not.toHaveBeenCalled();
    });

    it('announces a reconcile as a confirmation, not as a fresh disable', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'ALREADY_DISABLED',
            journalId: 'jrnl-99',
        });
        const rows = created();
        expect(rows).toHaveLength(2);
        expect(rows[0].bodyText).toContain('has now been confirmed as applied');
        expect(rows[0].bodyText).not.toContain('account was disabled on');
    });

    it('still reaches IT when the link is unresolvable', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([]);
        const result = await notifyLeaverOutcome(ctx, await book(), {
            linkId: null,
            provider: 'active-directory',
            outcome: 'INDETERMINATE',
            reason: 'connection reset',
            journalId: 'jrnl-11',
        });
        expect(result.enqueued).toBe(1);
        expect(created()[0].toEmail).toBe('it@acme.test');
        expect(created()[0].bodyText).toContain('a departing worker');
    });

    it('still reaches IT when the worker has no manager', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: {
                    id: 'emp-1',
                    fullName: 'Dana Okafor',
                    workEmail: 'dana@acme.test',
                    manager: null,
                },
            }),
        ]);
        const result = await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-12',
        });
        expect(result.enqueued).toBe(1);
        expect(created()[0].toEmail).toBe('it@acme.test');
    });

    it('dedupes per journal row, so one write can never mail twice', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });
        const it = created().find((r) => r.toEmail === 'it@acme.test');
        expect(it?.dedupeKey).toContain('jrnl-77');
        expect(it?.dedupeKey).toContain('IDENTITY_LEAVER_DISABLED');
    });

    it('dedupes a pre-journal refusal per link, so a daily pass mails once a day', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'REFUSED_TARGET',
            reason: 'mastered on-premises',
        });
        expect(created()[0].dedupeKey).toContain('link-1');
    });

    it('strips markup out of a provider error before it reaches an inbox', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'FAILED',
            reason: '<script>alert(1)</script>refused',
        });
        const row = created()[0];
        expect(row.bodyText).not.toContain('<script>');
        expect(row.bodyHtml).not.toContain('<script>');
        expect(row.bodyText).toContain('refused');
    });

    it('clamps a runaway provider error — an email is not a log', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'FAILED',
            reason: 'x'.repeat(5000),
        });
        expect(created()[0].bodyText).not.toContain('x'.repeat(400));
    });

    it('never throws when the outbox insert fails — offboarding is not blocked by mail', async () => {
        db.notificationOutbox.create.mockRejectedValue(new Error('outbox is on fire'));
        await expect(
            notifyLeaverOutcome(ctx, await book(), {
                linkId: 'link-1',
                provider: 'entra-id',
                outcome: 'DISABLED',
                journalId: 'jrnl-77',
            }),
            // Both recipients attempted, both lost, and the count says so —
            // "0 enqueued" and "0 enqueued, 2 lost" are different facts.
        ).resolves.toEqual({ enqueued: 0, failed: 2, silent: false });
    });

    it('one failing recipient does not take the others down with it', async () => {
        // IT is enumerated before the manager, so a shared try around the loop
        // would let the first administrator's failing insert silently delete
        // the manager's mail. And "the next pass re-enqueues it" is no rescue:
        // a DISABLED mail's dedupe entity is the journal row, minted once.
        let n = 0;
        db.notificationOutbox.create.mockImplementation(async (args: { data: CreatedRow }) => {
            if (n++ === 0) throw new Error('first insert is on fire');
            return { id: 'outbox-2', ...args.data };
        });
        const result = await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });
        expect(result).toEqual({ enqueued: 1, failed: 1, silent: false });
        expect(db.notificationOutbox.create).toHaveBeenCalledTimes(2);
        expect(created()[1].toEmail).toBe('sam@acme.test');
    });

    it.each([
        ["a UPN in a Graph error", "Resource 'dana.okafor@acme.test' does not exist", 'dana.okafor@acme.test'],
        ['a DN in an LDAP error', 'no such object: CN=Dana Okafor,OU=Leavers,DC=acme,DC=test', 'CN=Dana Okafor'],
        [
            'an object id',
            'PATCH /users/3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed',
            '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        ],
    ])('strips %s out of the provider text before it reaches an inbox', async (_label, reason, leaked) => {
        // Half the audience are line managers who are often not tenant members,
        // and the IT copy commonly lands in a shared queue that forwards
        // outside the tenant. A message pairing "this person has left" with
        // their username is one sentence from a phishing template.
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'FAILED',
            reason,
        });
        const body = created()[0].bodyText;
        expect(body).not.toContain(leaked);
        expect(body).toContain('{account}');
    });

    it("strips the account's own id, which has no shape to match on", async () => {
        // A sAMAccountName is just a word. Only the caller knows it, which is
        // why the id is passed in at all — it is never rendered.
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'active-directory',
            outcome: 'FAILED',
            reason: 'insufficientAccessRights modifying d.okafor',
            externalUserId: 'd.okafor',
        });
        expect(created()[0].bodyText).not.toContain('d.okafor');
    });

    it('counts each recipient by what became of it', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });

        expect(notifMetric).toHaveBeenCalledWith({ provider: 'entra-id', audience: 'IT', result: 'enqueued' });
        expect(notifMetric).toHaveBeenCalledWith({ provider: 'entra-id', audience: 'MANAGER', result: 'enqueued' });
    });

    it('counts a deduped row as suppressed, not as delivered', async () => {
        // The outbox dedupes per (tenant, type, toEmail, entity, day). A second
        // pass over the same journal row is correctly silent — but a rising
        // suppressed rate must be legible as dedupe rather than as delivery.
        // A duplicate is a P2002 that enqueueEmail swallows into a null return,
        // NOT a null row — the distinction matters, because a null return from
        // create() is a throw on the way out and would be counted as failed.
        db.notificationOutbox.create.mockRejectedValue(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
        );

        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });

        expect(notifMetric).toHaveBeenCalledWith({ provider: 'entra-id', audience: 'IT', result: 'suppressed' });
    });

    it('counts a lost row as failed — the one that needs an alert', async () => {
        db.notificationOutbox.create.mockRejectedValue(new Error('outbox is on fire'));

        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });

        const failures = notifMetric.mock.calls.filter((c) => (c[0] as { result: string }).result === 'failed');
        expect(failures).toHaveLength(2);
    });

    it('counts "there was nobody to tell" — no row, no error, no retry', async () => {
        // The quietest way this subsystem fails: a tenant whose privileged
        // members hold no address produces nothing at all.
        db.tenantMembership.findMany.mockResolvedValue([]);
        db.tenantNotificationSettings.findUnique.mockResolvedValue({ complianceMailbox: null });

        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });

        expect(notifMetric).toHaveBeenCalledWith({
            provider: 'entra-id',
            audience: 'IT',
            result: 'no_recipient',
        });
    });

    it('counts a manager who does not exist, not just a log line', async () => {
        db.identityAccountLink.findMany.mockResolvedValue([
            linkRow({
                employee: { id: 'emp-1', fullName: 'Dana Okafor', workEmail: 'dana@acme.test', manager: null },
            }),
        ]);

        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });

        expect(notifMetric).toHaveBeenCalledWith({
            provider: 'entra-id',
            audience: 'MANAGER',
            result: 'no_recipient',
        });
    });

    it('counts what was planned but never reached an insert attempt', async () => {
        // The outer catch covers a throw before or between recipients — here an
        // unrepresentable date, which blows up building the payload. Both
        // audiences were planned and neither was attempted, so both must be
        // counted; anything less makes a wholly-lost notification invisible.
        //
        // This assertion used to read `failed: 0` while asserting the metric had
        // counted two — pinning a drift between what this function REPORTS and
        // what it COUNTS as though it were the contract. The caller builds its
        // batch line from the return value, so the zero hid the worst case
        // (nobody told at all) behind a clean total.
        const r = await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
            occurredAt: new Date(NaN),
        });

        expect(r).toEqual({ enqueued: 0, failed: 2, silent: false });
        const failed = notifMetric.mock.calls
            .map((c) => c[0] as { audience: string; result: string })
            .filter((a) => a.result === 'failed');
        expect(failed.map((a) => a.audience).sort()).toEqual(['IT', 'MANAGER']);
    });

    it('enqueues rather than sending — no mail transport is touched', async () => {
        await notifyLeaverOutcome(ctx, await book(), {
            linkId: 'link-1',
            provider: 'entra-id',
            outcome: 'DISABLED',
            journalId: 'jrnl-77',
        });
        // The whole delivery surface is a row in NotificationOutbox. If this
        // ever grew a direct send, a leaver pass would inherit SMTP latency and
        // SMTP failure — which is the reason the outbox exists.
        expect(db.notificationOutbox.create).toHaveBeenCalledTimes(2);
    });
});
