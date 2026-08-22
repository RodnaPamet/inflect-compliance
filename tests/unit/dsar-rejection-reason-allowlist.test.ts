/**
 * `DataSubjectRequest.rejectionReason` is protected by an ALLOWLIST, not by
 * sanitisation — and until this file existed, nothing tested that.
 *
 * The column is written raw at `dsar-register.ts:236`
 * (`rejectionReason: input.reason ?? null`). What makes that safe is the check
 * at :204-212: the write is gated on `input.to === 'REJECTED'`, `requiresReason`
 * is exactly that same condition, so the allowlist always runs first and the
 * column can only ever hold one of the three values in `DSAR_REJECTION_REASONS`.
 *
 * That protection is easy to lose by accident. Add an `other: please specify`
 * reason, or widen the vocabulary to free text, and the allowlist stops
 * protecting anything — while the rich-text sanitiser ratchet stays GREEN,
 * because it is file-level and `dsar-register.ts` does call `sanitizePlainText`
 * for the sibling column `fulfilmentNotes`.
 *
 * So this is the thing that fails instead. If a future reason value is not a
 * fixed token, the first test breaks and points at the write path that then
 * needs `sanitizeOptional`.
 *
 * The allowlist check runs BEFORE `runInTenantContext`, so no database is
 * needed: the mocked tenant scope throws a sentinel, and which error surfaces
 * tells us whether the input got past the allowlist.
 */

const SENTINEL = 'REACHED_DB_SCOPE';

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async () => {
        throw new Error(SENTINEL);
    }),
}));

import { transitionDsarRequest } from '@/app-layer/usecases/dsar-register';
import { DSAR_REJECTION_REASONS } from '@/lib/dsar';
import { makeRequestContext } from '../helpers/make-context';

const ctx = {
    ...makeRequestContext('ADMIN'),
    appPermissions: { admin: { compliance_dsar_manage: true } },
} as unknown as Parameters<typeof transitionDsarRequest>[0];

describe('rejectionReason is confined to a closed vocabulary', () => {
    it('every allowed value is a fixed token, not free text', () => {
        // The premise the raw write depends on. A value carrying spaces or
        // punctuation is a sign the vocabulary has become prose — at which
        // point `dsar-register.ts:236` needs `sanitizeOptional` like its
        // sibling column already has.
        for (const value of Object.values(DSAR_REJECTION_REASONS)) {
            expect(typeof value).toBe('string');
            expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
        }
    });

    it('refuses a free-text rejection reason', async () => {
        await expect(
            transitionDsarRequest(ctx, 'd-1', {
                to: 'REJECTED',
                reason: '<img src=x onerror=alert(1)> because I said so',
            }),
        ).rejects.toThrow(/rejection requires one of/i);
    });

    it('refuses a missing rejection reason', async () => {
        await expect(
            transitionDsarRequest(ctx, 'd-1', { to: 'REJECTED' }),
        ).rejects.toThrow(/rejection requires one of/i);
    });

    it.each(Object.values(DSAR_REJECTION_REASONS))(
        'lets the allowlisted value %s through to the scoped read',
        async (reason) => {
            // The positive companion. Without it, the two refusals above would
            // pass just as well against a check that rejected EVERYTHING —
            // which would look like protection and be a broken feature.
            await expect(
                transitionDsarRequest(ctx, 'd-1', { to: 'REJECTED', reason }),
            ).rejects.toThrow(SENTINEL);
        },
    );

    it('does not demand a reason for a non-REJECTED transition', async () => {
        // `requiresReason` is exactly `to === 'REJECTED'`, which is what makes
        // the guard condition and the write condition the same. If they ever
        // diverge, a reasonless transition would either be wrongly blocked here
        // or wrongly write an unvalidated value.
        await expect(
            transitionDsarRequest(ctx, 'd-1', { to: 'VERIFIED' }),
        ).rejects.toThrow(SENTINEL);
    });
});
