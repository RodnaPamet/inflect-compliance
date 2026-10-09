/**
 * Promoting an `ACCEPTED` external write once delivery is confirmed (#3334).
 *
 * Two things are under test and the first is the one with the longest reach:
 * that `ASYNC_DELIVERY_TOOLS` (which decides what settles `ACCEPTED`) and
 * `DELIVERY_VERIFIERS` (which decides what promotes it) cannot drift apart. A
 * tool in the first with no entry in the second settles rows that nothing can
 * ever promote, which is the original defect returning through a new door.
 */
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer abc'),
}));
const promoteMock = jest.fn(async (..._a: unknown[]) => undefined);
const settleMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    promoteAcceptedWrite: (...a: unknown[]) => promoteMock(...a),
    settleWrite: (...a: unknown[]) => settleMock(...a),
}));
const getPriorStateReadMock = jest.fn();
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: (...a: unknown[]) => getPriorStateReadMock(...a),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: (s: string) => s,
}));
const mockTx = {
    externalWriteJournal: { findMany: jest.fn() },
    integrationConnection: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import {
    DELIVERY_VERIFIERS,
    reconcileAcceptedExternalWrites,
} from '@/app-layer/usecases/external-write-reconcile';
import { ASYNC_DELIVERY_TOOLS } from '@/app-layer/usecases/external-write-dispatch';

const T = 'tenant-x';
const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const GRANT = 'grant_time_bounded_access';
const WRITE = `mcp__${CONN}__${GRANT}`;
const READ = `mcp__${CONN}__read_access_assignments`;

/**
 * A read answer carrying these assignment ids.
 *
 * `live` is EMPTY in every fixture on purpose. A time-bounded grant can be
 * delivered and already expired by the time this pass runs, so a verifier that
 * asked "does the subject hold live access" would call that a non-delivery.
 * Building every fixture in the shape that would break such a verifier keeps
 * the distinction from being quietly reintroduced.
 */
const readResult = (ids: string[]) => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify({
                assignments: {
                    all: ids.map((id) => ({ id, state: 'expired', liveness: 'inactive' })),
                    live: [],
                },
            }),
        },
    ],
});

const row = (over: Record<string, unknown> = {}) => ({
    id: 'jrn_1',
    tenantId: T,
    connectionId: CONN,
    toolName: WRITE,
    advertisedToolName: GRANT,
    argumentsJson: JSON.stringify({ targetId: 'subj-1', accessPackageId: 'pkg-1' }),
    priorStateJson: JSON.stringify(readResult([])),
    ...over,
});

const connectionRow = (over: Record<string, unknown> = {}) => ({
    id: CONN,
    isEnabled: true,
    configJson: { url: 'https://mcp.example.test/endpoint' },
    secretEncrypted: JSON.stringify({ authorization: 'Bearer abc' }),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    promoteMock.mockResolvedValue(undefined);
    settleMock.mockResolvedValue(undefined);
    getPriorStateReadMock.mockResolvedValue({ readToolName: READ });
    mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
    mockTx.integrationConnection.findMany.mockResolvedValue([connectionRow()]);
    callToolMock.mockResolvedValue(readResult(['asg-new']));
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE TWO DECLARATIONS CANNOT DRIFT APART
// ═════════════════════════════════════════════════════════════════════

describe('every asynchronous tool has a way to be promoted', () => {
    it('declares a verifier for every tool that can settle ACCEPTED', () => {
        const missing = [...ASYNC_DELIVERY_TOOLS].filter((t) => !DELIVERY_VERIFIERS.has(t));
        expect(missing).toEqual([]);
    });

    it('declares no verifier for a tool that never settles ACCEPTED', () => {
        // The other direction. A verifier for a tool outside the set is dead
        // code that reads like coverage.
        const extra = [...DELIVERY_VERIFIERS.keys()].filter((t) => !ASYNC_DELIVERY_TOOLS.has(t));
        expect(extra).toEqual([]);
    });

    it('has a non-empty set to compare — otherwise both assertions are vacuous', () => {
        expect(ASYNC_DELIVERY_TOOLS.size).toBeGreaterThanOrEqual(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. WHAT COUNTS AS DELIVERY
// ═════════════════════════════════════════════════════════════════════

describe('the Entra verifier reads an appearance, not current liveness', () => {
    const verify = DELIVERY_VERIFIERS.get(GRANT)!;

    it('calls it delivered when an assignment exists that did not before', () => {
        expect(verify(readResult([]), readResult(['asg-new']))).toBe('delivered');
    });

    it('calls it delivered even when that assignment has already expired', () => {
        // The case `live` would get wrong: every fixture here reports
        // `live: []`, and this still promotes, because the question is whether
        // the far end DID the thing.
        expect(verify(readResult(['old']), readResult(['old', 'asg-new']))).toBe('delivered');
    });

    it('calls it not-yet when the ids are unchanged', () => {
        expect(verify(readResult(['old']), readResult(['old']))).toBe('not_yet');
    });

    it('calls it not-yet when the subject holds nothing, before and after', () => {
        expect(verify(readResult([]), readResult([]))).toBe('not_yet');
    });

    it('does NOT call a pre-existing assignment our delivery', () => {
        // Without the prior-state baseline, "an assignment exists" would
        // promote a write that delivered nothing.
        expect(verify(readResult(['already-held']), readResult(['already-held']))).toBe('not_yet');
    });

    it('calls it not-yet, not delivered, when an assignment DISAPPEARED', () => {
        expect(verify(readResult(['a', 'b']), readResult(['a']))).toBe('not_yet');
    });

    it.each([
        ['an error result', { content: [{ type: 'text', text: '{}' }], isError: true }],
        ['no content array', { content: 'nope' }],
        ['unparseable text', { content: [{ type: 'text', text: 'not json' }] }],
        ['the wrong shape', { content: [{ type: 'text', text: '{"other":1}' }] }],
        ['null', null],
    ])('calls %s unreadable rather than guessing', (_label, bad) => {
        expect(verify(readResult([]), bad)).toBe('unreadable');
    });

    it('calls an unreadable PRIOR state unreadable, not delivered', () => {
        // The dangerous direction: no baseline means no way to tell our
        // delivery from access the subject already had.
        expect(verify({ content: [{ type: 'text', text: 'x' }] }, readResult(['a']))).toBe(
            'unreadable',
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE PASS ITSELF — AND THAT IT NEVER DEMOTES
// ═════════════════════════════════════════════════════════════════════

describe('the reconcile pass promotes on positive evidence only', () => {
    it('promotes a delivered row to APPLIED', async () => {
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.promoted).toBe(1);
        expect(promoteMock).toHaveBeenCalledTimes(1);
        expect(promoteMock.mock.calls[0][1]).toBe('jrn_1');
    });

    it('reads only ACCEPTED rows', async () => {
        await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(mockTx.externalWriteJournal.findMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: T, outcome: 'ACCEPTED' },
        });
    });

    it('runs the PAIRED read, with the row arguments, and sends no write', async () => {
        await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(callToolMock).toHaveBeenCalledTimes(1);
        expect(callToolMock.mock.calls[0][1]).toBe('read_access_assignments');
        expect(callToolMock.mock.calls[0][2]).toEqual({
            targetId: 'subj-1',
            accessPackageId: 'pkg-1',
        });
        // The write verb must never leave this pass.
        expect(callToolMock.mock.calls.some((c) => c[1] === GRANT)).toBe(false);
    });

    it('leaves a not-yet row ACCEPTED and settles nothing', async () => {
        callToolMock.mockResolvedValue(readResult([]));
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.notYet).toBe(1);
        expect(r.promoted).toBe(0);
        expect(promoteMock).not.toHaveBeenCalled();
        expect(settleMock).not.toHaveBeenCalled();
    });

    it.each([
        ['the read throws', () => callToolMock.mockRejectedValue(new Error('down'))],
        [
            'the connection is disabled',
            () =>
                mockTx.integrationConnection.findMany.mockResolvedValue([
                    connectionRow({ isEnabled: false }),
                ]),
        ],
        [
            'the connection is gone',
            () => mockTx.integrationConnection.findMany.mockResolvedValue([]),
        ],
        [
            'the connection has no URL',
            () =>
                mockTx.integrationConnection.findMany.mockResolvedValue([
                    connectionRow({ configJson: {} }),
                ]),
        ],
        ['the pairing was withdrawn', () => getPriorStateReadMock.mockResolvedValue(null)],
        [
            'the journalled arguments will not parse',
            () =>
                mockTx.externalWriteJournal.findMany.mockResolvedValue([
                    row({ argumentsJson: 'not json' }),
                ]),
        ],
    ])('leaves the row ACCEPTED when %s — never FAILED', async (_label, arrange) => {
        arrange();
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.unreadable).toBe(1);
        expect(r.promoted).toBe(0);
        // The whole point: nothing here may make a negative claim.
        expect(promoteMock).not.toHaveBeenCalled();
        expect(settleMock).not.toHaveBeenCalled();
    });

    it('counts a tool with no verifier instead of silently skipping it', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ advertisedToolName: 'some_other_async_tool' }),
        ]);
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.unverifiable).toBe(1);
        expect(callToolMock).not.toHaveBeenCalled();
        expect(promoteMock).not.toHaveBeenCalled();
    });

    it('does nothing at all when there are no ACCEPTED rows', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([]);
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r).toEqual({
            scanned: 0,
            promoted: 0,
            notYet: 0,
            unreadable: 0,
            unverifiable: 0,
        });
        expect(mockTx.integrationConnection.findMany).not.toHaveBeenCalled();
    });
});
