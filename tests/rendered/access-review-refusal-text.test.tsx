/**
 * Access review refusals are worded for the person (#4699).
 *
 * A named refusal reads in the user's language; any other keeps the
 * server's message; one with no message gets the action's own sentence.
 * The page used to fall back to "HTTP 409".
 */
jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
jest.mock('@/lib/tenant-context-provider', () => ({ useTenantApiUrl: () => (p: string) => p }));

import { refusalText } from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient';

const en = require('../../messages/en.json');

function translator() {
    const lookup = (key: string) =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en.accessReviews);
    const t = (key: string) => {
        const v = lookup(key);
        return typeof v === 'string' ? v : key;
    };
    t.has = (key: string) => typeof lookup(key) === 'string';
    return t;
}

describe('refusalText', () => {
    const t = translator();

    it('words a named refusal in the user\'s language', () => {
        const body = {
            error: {
                code: 'FORBIDDEN',
                message: 'Demoting or revoking an OWNER membership through a campaign is an OWNER’s change.',
                details: { reason: 'OWNER_SUBJECT_NEEDS_OWNER_CLOSER' },
            },
        };
        expect(refusalText(t, body, 'fallback')).toBe(en.accessReviews.refused.OWNER_SUBJECT_NEEDS_OWNER_CLOSER);
    });

    it('keeps the server message for a refusal it cannot name', () => {
        expect(refusalText(t, { error: { code: 'CONFLICT', message: 'Already closed.' } }, 'fallback')).toBe('Already closed.');
    });

    it('uses the action\'s own sentence when the server gave none — never "HTTP" and a status', () => {
        expect(refusalText(t, null, en.accessReviews.closeFailed)).toBe(en.accessReviews.closeFailed);
        expect(refusalText(t, {}, en.accessReviews.closeFailed)).not.toMatch(/HTTP/);
    });

    it('every named decision refusal has a sentence in both languages', () => {
        const bg = require('../../messages/bg.json');
        const { MEMBER_DECISION_REFUSAL } = require('@/lib/access-review/member-decision-rules');
        for (const reason of Object.values(MEMBER_DECISION_REFUSAL) as string[]) {
            expect(typeof en.accessReviews.refused[reason]).toBe('string');
            expect(typeof bg.accessReviews.refused[reason]).toBe('string');
        }
    });
});
