/**
 * The enforcement facts `get_harness_register` carries for a scanner (#5004),
 * over a fake tenant transaction: each rule the H2 and H3 verdicts stand on.
 *
 *   • the ceiling is the funnel's own composition, and an unscored agent is
 *     denied outright;
 *   • a grant is counted by class, an unknown built-in as propose and every
 *     external tool as external;
 *   • manifests are pinned only with at least one grant, no external grant, and
 *     every built-in verifying against its pin — a drifted pin does not;
 *   • a run that mounted `[]` mounted nothing; a read past the cap is unknown;
 *   • per key, the endpoint gate's own predicate and the exchange requirement.
 *
 * The end-to-end read through `/api/mcp` is
 * `tests/integration/agent-harness-register-read.test.ts`.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb)),
}));

import {
    HARNESS_REGISTER_SKILL_RUNS_CAP,
    readHarnessRegisterForScanner,
} from '@/app-layer/usecases/agent-harness-register-read';
import { hashToolManifest, type ToolDefinition } from '@/lib/mcp/tool-manifest';
import { makeRequestContext } from '../helpers/make-context';

interface Rows {
    agents: Array<Record<string, unknown>>;
    keys: Array<Record<string, unknown>>;
    grants: Array<{ agentId: string; toolName: string }>;
    pins: Array<Record<string, unknown>>;
    profiles: Array<{ agentId: string }>;
    runs: Array<{ agentId: string; mountedSkills: unknown }>;
}
let rows: Rows;
const take = <T>(list: T[], args: { take?: number }) => (args.take === undefined ? list : list.slice(0, args.take));
const fakeDb = {
    registeredAgent: { findMany: async (a: { take?: number }) => take(rows.agents, a) },
    tenantApiKey: { findMany: async (a: { take?: number }) => take(rows.keys, a) },
    agentPolicyCard: { findMany: async () => [] },
    agentRiskAssessment: { findMany: async () => [] },
    agentServicePrincipalConfirmation: { findMany: async () => [] },
    registeredAgentTool: { findMany: async (a: { take?: number }) => take(rows.grants, a) },
    mcpToolManifestPin: { findMany: async (a: { take?: number }) => take(rows.pins, a) },
    agentProfile: { findMany: async (a: { take?: number }) => take(rows.profiles, a) },
    workflowRun: { findMany: async (a: { take?: number }) => take(rows.runs, a) },
};

const READ_DEF: ToolDefinition = { name: 'get_harness_register', description: 'read the register', inputSchema: { type: 'object' } };
const PROPOSE_DEF: ToolDefinition = { name: 'propose_risks', description: 'propose risks', inputSchema: { type: 'object' } };
const builtInTools = new Map([
    [READ_DEF.name, READ_DEF],
    [PROPOSE_DEF.name, PROPOSE_DEF],
]);
const pinOf = (def: ToolDefinition, over: Partial<ToolDefinition> = {}) => {
    const h = hashToolManifest({ ...def, ...over });
    return {
        toolName: def.name,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        annotationsHash: h.annotationsHash,
        revision: 1,
        approvedByUserId: null,
        approvalSource: 'BASELINE',
    };
};
const agent = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: 'ACTIVE',
    ownerUserId: 'u1',
    autonomyLevel: 1,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'REVERSIBLE',
    provenance: 'FIRST_PARTY',
    riskTier: 'LOW',
    ...over,
});
const ctx = makeRequestContext('OWNER');
const read = async () => (await readHarnessRegisterForScanner(ctx, { builtInTools })).agents;
const byId = async (id: string) => (await read()).find((a) => a.registeredAgentId === id)!;

beforeEach(() => {
    rows = { agents: [agent('a1')], keys: [], grants: [], pins: [], profiles: [], runs: [] };
});

describe('the ceiling and the rungs it refuses', () => {
    it('is the agent autonomy under its tier cap: a read-only agent refuses propose and orchestrate', async () => {
        expect((await byId('a1')).enforcement).toMatchObject({ autonomyCeiling: 1, proposeRefused: true, orchestrateRefused: true });
    });

    it('takes the tier cap when it is lower than the registration', async () => {
        rows.agents = [agent('a1', { autonomyLevel: 6, riskTier: 'HIGH' })];
        expect((await byId('a1')).enforcement).toMatchObject({ autonomyCeiling: 2, proposeRefused: false, orchestrateRefused: true });
    });

    it('denies an unscored agent everything', async () => {
        rows.agents = [agent('a1', { autonomyLevel: 6, riskTier: null })];
        expect((await byId('a1')).enforcement).toMatchObject({ autonomyCeiling: -1, proposeRefused: true, orchestrateRefused: true });
    });
});

describe('grants and their pins', () => {
    it('one read grant whose pin verifies: pinned', async () => {
        rows.grants = [{ agentId: 'a1', toolName: READ_DEF.name }];
        rows.pins = [pinOf(READ_DEF)];
        expect((await byId('a1')).enforcement).toMatchObject({ grants: { read: 1, propose: 0, external: 0 }, manifestsPinned: true });
    });

    it('no grant pins nothing', async () => {
        expect((await byId('a1')).enforcement.manifestsPinned).toBe(false);
    });

    it('a pin the definition has drifted from does not verify', async () => {
        rows.grants = [{ agentId: 'a1', toolName: READ_DEF.name }];
        rows.pins = [pinOf(READ_DEF, { description: 'what it said when it was pinned' })];
        expect((await byId('a1')).enforcement.manifestsPinned).toBe(false);
    });

    it('a grant with no pin does not verify', async () => {
        rows.grants = [{ agentId: 'a1', toolName: READ_DEF.name }];
        expect((await byId('a1')).enforcement.manifestsPinned).toBe(false);
    });

    it('an external grant is counted as external and is never vouched for', async () => {
        rows.grants = [
            { agentId: 'a1', toolName: READ_DEF.name },
            { agentId: 'a1', toolName: 'mcp__conn1__list_alerts' },
        ];
        rows.pins = [pinOf(READ_DEF)];
        expect((await byId('a1')).enforcement).toMatchObject({ grants: { read: 1, propose: 0, external: 1 }, manifestsPinned: false });
    });

    it('a propose tool, and a built-in name the catalogue does not list, count as propose', async () => {
        rows.grants = [
            { agentId: 'a1', toolName: PROPOSE_DEF.name },
            { agentId: 'a1', toolName: 'not_a_tool_this_build_has' },
        ];
        rows.pins = [pinOf(PROPOSE_DEF)];
        expect((await byId('a1')).enforcement).toMatchObject({ grants: { read: 0, propose: 2, external: 0 }, manifestsPinned: false });
    });
});

describe('profile and skills', () => {
    it('a profile with an approved version is in force', async () => {
        rows.profiles = [{ agentId: 'a1' }];
        expect((await byId('a1')).enforcement.profileInForce).toBe(true);
    });

    it('a run that mounted [] mounted nothing; one that mounted a skill did', async () => {
        rows.agents = [agent('a1'), agent('a2')];
        rows.runs = [
            { agentId: 'a1', mountedSkills: [] },
            { agentId: 'a2', mountedSkills: [{ name: 'x', hash: 'h' }] },
        ];
        const [a1, a2] = [await byId('a1'), await byId('a2')];
        expect(a1.enforcement.skillsMounted).toBe(false);
        expect(a2.enforcement.skillsMounted).toBe(true);
    });

    it('runs read past the cap make it unknown, never false', async () => {
        rows.runs = Array.from({ length: HARNESS_REGISTER_SKILL_RUNS_CAP + 1 }, () => ({ agentId: 'a1', mountedSkills: [] }));
        expect((await byId('a1')).enforcement.skillsMounted).toBeNull();
    });
});

describe('keys', () => {
    it('reports the endpoint gate predicate and the exchange requirement per key', async () => {
        const created = new Date('2026-11-01T00:00:00Z');
        rows.keys = [
            { id: 'k1', agentId: 'a1', createdAt: created, expiresAt: null, scopes: ['mcp:read', 'admin:harness_ingest'], requiresTokenExchange: true },
            { id: 'k2', agentId: 'a1', createdAt: created, expiresAt: null, scopes: ['controls:read'], requiresTokenExchange: false },
            { id: 'k3', agentId: 'a1', createdAt: created, expiresAt: null, scopes: 'not an array', requiresTokenExchange: false },
        ];
        expect((await byId('a1')).apiKeys).toEqual([
            expect.objectContaining({ id: 'k1', mcpCapable: true, requiresTokenExchange: true }),
            expect.objectContaining({ id: 'k2', mcpCapable: false, requiresTokenExchange: false }),
            expect.objectContaining({ id: 'k3', mcpCapable: false, requiresTokenExchange: false }),
        ]);
    });
});
