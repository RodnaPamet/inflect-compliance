/**
 * WHICH WORKSPACE A MANAGED AGENTS RUN USES (Step 6b of
 * `docs/claude-managed-agents-design.md`, shape MA-C1), asserted on the
 * factory and the one resolution function, not on a setting.
 *
 * ═══ THE MODULE SEAM ═══
 *
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is a source literal that stays `false` until
 * Step 6c. To prove the `true` branch, this file replaces the leaf module
 * that declares it (`jest.mock` of `managed-agents/hosted-activation`) with a
 * getter. Production cannot reach that seam: `jest.mock` exists only in the
 * test runner, and `tests/guards/hosted-managed-agents-activation.test.ts`
 * holds that nothing in `src/` writes the constant. The FIRST describe reads
 * the getter through to the real module's value, so it asserts the shipped
 * state, and asserts that value is `false`.
 *
 * ═══ WHAT IS FAKED ═══
 *
 * The environment (a Proxy that RECORDS which variables were read), the
 * engine's store (the tenant's own connection), the tenant's settings row and
 * the plan entitlement.
 */
const mockActivation = { active: false };
jest.mock('@/lib/agentic/managed-agents/hosted-activation', () => ({
    get HOSTED_MANAGED_AGENTS_ACTIVE() {
        return mockActivation.active;
    },
}));

const mockEnvValues: Record<string, string | undefined> = {};
const mockEnvReads: string[] = [];
jest.mock('@/env', () => ({
    env: new Proxy(
        {},
        {
            get: (_t, key) => {
                if (typeof key !== 'string') return undefined;
                mockEnvReads.push(key);
                return mockEnvValues[key];
            },
        },
    ),
}));

const mockStore = {
    own: { ok: false, reason: 'NO_CONNECTION' } as
        | { ok: true; connection: Record<string, unknown> }
        | { ok: false; reason: 'NO_CONNECTION' | 'AMBIGUOUS_CONNECTION' | 'CONNECTION_UNREADABLE' },
    ownState: 'NONE' as 'CONNECTED' | 'NONE' | 'AMBIGUOUS',
};
jest.mock('@/lib/agentic/managed-agents/store', () => ({
    readWorkspaceConnection: jest.fn(async () => mockStore.own),
    readWorkspaceConnectionState: jest.fn(async () => mockStore.ownState),
}));

const mockSettings = { row: null as null | { aiResidency: 'EXTERNAL' | 'LOCAL_ONLY'; hostedManagedAgentsOptIn: boolean } };
const mockSettingsReads = { count: 0 };
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            tenantSecuritySettings: {
                findUnique: jest.fn(async () => {
                    mockSettingsReads.count += 1;
                    return mockSettings.row;
                }),
            },
        }),
    ),
}));

const mockEntitled = { value: true };
jest.mock('@/lib/billing/entitlements', () => ({
    ...jest.requireActual('@/lib/billing/entitlements'),
    isEntitledTo: jest.fn(async () => mockEntitled.value),
}));

import {
    INFLECT_HOSTED_CONNECTION_ID,
    hostedTermsRefusal,
    inflectHostedWorkspace,
    readManagedAgentsWorkspaceState,
    resolveManagedAgentsWorkspace,
} from '@/lib/agentic/managed-agents/workspace';
import { planIncludes, type Plan } from '@/lib/billing/entitlements';
import { makeRequestContext } from '../../helpers/make-context';

const HOSTED_KEY = 'sk-ant-inflect-hosted-key-for-tests'; // pragma: allowlist secret -- a placeholder
const HOSTED_WORKSPACE = 'wrkspc_inflect_hosted';
const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-a', tenantSlug: 'acme' });

function configureDeployment(on: boolean): void {
    mockEnvValues.AGENT_MANAGED_AGENTS_HOSTED_API_KEY = on ? HOSTED_KEY : undefined;
    mockEnvValues.AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID = on ? HOSTED_WORKSPACE : undefined;
}

beforeEach(() => {
    mockEnvReads.length = 0;
    mockSettingsReads.count = 0;
    mockStore.own = { ok: false, reason: 'NO_CONNECTION' };
    mockStore.ownState = 'NONE';
    mockSettings.row = { aiResidency: 'EXTERNAL', hostedManagedAgentsOptIn: true };
    mockEntitled.value = true;
    configureDeployment(true);
});

describe('with the constant at its shipped value, nothing resolves the hosted workspace', () => {
    beforeEach(() => {
        mockActivation.active = (
            jest.requireActual('@/lib/agentic/managed-agents/hosted-activation') as { HOSTED_MANAGED_AGENTS_ACTIVE: boolean }
        ).HOSTED_MANAGED_AGENTS_ACTIVE;
    });

    it('the shipped value is false', () => {
        expect(mockActivation.active).toBe(false);
    });

    it('the factory refuses HOSTED_NOT_ACTIVE and reads neither deployment variable', () => {
        expect(inflectHostedWorkspace()).toEqual({ ok: false, reason: 'HOSTED_NOT_ACTIVE' });
        expect(mockEnvReads).toEqual([]);
    });

    // Every combination of every other term, the deployment configured
    // included: none of them reaches Inflect's key.
    const combos: Array<[boolean, boolean, 'EXTERNAL' | 'LOCAL_ONLY', boolean]> = [];
    for (const configured of [true, false])
        for (const optedIn of [true, false])
            for (const residency of ['EXTERNAL', 'LOCAL_ONLY'] as const)
                for (const entitled of [true, false]) combos.push([configured, optedIn, residency, entitled]);

    it.each(combos)(
        'configured=%s optedIn=%s residency=%s entitled=%s: the resolution refuses HOSTED_NOT_ACTIVE, before the key or the tenant terms are read',
        async (configured, optedIn, residency, entitled) => {
            configureDeployment(configured);
            mockSettings.row = { aiResidency: residency, hostedManagedAgentsOptIn: optedIn };
            mockEntitled.value = entitled;

            const resolved = await resolveManagedAgentsWorkspace(ctx);
            expect(resolved).toEqual({ ok: false, reason: 'HOSTED_NOT_ACTIVE' });
            expect(JSON.stringify(resolved)).not.toContain(HOSTED_KEY);
            expect(mockEnvReads).toEqual([]);
            expect(mockSettingsReads.count).toBe(0);

            const state = await readManagedAgentsWorkspaceState(ctx);
            expect(state).toEqual({ state: 'NONE', hostedRefusal: 'HOSTED_NOT_ACTIVE' });
            expect(mockEnvReads).toEqual([]);
        },
    );

    it('the tenant\'s own workspace still wins, unchanged', async () => {
        mockStore.own = { ok: true, connection: { connectionId: 'conn-1', workspaceId: 'wrkspc_own', keepSessions: true, apiKey: 'own-key' } };
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({
            ok: true,
            workspace: { kind: 'TENANT', connectionId: 'conn-1', workspaceId: 'wrkspc_own', keepSessions: true, apiKey: 'own-key' },
        });
        expect(mockEnvReads).toEqual([]);
    });
});

describe('with the constant true (module seam): the resolution matrix', () => {
    beforeEach(() => {
        mockActivation.active = true;
    });

    it('every term holding resolves Inflect\'s workspace, under its fixed id, never keeping sessions', async () => {
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({
            ok: true,
            workspace: {
                kind: 'HOSTED',
                connectionId: INFLECT_HOSTED_CONNECTION_ID,
                workspaceId: HOSTED_WORKSPACE,
                keepSessions: false,
                apiKey: HOSTED_KEY,
            },
        });
        expect(await readManagedAgentsWorkspaceState(ctx)).toEqual({ state: 'HOSTED', hostedRefusal: null });
    });

    it('own connection: the tenant\'s own workspace wins over a full opt-in', async () => {
        mockStore.own = { ok: true, connection: { connectionId: 'conn-1', workspaceId: 'wrkspc_own', keepSessions: false, apiKey: 'own-key' } };
        mockStore.ownState = 'CONNECTED';
        const resolved = await resolveManagedAgentsWorkspace(ctx);
        expect(resolved).toMatchObject({ ok: true, workspace: { kind: 'TENANT', connectionId: 'conn-1' } });
        expect(JSON.stringify(resolved)).not.toContain(HOSTED_KEY);
        expect(mockEnvReads).toEqual([]);
        expect(await readManagedAgentsWorkspaceState(ctx)).toEqual({ state: 'CONNECTED', hostedRefusal: null });
    });

    it.each(['AMBIGUOUS_CONNECTION', 'CONNECTION_UNREADABLE'] as const)(
        'own connection %s: refused by name, never a fall-back to Inflect\'s workspace',
        async (reason) => {
            mockStore.own = { ok: false, reason };
            expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason });
            expect(mockEnvReads).toEqual([]);
        },
    );

    it('deployment not configured: HOSTED_NOT_CONFIGURED', async () => {
        configureDeployment(false);
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_NOT_CONFIGURED' });
        expect(inflectHostedWorkspace()).toEqual({ ok: false, reason: 'HOSTED_NOT_CONFIGURED' });
        mockEnvValues.AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID = HOSTED_WORKSPACE;
        expect(inflectHostedWorkspace()).toEqual({ ok: false, reason: 'HOSTED_NOT_CONFIGURED' });
    });

    it('no opt-in: HOSTED_NOT_OPTED_IN (an absent settings row is not an opt-in)', async () => {
        mockSettings.row = { aiResidency: 'EXTERNAL', hostedManagedAgentsOptIn: false };
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_NOT_OPTED_IN' });
        mockSettings.row = null;
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_NOT_OPTED_IN' });
    });

    it('residency LOCAL_ONLY: HOSTED_LOCAL_ONLY, opted in or not entitled', async () => {
        mockSettings.row = { aiResidency: 'LOCAL_ONLY', hostedManagedAgentsOptIn: true };
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_LOCAL_ONLY' });
        mockEntitled.value = false;
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_LOCAL_ONLY' });
    });

    it('plan not entitled: HOSTED_NOT_ENTITLED', async () => {
        mockEntitled.value = false;
        expect(await resolveManagedAgentsWorkspace(ctx)).toEqual({ ok: false, reason: 'HOSTED_NOT_ENTITLED' });
        expect(await readManagedAgentsWorkspaceState(ctx)).toEqual({ state: 'NONE', hostedRefusal: 'HOSTED_NOT_ENTITLED' });
    });

    it('the order of the tenant terms is fixed: opt-in, then residency, then entitlement', () => {
        expect(hostedTermsRefusal({ optedIn: false, residency: 'LOCAL_ONLY', entitled: false })).toBe('HOSTED_NOT_OPTED_IN');
        expect(hostedTermsRefusal({ optedIn: true, residency: 'LOCAL_ONLY', entitled: false })).toBe('HOSTED_LOCAL_ONLY');
        expect(hostedTermsRefusal({ optedIn: true, residency: 'EXTERNAL', entitled: false })).toBe('HOSTED_NOT_ENTITLED');
        expect(hostedTermsRefusal({ optedIn: true, residency: 'EXTERNAL', entitled: true })).toBeNull();
    });
});

describe('the hosting entitlement refuses by default', () => {
    it.each(['FREE', 'TRIAL', 'PRO', 'ENTERPRISE'] as Plan[])('%s does not include hosted Managed Agents', (plan) => {
        expect(planIncludes(plan, 'hostedManagedAgents')).toBe(false);
    });
});
