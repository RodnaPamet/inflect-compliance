/**
 * The organization's agent switches (#4557), proved on real rows.
 *
 *   - THE SETTER: `PUT /api/org/:slug/agent-switches` through its real handler.
 *     An ORG_READER is refused with one `ORG_AUTHZ_DENIED` row and nothing
 *     written; an ORG_ADMIN's change writes the column and one
 *     `ORG_AGENT_SWITCHES_CHANGED` row naming the before and after of each
 *     switch that moved, and a PUT that moves nothing writes no row.
 *   - THE EFFECT: with the deployment's variables unset, the run path's own
 *     resolver (`resolveDriverForTenant`) and the profile gate's reader
 *     (`agentProfilesOnFor`) follow the organization's choice, for every
 *     workspace under it and for no other: a second organization's workspace
 *     and a workspace with no organization are unmoved.
 *   - THE VETO: `0` turns the switch off for a workspace whose organization
 *     turned it on, and `1` turns it on for a workspace with no organization.
 *
 * Only `getOrgCtx` is mocked — it needs a browser session. The permission
 * middleware, the usecase, the org audit writer and the resolvers are real.
 */
const mockGetOrgCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a),
}));

const envOverride: Record<string, string | undefined> = {};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) =>
                typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key),
        }),
    };
});

import { PrismaClient, type OrgRole } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { getOrgPermissions } from '@/lib/permissions';
import { GET, PUT } from '@/app/api/org/[orgSlug]/agent-switches/route';
import { agentProfilesOnFor, toolRunnerDecisionFor } from '@/lib/agentic/agent-switches-policy';
import { getOrgAgentSwitches, setOrgAgentSwitches } from '@/app-layer/usecases/org-agent-switches';
import { resolveDriverForTenant } from '@/lib/agentic/agent-driver-policy';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const ORG = `switches-org-${SUITE}`;
const OTHER_ORG = `switches-other-${SUITE}`;
const T = {
    chose: `switches-chose-${SUITE}`, // under ORG, its owner chose the Tool Runner
    sibling: `switches-sibling-${SUITE}`, // under ORG, left on the built-in engine
    other: `switches-other-t-${SUITE}`, // under OTHER_ORG, chose the Tool Runner
    alone: `switches-alone-${SUITE}`, // no organization, chose the Tool Runner
};
const TENANTS = Object.values(T);
const users: Record<'admin' | 'reader', string> = { admin: '', reader: '' };
const orgIds: Record<string, string> = {};

function ctxAs(who: 'admin' | 'reader'): OrgContext {
    const role: OrgRole = who === 'admin' ? 'ORG_ADMIN' : 'ORG_READER';
    return {
        requestId: `req-${who}`,
        userId: users[who],
        organizationId: orgIds[ORG],
        orgSlug: ORG,
        orgRole: role,
        permissions: getOrgPermissions(role),
    } as OrgContext;
}

const url = () => `http://localhost/api/org/${ORG}/agent-switches`;
const put = (body: unknown) =>
    new NextRequest(url(), {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const args = () => ({ params: Promise.resolve({ orgSlug: ORG }) });

const orgRows = (action: string) =>
    prisma.orgAuditLog.findMany({ where: { organizationId: orgIds[ORG], action: action as never }, orderBy: { occurredAt: 'asc' } });
const stored = () =>
    prisma.organization.findUniqueOrThrow({
        where: { id: orgIds[ORG] },
        select: { agentProfilesEnabled: true, agentToolRunnerEnabled: true },
    });

beforeAll(async () => {
    for (const slug of [ORG, OTHER_ORG]) {
        const org = await prisma.organization.create({ data: { name: slug, slug } });
        orgIds[slug] = org.id;
    }
    const parent: Record<string, string | null> = {
        [T.chose]: orgIds[ORG],
        [T.sibling]: orgIds[ORG],
        [T.other]: orgIds[OTHER_ORG],
        [T.alone]: null,
    };
    for (const t of TENANTS) {
        await prisma.tenant.create({ data: { id: t, name: t, slug: t, organizationId: parent[t] } });
    }
    // Each workspace's OWN half of the engine gate, as its owner would set it.
    for (const t of [T.chose, T.other, T.alone]) {
        await prisma.tenantSecuritySettings.create({ data: { tenantId: t, agentDriver: 'TOOL_RUNNER' } });
    }
    for (const who of ['admin', 'reader'] as const) {
        const email = `${who}@${ORG}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
        await prisma.orgMembership.create({
            data: { organizationId: orgIds[ORG], userId: user.id, role: who === 'admin' ? 'ORG_ADMIN' : 'ORG_READER' },
        });
    }
    // The deployment leaves both switches to organizations.
    envOverride.AGENT_DRIVER_TOOL_RUNNER = undefined;
    envOverride.AGENT_PROFILES = undefined;
    envOverride.AGENT_PROFILES_TENANTS = undefined;
    envOverride.AGENT_DRIVER_FLUE = undefined;
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await deleteAuditRowsForUsers(prisma, Object.values(users));
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    // The org chain is append-only by trigger; the sanctioned helper removes the
    // test's own rows with its organizations.
    await deleteOrgAuditRowsForOrganizations(prisma, Object.values(orgIds));
    await prisma.orgMembership.deleteMany({ where: { organizationId: { in: Object.values(orgIds) } } });
    await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgIds) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
});

describe('before any choice', () => {
    it('every workspace reads off, and says who holds the switch', async () => {
        expect(await toolRunnerDecisionFor({ tenantId: T.chose })).toEqual({ on: false, basis: 'ORGANIZATION_OFF' });
        expect(await toolRunnerDecisionFor({ tenantId: T.alone })).toEqual({ on: false, basis: 'NO_ORGANIZATION' });
        expect(await resolveDriverForTenant(T.chose)).toMatchObject({ driver: 'static', reason: 'ENV_DISABLED' });
        expect(await agentProfilesOnFor(T.chose)).toBe(false);
    });
});

describe('the setter, through the real route', () => {
    it('an ORG_READER is refused with one ORG_AUTHZ_DENIED row, and nothing is written', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('reader'));
        const res = await PUT(put({ toolRunner: true }), args());
        expect(res.status).toBe(403);
        expect(await orgRows('ORG_AUTHZ_DENIED')).toHaveLength(1);
        expect(await stored()).toEqual({ agentProfilesEnabled: false, agentToolRunnerEnabled: false });
        expect(await orgRows('ORG_AGENT_SWITCHES_CHANGED')).toHaveLength(0);
    });

    it('a body naming no switch, or a misspelt one, is a 400', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        expect((await PUT(put({}), args())).status).toBe(400);
        expect((await PUT(put({ toolrunner: true }), args())).status).toBe(400);
        expect(await stored()).toEqual({ agentProfilesEnabled: false, agentToolRunnerEnabled: false });
    });

    it('an ORG_ADMIN turns the Tool Runner on: the column, and one row with both values', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ toolRunner: true }), args());
        expect(res.status).toBe(200);
        expect((await res.json()).switches).toMatchObject({
            toolRunner: { organization: true, deployment: 'UNSET' },
            agentProfiles: { organization: false, deployment: 'UNSET' },
        });
        expect(await stored()).toEqual({ agentProfilesEnabled: false, agentToolRunnerEnabled: true });

        const rows = await orgRows('ORG_AGENT_SWITCHES_CHANGED');
        expect(rows).toHaveLength(1);
        expect(rows[0].actorUserId).toBe(users.admin);
        expect(rows[0].detailsJson).toEqual({
            changes: { toolRunner: { before: false, after: true } },
            deployment: { agentProfiles: 'UNSET', toolRunner: 'UNSET' },
        });
    });

    it('a PUT that moves nothing writes no row', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        expect((await PUT(put({ toolRunner: true }), args())).status).toBe(200);
        expect(await orgRows('ORG_AGENT_SWITCHES_CHANGED')).toHaveLength(1);
    });

    it('any member who can see the portfolio reads the switches, and is told whether they may change them', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('reader'));
        const res = await GET(new NextRequest(url()), args());
        expect(res.status).toBe(200);
        expect((await res.json()).switches).toMatchObject({ toolRunner: { organization: true }, canManage: false });
    });

    it('names the reach: the organization\'s own live workspaces, and no other\'s (#4850)', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('reader'));
        const res = await GET(new NextRequest(url()), args());
        // T.chose and T.sibling sit under this organization; T.other is
        // another organization's and T.alone belongs to none.
        expect((await res.json()).switches.workspaceCount).toBe(2);
    });
});

describe('the usecase holds its own gates, whoever calls it', () => {
    it('the read refuses a context that cannot see the portfolio', async () => {
        const ctx = { ...ctxAs('reader'), permissions: { ...ctxAs('reader').permissions, canViewPortfolio: false } };
        await expect(getOrgAgentSwitches(ctx)).rejects.toThrow(/access/i);
    });

    it('the write refuses a context without canManageAgentSwitches, and writes nothing', async () => {
        const before = await stored();
        await expect(setOrgAgentSwitches(ctxAs('reader'), { agentProfiles: !before.agentProfilesEnabled })).rejects.toThrow(
            /organization admin/,
        );
        expect(await stored()).toEqual(before);
    });
});

describe('the effect, through the resolvers the run path and the gate use', () => {
    it('the Tool Runner follows the organization for every workspace under it, and for no other', async () => {
        expect(await toolRunnerDecisionFor({ tenantId: T.chose })).toEqual({ on: true, basis: 'ORGANIZATION_ON' });
        // The run path: the workspace that chose the engine now runs on it.
        expect(await resolveDriverForTenant(T.chose)).toMatchObject({ driver: 'tool-runner' });
        // Its sibling may use it, but its owner has not chosen it, so it stays
        // on the built-in engine (the reason names Flue's switch, as it did
        // before organizations: a workspace that chose no engine is asked
        // about Flue).
        expect(await toolRunnerDecisionFor({ tenantId: T.sibling })).toEqual({ on: true, basis: 'ORGANIZATION_ON' });
        expect(await resolveDriverForTenant(T.sibling)).toMatchObject({ driver: 'static' });
        // Another organization's workspace, and one with none, are unmoved.
        expect(await toolRunnerDecisionFor({ tenantId: T.other })).toEqual({ on: false, basis: 'ORGANIZATION_OFF' });
        expect(await resolveDriverForTenant(T.other)).toMatchObject({ driver: 'static', reason: 'ENV_DISABLED' });
        expect(await resolveDriverForTenant(T.alone)).toMatchObject({ driver: 'static', reason: 'ENV_DISABLED' });
    });

    it('profiles follow the organization by the workspace\'s own slug, and for no other', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        expect((await PUT(put({ agentProfiles: true }), args())).status).toBe(200);
        expect(await agentProfilesOnFor(T.chose)).toBe(true);
        expect(await agentProfilesOnFor(T.sibling)).toBe(true);
        expect(await agentProfilesOnFor(T.other)).toBe(false);
        expect(await agentProfilesOnFor(T.alone)).toBe(false);
        expect(await agentProfilesOnFor('no-such-workspace')).toBe(false);
    });
});

describe('the deployment can veto', () => {
    afterEach(() => {
        envOverride.AGENT_DRIVER_TOOL_RUNNER = undefined;
        envOverride.AGENT_PROFILES = undefined;
    });

    it('0 turns both off for a workspace whose organization turned them on', async () => {
        envOverride.AGENT_DRIVER_TOOL_RUNNER = '0';
        envOverride.AGENT_PROFILES = '0';
        expect(await toolRunnerDecisionFor({ tenantId: T.chose })).toEqual({ on: false, basis: 'DEPLOYMENT_OFF' });
        expect(await resolveDriverForTenant(T.chose)).toMatchObject({ driver: 'static', reason: 'ENV_DISABLED' });
        expect(await agentProfilesOnFor(T.chose)).toBe(false);
    });

    it('1 turns the Tool Runner on for a workspace with no organization', async () => {
        envOverride.AGENT_DRIVER_TOOL_RUNNER = '1';
        expect(await toolRunnerDecisionFor({ tenantId: T.alone })).toEqual({ on: true, basis: 'DEPLOYMENT_ON' });
        expect(await resolveDriverForTenant(T.alone)).toMatchObject({ driver: 'tool-runner' });
    });

    it('a choice made while the deployment overrides it is stored, and applies once the variable is unset', async () => {
        envOverride.AGENT_DRIVER_TOOL_RUNNER = '0';
        mockGetOrgCtx.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ toolRunner: false }), args());
        expect((await res.json()).switches.toolRunner).toEqual({ organization: false, deployment: 'OFF' });
        const rows = await orgRows('ORG_AGENT_SWITCHES_CHANGED');
        expect(rows.at(-1)!.detailsJson).toMatchObject({ deployment: { toolRunner: 'OFF' } });

        envOverride.AGENT_DRIVER_TOOL_RUNNER = undefined;
        expect(await toolRunnerDecisionFor({ tenantId: T.chose })).toEqual({ on: false, basis: 'ORGANIZATION_OFF' });
    });
});
