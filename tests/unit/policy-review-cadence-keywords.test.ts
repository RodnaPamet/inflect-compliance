/**
 * The review-cadence keyword fallback reads a six-monthly cadence as six
 * months, not a year (#5316).
 *
 * `\bannually\b` matches inside `semi-annually` — the hyphen is a word
 * boundary — and the annual pattern was tested first, so a template stating
 * "reviewed semi-annually" got a 365-day cadence and its review reminder fired
 * six months late.
 */
import { parseReviewCadenceDays } from '@/lib/policy/template-skeleton';

const withControl = (sentence: string) =>
    `# Policy\n\n## Document Control\n\n${sentence}\n\n## Purpose\n\nText.\n`;

describe('parseReviewCadenceDays — keyword fallback', () => {
    it.each([
        ['This policy is reviewed semi-annually.', 182],
        ['This policy is reviewed semiannually.', 182],
        ['Review cadence: semi-annual.', 182],
        ['This policy is reviewed bi-annually.', 182],
        ['Reviewed every six months.', 182],
        ['This policy is reviewed annually.', 365],
        ['Annual review.', 365],
        ['Reviewed every year.', 365],
        ['Reviewed quarterly.', 90],
        ['Reviewed monthly.', 30],
    ])('%s -> %i days', (sentence, days) => {
        expect(parseReviewCadenceDays(withControl(sentence))).toBe(days);
    });

    it('a stated date pair still wins over any keyword', () => {
        const md = withControl(
            'Effective Date: 2026-01-01\n\nNext Review Date: 2026-04-01\n\nReviewed semi-annually.',
        );
        expect(parseReviewCadenceDays(md)).toBe(90);
    });
});
