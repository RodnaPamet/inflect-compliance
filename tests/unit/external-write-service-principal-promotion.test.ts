/**
 * #3671 — a service-principal disable is SENT only by the dispatch, settles
 * ACCEPTED, and becomes APPLIED only when the paired read shows the principal
 * disabled.
 *
 * Graph answers the PATCH 204, so "it succeeded" is the easy thing to record.
 * It is also not what `APPLIED` claims. `APPLIED` says the principal IS
 * disabled, and the only evidence for that is the read reporting
 * `accountEnabled: false` for the same principal that read enabled before the
 * write. Every combination short of that leaves the row ACCEPTED.
 *
 * And the in-band refusal: the endpoint refuses a disable it cannot interpret
 * (already disabled, the connection's own principal) with an MCP error result,
 * which `callTool` RETURNS rather than throws. The dispatch used to read that as
 * success. It now settles INDETERMINATE with the refusal's words.
 */
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer abc'),
}));
const settleMock = jest.fn(async (..._a: unknown[]) => undefined);
const promoteMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    settleWrite: (...a: unknown[]) => settleMock(...a),
    promoteAcceptedWrite: (...a: unknown[]) => promoteMock(...a),
}));
const getPriorStateReadMock = jest.fn();
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: (...a: unknown[]) => getPriorStateReadMock(...a),
}));
const boundRefusalMock = jest.fn(async (..._a: unknown[]) => null as string | null);
jest.mock('@/app-layer/usecases/external-write-automatic', () => ({
    ...jest.requireActual('@/app-layer/usecases/external-write-automatic'),
    automaticBoundRefusalAtSend: (...a: unknown[]) => boundRefusalMock(...a),
}));
const memberMock = jest.fn(async (..._a: unknown[]) => ({ ok: true }) as unknown);
jest.mock('@/app-layer/usecases/external-tool-target-populations', () => ({
    checkTargetInPopulation: (...a: unknown[]) => memberMock(...a),
}));
const linkConfirmedMock = jest.fn(async (..._a: unknown[]) => true);
jest.mock('@/app-layer/usecases/agent-service-principal-confirmation', () => ({
    servicePrincipalLinkConfirmed: (...a: unknown[]) => linkConfirmedMock(...a),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
}));
const mockTx = {
    externalWriteJournal: { findMany: jest.fn() },
    integrationConnection: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import { runExternalWriteDispatch } from '@/app-layer/usecases/external-write-dispatch';
import {
    DELIVERY_EVIDENCE,
    DELIVERY_VERIFIERS,
    reconcileAcceptedExternalWrites,
} from '@/app-layer/usecases/external-write-reconcile';
import {
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_READ_TOOL,
} from '@/lib/agentic/service-principal-disable';

const T = 'tenant-sp';
const CONN = 'cmconnspaaaaaaaaaaaaaaaa';
const SP = '9f1c2b7e-4a3d-4c1e-8b2f-6d5e4c3b2a19';
const WRITE = `mcp__${CONN}__${SERVICE_PRINCIPAL_DISABLE_TOOL}`;
const READ = `mcp__${CONN}__${SERVICE_PRINCIPAL_READ_TOOL}`;

const readAnswer = (accountEnabled: unknown, id = SP) => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify({ servicePrincipal: { id, accountEnabled, displayName: 'agent' } }),
        },
    ],
});

const row = (over: Record<string, unknown> = {}) => ({
    id: 'jrn_sp',
    tenantId: T,
    connectionId: CONN,
    toolName: WRITE,
    advertisedToolName: SERVICE_PRINCIPAL_DISABLE_TOOL,
    mode: 'PROPOSE_ONLY',
    parameterSetLabel: null,
    argumentsJson: JSON.stringify({ servicePrincipalId: SP }),
    priorStateJson: JSON.stringify(readAnswer(true)),
    ...over,
});

const connection = (mode = 'PROPOSE_ONLY') => ({
    id: CONN,
    isEnabled: true,
    configJson: { url: 'https://app.example.test/api/mcp/entra-service-principal' },
    secretEncrypted: JSON.stringify({ authorization: 'Bearer abc' }),
    externalWriteMode: mode,
});

const settled = () => {
    const c = settleMock.mock.calls[0] as unknown[] | undefined;
    return c ? { outcome: c[2] as string, detail: (c[3] ?? null) as string | null } : null;
};
const writeWasSent = () => callToolMock.mock.calls.some((c) => c[1] === SERVICE_PRINCIPAL_DISABLE_TOOL);

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.externalWriteJournal.findMany.mockResolvedValue([row()]);
    mockTx.integrationConnection.findMany.mockResolvedValue([connection()]);
    getPriorStateReadMock.mockResolvedValue({ writeToolName: WRITE, readToolName: READ });
    boundRefusalMock.mockResolvedValue(null);
    memberMock.mockResolvedValue({ ok: true });
    linkConfirmedMock.mockResolvedValue(true);
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE DISPATCH SENDS IT, AND SETTLES ACCEPTED
// ═════════════════════════════════════════════════════════════════════

describe('the dispatch is the one sender, and a sent disable settles ACCEPTED', () => {
    it.each([['PROPOSE_ONLY'], ['AUTOMATIC']])(
        'a %s row is sent and settles ACCEPTED, never APPLIED',
        async (mode) => {
            mockTx.externalWriteJournal.findMany.mockResolvedValue([
                row({ mode, parameterSetLabel: mode === 'AUTOMATIC' ? 'contained-agent-disable' : null }),
            ]);
            mockTx.integrationConnection.findMany.mockResolvedValue([connection(mode)]);
            callToolMock.mockImplementation(async (_t: unknown, name: string) =>
                name === SERVICE_PRINCIPAL_READ_TOOL ? readAnswer(true) : { content: [{ type: 'text', text: '{"disabled":true}' }] },
            );
            const r = await runExternalWriteDispatch({ tenantId: T });
            expect(writeWasSent()).toBe(true);
            expect(settled()?.outcome).toBe('ACCEPTED');
            expect(r.accepted).toBe(1);
            expect(r.applied).toBe(0);
        },
    );

    it('at AUTOMATIC a population that no longer admits the principal refuses at send', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ mode: 'AUTOMATIC', parameterSetLabel: 'contained-agent-disable' }),
        ]);
        mockTx.integrationConnection.findMany.mockResolvedValue([connection('AUTOMATIC')]);
        boundRefusalMock.mockResolvedValue('external_write_automatic_target_left_population: …');
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()?.outcome).toBe('FAILED');
        expect(r.refused).toBe(1);
    });

    it.each([['PROPOSE_ONLY'], ['AUTOMATIC']])(
        'at %s a principal whose agent is no longer contained is refused at send — a transfer completed in between',
        async (mode) => {
            mockTx.externalWriteJournal.findMany.mockResolvedValue([
                row({ mode, parameterSetLabel: mode === 'AUTOMATIC' ? 'contained-agent-disable' : null }),
            ]);
            mockTx.integrationConnection.findMany.mockResolvedValue([connection(mode)]);
            callToolMock.mockResolvedValue(readAnswer(true));
            memberMock.mockResolvedValue({ ok: false, kind: 'not_a_member', size: 0 });
            const r = await runExternalWriteDispatch({ tenantId: T });
            expect(writeWasSent()).toBe(false);
            expect(settled()?.outcome).toBe('FAILED');
            expect(settled()?.detail).toContain('no longer the principal of a contained agent');
            expect(r.refused).toBe(1);
            expect(memberMock).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: T }),
                'contained_orphan_agent_entra_service_principals',
                SP,
            );
        },
    );

    it('an AUTOMATIC row whose link is no longer CONFIRMED by a person is refused at send', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ mode: 'AUTOMATIC', parameterSetLabel: 'contained-agent-disable' }),
        ]);
        mockTx.integrationConnection.findMany.mockResolvedValue([connection('AUTOMATIC')]);
        linkConfirmedMock.mockResolvedValue(false);
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()?.outcome).toBe('FAILED');
        expect(settled()?.detail).toContain('no longer confirmed by a person');
        expect(r.refused).toBe(1);
        expect(linkConfirmedMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T }), SP);
    });

    it('a PROPOSE_ONLY row is not asked for a confirmation — a person approved it', async () => {
        callToolMock.mockImplementation(async (_t: unknown, name: string) =>
            name === SERVICE_PRINCIPAL_READ_TOOL ? readAnswer(true) : { content: [] },
        );
        linkConfirmedMock.mockResolvedValue(false);
        await runExternalWriteDispatch({ tenantId: T });
        expect(linkConfirmedMock).not.toHaveBeenCalled();
        expect(settled()?.outcome).toBe('ACCEPTED');
    });

    it('a write with no declared precondition never asks the population', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            row({ advertisedToolName: 'set_alert_owner', toolName: `mcp__${CONN}__set_alert_owner` }),
        ]);
        callToolMock.mockResolvedValue(readAnswer(true));
        await runExternalWriteDispatch({ tenantId: T });
        expect(memberMock).not.toHaveBeenCalled();
    });

    it('an IN-BAND refusal from the endpoint settles INDETERMINATE, with its words — not ACCEPTED', async () => {
        callToolMock.mockImplementation(async (_t: unknown, name: string) =>
            name === SERVICE_PRINCIPAL_READ_TOOL
                ? readAnswer(true)
                : {
                      content: [
                          {
                              type: 'text',
                              text: 'That service principal is the one this connection authenticates as.',
                          },
                      ],
                      isError: true,
                  },
        );
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(settled()?.outcome).toBe('INDETERMINATE');
        expect(settled()?.detail).toContain('authenticates as');
        expect(r.indeterminate).toBe(1);
        expect(r.accepted).toBe(0);
        expect(r.applied).toBe(0);
    });

    it('a result that merely CARRIES isError: false is a success', async () => {
        callToolMock.mockImplementation(async (_t: unknown, name: string) =>
            name === SERVICE_PRINCIPAL_READ_TOOL ? readAnswer(true) : { content: [], isError: false },
        );
        await runExternalWriteDispatch({ tenantId: T });
        expect(settled()?.outcome).toBe('ACCEPTED');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. WHAT COUNTS AS THE PRINCIPAL BEING DISABLED
// ═════════════════════════════════════════════════════════════════════

describe('the verifier promotes only on the read showing the principal disabled', () => {
    const verify = DELIVERY_VERIFIERS.get(SERVICE_PRINCIPAL_DISABLE_TOOL)!;

    it('is declared', () => {
        expect(verify).toBeDefined();
    });

    it('enabled before, disabled now: delivered', () => {
        expect(verify(readAnswer(true), readAnswer(false))).toBe('delivered');
    });

    it('enabled before, still enabled: not yet — replication, or not applied', () => {
        expect(verify(readAnswer(true), readAnswer(true))).toBe('not_yet');
    });

    it('ALREADY disabled before: unreadable, never credited to our write', () => {
        expect(verify(readAnswer(false), readAnswer(false))).toBe('unreadable');
    });

    it('a different principal now: unreadable', () => {
        expect(verify(readAnswer(true), readAnswer(false, '11111111-2222-4333-8444-555555555555'))).toBe(
            'unreadable',
        );
    });

    it.each([
        ['an error result', { content: [{ type: 'text', text: 'gone' }], isError: true }],
        ['an absent accountEnabled — absence is not false', readAnswer(undefined)],
        ['a string accountEnabled', readAnswer('false')],
        ['unparseable text', { content: [{ type: 'text', text: 'not json' }] }],
        ['null', null],
    ])('%s now: unreadable', (_label, current) => {
        expect(verify(readAnswer(true), current)).toBe('unreadable');
    });

    it('an unreadable PRIOR state: unreadable, because there is no baseline', () => {
        expect(verify({ content: [{ type: 'text', text: 'x' }] }, readAnswer(false))).toBe('unreadable');
    });
});

describe('the reconcile pass', () => {
    beforeEach(() => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([row({ mode: 'AUTOMATIC' })]);
    });

    it('promotes to APPLIED when the read shows the principal disabled, and says that is why', async () => {
        callToolMock.mockResolvedValue(readAnswer(false));
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.promoted).toBe(1);
        expect(promoteMock).toHaveBeenCalledTimes(1);
        expect(promoteMock.mock.calls[0][1]).toBe('jrn_sp');
        expect(promoteMock.mock.calls[0][2]).toBe(DELIVERY_EVIDENCE.get(SERVICE_PRINCIPAL_DISABLE_TOOL));
        expect(String(promoteMock.mock.calls[0][2])).toContain('disabled');
        // It runs the READ and never the write.
        expect(callToolMock.mock.calls.map((c) => c[1])).toEqual([SERVICE_PRINCIPAL_READ_TOOL]);
        expect(callToolMock.mock.calls[0][2]).toEqual({ servicePrincipalId: SP });
    });

    it('leaves the row ACCEPTED while the principal still reads enabled, and settles nothing', async () => {
        callToolMock.mockResolvedValue(readAnswer(true));
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.notYet).toBe(1);
        expect(promoteMock).not.toHaveBeenCalled();
        expect(settleMock).not.toHaveBeenCalled();
    });

    it('leaves the row ACCEPTED when the read cannot be run — never FAILED', async () => {
        callToolMock.mockRejectedValue(new Error('down'));
        const r = await reconcileAcceptedExternalWrites({ tenantId: T });
        expect(r.unreadable).toBe(1);
        expect(promoteMock).not.toHaveBeenCalled();
        expect(settleMock).not.toHaveBeenCalled();
    });
});

describe('every promotion sentence names its own evidence', () => {
    it('declares evidence only for tools that have a verifier', () => {
        const extra = [...DELIVERY_EVIDENCE.keys()].filter((t) => !DELIVERY_VERIFIERS.has(t));
        expect(extra).toEqual([]);
        expect(DELIVERY_EVIDENCE.size).toBeGreaterThanOrEqual(1);
    });
});
