/**
 * `projectAgentForCanvas` (Phase 2.1, docs/ai-architecture/langflow.md).
 *
 * The usecase reads every layer through the surface that owns it, so these
 * tests hold the joins, not the surfaces: the register read is the tenant
 * boundary, the profile layer exists only where the REAL profile gate admits
 * the reader, and a profile tool's state is whatever `offerToolSet` — the
 * function every engine calls — says a run of this agent would be offered.
 *
 * The register, tool-exposure and kill-switch reads, the invocation builder and
 * the database are mocked at their module boundary. `getAgentProfile` is the
 * real one for the gate cases (its gate throws before any read), and a fixture
 * once a reader is admitted.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockGetRegisteredAgent = jest.fn();
jest.mock('@/app-layer/usecases/agent-registry', () => ({
    getRegisteredAgent: (...a: unknown[]) => mockGetRegisteredAgent(...a),
}));
const mockListAgentTools = jest.fn();
jest.mock('@/app-layer/usecases/agent-tool-exposure', () => ({
    listAgentTools: (...a: unknown[]) => mockListAgentTools(...a),
}));
jest.mock('@/lib/agentic/kill-switch', () => ({
    ...jest.requireActual('@/lib/agentic/kill-switch'),
    resolveKillState: jest.fn(async () => null),
}));
const mockResolveInvocation = jest.fn();
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: (...a: unknown[]) => mockResolveInvocation(...a),
}));
const mockOfferToolSet = jest.fn();
jest.mock('@/lib/agentic/engine-tools', () => ({
    offerToolSet: (...a: unknown[]) => mockOfferToolSet(...a),
}));
let profilesOn = true;
jest.mock('@/lib/agentic/agent-switches-policy', () => ({
    ...jest.requireActual('@/lib/agentic/agent-switches-policy'),
    agentProfilesOnFor: jest.fn(async () => profilesOn),
}));
let profileView: unknown = null;
jest.mock('@/app-layer/usecases/agent-profiles', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-profiles') as typeof import('@/app-layer/usecases/agent-profiles');
    return {
        ...actual,
        // The real gate first; a fixture only for a reader it admits.
        getAgentProfile: async (ctx: Parameters<typeof actual.getAgentProfile>[0], agentId: string) => {
            if (!profilesOn || ctx.appPermissions.admin.agent_registry !== true) return actual.getAgentProfile(ctx, agentId);
            return profileView;
        },
    };
});
const fakeDb = {
    agentPolicyCard: { findFirst: jest.fn(async () => ({ currentVersion: 4 })) },
    agentCircuitBreaker: { findFirst: jest.fn(async () => ({ state: 'CLOSED' })) },
    automationRule: { findMany: jest.fn(async () => [] as unknown[]) },
    processNode: { findMany: jest.fn(async () => [] as unknown[]) },
};
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb),
}));

import { projectAgentForCanvas } from '@/app-layer/usecases/agent-canvas-projection';
import { NotFoundError } from '@/lib/errors/types';

const AGENT = { id: 'agent-1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW' };

function version(overrides: Record<string, unknown> = {}) {
    return {
        id: 'v-2',
        version: 2,
        status: 'APPROVED',
        instructions: 'Summarise the posture.',
        toolNames: ['get_compliance_posture', 'propose_controls', 'revoked_tool'],
        skillRefs: [{ origin: 'repository', name: 'posture-review' }, { origin: 'tenant', name: 'gone' }],
        modelTier: 'balanced',
        effort: 'medium',
        maxTurns: 8,
        outputKind: 'ANSWER_AND_PROPOSALS',
        allowedTriggers: ['ASK'],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    profilesOn = true;
    mockGetRegisteredAgent.mockResolvedValue(AGENT);
    mockListAgentTools.mockResolvedValue({
        granted: [{ toolName: 'get_compliance_posture' }, { toolName: 'propose_controls' }],
        autonomyCeiling: 2,
        requiredAutonomy: { get_compliance_posture: 1, propose_controls: 2 },
    });
    mockResolveInvocation.mockResolvedValue({ marker: 'the-run-invocation' });
    profileView = {
        profile: { profileId: 'p1', currentApprovedVersion: 2, runKey: 'agent-profile:p1@v2' },
        versions: [version({ id: 'v-3', version: 3, status: 'DRAFT' }), version()],
        options: { tools: [], skills: [{ origin: 'repository', name: 'posture-review', catalogueBytes: 10 }] },
    };
});

describe('projectAgentForCanvas', () => {
    it("another tenant's agent cannot be projected: the register's 404 stops every other read", async () => {
        mockGetRegisteredAgent.mockRejectedValue(new NotFoundError('Registered agent not found'));
        const ctxB = makeRequestContext('ADMIN', { tenantId: 'tenant-B' });
        await expect(projectAgentForCanvas(ctxB, 'agent-of-tenant-A')).rejects.toBeInstanceOf(NotFoundError);
        expect(mockGetRegisteredAgent).toHaveBeenCalledWith(ctxB, 'agent-of-tenant-A');
        expect(mockListAgentTools).not.toHaveBeenCalled();
        expect(mockResolveInvocation).not.toHaveBeenCalled();
        expect(fakeDb.automationRule.findMany).not.toHaveBeenCalled();
    });

    it("the view's tool states equal what a run is offered", async () => {
        mockOfferToolSet.mockImplementation((_inv, build: (o: { tool: { name: string } }) => string) => ({
            tools: [build({ tool: { name: 'get_compliance_posture' } })],
            omitted: [
                { name: 'propose_controls', reason: 'AUTONOMY' },
                { name: 'revoked_tool', reason: 'PROFILE_TOOL_NOT_GRANTED' },
            ],
            externalConnections: [],
            review: {},
        }));
        const ctx = makeRequestContext('ADMIN');
        const p = await projectAgentForCanvas(ctx, AGENT.id);

        // The invocation a run of this agent started by this viewer gets, with
        // no external catalogue read (no credential exchange, no third party).
        expect(mockResolveInvocation).toHaveBeenCalledWith({ ...ctx, agentId: AGENT.id }, { externalCatalogues: 'NOT_READ' });
        // The options a profile run passes: the version's tools, and read-only
        // exactly when the version answers only.
        expect(mockOfferToolSet).toHaveBeenCalledWith(
            { marker: 'the-run-invocation' },
            expect.any(Function),
            expect.objectContaining({ profileTools: version().toolNames, readOnly: false }),
        );
        if (p.profile.state !== 'SHOWN') throw new Error('profile layer expected');
        expect(p.profile.version).toBe(2);
        expect(p.profile.inForce).toBe(true);
        expect(p.profile.runAs).toBe('RUN');
        expect(p.profile.tools).toEqual([
            { name: 'get_compliance_posture', offered: true },
            { name: 'propose_controls', offered: false, reason: 'AUTONOMY' },
            { name: 'revoked_tool', offered: false, reason: 'PROFILE_TOOL_NOT_GRANTED' },
        ]);
        expect(p.profile.skills).toEqual([
            { origin: 'repository', name: 'posture-review', mountable: true },
            { origin: 'tenant', name: 'gone', mountable: false },
        ]);
    });

    it('an answer-only version is probed as a read-only run', async () => {
        mockOfferToolSet.mockReturnValue({ tools: [], omitted: [], externalConnections: [], review: {} });
        profileView = { ...(profileView as object), versions: [version({ outputKind: 'ANSWER_ONLY' })] };
        await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id);
        expect(mockOfferToolSet).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Function),
            expect.objectContaining({ readOnly: true }),
        );
    });

    it('a version submitted for review is probed as its Test run, which is read-only whatever its output kind', async () => {
        mockOfferToolSet.mockImplementation((_inv, build: (o: { tool: { name: string } }) => string) => ({
            tools: [build({ tool: { name: 'get_compliance_posture' } })],
            omitted: [
                { name: 'propose_controls', reason: 'READ_ONLY_WORKFLOW' },
                { name: 'revoked_tool', reason: 'PROFILE_TOOL_NOT_GRANTED' },
            ],
            externalConnections: [],
            review: {},
        }));
        const submitted = version({ id: 'v-3', version: 3, status: 'SUBMITTED', allowedTriggers: ['ASK', 'TEST_RUN'] });
        profileView = { ...(profileView as object), versions: [submitted, version()] };
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id, { versionId: 'v-3' });

        // ANSWER_AND_PROPOSALS, yet probed read-only: its only run is a Test run.
        expect(mockOfferToolSet).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Function),
            expect.objectContaining({ readOnly: true }),
        );
        if (p.profile.state !== 'SHOWN') throw new Error('profile layer expected');
        expect(p.profile.inForce).toBe(false);
        expect(p.profile.runAs).toBe('TEST_RUN');
        expect(p.profile.readOnly).toBe(true);
        expect(p.profile.tools.find((t) => t.name === 'propose_controls')).toEqual({
            name: 'propose_controls',
            offered: false,
            reason: 'TEST_RUN_READ_ONLY',
        });
    });

    it.each([
        ['a draft', { status: 'DRAFT' }],
        ['a rejected version', { status: 'REJECTED' }],
        ['a submitted version that does not allow a Test run', { status: 'SUBMITTED', allowedTriggers: ['ASK'] }],
        ['an approved version no longer in force', { status: 'APPROVED', version: 1 }],
    ])('%s has no run, so nothing is offered and no run is probed', async (_label, overrides) => {
        profileView = { ...(profileView as object), versions: [version({ id: 'v-x', ...overrides }), version()] };
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id, { versionId: 'v-x' });
        expect(mockResolveInvocation).not.toHaveBeenCalled();
        if (p.profile.state !== 'SHOWN') throw new Error('profile layer expected');
        expect(p.profile.runAs).toBeNull();
        expect(p.profile.tools.length).toBe(3);
        expect(p.profile.tools.every((t) => !t.offered && t.reason === 'VERSION_NOT_RUNNABLE')).toBe(true);
    });

    it('an external tool the agent is granted is reported as not checked, never as offered or lost', async () => {
        const ext = 'mcp__cmconn__list_alerts';
        const gone = 'mcp__cmconn__list_incidents';
        mockResolveInvocation.mockResolvedValue({ grantedTools: new Set(['get_compliance_posture', ext]) });
        mockOfferToolSet.mockImplementation((_inv, build: (o: { tool: { name: string } }) => string) => ({
            tools: [build({ tool: { name: 'get_compliance_posture' } })],
            omitted: [
                { name: ext, reason: 'PROFILE_TOOL_NOT_GRANTED' },
                { name: gone, reason: 'PROFILE_TOOL_NOT_GRANTED' },
            ],
            externalConnections: [],
            review: {},
        }));
        profileView = {
            ...(profileView as object),
            versions: [version({ toolNames: ['get_compliance_posture', ext, gone] })],
        };
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id);
        if (p.profile.state !== 'SHOWN') throw new Error('profile layer expected');
        expect(p.profile.tools).toEqual([
            { name: 'get_compliance_posture', offered: true },
            { name: ext, offered: false, reason: 'EXTERNAL_NOT_PROBED' },
            // No longer granted: the grant list is read, so a lost external tool still says so.
            { name: gone, offered: false, reason: 'PROFILE_TOOL_NOT_GRANTED' },
        ]);
    });

    it('an agent that is not active offers nothing, and no run is probed for it', async () => {
        mockGetRegisteredAgent.mockResolvedValue({ ...AGENT, status: 'DRAFT' });
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id);
        expect(mockResolveInvocation).not.toHaveBeenCalled();
        if (p.profile.state !== 'SHOWN') throw new Error('profile layer expected');
        expect(p.profile.tools.every((t) => !t.offered && t.reason === 'AGENT_NOT_ACTIVE')).toBe(true);
    });

    it('a reader without admin.agent_registry sees the envelope and not the profile', async () => {
        const auditor = makeRequestContext('AUDITOR');
        expect(auditor.appPermissions.admin.agent_registry).toBe(false);
        const p = await projectAgentForCanvas(auditor, AGENT.id);
        expect(p.profile).toEqual({ state: 'NOT_PERMITTED' });
        expect(mockResolveInvocation).not.toHaveBeenCalled();
        expect(p.envelope.grants?.map((g) => g.name)).toEqual(['get_compliance_posture', 'propose_controls']);
        expect(p.envelope.policyCardVersion).toBe(4);
    });

    it('where agent profiles are off, the profile layer does not exist, whoever reads', async () => {
        profilesOn = false;
        const p = await projectAgentForCanvas(makeRequestContext('OWNER'), AGENT.id);
        expect(p.profile).toEqual({ state: 'OFF' });
        expect(mockResolveInvocation).not.toHaveBeenCalled();
    });

    it('a retired agent is drawn with no grants, and its tools are never listed', async () => {
        mockGetRegisteredAgent.mockResolvedValue({ ...AGENT, status: 'RETIRED' });
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id);
        expect(p.envelope.grants).toBeNull();
        expect(mockListAgentTools).not.toHaveBeenCalled();
    });

    it('draws the registry workflows and the maps that invoke the agent, and never a profile key as a workflow', async () => {
        mockOfferToolSet.mockReturnValue({ tools: [], omitted: [], externalConnections: [], review: {} });
        fakeDb.automationRule.findMany.mockResolvedValueOnce([
            { id: 'r1', actionConfigJson: { agentId: AGENT.id, workflowKey: 'diagnostic' } },
            { id: 'r2', actionConfigJson: { agentId: AGENT.id, workflowKey: 'agent-profile:p1@v2' } },
        ]);
        fakeDb.processNode.findMany.mockResolvedValueOnce([{ nodeKey: 'n-1', processMap: { id: 'm1', name: 'Onboarding' } }]);
        const p = await projectAgentForCanvas(makeRequestContext('ADMIN'), AGENT.id);
        expect(p.workflows.map((w) => w.key)).toEqual(['diagnostic']);
        expect(p.workflows[0].steps.map((s) => s.kind)).toEqual(['READ', 'SYNTHESIS']);
        expect(p.workflows[0].orderEnforced).toBe(true);
        expect(p.usedIn).toEqual([{ mapId: 'm1', mapName: 'Onboarding', nodeKey: 'n-1' }]);
    });
});
