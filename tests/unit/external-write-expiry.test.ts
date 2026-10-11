/**
 * Verifying that a time-bounded grant actually expired (#3416).
 *
 * The property with the longest reach is the fail-closed one: this pass must
 * never stamp `expiryVerifiedAt` on a row it could not read. A column saying
 * "checked" on a grant nobody checked is worse than no column, because the
 * sweep then skips it forever.
 */
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer abc'),
}));
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    promoteAcceptedWrite: jest.fn(async () => undefined),
    settleWrite: jest.fn(async () => undefined),
}));
const getPriorStateReadMock = jest.fn();
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: (...a: unknown[]) => getPriorStateReadMock(...a),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: (s: string) => s }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createTaskMock = jest.fn<any, any[]>(async () => ({ id: 'task-1' }));
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...a: unknown[]) => createTaskMock(...a),
}));
const mockTx = {
    externalWriteJournal: {
        findMany: jest.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: jest.fn<any, any[]>(async () => ({})),
    },
    integrationConnection: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import {
    DELIVERY_VERIFIERS,
    GRANT_EXPIRY_ARGS,
    expiryVerdict,
    verifyGrantExpiry,
} from '@/app-layer/usecases/external-write-reconcile';
// TYPED, for the reason the sibling suite records: a fixture that invents its
// own shape matches the extractor and not the endpoint, so the predicate reads
// nothing from every real answer and no test can see it.
import type { AccessAssignmentState } from '@/app-layer/integrations/providers/entra-id/entitlement';

const T = 'tenant-x';
const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const GRANT = 'grant_time_bounded_access';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

function assignment(over: Partial<AccessAssignmentState> = {}): AccessAssignmentState {
    return {
        assignmentId: 'a-1',
        accessPackageId: 'pkg-1',
        state: 'delivered',
        endDateTime: PAST,
        liveness: 'live',
        ...over,
    };
}

/** The MCP tool-result envelope the paired read returns. */
function envelope(assignments: AccessAssignmentState[]) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ assignments: { all: assignments } }) }],
    };
}

function row(over: Record<string, unknown> = {}) {
    return {
        id: 'row-1',
        tenantId: T,
        connectionId: CONN,
        connectionName: 'Entra grants',
        toolName: `mcp__${CONN}__${GRANT}`,
        advertisedToolName: GRANT,
        argumentsJson: JSON.stringify({ targetId: 'u-1', endDateTime: PAST }),
        priorStateJson: JSON.stringify({}),
        expiryRaisedAt: null,
        attemptedAt: new Date('2026-09-01T00:00:00.000Z'),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findMany.mockResolvedValue([
        { id: CONN, isEnabled: true, configJson: { url: 'https://mcp.example.com' }, secretEncrypted: null },
    ]);
    getPriorStateReadMock.mockResolvedValue({ readToolName: `mcp__${CONN}__read_assignments` });
    mockTx.externalWriteJournal.update.mockResolvedValue({});
});

describe('expiryVerdict', () => {
    it('reports expired when the subject holds nothing at all', () => {
        expect(expiryVerdict(envelope([]))).toBe('expired');
    });

    it('reports expired when every assignment is inactive', () => {
        expect(expiryVerdict(envelope([assignment({ liveness: 'inactive' })]))).toBe('expired');
    });

    it('reports still_live for a live assignment', () => {
        expect(expiryVerdict(envelope([assignment({ liveness: 'live' })]))).toBe('still_live');
    });

    it('treats PENDING as still live, not as gone', () => {
        // `delivering` is not held yet and not history either (#3326). Counting
        // it as expired would close the case on a grant mid-delivery.
        expect(expiryVerdict(envelope([assignment({ liveness: 'pending' })]))).toBe('still_live');
    });

    it('treats UNKNOWN as unreadable, never as expired', () => {
        // The fail-closed direction. A row the classifier cannot place must not
        // be counted as gone.
        expect(expiryVerdict(envelope([assignment({ liveness: 'unknown' })]))).toBe('unreadable');
    });

    it('reports unreadable for an error envelope, which is not evidence of expiry', () => {
        expect(expiryVerdict({ isError: true, content: [] })).toBe('unreadable');
        expect(expiryVerdict(null)).toBe('unreadable');
    });

    it('a mix of inactive and live is still_live', () => {
        expect(
            expiryVerdict(envelope([
                assignment({ assignmentId: 'a-1', liveness: 'inactive' }),
                assignment({ assignmentId: 'a-2', liveness: 'live' }),
            ])),
        ).toBe('still_live');
    });
});

describe('verifyGrantExpiry', () => {
    it('stamps expiryVerifiedAt when the grant is confirmed gone', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
        callToolMock.mockResolvedValue(envelope([assignment({ liveness: 'inactive' })]));

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, confirmedExpired: 1, raised: 0, unreadable: 0 });
        expect(mockTx.externalWriteJournal.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'row-1' },
                data: { expiryVerifiedAt: NOW },
            }),
        );
        expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('RAISES a task when the grant is still live past its end date', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
        callToolMock.mockResolvedValue(envelope([assignment({ liveness: 'live' })]));

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, raised: 1, confirmedExpired: 0 });
        expect(createTaskMock).toHaveBeenCalledTimes(1);
        const task = createTaskMock.mock.calls[0]![1] as Record<string, unknown>;
        expect(task.source).toBe('GRANT_EXPIRY');
        expect(task.severity).toBe('HIGH');
        expect((task.metadataJson as { externalWriteJournalId: string }).externalWriteJournalId).toBe('row-1');
        // The row is marked raised, NOT verified: nothing was confirmed gone.
        expect(mockTx.externalWriteJournal.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { expiryRaisedAt: NOW } }),
        );
        const stamped = mockTx.externalWriteJournal.update.mock.calls.map(
            (c) => Object.keys((c[0] as { data: object }).data),
        );
        expect(stamped.flat()).not.toContain('expiryVerifiedAt');
    });

    it('does not raise a SECOND task for a row already raised', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ expiryRaisedAt: new Date('2026-10-05T00:00:00.000Z') }),
        ]);
        callToolMock.mockResolvedValue(envelope([assignment({ liveness: 'live' })]));

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, alreadyRaised: 1, raised: 0 });
        expect(createTaskMock).not.toHaveBeenCalled();
    });

    it('does not scan a grant whose end date has not passed', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ argumentsJson: JSON.stringify({ targetId: 'u-1', endDateTime: FUTURE }) }),
        ]);
        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r.scanned).toBe(0);
        expect(callToolMock).not.toHaveBeenCalled();
        expect(mockTx.externalWriteJournal.update).not.toHaveBeenCalled();
    });

    it('NEVER stamps a row whose state could not be read', async () => {
        // The property this pass exists to protect. A stamped row is never
        // asked again, so stamping on an unreadable answer loses the grant.
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
        callToolMock.mockRejectedValue(new Error('the far end is down'));

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, unreadable: 1, confirmedExpired: 0, raised: 0 });
        expect(mockTx.externalWriteJournal.update).not.toHaveBeenCalled();
    });

    it('NEVER stamps a row whose answer READ fine but could not be interpreted', async () => {
        // Distinct from the test above, and mutation-proving is what showed it:
        // that one rejects the read, so it exercises the `!read.ok` branch. This
        // one SUCCEEDS at reading and gets an answer the predicate cannot place,
        // which is the other way to reach "unverified" — and the branch that a
        // stamping mutation survived until this existed.
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
        callToolMock.mockResolvedValue(envelope([assignment({ liveness: 'unknown' })]));

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, unreadable: 1, confirmedExpired: 0, raised: 0 });
        expect(mockTx.externalWriteJournal.update).not.toHaveBeenCalled();
    });

    it('NEVER stamps on an ERROR envelope either', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
        callToolMock.mockResolvedValue({ isError: true, content: [] });

        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, unreadable: 1 });
        expect(mockTx.externalWriteJournal.update).not.toHaveBeenCalled();
    });

    it('counts an unparseable end date rather than passing over it', async () => {
        // A row claiming a bounded grant whose bound cannot be read is a thing
        // somebody should look at, not a thing to skip.
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ argumentsJson: JSON.stringify({ targetId: 'u-1', endDateTime: 'not a date' }) }),
        ]);
        const r = await verifyGrantExpiry({ tenantId: T, now: NOW });
        expect(r).toMatchObject({ scanned: 1, unreadable: 1 });
        expect(callToolMock).not.toHaveBeenCalled();
        expect(mockTx.externalWriteJournal.update).not.toHaveBeenCalled();
    });
});

describe('the two maps cannot drift apart', () => {
    it('every tool this sweep expires is also a tool the journal verifies', () => {
        // A tool with an expiry argument but no delivery verifier would be swept
        // for expiry while never reaching APPLIED — so the sweep would have no
        // population and the omission would be invisible.
        for (const tool of GRANT_EXPIRY_ARGS.keys()) {
            expect([...DELIVERY_VERIFIERS.keys()]).toContain(tool);
        }
    });

    it('a revoke is NOT swept for expiry, because it has no end date', () => {
        expect(GRANT_EXPIRY_ARGS.has('revoke_access_assignment')).toBe(false);
    });
});
