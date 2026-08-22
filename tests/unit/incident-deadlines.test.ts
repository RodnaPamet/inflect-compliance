/**
 * Unit coverage for the NIS2 Article 23 deadline math + the
 * deadline-clock transition decision. Pure functions — no DB.
 */
import {
    computeDeadlines,
    deadlineFor,
    addMonths,
    nextPhase,
    PHASE_ORDER,
    suggestsReportable,
} from '@/lib/incidents/deadlines';
import { decideTransition } from '@/app-layer/jobs/incident-notification-deadlines';

describe('deadline arithmetic', () => {
    const detectedAt = new Date('2026-06-01T00:00:00.000Z');

    it('computes the three Article 23 deadlines', () => {
        const d = computeDeadlines(detectedAt);
        expect(d.map((x) => x.kind)).toEqual([
            'EARLY_WARNING_24H',
            'DETAILED_72H',
            'FINAL_1MONTH',
        ]);
        expect(deadlineFor(detectedAt, 'EARLY_WARNING_24H').toISOString()).toBe(
            '2026-06-02T00:00:00.000Z',
        );
        expect(deadlineFor(detectedAt, 'DETAILED_72H').toISOString()).toBe(
            '2026-06-04T00:00:00.000Z',
        );
        expect(deadlineFor(detectedAt, 'FINAL_1MONTH').toISOString()).toBe(
            '2026-07-01T00:00:00.000Z',
        );
    });

    it('clamps day-of-month on a short target month', () => {
        // 31 Jan + 1 month → 28 Feb (2026 is not a leap year).
        expect(addMonths(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
            '2026-02-28T00:00:00.000Z',
        );
    });
});

describe('phase ordering', () => {
    it('walks the seven-phase flow then terminates at CLOSED', () => {
        // LITERAL ON PURPOSE — do not derive. NIS2 Article 23 incident handling
        // is a seven-phase flow plus the CLOSED terminal; a ninth phase changes
        // the regulatory lifecycle and must fail here rather than pass silently.
        expect(PHASE_ORDER).toHaveLength(8);
        expect(nextPhase('DETECTION')).toBe('CLASSIFICATION');
        expect(nextPhase('RECOVERY')).toBe('CLOSED');
        expect(nextPhase('CLOSED')).toBeNull();
    });
});

describe('reportability heuristic', () => {
    it('suggests for HIGH/CRITICAL only', () => {
        expect(suggestsReportable('CRITICAL')).toBe(true);
        expect(suggestsReportable('HIGH')).toBe(true);
        expect(suggestsReportable('MEDIUM')).toBe(false);
        expect(suggestsReportable('LOW')).toBe(false);
    });
});

describe('deadline-clock transition decision', () => {
    const dueAt = new Date('2026-06-02T00:00:00.000Z');
    const leadMs = 6 * 60 * 60 * 1000; // 6h

    it('PENDING → DUE inside the lead window', () => {
        const now = new Date('2026-06-01T20:00:00.000Z'); // 4h before due
        expect(decideTransition('PENDING', dueAt, now, leadMs)).toBe('DUE');
    });

    it('PENDING stays PENDING before the lead window', () => {
        const now = new Date('2026-06-01T12:00:00.000Z'); // 12h before due
        expect(decideTransition('PENDING', dueAt, now, leadMs)).toBeNull();
    });

    it('→ OVERDUE once the deadline passes', () => {
        const now = new Date('2026-06-02T01:00:00.000Z');
        expect(decideTransition('PENDING', dueAt, now, leadMs)).toBe('OVERDUE');
        expect(decideTransition('DUE', dueAt, now, leadMs)).toBe('OVERDUE');
    });

    it('DUE stays DUE inside the window (no redundant transition)', () => {
        const now = new Date('2026-06-01T20:00:00.000Z');
        expect(decideTransition('DUE', dueAt, now, leadMs)).toBeNull();
    });
});
