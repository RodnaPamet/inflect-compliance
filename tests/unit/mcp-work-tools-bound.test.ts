jest.mock('@/app-layer/usecases/finding', () => ({ listFindings: jest.fn(async () => []) }));
jest.mock('@/app-layer/usecases/task', () => ({ listTasks: jest.fn(async () => []) }));

import { listFindingsTool, listTasksTool } from '@/lib/mcp/tools/work-tools';
import { listFindings } from '@/app-layer/usecases/finding';
import { listTasks } from '@/app-layer/usecases/task';

import type { RequestContext } from '@/app-layer/types';

/**
 * THE WORK TOOLS' PAGE BOUND, ASSERTED WHERE IT IS VISIBLE (#3617).
 *
 * `work-tools.ts` was at 0 of 8 branches. The uncovered arms are both
 * `limit ?? 50` — the default page size, and the only thing between an agent
 * and a whole tenant's finding or task list in a single call.
 *
 * ── WHY THIS IS A UNIT TEST AND NOT PART OF THE READ SUITE ──────────────────
 *
 * It was first written there, through `tools/call`, and it reached 8 of 8
 * branches while asserting nothing. That suite seeds no findings and no tasks,
 * so both tools return an empty array and every assertion about the resulting
 * LENGTH passes whatever the bound says. Measured: replacing the bound with
 * `take: 999` reddened not one test.
 *
 * The bound is only observable where the value is — in the argument handed to
 * the usecase. So that is what this asserts, with the usecases mocked so the
 * exact `take` is readable.
 */
const CTX = { tenantId: 't1', requestId: 'r1' } as unknown as RequestContext;

const findingsMock = listFindings as jest.MockedFunction<typeof listFindings>;
const tasksMock = listTasks as jest.MockedFunction<typeof listTasks>;

beforeEach(() => {
    jest.clearAllMocks();
});

const OPEN = { status: 'OPEN,IN_PROGRESS,READY_FOR_VERIFICATION' };

describe('list_findings is bounded', () => {
    it('defaults to 50 when no limit is given', async () => {
        await listFindingsTool.run(CTX, {});
        expect(findingsMock).toHaveBeenCalledWith(CTX, { take: 50 }, OPEN);
    });

    it('honours an explicit limit', async () => {
        await listFindingsTool.run(CTX, { limit: 7 });
        expect(findingsMock).toHaveBeenCalledWith(CTX, { take: 7 }, OPEN);
    });
});

describe('list_findings returns the OPEN findings its description promises (#5304)', () => {
    it('asks for every status but CLOSED, so the bound counts open findings only', async () => {
        // It passed no status, so an agent asking for open findings got the
        // newest 50 of ANY status, closed ones included, and lost older open
        // ones past the bound. The workflows that read it report the count as
        // "open findings".
        await listFindingsTool.run(CTX, {});
        const filters = findingsMock.mock.calls[0][2];
        expect(filters?.status?.split(',').sort()).toEqual(['IN_PROGRESS', 'OPEN', 'READY_FOR_VERIFICATION']);
        expect(filters?.status).not.toContain('CLOSED');
    });
});

describe('list_tasks is bounded, and passes its filters through', () => {
    it('defaults to 50 when no limit is given', async () => {
        await listTasksTool.run(CTX, {});
        expect(tasksMock).toHaveBeenCalledWith(CTX, {}, { take: 50 });
    });

    it('honours an explicit limit', async () => {
        await listTasksTool.run(CTX, { limit: 3 });
        expect(tasksMock).toHaveBeenCalledWith(CTX, {}, { take: 3 });
    });

    it('separates the limit from the FILTERS, rather than passing it as one', async () => {
        // `const { limit, ...filters } = args` — the destructure is what keeps
        // `limit` out of the filter bag. Passing it through as a filter would
        // reach the usecase as an unknown `where` term.
        await listTasksTool.run(CTX, { limit: 5, status: 'OPEN', severity: 'HIGH' });
        expect(tasksMock).toHaveBeenCalledWith(
            CTX,
            { status: 'OPEN', severity: 'HIGH' },
            { take: 5 },
        );
    });
});
