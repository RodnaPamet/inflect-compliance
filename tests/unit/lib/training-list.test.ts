/**
 * #4817 — an open training assignment past its due date is overdue, though
 * nothing stores OVERDUE; the same rule the training check applies.
 */
import { effectiveTrainingStatus } from '@/lib/training-list';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

describe('effectiveTrainingStatus', () => {
    it.each([
        ['ASSIGNED', PAST, 'OVERDUE'],
        ['IN_PROGRESS', PAST, 'OVERDUE'],
        ['ASSIGNED', FUTURE, 'ASSIGNED'],
        ['IN_PROGRESS', null, 'IN_PROGRESS'],
        ['COMPLETED', PAST, 'COMPLETED'],
        ['OVERDUE', FUTURE, 'OVERDUE'],
    ] as const)('%s due %s reads %s', (status, dueAt, expected) => {
        expect(effectiveTrainingStatus({ status, dueAt }, NOW)).toBe(expected);
    });

    it('an unknown stored status is left as it is', () => {
        expect(effectiveTrainingStatus({ status: 'WAIVED', dueAt: PAST }, NOW)).toBe('WAIVED');
    });
});
