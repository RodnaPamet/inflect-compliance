/**
 * Recipient validation for scheduled report delivery.
 *
 * The module this covers exists because `recipients` on a ReportSchedule was
 * validated for RFC email SHAPE only — no count cap, no check on who the
 * addresses belonged to — and the delivery path then did
 * `to: recipients.join(', ')` unfiltered. Any writer could aim the tenant's
 * board-risk PDF at an arbitrary address, weekly, forever.
 *
 * Two independent gates are asserted here: the address must RESOLVE (member or
 * allowlisted), and aiming off-tenant needs `reports.schedule_external`. Either
 * one alone stops the attack; both are tested separately so a future change that
 * removes one is visible.
 */
const mockDbHolder: { db: Record<string, unknown> } = { db: {} };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDbHolder.db),
    ),
}));

import {
    resolveScheduleRecipients,
    parseRecipientAllowlist,
    MAX_SCHEDULE_RECIPIENTS,
    MAX_EMAIL_ATTACHMENT_BYTES,
} from '@/app-layer/usecases/report-recipients';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function primeDb(memberEmails: string[], allowlist: unknown = null) {
    mockDbHolder.db = {
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue(
                memberEmails.map((email) => ({ user: { email } })),
            ),
        },
        tenantSecuritySettings: {
            findUnique: jest.fn().mockResolvedValue({ reportRecipientAllowlistJson: allowlist }),
        },
    };
}

const editorish = {
    ...ctx,
    appPermissions: {
        ...ctx.appPermissions,
        reports: { ...ctx.appPermissions.reports, schedule_external: false },
    },
};

beforeEach(() => jest.clearAllMocks());

describe('parseRecipientAllowlist', () => {
    it('reads exact addresses, @domain and bare domain forms', () => {
        // Operators write domains both ways; silently honouring only one would
        // fail closed in a way that looks like a bug in the allowlist.
        const { exact, domains } = parseRecipientAllowlist([
            'auditor@kpmg.com',
            '@bdo.com',
            'pwc.com',
        ]);
        expect(exact.has('auditor@kpmg.com')).toBe(true);
        expect(domains.has('bdo.com')).toBe(true);
        expect(domains.has('pwc.com')).toBe(true);
    });

    it('normalises case and ignores junk entries', () => {
        const { exact, domains } = parseRecipientAllowlist([
            '  Auditor@KPMG.com ',
            '',
            42,
            null,
            '@BDO.com',
        ]);
        expect(exact.has('auditor@kpmg.com')).toBe(true);
        expect(domains.has('bdo.com')).toBe(true);
        expect(exact.size + domains.size).toBe(2);
    });

    it('treats a non-array (or absent) allowlist as empty, not as a wildcard', () => {
        for (const bad of [null, undefined, {}, 'kpmg.com', 7]) {
            const { exact, domains } = parseRecipientAllowlist(bad);
            expect(exact.size).toBe(0);
            expect(domains.size).toBe(0);
        }
    });
});

describe('resolveScheduleRecipients — the exfiltration gate', () => {
    it('accepts an ACTIVE member', async () => {
        primeDb(['ciso@acme.test']);
        const out = await resolveScheduleRecipients(ctx, ['ciso@acme.test']);
        expect(out.internal).toEqual(['ciso@acme.test']);
        expect(out.external).toEqual([]);
    });

    it('refuses an address that is neither a member nor allowlisted, naming it', async () => {
        // The headline attack.
        primeDb(['ciso@acme.test']);
        await expect(
            resolveScheduleRecipients(ctx, ['attacker@example.com']),
        ).rejects.toThrow(/"attacker@example.com" is not a member/);
    });

    it('refuses the whole list when ONE address fails, rather than silently dropping it', async () => {
        // Partial acceptance would be the worst outcome: the user believes the
        // schedule includes an address it does not, or does not notice one it
        // does.
        primeDb(['ciso@acme.test']);
        await expect(
            resolveScheduleRecipients(ctx, ['ciso@acme.test', 'attacker@example.com']),
        ).rejects.toThrow(/not a member/);
    });

    it('accepts an allowlisted external address for a caller with the elevation', async () => {
        primeDb(['ciso@acme.test'], ['@kpmg.com']);
        const out = await resolveScheduleRecipients(ctx, ['auditor@kpmg.com']);
        expect(out.external).toEqual(['auditor@kpmg.com']);
        expect(out.internal).toEqual([]);
    });

    it('refuses the SAME allowlisted address without reports.schedule_external', async () => {
        // Gate two. The allowlist says the address is acceptable; the permission
        // says who may point a standing feed at it.
        primeDb(['ciso@acme.test'], ['@kpmg.com']);
        await expect(
            resolveScheduleRecipients(editorish, ['auditor@kpmg.com']),
        ).rejects.toThrow(/requires an administrator/);
    });

    it('does NOT require the elevation for a members-only schedule', async () => {
        // The elevation must not become a blanket ban on scheduling: a writer
        // sending a report to colleagues is the ordinary case.
        primeDb(['ciso@acme.test', 'cfo@acme.test']);
        const out = await resolveScheduleRecipients(editorish, [
            'ciso@acme.test',
            'cfo@acme.test',
        ]);
        expect(out.internal).toHaveLength(2);
    });

    it('matches members case-insensitively', async () => {
        primeDb(['ciso@acme.test']);
        const out = await resolveScheduleRecipients(ctx, ['CISO@Acme.Test']);
        expect(out.internal).toEqual(['ciso@acme.test']);
    });

    it('de-duplicates while preserving order', async () => {
        primeDb(['a@acme.test', 'b@acme.test']);
        const out = await resolveScheduleRecipients(ctx, [
            'b@acme.test',
            'a@acme.test',
            'B@ACME.TEST',
        ]);
        expect(out.recipients).toEqual(['b@acme.test', 'a@acme.test']);
    });

    it('caps the recipient count', async () => {
        primeDb([]);
        const many = Array.from({ length: MAX_SCHEDULE_RECIPIENTS + 1 }, (_, i) => `p${i}@acme.test`);
        await expect(resolveScheduleRecipients(ctx, many)).rejects.toThrow(
            new RegExp(`at most ${MAX_SCHEDULE_RECIPIENTS} recipients`),
        );
    });

    it('counts the cap AFTER de-duplication, so repeats are not punished', async () => {
        primeDb(['a@acme.test']);
        const dupes = Array.from({ length: MAX_SCHEDULE_RECIPIENTS + 5 }, () => 'a@acme.test');
        const out = await resolveScheduleRecipients(ctx, dupes);
        expect(out.recipients).toEqual(['a@acme.test']);
    });

    it('short-circuits an empty list without touching the database', async () => {
        primeDb([]);
        const out = await resolveScheduleRecipients(ctx, []);
        expect(out).toEqual({ recipients: [], internal: [], external: [] });
        expect(
            (mockDbHolder.db as { tenantMembership: { findMany: jest.Mock } }).tenantMembership
                .findMany,
        ).not.toHaveBeenCalled();
    });

    it('matches membership in the DATABASE rather than loading the roster', async () => {
        // A schedule save must not pull a large tenant's whole membership list
        // into memory. Bounded by the recipient cap on both sides.
        primeDb(['a@acme.test']);
        await resolveScheduleRecipients(ctx, ['a@acme.test']);
        const arg = (
            mockDbHolder.db as { tenantMembership: { findMany: jest.Mock } }
        ).tenantMembership.findMany.mock.calls[0][0];
        expect(arg.where.status).toBe('ACTIVE');
        expect(arg.where.user.email.in).toEqual(['a@acme.test']);
        expect(arg.take).toBe(MAX_SCHEDULE_RECIPIENTS);
    });

    it('fails closed when the tenant has configured no allowlist', async () => {
        // "No external destinations approved yet" and "every destination is
        // fine" are opposite statements.
        primeDb(['a@acme.test'], null);
        await expect(
            resolveScheduleRecipients(ctx, ['auditor@kpmg.com']),
        ).rejects.toThrow(/not on the report-recipient allowlist/);
    });
});

describe('attachment cap', () => {
    it('sits under the common provider ceiling with base64 headroom', () => {
        // 15 MB raw ≈ 20 MB base64-encoded, under the usual 20–25 MB limits.
        expect(MAX_EMAIL_ATTACHMENT_BYTES).toBe(15 * 1024 * 1024);
        expect(MAX_EMAIL_ATTACHMENT_BYTES * 1.34).toBeLessThan(25 * 1024 * 1024);
    });
});
