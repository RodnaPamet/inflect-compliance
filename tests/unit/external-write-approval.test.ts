/**
 * WHAT APPROVING AN EXTERNAL WRITE OPENS (#2861).
 *
 * The seam is small and its placement is the whole argument, so the assertions
 * are about the placement rather than the plumbing: the rung is re-checked HERE,
 * at the moment a human commits, because `beginWrite` refuses DRY_RUN and
 * DISABLED. Move this into the dispatch job and an operator's withdrawal stops
 * taking effect in front of the person approving and starts failing hours later,
 * out of their sight.
 *
 * Nothing is sent from here. The row lands PENDING and the dispatch pass is what
 * calls the far end.
 */
const beginWriteMock = jest.fn(async (..._a: unknown[]) => ({ journalId: 'jrn_9' }));
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    beginWrite: (...a: unknown[]) => beginWriteMock(...a),
}));

const mockTx = { integrationConnection: { findFirst: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import { openApprovedExternalWrite } from '@/app-layer/usecases/external-write-approval';
import { makeRequestContext } from '../helpers/make-context';

const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const ctx = makeRequestContext('OWNER', { tenantId: 't1', userId: 'u1' });

const PAYLOAD = {
    connectionId: CONN,
    connectionName: 'HRM',
    endpointUrl: 'https://hrm.example.test/mcp',
    toolName: `mcp__${CONN}__set_employee_work_email`,
    advertisedToolName: 'set_employee_work_email',
    arguments: { empNumber: 7 },
    priorState: { workEmail: 'old@example.test' },
};

const proposal = (payload: unknown = PAYLOAD) => ({
    id: 'prp_1',
    payloadJson: JSON.stringify(payload),
    agentId: 'agt_1',
    runId: null,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findFirst.mockResolvedValue({
        id: CONN,
        externalWriteMode: 'PROPOSE_ONLY',
    });
});

describe('the rung is re-checked at approval', () => {
    it.each(['DRY_RUN', 'DISABLED', null, 'nonsense-value'])(
        'refuses when the connection reads %s, and opens no row',
        async (mode) => {
            // `null` and an unrecognised value both coerce to DISABLED at the read
            // boundary, so an unknown stored rung fails CLOSED here rather than
            // sailing past into a write.
            mockTx.integrationConnection.findFirst.mockResolvedValue({
                id: CONN,
                externalWriteMode: mode,
            });
            await expect(openApprovedExternalWrite(ctx, proposal())).rejects.toThrow(
                /cannot be sent/,
            );
            expect(beginWriteMock).not.toHaveBeenCalled();
        },
    );

    it('opens the row at a rung that permits sending', async () => {
        // The positive control. Without it every refusal above would be satisfied
        // by a seam that refuses unconditionally.
        const journalId = await openApprovedExternalWrite(ctx, proposal());
        expect(journalId).toBe('jrn_9');
        expect(beginWriteMock).toHaveBeenCalledTimes(1);
    });
});

describe('what it writes onto the row', () => {
    it('carries the prior state the APPROVER saw, for the dispatch to compare against', async () => {
        await openApprovedExternalWrite(ctx, proposal());
        const attempt = beginWriteMock.mock.calls[0]![1] as Record<string, string>;
        expect(attempt.mode).toBe('PROPOSE_ONLY');
        expect(JSON.parse(attempt.priorStateJson)).toEqual({ workEmail: 'old@example.test' });
        expect(JSON.parse(attempt.argumentsJson)).toEqual({ empNumber: 7 });
        // Denormalised, so the row stays readable after the connection is renamed
        // or deleted — the same reason the journal denormalises them.
        expect(attempt.connectionName).toBe('HRM');
        expect(attempt.endpointUrl).toBe('https://hrm.example.test/mcp');
    });
});

describe('what it refuses outright', () => {
    it('a stored payload that no longer satisfies its own schema', async () => {
        // Dispatching on a guess is the one thing that must not happen.
        await expect(
            openApprovedExternalWrite(ctx, proposal({ empNumber: 7 })),
        ).rejects.toThrow(/well-formed external write/);
        expect(beginWriteMock).not.toHaveBeenCalled();
    });

    it('a connection deleted between proposal and approval', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(openApprovedExternalWrite(ctx, proposal())).rejects.toThrow(
            /no longer exists/,
        );
        expect(beginWriteMock).not.toHaveBeenCalled();
    });
});
