/**
 * RQ3-OB-D — `movementArrowTitle` pure suite.
 *
 * The deduped movement arrow names the risks that took its path,
 * bounded: top N titles + a "+M more" overflow tail so a path shared
 * by 40 risks doesn't produce an unreadable tooltip.
 */
import {
    movementArrowTitle,
    MOVEMENT_ARROW_TOOLTIP_MAX,
} from '@/components/risks/RiskMatrix';

describe('movementArrowTitle', () => {
    it('empty list → empty string (caller skips the <title>)', () => {
        expect(movementArrowTitle([])).toBe('');
    });

    it('joins all titles when within the bound', () => {
        expect(movementArrowTitle(['Phishing', 'Outage', 'Breach'])).toBe(
            'Phishing, Outage, Breach',
        );
    });

    it('a single title renders bare', () => {
        expect(movementArrowTitle(['Vendor outage'])).toBe('Vendor outage');
    });

    it('caps at the top N and appends a "+M more" overflow tail', () => {
        const titles = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
        const out = movementArrowTitle(titles);
        // Default bound is 8 → 12 − 8 = 4 overflow.
        expect(out).toBe('R1, R2, R3, R4, R5, R6, R7, R8 +4 more');
        expect(MOVEMENT_ARROW_TOOLTIP_MAX).toBe(8);
    });

    it('exactly at the bound → no overflow tail', () => {
        const titles = Array.from({ length: 8 }, (_, i) => `R${i + 1}`);
        expect(movementArrowTitle(titles)).not.toMatch(/more/);
    });

    it('respects a custom max', () => {
        expect(movementArrowTitle(['A', 'B', 'C', 'D'], 2)).toBe('A, B +2 more');
    });
});
