/**
 * The break-glass rail's producer.
 *
 * `disableAccount` has refused a protected account since #2036 — refusal, reason
 * and outcome all in place and tested. Nothing ever SET the flag, so the rail was
 * a guard bound to nothing. These tests are about the half that was missing.
 */
const mockDb = {
    connectedIdentityAccount: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
const logEventMock = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

import { setAccountProtection, MAX_PROTECTION_REASON } from '@/app-layer/usecases/identity-account-protection';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1', userId: 'u-1' });
const NOW = new Date('2026-08-21T10:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({ id: 'acct-1', isProtected: false });
    mockDb.connectedIdentityAccount.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
        id: 'acct-1',
        ...a.data,
    }));
});

describe('setAccountProtection', () => {
    it('records who protected the account, when, and why', async () => {
        const r = await setAccountProtection(ctx, 'acct-1', { isProtected: true, reason: 'break-glass' }, NOW);

        expect(r.isProtected).toBe(true);
        const data = mockDb.connectedIdentityAccount.update.mock.calls[0][0].data;
        expect(data).toMatchObject({
            isProtected: true,
            protectedAt: NOW,
            protectedByUserId: 'u-1',
            protectionReason: 'break-glass',
        });
    });

    it('CLEARS the provenance on release rather than leaving it behind', async () => {
        // A stale "protected by X on the 3rd" beside an unprotected account is a
        // sentence that reads as true and is not.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({ id: 'acct-1', isProtected: true });
        await setAccountProtection(ctx, 'acct-1', { isProtected: false }, NOW);

        expect(mockDb.connectedIdentityAccount.update.mock.calls[0][0].data).toMatchObject({
            isProtected: false,
            protectedAt: null,
            protectedByUserId: null,
            protectionReason: null,
        });
    });

    it('requires a reason to protect, because an unexplained flag is a mistake', async () => {
        // The whole value of this list a year from now is that each entry says
        // why it is there.
        await expect(setAccountProtection(ctx, 'acct-1', { isProtected: true }, NOW)).rejects.toThrow(/reason is required/i);
        // And it refuses BEFORE opening the transaction — no read, no write. The
        // specific message above is what makes this pair meaningful: asserting
        // only that nothing was called would pass just as well if the function
        // had thrown for some unrelated reason, or never run at all.
        expect(mockDb.connectedIdentityAccount.findFirst).not.toHaveBeenCalled();
        expect(mockDb.connectedIdentityAccount.update).not.toHaveBeenCalled();
    });

    it('does not require a reason to RELEASE', async () => {
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({ id: 'acct-1', isProtected: true });
        await expect(setAccountProtection(ctx, 'acct-1', { isProtected: false }, NOW)).resolves.toMatchObject({
            isProtected: false,
        });
    });

    it('sanitises the reason at the WRITE path', async () => {
        // Epic C.5: a roster page, a pass report and any future SDK consumer all
        // read this back verbatim. Escaping at render time alone leaves the
        // stored row dangerous to everything that is not an escaper.
        await setAccountProtection(
            ctx,
            'acct-1',
            { isProtected: true, reason: '<script>alert(1)</script>emergency access' },
            NOW,
        );
        const reason = mockDb.connectedIdentityAccount.update.mock.calls[0][0].data.protectionReason as string;
        expect(reason).not.toMatch(/<script>/i);
        expect(reason).toContain('emergency access');
    });

    it('refuses a reason longer than the bound', async () => {
        await expect(
            setAccountProtection(ctx, 'acct-1', { isProtected: true, reason: 'x'.repeat(MAX_PROTECTION_REASON + 1) }, NOW),
        ).rejects.toThrow(/characters or fewer/i);
    });

    it('treats another tenant\'s account as NOT FOUND, not as a silent no-op', async () => {
        // The predicate carries tenantId as well as the RLS transaction. A
        // cross-tenant id must fail loudly; a no-op that reports success is how
        // an operator believes an account is protected when it is not.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue(null);
        await expect(setAccountProtection(ctx, 'other', { isProtected: true, reason: 'x' }, NOW)).rejects.toThrow(/not found/i);
        expect(mockDb.connectedIdentityAccount.update).not.toHaveBeenCalled();
        expect(mockDb.connectedIdentityAccount.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 't1' });
    });

    it('audits under `access`, and names the account row rather than the directory id', async () => {
        await setAccountProtection(ctx, 'acct-1', { isProtected: true, reason: 'break-glass' }, NOW);

        const entry = logEventMock.mock.calls[0][2];
        expect(entry.action).toBe('IDENTITY_ACCOUNT_PROTECTION_CHANGED');
        expect(entry.detailsJson.category).toBe('access');
        // Protecting REVOKES the product's authority over this account;
        // releasing GRANTS it. Same orientation as the write-mode ladder.
        expect(entry.detailsJson.operation).toBe('revoke');
        expect(entry.metadata).toMatchObject({ accountId: 'acct-1', from: false, to: true });
        // The audit row is hash-chained and permanent. No directory identifier
        // may reach it — the rule #2060 set for this whole subsystem.
        expect(JSON.stringify(entry)).not.toMatch(/externalUserId/);
    });

    it('audits a RELEASE as granting authority back', async () => {
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({ id: 'acct-1', isProtected: true });
        await setAccountProtection(ctx, 'acct-1', { isProtected: false }, NOW);
        expect(logEventMock.mock.calls[0][2].detailsJson.operation).toBe('grant');
    });
});
