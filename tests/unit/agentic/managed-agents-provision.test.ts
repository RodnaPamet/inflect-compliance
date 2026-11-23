/**
 * PROVISIONING ON APPROVAL (Step 5b of `docs/claude-managed-agents-design.md`,
 * #4165): `provisionApprovedProfileVersion`, which `approveAgentProfileVersion`
 * calls once its transaction has committed.
 *
 *   • Where the engine is NOT in force it provisions NOTHING. Proved with the
 *     tenant's stored engine at MANAGED_AGENTS and the engine's own switch
 *     off, through the real pure resolver: no client is constructed and no
 *     row is written. (Until Step 5d the build flag refused every tenant.)
 *   • When the engine IS in force (the resolver stubbed to say so), it
 *     provisions over the faux workspace, and the version's instructions are
 *     not even read: the version query does not select them.
 */
jest.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }));

jest.mock('@anthropic-ai/sdk', () => {
    const actual = jest.requireActual('@anthropic-ai/sdk');
    const Ctor = jest.fn((opts: unknown) => new actual.default(opts));
    return { __esModule: true, ...actual, default: Ctor };
});

const mockGate = { inForce: false };
jest.mock('@/lib/agentic/agent-driver-policy', () => ({
    resolveDriverForTenant: jest.fn(async () => {
        if (mockGate.inForce) return { driver: 'managed-agents', reason: null };
        const { resolveAgentDriver } = jest.requireActual('@/lib/agentic/agent-driver') as typeof import('@/lib/agentic/agent-driver');
        return resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, managedAgentsEnvEnabled: false, tenantSetting: 'MANAGED_AGENTS' });
    }),
}));

const versionQueries: unknown[] = [];
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            tenantSecuritySettings: { findUnique: async () => ({ aiResidency: 'EXTERNAL', aiLocalBaseUrl: null, aiLocalModel: null }) },
            agentProfileVersion: {
                findFirst: async (q: unknown) => {
                    versionQueries.push(q);
                    return { id: 'pv-1', profileId: 'profile-1', status: 'APPROVED', toolNames: ['list_risks'], skillRefs: [], modelTier: 'deep' };
                },
            },
        }),
    ),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));

const provisions: Array<Record<string, unknown>> = [];
jest.mock('@/lib/agentic/managed-agents/store', () => ({
    readWorkspaceConnection: jest.fn(async () => ({
        ok: true,
        connection: { connectionId: 'conn-1', workspaceId: 'wrkspc_faux', keepSessions: false, apiKey: 'sk-ant-faux' }, // pragma: allowlist secret
    })),
    readProvision: jest.fn(async () => null),
    readProfileAgent: jest.fn(async () => null),
    readConnectionEnvironment: jest.fn(async () => null),
    recordProvision: jest.fn(async (_ctx: unknown, r: Record<string, unknown>) => {
        provisions.push(r);
    }),
}));

import type { RequestContext } from '@/app-layer/types';
import { provisionApprovedProfileVersion } from '@/app-layer/usecases/agent-profile-provision';
import { logEvent } from '@/app-layer/events/audit';
import { MANAGED_AGENTS_PREAMBLE, systemHashOf } from '@/lib/agentic/managed-agents/definition';
import { ManagedAgentsFaux } from '../../helpers/managed-agents-faux';

const sdk = jest.requireMock('@anthropic-ai/sdk') as { default: jest.Mock };
const ctx = { requestId: 'r', userId: 'u', tenantId: 't1', tenantSlug: 't1', role: 'ADMIN' } as unknown as RequestContext;
let faux: ManagedAgentsFaux;

beforeEach(() => {
    sdk.default.mockClear();
    provisions.length = 0;
    versionQueries.length = 0;
    mockGate.inForce = false;
    faux = new ManagedAgentsFaux();
    faux.install();
});

afterEach(() => faux.uninstall());

describe('provisionApprovedProfileVersion', () => {
    it('provisions nothing where the engine is not in force: a stored MANAGED_AGENTS with its switch off', async () => {
        await expect(provisionApprovedProfileVersion(ctx, 'pv-1')).resolves.toEqual({ provisioned: false, reason: 'ENGINE_NOT_IN_FORCE' });
        expect(sdk.default).not.toHaveBeenCalled();
        expect(faux.requests).toEqual([]);
        expect(provisions).toEqual([]);
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('when the engine is in force, provisions the version with Inflect\'s preamble, without reading its instructions', async () => {
        mockGate.inForce = true;
        await expect(provisionApprovedProfileVersion(ctx, 'pv-1')).resolves.toEqual({ provisioned: true, created: true });
        expect(faux.agentWrites).toHaveLength(1);
        expect(faux.agentWrites[0].body.system).toBe(MANAGED_AGENTS_PREAMBLE);
        expect(faux.agentWrites[0].body.model).toBe('claude-opus-5-5');
        expect(faux.environments).toHaveLength(1);
        expect(provisions).toEqual([expect.objectContaining({ profileVersionId: 'pv-1', connectionId: 'conn-1', systemHash: systemHashOf(MANAGED_AGENTS_PREAMBLE) })]);
        // The version read selects no instructions: they cannot reach the agent.
        expect(JSON.stringify(versionQueries)).not.toMatch(/instructions/);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('never throws into the approval: a provider error is an outcome', async () => {
        mockGate.inForce = true;
        global.fetch = (async () => new Response('{"type":"error","error":{"type":"invalid_request_error"}}', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        await expect(provisionApprovedProfileVersion(ctx, 'pv-1')).resolves.toEqual({ provisioned: false, reason: 'PROVIDER_ERROR' });
        expect(provisions).toEqual([]);
    });
});
