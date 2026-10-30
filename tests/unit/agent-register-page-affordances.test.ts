/**
 * What the agent register and the agent page OFFER, per role (#4471).
 *
 * Both server pages hand their client a set of write affordances. They must be
 * exactly the writes the server takes from that viewer, and a write to the
 * register passes three gates: the edge (a built-in OWNER, ADMIN or AI_ADMIN
 * membership in this tenant), the route's `admin.agent_registry`, and the
 * usecase's agent-governance floor — the coarse tier OR the register key.
 *
 * The defect: the agent page asked the coarse `canWrite` / `canAdmin` instead
 * of that floor. The built-in AI admin sits on READER's coarse rung, so it
 * could register an agent and was then offered no Amend, no Activate,
 * Suspend or Retire, no risk scoring and no way to close a breaker — every one
 * of which the server accepts from it.
 *
 * Driven through the real page modules, with the usecases and the session
 * stubbed and the permission sets real (`makeRequestContext`).
 */
import * as React from 'react';
import type { Role } from '@prisma/client';

const getTenantCtxMock = jest.fn();
const authMock = jest.fn();
const listRegisteredAgentsMock = jest.fn();
const listVendorsMock = jest.fn();

jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
jest.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('NOT_FOUND');
    },
}));
jest.mock('@/auth', () => ({
    auth: (...a: unknown[]) => authMock(...a),
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/agent-registry', () => ({
    parseAgentListFilters: () => ({}),
    listRegisteredAgents: (...a: unknown[]) => listRegisteredAgentsMock(...a),
    listAgentKpiCounts: async () => ({ total: 0, active: 0, unscored: 0, egress: 0 }),
    getAgentGovernanceStatus: async () => ({
        enforcing: true,
        unboundCredentials: 0,
        unboundCredentialSamples: [],
        concurrency: { cap: null, inFlight: 0 },
    }),
    getAgenticAssuranceSignals: async () => null,
    getRegisteredAgent: async () => ({
        id: 'agent-1',
        name: 'Control reconciler',
        status: 'DRAFT',
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        riskTier: null,
        aiSystem: { riskTier: 'MINIMAL' },
        description: null,
        modelRef: null,
        ownerUserId: 'user-1',
        vendorId: null,
        registrationEnforced: true,
    }),
}));
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    countAgentProposalsAwaitingReview: async () => 0,
}));
jest.mock('@/app-layer/usecases/tenant-admin', () => ({
    listAssignableUsers: async () => [],
}));
jest.mock('@/app-layer/usecases/vendor', () => ({
    listVendors: (...a: unknown[]) => listVendorsMock(...a),
}));
jest.mock('@/app-layer/usecases/agent-profiles', () => ({
    agentProfilesOn: () => false,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/AgentsClient', () => ({
    AgentsClient: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient', () => ({
    AgentDetailClient: () => null,
}));

import AgentRegisterPage from '@/app/t/[tenantSlug]/(app)/agents/page';
import AgentDetailPage from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/page';
import { AgentsClient } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';
import { AgentDetailClient } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

interface RegisterProps {
    canWrite: boolean;
    canSetCapacity: boolean;
    canInvestigate: boolean;
    canListVendors: boolean;
    truncated: boolean;
    initialRows: unknown[];
}
interface DetailProps {
    perms: {
        canManageRegistry: boolean;
        canCloseBreaker: boolean;
        canReadKillHistory?: boolean;
    };
}

/** A session holding one membership in `acme`, with this built-in role. */
function signedInAs(membershipRole: string, ctx: RequestContext) {
    getTenantCtxMock.mockResolvedValue(ctx);
    authMock.mockResolvedValue({
        user: {
            role: membershipRole,
            memberships: [{ slug: 'acme', role: membershipRole, tenantId: 'tenant-1' }],
        },
    });
}

async function registerPage(): Promise<React.ReactElement> {
    return (await AgentRegisterPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
        searchParams: Promise.resolve({}),
    })) as React.ReactElement;
}

async function detailPage(): Promise<React.ReactElement> {
    return (await AgentDetailPage({
        params: Promise.resolve({ tenantSlug: 'acme', agentId: 'agent-1' }),
    })) as React.ReactElement;
}

async function registerProps(): Promise<RegisterProps> {
    const el = await registerPage();
    expect(el.type).toBe(AgentsClient);
    return el.props as RegisterProps;
}

async function detailPerms(): Promise<DetailProps['perms']> {
    const el = await detailPage();
    expect(el.type).toBe(AgentDetailClient);
    return (el.props as DetailProps).perms;
}

/** A custom role: `base`'s permission sets with the register key added. */
function customRoleWithRegisterKey(base: Role): RequestContext {
    const ctx = makeRequestContext(base);
    return {
        ...ctx,
        appPermissions: {
            ...ctx.appPermissions,
            admin: { ...ctx.appPermissions.admin, agent_registry: true },
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    listRegisteredAgentsMock.mockResolvedValue([]);
    listVendorsMock.mockResolvedValue([]);
});

describe('per built-in role', () => {
    it('AI admin: offered every register write the server takes from it', async () => {
        // Its coarse tier is READER's (`canWrite` and `canAdmin` false); the
        // agent-governance floor admits it on the register key.
        const ctx = makeRequestContext('AI_ADMIN');
        expect(ctx.permissions.canWrite).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
        signedInAs('AI_ADMIN', ctx);

        const perms = await detailPerms();
        expect(perms.canManageRegistry).toBe(true);
        expect(perms.canCloseBreaker).toBe(true);
        expect(perms.canReadKillHistory).toBe(true);

        const props = await registerProps();
        expect(props.canWrite).toBe(true);
        expect(props.canSetCapacity).toBe(true);
    });

    it('Admin: offered every register write', async () => {
        signedInAs('ADMIN', makeRequestContext('ADMIN'));

        const perms = await detailPerms();
        expect(perms.canManageRegistry).toBe(true);
        expect(perms.canCloseBreaker).toBe(true);

        const props = await registerProps();
        expect(props.canWrite).toBe(true);
        expect(props.canSetCapacity).toBe(true);
    });

    it('Reader: refused both pages, so offered nothing and nothing is read', async () => {
        signedInAs('READER', makeRequestContext('READER'));

        expect((await detailPage()).type).not.toBe(AgentDetailClient);
        expect((await registerPage()).type).not.toBe(AgentsClient);
        expect(listRegisteredAgentsMock).not.toHaveBeenCalled();
    });

    it('Auditor: reads both pages and is offered no write', async () => {
        signedInAs('AUDITOR', makeRequestContext('AUDITOR'));

        const perms = await detailPerms();
        expect(perms.canManageRegistry).toBe(false);
        expect(perms.canCloseBreaker).toBe(false);

        const props = await registerProps();
        expect(props.canWrite).toBe(false);
        expect(props.canSetCapacity).toBe(false);
    });
});

describe('custom roles, judged as the edge judges them', () => {
    it('the register key on an Editor membership: offered nothing, because the edge refuses every write', async () => {
        signedInAs('EDITOR', customRoleWithRegisterKey('EDITOR'));

        const props = await registerProps();
        expect(props.canWrite).toBe(false);
        expect(props.canSetCapacity).toBe(false);
        // The assurance views are pages gated on the key alone, not admin API
        // writes, so the menu still offers them.
        expect(props.canInvestigate).toBe(true);

        const perms = await detailPerms();
        expect(perms.canManageRegistry).toBe(false);
        expect(perms.canCloseBreaker).toBe(false);
    });

    it('the register key on a Reader-based custom role of an Admin membership: offered the writes', async () => {
        // The edge reads the MEMBERSHIP role (ADMIN, admitted); the coarse
        // tier is the custom role's base (READER); the floor admits the key.
        signedInAs('ADMIN', customRoleWithRegisterKey('READER'));

        const props = await registerProps();
        expect(props.canWrite).toBe(true);
        expect(props.canSetCapacity).toBe(true);

        const perms = await detailPerms();
        expect(perms.canManageRegistry).toBe(true);
        expect(perms.canCloseBreaker).toBe(true);
    });

    it('a role that may read the agent inventory but not vendors still gets the register', async () => {
        const ctx = makeRequestContext('ADMIN');
        signedInAs('ADMIN', {
            ...ctx,
            appPermissions: { ...ctx.appPermissions, vendors: { ...ctx.appPermissions.vendors, view: false } },
        });
        // The real usecase refuses this role; the page must not depend on it.
        listVendorsMock.mockRejectedValue(new Error('No read access'));

        const props = await registerProps();
        expect(listVendorsMock).not.toHaveBeenCalled();
        expect(props.canListVendors).toBe(false);
    });
});

describe('the 200-agent page', () => {
    const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));

    it('reads one past the page and reports a longer register as truncated', async () => {
        signedInAs('ADMIN', makeRequestContext('ADMIN'));
        listRegisteredAgentsMock.mockResolvedValue(agents(201));

        const props = await registerProps();
        expect(listRegisteredAgentsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ take: 201 }));
        expect(props.initialRows).toHaveLength(200);
        expect(props.truncated).toBe(true);
    });

    it('a register that fits is not truncated', async () => {
        signedInAs('ADMIN', makeRequestContext('ADMIN'));
        listRegisteredAgentsMock.mockResolvedValue(agents(200));

        const props = await registerProps();
        expect(props.initialRows).toHaveLength(200);
        expect(props.truncated).toBe(false);
    });
});
