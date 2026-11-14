/**
 * `markAssessmentCompleted` leaves a finalised run as it was (#5305).
 *
 * The write had no status predicate, so a run marked COMPLETED again had its
 * `completedAt` moved to now, which moved its place in the trend and the
 * history. The predicate is in the write itself, so a second finalize racing
 * the first changes nothing either.
 */
import { Nis2GapAssessmentRepository } from '@/app-layer/repositories/Nis2GapAssessmentRepository';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

describe('Nis2GapAssessmentRepository.markAssessmentCompleted', () => {
    it('updates only a run that is not already COMPLETED or ARCHIVED', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findFirst = jest.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED' });
        const db = { nis2SelfAssessment: { updateMany, findFirst } } as unknown as PrismaTx;
        const ctx = makeRequestContext('ADMIN');

        await Nis2GapAssessmentRepository.markAssessmentCompleted(db, ctx, 'run-1');

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: 'run-1', tenantId: ctx.tenantId, status: { notIn: ['COMPLETED', 'ARCHIVED'] } },
            data: { status: 'COMPLETED', completedAt: expect.any(Date) },
        });
    });
});
