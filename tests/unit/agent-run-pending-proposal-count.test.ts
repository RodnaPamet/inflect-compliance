/**
 * The paused-run hint counts what is STILL WAITING, not what was ever queued.
 *
 * The run list asks "is there anything in the proposals queue for this run",
 * and answers it with a filtered relation count. Without the filter the answer
 * is "did this run ever propose anything" — a different question with the same
 * shape, and one that stays `true` forever. A run whose proposals were all
 * approved or rejected months ago would go on sending reviewers to the queue
 * to look for them.
 *
 * Asserted on the QUERY rather than through a render, because the filter is
 * the whole claim and a rendered test can only see the number it produced.
 */
const findMany = jest.fn(async (_args: unknown): Promise<unknown> => []);

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ workflowRun: { findMany } })),
}));

import { listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const argsOf = () => findMany.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => jest.clearAllMocks());

describe('the pending-proposal count', () => {
    it('is filtered to PENDING', () => {
        return listWorkflowRuns(ctx, {}).then(() => {
            expect(argsOf().include).toEqual({
                _count: { select: { proposals: { where: { status: 'PENDING' } } } },
            });
        });
    });

    it('counts rather than loading the rows', () => {
        // The list needs the NUMBER and never the proposals themselves.
        // `include: { proposals: true }` would answer the same question and
        // drag every proposal body — encrypted columns included — into a list
        // query that renders none of them.
        return listWorkflowRuns(ctx, {}).then(() => {
            const include = argsOf().include as Record<string, unknown>;
            expect(Object.keys(include)).toEqual(['_count']);
        });
    });

    it('still bounds the list', () => {
        // The count rides along with a `take`; a relation count on an
        // unbounded findMany would be the expensive version of this fix.
        return listWorkflowRuns(ctx, {}).then(() => {
            expect(argsOf().take).toBe(50);
        });
    });
});
