/**
 * #4846 — "critical" starts at the lowest score of a workspace's highest band.
 */
import { criticalScoreFloor } from '@/lib/risk-matrix/critical-band';
import { DEFAULT_BANDS } from '@/lib/risk-matrix/defaults';

const band = (name: string, minScore: number, maxScore: number) => ({ name, minScore, maxScore, color: '#000' });

describe('criticalScoreFloor', () => {
    it('is 15 for the default 5 x 5 bands', () => {
        expect(criticalScoreFloor(DEFAULT_BANDS)).toBe(15);
    });

    it('follows a 3 x 3 grid, whose maximum score is 9', () => {
        expect(criticalScoreFloor([band('Low', 1, 2), band('Medium', 3, 5), band('High', 6, 9)])).toBe(6);
    });

    it('follows a top band that starts lower than the default', () => {
        expect(
            criticalScoreFloor([band('Low', 1, 4), band('Medium', 5, 8), band('High', 9, 11), band('Critical', 12, 25)]),
        ).toBe(12);
    });

    it('reads the band reaching the highest score, whatever the order or name', () => {
        expect(criticalScoreFloor([band('Severe', 16, 25), band('Low', 1, 7), band('Moderate', 8, 15)])).toBe(16);
    });

    it.each([
        ['no bands', []],
        ['a value that is not a list', { minScore: 3 }],
        ['null', null],
        ['bands with no readable range', [{ name: 'x' }, { minScore: 'a', maxScore: 9 }, { minScore: 9, maxScore: 3 }]],
    ])('falls back to the default top band for %s', (_label, bands) => {
        expect(criticalScoreFloor(bands)).toBe(15);
    });

    it('ignores unreadable entries beside readable ones', () => {
        expect(criticalScoreFloor([{ name: 'broken' }, band('Low', 1, 4), band('Top', 5, 9)])).toBe(5);
    });
});
