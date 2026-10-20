/**
 * Unit test — resolveEntraEmail (Microsoft Entra B2B guest onboarding).
 *
 * Desired flow: an admin adds `…@partner.example` as a B2B guest in our Entra
 * tenant + sends an in-app invite; the guest signs in with Microsoft and
 * is provisioned immediately. That hinges on the sign-in surfacing the
 * guest's REAL email so it matches the invite (redeemPendingInvitesByEmail).
 * Entra frequently omits the `email` claim for guests and only carries the
 * address in `preferred_username`; resolveEntraEmail bridges that gap.
 */

// @/auth constructs providers at import; the prisma mock keeps that inert.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {},
}));

import { resolveEntraEmail } from '@/auth';

describe('resolveEntraEmail', () => {
    it('uses the email claim when present', () => {
        expect(resolveEntraEmail('jane.doe@partner.example', 'x@partner.example')).toBe(
            'jane.doe@partner.example',
        );
    });

    it('falls back to preferred_username when the email claim is missing (B2B guest)', () => {
        expect(resolveEntraEmail(undefined, 'jane.doe@partner.example')).toBe(
            'jane.doe@partner.example',
        );
        expect(resolveEntraEmail(null, 'jane.doe@partner.example')).toBe(
            'jane.doe@partner.example',
        );
    });

    it('skips non-email-shaped claims (e.g. a bare UPN with no @) and keeps looking', () => {
        // A caller must never pass the mangled `..._partner.example#EXT#@host` upn,
        // but a stray non-email value should be ignored, not returned.
        expect(resolveEntraEmail('not-an-email', 'jane.doe@partner.example')).toBe(
            'jane.doe@partner.example',
        );
    });

    it('trims surrounding whitespace', () => {
        expect(resolveEntraEmail('  jane.doe@partner.example  ')).toBe(
            'jane.doe@partner.example',
        );
    });

    it('returns null when no usable email-shaped claim is present', () => {
        expect(resolveEntraEmail(undefined, null)).toBeNull();
        expect(resolveEntraEmail('', '   ')).toBeNull();
        expect(resolveEntraEmail(42, {})).toBeNull();
    });

    it('honours claim priority — first @-shaped string wins', () => {
        expect(
            resolveEntraEmail('primary@partner.example', 'secondary@partner.example'),
        ).toBe('primary@partner.example');
    });
});
