/**
 * A policy export is stamped DRAFT when the policy is not in force, and
 * never because of its classification (#5133).
 *
 * The watermark slot used to carry the classification, so every
 * CONFIDENTIAL or RESTRICTED export of a published policy read "DRAFT"
 * across every page, while a real draft exported as INTERNAL looked like
 * the live policy.
 */
import { policyWatermark } from '@/app-layer/reports/pdf/policyDocument';

describe('policyWatermark', () => {
    it.each(['DRAFT', 'IN_REVIEW', 'APPROVED'])('stamps a %s policy DRAFT', (status) => {
        expect(policyWatermark(status)).toBe('DRAFT');
    });

    it.each(['PUBLISHED', 'ARCHIVED'])('leaves a %s policy unstamped', (status) => {
        expect(policyWatermark(status)).toBe('NONE');
    });
});
