/**
 * Who started a run, and which rule caused it (#4894) — resolved for the run's
 * own page, inside this workspace only.
 */
const mockMembership = jest.fn();
const mockExecution = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            tenantMembership: { findFirst: mockMembership },
            automationExecution: { findFirst: mockExecution },
        }),
    ),
}));

import { readWorkflowRunProvenance } from '@/app-layer/usecases/workflow-run-provenance';

const ctx = { tenantId: 'tenant-A', userId: 'u-1' } as never;

beforeEach(() => {
    mockMembership.mockReset();
    mockExecution.mockReset();
});

describe('readWorkflowRunProvenance', () => {
    it('names the starter and the rule, each read in this workspace', async () => {
        mockMembership.mockResolvedValueOnce({ user: { name: 'Ana Petrova', email: 'ana@x.test' } });
        mockExecution.mockResolvedValueOnce({ rule: { name: 'Nightly review' } });
        const out = await readWorkflowRunProvenance(ctx, { startedByUserId: 'u-7', parentExecutionId: 'ex-1' });
        expect(out).toEqual({ startedBy: 'Ana Petrova', ruleName: 'Nightly review' });
        expect(mockMembership.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-A', userId: 'u-7' });
        expect(mockExecution.mock.calls[0][0].where).toEqual({ id: 'ex-1', tenantId: 'tenant-A' });
    });

    it('falls back to the email when the member has no name', async () => {
        mockMembership.mockResolvedValueOnce({ user: { name: null, email: 'ana@x.test' } });
        const out = await readWorkflowRunProvenance(ctx, { startedByUserId: 'u-7', parentExecutionId: null });
        expect(out).toEqual({ startedBy: 'ana@x.test', ruleName: null });
        expect(mockExecution).not.toHaveBeenCalled();
    });

    it('names nobody who is not a member here', async () => {
        mockMembership.mockResolvedValueOnce(null);
        const out = await readWorkflowRunProvenance(ctx, { startedByUserId: 'u-other', parentExecutionId: null });
        expect(out.startedBy).toBeNull();
    });

    it('reads nothing for a run with neither', async () => {
        const out = await readWorkflowRunProvenance(ctx, { startedByUserId: null, parentExecutionId: null });
        expect(out).toEqual({ startedBy: null, ruleName: null });
        expect(mockMembership).not.toHaveBeenCalled();
        expect(mockExecution).not.toHaveBeenCalled();
    });
});
