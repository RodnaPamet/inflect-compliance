/**
 * #3671 — requesting a contained agent's service-principal disable, rung by
 * rung, through the external write ladder.
 *
 * The property every test below protects: THIS MODULE NEVER SENDS THE WRITE.
 * It may run the paired READ (that is the precondition, owner decision 2), and
 * it hands the write to the rung's own primitive — `recordIntent`,
 * `createAgentProposal`, `openAutomaticExternalWrite` — which open rows and
 * send nothing. The one sender is `external-write-dispatch`. So every test
 * asserts the WRITE tool name never reached `callTool`, rather than trusting a
 * returned status.
 *
 * Per rung, as the issue's hardening checklist asks:
 *
 *   DISABLED      nothing — not even the read
 *   DRY_RUN       the read, then a RECORDED_ONLY intent; no proposal, no row to send
 *   PROPOSE_ONLY  the read, then an EXTERNAL_WRITE proposal carrying it
 *   AUTOMATIC     the read, then a PENDING journal row carrying it, under the
 *                 one approved template bounded to the contained-agent population
 *
 * And a failed prior-state read REFUSES at every rung that would write.
 */
const linksMock = jest.fn();
jest.mock('@/app-layer/usecases/agent-service-principal-links', () => ({
    readContainedAgentServicePrincipalLinks: (...a: unknown[]) => linksMock(...a),
}));

const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer conn.secret'),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
}));

const recordIntentMock = jest.fn();
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    recordIntent: (...a: unknown[]) => recordIntentMock(...a),
}));
const proposeMock = jest.fn();
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: (...a: unknown[]) => proposeMock(...a),
}));
const openAutomaticMock = jest.fn();
jest.mock('@/app-layer/usecases/external-write-automatic', () => ({
    openAutomaticExternalWrite: (...a: unknown[]) => openAutomaticMock(...a),
}));
const memberMock = jest.fn();
jest.mock('@/app-layer/usecases/external-tool-target-populations', () => ({
    checkTargetInPopulation: (...a: unknown[]) => memberMock(...a),
}));
const confirmationMock = jest.fn();
jest.mock('@/app-layer/usecases/agent-service-principal-confirmation', () => ({
    liveConfirmationFor: (...a: unknown[]) => confirmationMock(...a),
}));

const mockTx = {
    externalToolPriorStateRead: { findMany: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
    externalToolParameterSet: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import { requestServicePrincipalDisable } from '@/app-layer/usecases/agent-service-principal-disable';
import {
    CONTAINED_AGENT_SP_POPULATION,
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_READ_TOOL,
} from '@/lib/agentic/service-principal-disable';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { buildSystemContext } from '@/app-layer/context-system';

const T = 'tenant-sp';
const ctx = buildSystemContext({ tenantId: T, job: 'agent-owner-orphan-pass' });
const AGENT = 'agent-1';
const SP = '9f1c2b7e-4a3d-4c1e-8b2f-6d5e4c3b2a19';
const CONN = 'cmconnspaaaaaaaaaaaaaaaa';
const WRITE = `mcp__${CONN}__${SERVICE_PRINCIPAL_DISABLE_TOOL}`;
/** A person's live confirmation of the link (owner decision, 2026-10-18). */
const CONFIRMED = { id: 'conf-1', confirmedByUserId: 'user-confirmer', confirmedAt: new Date('2026-10-18T09:00:00.000Z') };
const READ = `mcp__${CONN}__${SERVICE_PRINCIPAL_READ_TOOL}`;

/** The read tool's answer, in the envelope `callTool` returns. */
const readAnswer = (accountEnabled: boolean, id = SP) => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify({
                servicePrincipal: {
                    id,
                    appId: 'ffffffff-1111-2222-3333-444455556666',
                    displayName: 'billing-agent',
                    accountEnabled,
                    servicePrincipalType: 'Application',
                    appOwnerOrganizationId: '5c459bc6-0000-4000-8000-000000000001',
                },
            }),
        },
    ],
});

const connection = (mode: string | null) => ({
    id: CONN,
    name: 'SP endpoint',
    isEnabled: true,
    configJson: { url: 'https://app.example.test/api/mcp/entra-service-principal' },
    secretEncrypted: JSON.stringify({ authorization: 'Bearer conn.secret' }),
    externalWriteMode: mode,
});

const template = (over: Record<string, unknown> = {}) => ({
    label: 'contained-agent-disable',
    parameters: {},
    openFields: { servicePrincipalId: { kind: 'target' } },
    targetPopulation: CONTAINED_AGENT_SP_POPULATION,
    ...over,
});

/** Did the WRITE leave from here? It must never. The read is allowed. */
const writeWasSent = () => callToolMock.mock.calls.some((c) => c[1] === SERVICE_PRINCIPAL_DISABLE_TOOL);
const readWasRun = () => callToolMock.mock.calls.some((c) => c[1] === SERVICE_PRINCIPAL_READ_TOOL);
const nothingOpened = () =>
    recordIntentMock.mock.calls.length === 0
    && proposeMock.mock.calls.length === 0
    && openAutomaticMock.mock.calls.length === 0;

beforeEach(() => {
    jest.clearAllMocks();
    linksMock.mockResolvedValue({
        containedAgentIds: new Set([AGENT]),
        links: [
            { agentId: AGENT, discoveredAgentId: 'disc-1', discoveredId: `entra:sp:${SP}`, servicePrincipalId: SP },
        ],
    });
    confirmationMock.mockResolvedValue(CONFIRMED);
    mockTx.externalToolPriorStateRead.findMany.mockResolvedValue([
        { writeToolName: WRITE, readToolName: READ },
    ]);
    mockTx.integrationConnection.findFirst.mockResolvedValue(connection('DRY_RUN'));
    mockTx.externalToolParameterSet.findMany.mockResolvedValue([template()]);
    callToolMock.mockResolvedValue(readAnswer(true));
    recordIntentMock.mockResolvedValue({ journalId: 'jrn-intent' });
    proposeMock.mockResolvedValue({ id: 'prop-1', status: 'PENDING', guardVerdict: 'CLEAN' });
    openAutomaticMock.mockResolvedValue({ journalId: 'jrn-auto' });
    memberMock.mockResolvedValue({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════
// 1. EACH RUNG, ASSERTED PER RUNG
// ═════════════════════════════════════════════════════════════════════

describe('each rung behaves as specified', () => {
    it.each([['DISABLED'], [null], ['SOMETHING_RETIRED']])(
        'at %s (coerced to DISABLED) nothing is read and nothing is written',
        async (mode) => {
            mockTx.integrationConnection.findFirst.mockResolvedValue(connection(mode));
            const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
            expect(out.status).toBe('RUNG_DISABLED');
            expect(out.rung).toBe('DISABLED');
            expect(callToolMock).not.toHaveBeenCalled();
            expect(nothingOpened()).toBe(true);
        },
    );

    it('at DRY_RUN the read runs and an intent is RECORDED, carrying it — and nothing is sent', async () => {
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out).toMatchObject({ status: 'RECORDED_INTENT', rung: 'DRY_RUN', journalId: 'jrn-intent' });
        expect(readWasRun()).toBe(true);
        expect(writeWasSent()).toBe(false);
        expect(recordIntentMock).toHaveBeenCalledTimes(1);
        const attempt = recordIntentMock.mock.calls[0][1] as Record<string, unknown>;
        expect(attempt.mode).toBe('DRY_RUN');
        expect(attempt.toolName).toBe(WRITE);
        expect(attempt.advertisedToolName).toBe(SERVICE_PRINCIPAL_DISABLE_TOOL);
        expect(JSON.parse(attempt.argumentsJson as string)).toEqual({ servicePrincipalId: SP });
        expect(JSON.parse(attempt.priorStateJson as string)).toEqual(readAnswer(true));
        expect(attempt.agentId).toBeNull();
        expect(proposeMock).not.toHaveBeenCalled();
        expect(openAutomaticMock).not.toHaveBeenCalled();
    });

    it('at PROPOSE_ONLY an EXTERNAL_WRITE proposal carries the prior state — and nothing is sent', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('PROPOSE_ONLY'));
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out).toMatchObject({ status: 'PROPOSED', rung: 'PROPOSE_ONLY', proposalId: 'prop-1' });
        expect(writeWasSent()).toBe(false);
        expect(proposeMock).toHaveBeenCalledTimes(1);
        const input = proposeMock.mock.calls[0][1] as {
            kind: string;
            payload: Record<string, unknown>;
            policyCardVersion: number;
            proposedBySessionRef: string;
        };
        expect(input.kind).toBe('EXTERNAL_WRITE');
        expect(input.payload).toEqual({
            connectionId: CONN,
            connectionName: 'SP endpoint',
            endpointUrl: 'https://app.example.test/api/mcp/entra-service-principal',
            toolName: WRITE,
            advertisedToolName: SERVICE_PRINCIPAL_DISABLE_TOOL,
            arguments: { servicePrincipalId: SP },
            priorState: readAnswer(true),
        });
        expect(input.policyCardVersion).toBe(NO_POLICY_CARD);
        expect(input.proposedBySessionRef).toBe(`agent-owner-orphan-pass:${AGENT}`);
        expect(recordIntentMock).not.toHaveBeenCalled();
        expect(openAutomaticMock).not.toHaveBeenCalled();
    });

    it('at PROPOSE_ONLY a quarantined proposal is reported as such, not as queued for review', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('PROPOSE_ONLY'));
        proposeMock.mockResolvedValue({ id: 'prop-q', status: 'QUARANTINED', guardVerdict: 'MALICIOUS' });
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('QUARANTINED');
    });

    it('at AUTOMATIC a PENDING journal row is opened carrying the prior state, read FIRST, under the template', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out).toMatchObject({ status: 'QUEUED', rung: 'AUTOMATIC', journalId: 'jrn-auto' });
        expect(writeWasSent()).toBe(false);
        expect(openAutomaticMock).toHaveBeenCalledTimes(1);
        const req = openAutomaticMock.mock.calls[0][1] as Record<string, unknown>;
        expect(req.parameterSetLabel).toBe('contained-agent-disable');
        expect(req.toolName).toBe(WRITE);
        expect(JSON.parse(req.priorStateJson as string)).toEqual(readAnswer(true));
        expect(JSON.parse(req.argumentsJson as string)).toEqual({ servicePrincipalId: SP });
        // The prior state exists before the row does.
        expect(callToolMock.mock.invocationCallOrder[0]).toBeLessThan(
            openAutomaticMock.mock.invocationCallOrder[0],
        );
        // And the target was checked against the approved population.
        expect(memberMock).toHaveBeenCalledWith(ctx, CONTAINED_AGENT_SP_POPULATION, SP);
        expect(recordIntentMock).not.toHaveBeenCalled();
        expect(proposeMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. NO EXTERNAL WRITE WITHOUT PRIOR STATE
// ═════════════════════════════════════════════════════════════════════

describe('a failed prior-state read refuses the write', () => {
    it.each([['DRY_RUN'], ['PROPOSE_ONLY'], ['AUTOMATIC']])(
        'a read that THROWS at %s opens nothing',
        async (mode) => {
            mockTx.integrationConnection.findFirst.mockResolvedValue(connection(mode));
            callToolMock.mockRejectedValue(new Error('socket hang up'));
            const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
            expect(out.status).toBe('PRIOR_STATE_UNREADABLE');
            expect(nothingOpened()).toBe(true);
            expect(writeWasSent()).toBe(false);
        },
    );

    it.each([
        ['an error result', { content: [{ type: 'text', text: 'No such principal' }], isError: true }],
        ['a different shape', { content: [{ type: 'text', text: '{"assignments":{"all":[]}}' }] }],
        ['no accountEnabled', { content: [{ type: 'text', text: JSON.stringify({ servicePrincipal: { id: SP } }) }] }],
        ['another principal', readAnswer(true, '11111111-2222-4333-8444-555555555555')],
    ])('a read that answers with %s refuses too', async (_label, answer) => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        callToolMock.mockResolvedValue(answer);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('PRIOR_STATE_UNREADABLE');
        expect(nothingOpened()).toBe(true);
    });

    it('no nominated pairing means no write, and no read either', async () => {
        mockTx.externalToolPriorStateRead.findMany.mockResolvedValue([]);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('NO_PAIRED_ENDPOINT');
        expect(callToolMock).not.toHaveBeenCalled();
        expect(nothingOpened()).toBe(true);
    });

    it('a pairing whose name only ENDS like the tool is not the tool', async () => {
        mockTx.externalToolPriorStateRead.findMany.mockResolvedValue([
            { writeToolName: `mcp__${CONN}__x__${SERVICE_PRINCIPAL_DISABLE_TOOL}`, readToolName: READ },
        ]);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('NO_PAIRED_ENDPOINT');
    });

    it('two pairings are refused rather than choosing a directory', async () => {
        mockTx.externalToolPriorStateRead.findMany.mockResolvedValue([
            { writeToolName: WRITE, readToolName: READ },
            {
                writeToolName: `mcp__cmotheraaaaaaaaaaaaaaaaa__${SERVICE_PRINCIPAL_DISABLE_TOOL}`,
                readToolName: `mcp__cmotheraaaaaaaaaaaaaaaaa__${SERVICE_PRINCIPAL_READ_TOOL}`,
            },
        ]);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('AMBIGUOUS_PAIRED_ENDPOINT');
        expect(callToolMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. WHAT IS NOT A CANDIDATE
// ═════════════════════════════════════════════════════════════════════

describe('only a contained agent naming exactly one principal is a candidate', () => {
    it('an already-disabled principal is left alone', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        callToolMock.mockResolvedValue(readAnswer(false));
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('ALREADY_DISABLED');
        expect(nothingOpened()).toBe(true);
    });

    it('an agent with no OWNER_DEPARTED kill in force is not contained', async () => {
        linksMock.mockResolvedValue({ containedAgentIds: new Set(), links: [] });
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('NOT_CONTAINED');
        expect(mockTx.externalToolPriorStateRead.findMany).not.toHaveBeenCalled();
    });

    it('an agent the harness reconciled to no principal is NOT_LINKED', async () => {
        linksMock.mockResolvedValue({ containedAgentIds: new Set([AGENT]), links: [] });
        expect((await requestServicePrincipalDisable(ctx, { agentId: AGENT })).status).toBe('NOT_LINKED');
    });

    it('an agent reconciled to TWO principals is refused, not resolved by order', async () => {
        linksMock.mockResolvedValue({
            containedAgentIds: new Set([AGENT]),
            links: [
                { agentId: AGENT, discoveredAgentId: 'd1', discoveredId: `entra:sp:${SP}`, servicePrincipalId: SP },
                {
                    agentId: AGENT,
                    discoveredAgentId: 'd2',
                    discoveredId: 'entra:sp:11111111-2222-4333-8444-555555555555',
                    servicePrincipalId: '11111111-2222-4333-8444-555555555555',
                },
            ],
        });
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('AMBIGUOUS_LINK');
        expect(callToolMock).not.toHaveBeenCalled();
    });

    it('a disabled or missing connection is unusable, and nothing is read', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue({ ...connection('AUTOMATIC'), isEnabled: false });
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('CONNECTION_UNUSABLE');
        expect(callToolMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3b. A PERSON CONFIRMS THE LINK BEFORE AN UNATTENDED DISABLE
// ═════════════════════════════════════════════════════════════════════

describe('the link must be confirmed by a person at AUTOMATIC, and is stated at PROPOSE_ONLY', () => {
    it('at AUTOMATIC an UNCONFIRMED link is refused with its own reason, before any read or row', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        confirmationMock.mockResolvedValue(null);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('LINK_UNCONFIRMED');
        expect(out.linkConfirmed).toBe(false);
        expect(callToolMock).not.toHaveBeenCalled();
        expect(nothingOpened()).toBe(true);
        expect(mockTx.externalToolParameterSet.findMany).not.toHaveBeenCalled();
    });

    it('asks about EXACTLY the link it found — the discovered agent, its harness id and the agent', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(confirmationMock).toHaveBeenCalledWith(ctx, {
            agentId: AGENT,
            discoveredAgentId: 'disc-1',
            discoveredId: `entra:sp:${SP}`,
        });
    });

    it('at AUTOMATIC a CONFIRMED link proceeds to the queued row', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('QUEUED');
        expect(out.linkConfirmed).toBe(true);
    });

    it.each([['DRY_RUN'], ['PROPOSE_ONLY']])(
        'at %s an unconfirmed link still proceeds — a person reads what it produces',
        async (mode) => {
            mockTx.integrationConnection.findFirst.mockResolvedValue(connection(mode));
            confirmationMock.mockResolvedValue(null);
            const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
            expect(out.status).toBe(mode === 'DRY_RUN' ? 'RECORDED_INTENT' : 'PROPOSED');
            expect(out.linkConfirmed).toBe(false);
        },
    );

    it('the PROPOSE_ONLY proposal tells the approver the link is UNCONFIRMED', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('PROPOSE_ONLY'));
        confirmationMock.mockResolvedValue(null);
        await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        const rationale = String((proposeMock.mock.calls[0][1] as { rationale: string }).rationale);
        expect(rationale).toContain('THE LINK IS UNCONFIRMED');
    });

    it('and names who confirmed it, and when, when it is confirmed', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('PROPOSE_ONLY'));
        await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        const rationale = String((proposeMock.mock.calls[0][1] as { rationale: string }).rationale);
        expect(rationale).toContain('confirmed by user user-confirmer at 2026-10-18T09:00:00.000Z');
        expect(rationale).not.toContain('UNCONFIRMED');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. AUTOMATIC STANDS ON A TEMPLATE AND A POPULATION
// ═════════════════════════════════════════════════════════════════════

describe('at AUTOMATIC the one approved template and the population decide', () => {
    beforeEach(() => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(connection('AUTOMATIC'));
    });

    it.each([
        ['no template at all', []],
        ['a template bound to another population', [template({ targetPopulation: 'terminated_employee_entra_account_ids' })]],
        ['a template that opens a second field', [template({ openFields: { servicePrincipalId: { kind: 'target' }, note: { kind: 'length', min: 1, max: 10 } } })]],
        ['a template that FIXES the principal', [template({ parameters: { servicePrincipalId: SP } })]],
        ['an unreadable template', [template({ targetPopulation: null })]],
    ])('%s is NO_APPROVED_TEMPLATE, before any read', async (_label, sets) => {
        mockTx.externalToolParameterSet.findMany.mockResolvedValue(sets);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('NO_APPROVED_TEMPLATE');
        expect(callToolMock).not.toHaveBeenCalled();
        expect(nothingOpened()).toBe(true);
    });

    it('two qualifying templates are refused rather than choosing', async () => {
        mockTx.externalToolParameterSet.findMany.mockResolvedValue([template(), template({ label: 'second' })]);
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('AMBIGUOUS_TEMPLATE');
        expect(nothingOpened()).toBe(true);
    });

    it('a principal the population does not admit NOW is refused, before any read', async () => {
        memberMock.mockResolvedValue({ ok: false, kind: 'not_a_member', size: 3 });
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('NOT_IN_POPULATION');
        expect(callToolMock).not.toHaveBeenCalled();
        expect(nothingOpened()).toBe(true);
    });

    it("the arm's own refusal (rate cap, Art 12 record) is REFUSED, and never thrown at the pass", async () => {
        openAutomaticMock.mockRejectedValue(new Error('external_write_automatic_rate_limited: …'));
        const out = await requestServicePrincipalDisable(ctx, { agentId: AGENT });
        expect(out.status).toBe('REFUSED');
        expect(out.detail).toContain('rate_limited');
    });
});

describe('it never throws at the pass', () => {
    it('an unexpected failure is a recorded FAILED outcome', async () => {
        linksMock.mockRejectedValue(new Error('connection reset'));
        await expect(requestServicePrincipalDisable(ctx, { agentId: AGENT })).resolves.toMatchObject({
            status: 'FAILED',
        });
    });
});
