/**
 * The org-level turn caps (#4594, owner decision 3 of 2026-11-13), proved on
 * real rows.
 *
 *   - THE ORG SETTER: `PUT /api/org/:slug/agent-turn-caps` through its real
 *     handler. An ORG_READER is refused with one `ORG_AUTHZ_DENIED` row and
 *     nothing written; a value outside the CHECKs' ranges, an unknown key and
 *     an empty body are 400s; an ORG_ADMIN's change writes the columns and one
 *     `ORG_AGENT_TURN_CAPS_CHANGED` row with the before and after of each cap
 *     that moved, and a PUT that moves nothing writes no row.
 *   - THE CHECKS: the database refuses an out-of-range value from a writer that
 *     bypasses the schema and the usecase, and admits a NULL workspace value.
 *   - THE WORKSPACE NARROWING: `PUT admin/security-settings` refuses a value
 *     above the organization's current ceiling with
 *     `TURN_CAP_ABOVE_ORGANIZATION_CEILING` and the ceiling in `details`,
 *     accepts one at or below it with its own audit row, and `null` follows the
 *     organization again.
 *   - THE EFFECT, through `readTurnCaps` (the one reader both engines use): the
 *     lower of the two applies, a lowered ceiling narrows a stored value
 *     without rewriting it, and it applies again when the ceiling is raised.
 *   - ISOLATION: another organization's workspace, and a workspace with no
 *     organization, are unmoved by either organization's change; another
 *     workspace of the same organization is unmoved by a workspace's narrowing.
 *
 * Only `getOrgCtx` and `getTenantCtx` are mocked — both need a browser session.
 * The permission middlewares, the usecases, both audit writers, RLS and the
 * reader are real.
 */
const mockGetOrgCtx = jest.fn();
const mockGetTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a),
    getTenantCtx: (...a: unknown[]) => mockGetTenantCtx(...a),
}));

import { PrismaClient, type OrgRole } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { getOrgPermissions } from '@/lib/permissions';
import { GET, PUT } from '@/app/api/org/[orgSlug]/agent-turn-caps/route';
import { PUT as putSecuritySettings } from '@/app/api/t/[tenantSlug]/admin/security-settings/route';
import { getOrgAgentTurnCaps, setOrgAgentTurnCaps } from '@/app-layer/usecases/org-agent-turn-caps';
import { readTurnCaps } from '@/lib/agentic/turn-caps-policy';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const ORG = `turncaps-org-${SUITE}`;
const OTHER_ORG = `turncaps-other-${SUITE}`;
const T = {
    a: `turncaps-a-${SUITE}`, // under ORG, its owner narrows
    b: `turncaps-b-${SUITE}`, // under ORG, never narrows
    other: `turncaps-other-t-${SUITE}`, // under OTHER_ORG
    alone: `turncaps-alone-${SUITE}`, // no organization
};
const TENANTS = Object.values(T);
const users: Record<'admin' | 'reader' | 'owner', string> = { admin: '', reader: '', owner: '' };
const orgIds: Record<string, string> = {};

function orgCtxAs(who: 'admin' | 'reader', slug = ORG): OrgContext {
    const role: OrgRole = who === 'admin' ? 'ORG_ADMIN' : 'ORG_READER';
    return {
        requestId: `req-${who}`,
        userId: users[who],
        organizationId: orgIds[slug],
        orgSlug: slug,
        orgRole: role,
        permissions: getOrgPermissions(role),
    } as OrgContext;
}
const ownerCtx = () => makeRequestContext('OWNER', { tenantId: T.a, tenantSlug: T.a, userId: users.owner });

const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const orgUrl = (slug = ORG) => `http://localhost/api/org/${slug}/agent-turn-caps`;
const orgArgs = (slug = ORG) => ({ params: Promise.resolve({ orgSlug: slug }) });
const putOrg = (body: unknown, slug = ORG) => PUT(jsonReq(orgUrl(slug), 'PUT', body), orgArgs(slug));
const putWorkspace = (body: unknown) =>
    putSecuritySettings(
        jsonReq(`http://localhost/api/t/${T.a}/admin/security-settings`, 'PUT', body),
        { params: Promise.resolve({ tenantSlug: T.a }) },
    );

const orgRows = (action: string, slug = ORG) =>
    prisma.orgAuditLog.findMany({ where: { organizationId: orgIds[slug], action: action as never }, orderBy: { occurredAt: 'asc' } });
const stored = (slug = ORG) =>
    prisma.organization.findUniqueOrThrow({
        where: { id: orgIds[slug] },
        select: { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true },
    });
const storedWorkspace = async (tenantId = T.a) =>
    prisma.tenantSecuritySettings.findUnique({
        where: { tenantId },
        select: { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true },
    });
const applies = async (tenantId: string) => {
    const caps = await readTurnCaps(tenantId, 'req-read');
    return {
        delegations: caps.delegationsPerTurn.value,
        toolCalls: caps.toolCallsPerTurn.value,
        delegationsBasis: caps.delegationsPerTurn.basis,
        toolCallsBasis: caps.toolCallsPerTurn.basis,
    };
};

beforeAll(async () => {
    for (const slug of [ORG, OTHER_ORG]) {
        const org = await prisma.organization.create({ data: { name: slug, slug } });
        orgIds[slug] = org.id;
    }
    const parent: Record<string, string | null> = {
        [T.a]: orgIds[ORG],
        [T.b]: orgIds[ORG],
        [T.other]: orgIds[OTHER_ORG],
        [T.alone]: null,
    };
    for (const t of TENANTS) {
        await prisma.tenant.create({ data: { id: t, name: t, slug: t, organizationId: parent[t] } });
    }
    for (const who of ['admin', 'reader', 'owner'] as const) {
        const email = `${who}@${ORG}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
    }
    for (const who of ['admin', 'reader'] as const) {
        await prisma.orgMembership.create({
            data: { organizationId: orgIds[ORG], userId: users[who], role: who === 'admin' ? 'ORG_ADMIN' : 'ORG_READER' },
        });
    }
    await prisma.tenantMembership.create({ data: { tenantId: T.a, userId: users.owner, role: 'OWNER', status: 'ACTIVE' } });
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await deleteAuditRowsForUsers(prisma, Object.values(users));
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: TENANTS } } });
    // The last-OWNER trigger refuses the delete; the suite's own rows go with
    // it suspended, as the rotation-age suite removes its owners.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await deleteOrgAuditRowsForOrganizations(prisma, Object.values(orgIds));
    await prisma.orgMembership.deleteMany({ where: { organizationId: { in: Object.values(orgIds) } } });
    await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgIds) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
});

describe('before any change, nothing moved', () => {
    it('every organization holds today\'s behaviour: 3 delegations and 1 tool call', async () => {
        expect(await stored()).toEqual({ agentMaxSubagentsPerTurn: 3, agentMaxToolCallsPerTurn: 1 });
        expect(await applies(T.a)).toEqual({
            delegations: 3, toolCalls: 1, delegationsBasis: 'ORGANIZATION_CEILING', toolCallsBasis: 'ORGANIZATION_CEILING',
        });
        expect(await applies(T.alone)).toEqual({
            delegations: 3, toolCalls: 1, delegationsBasis: 'NO_ORGANIZATION', toolCallsBasis: 'NO_ORGANIZATION',
        });
    });
});

describe('the org setter, through the real route', () => {
    it('an ORG_READER is refused with one ORG_AUTHZ_DENIED row, and nothing is written', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('reader'));
        const res = await putOrg({ toolCallsPerTurn: 3 });
        expect(res.status).toBe(403);
        expect(await orgRows('ORG_AUTHZ_DENIED')).toHaveLength(1);
        expect(await stored()).toEqual({ agentMaxSubagentsPerTurn: 3, agentMaxToolCallsPerTurn: 1 });
        expect(await orgRows('ORG_AGENT_TURN_CAPS_CHANGED')).toHaveLength(0);
    });

    it.each([
        ['an empty body', {}],
        ['an unknown key', { toolcallsPerTurn: 2 }],
        ['tool calls at 0', { toolCallsPerTurn: 0 }],
        ['tool calls above 10', { toolCallsPerTurn: 11 }],
        ['delegations below 0', { delegationsPerTurn: -1 }],
        ['delegations above 10', { delegationsPerTurn: 11 }],
        ['a fraction', { delegationsPerTurn: 1.5 }],
    ])('%s is a 400, and nothing is written', async (_what, body) => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('admin'));
        expect((await putOrg(body)).status).toBe(400);
        expect(await stored()).toEqual({ agentMaxSubagentsPerTurn: 3, agentMaxToolCallsPerTurn: 1 });
    });

    it('an ORG_ADMIN sets both: the columns, and one row with the before and after of each', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('admin'));
        const res = await putOrg({ delegationsPerTurn: 2, toolCallsPerTurn: 3 });
        expect(res.status).toBe(200);
        expect((await res.json()).turnCaps).toEqual({
            delegationsPerTurn: 2, toolCallsPerTurn: 3, canManage: true, workspaceCount: 2,
        });
        expect(await stored()).toEqual({ agentMaxSubagentsPerTurn: 2, agentMaxToolCallsPerTurn: 3 });

        const rows = await orgRows('ORG_AGENT_TURN_CAPS_CHANGED');
        expect(rows).toHaveLength(1);
        expect(rows[0].actorUserId).toBe(users.admin);
        expect(rows[0].detailsJson).toEqual({
            changes: {
                delegationsPerTurn: { before: 3, after: 2 },
                toolCallsPerTurn: { before: 1, after: 3 },
            },
        });
    });

    it('a PUT that moves nothing writes no row; one that moves one cap names only that cap', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('admin'));
        expect((await putOrg({ delegationsPerTurn: 2, toolCallsPerTurn: 3 })).status).toBe(200);
        expect(await orgRows('ORG_AGENT_TURN_CAPS_CHANGED')).toHaveLength(1);
        expect((await putOrg({ delegationsPerTurn: 2, toolCallsPerTurn: 4 })).status).toBe(200);
        const rows = await orgRows('ORG_AGENT_TURN_CAPS_CHANGED');
        expect(rows).toHaveLength(2);
        expect(rows[1].detailsJson).toEqual({ changes: { toolCallsPerTurn: { before: 3, after: 4 } } });
        // Back to 3 for the cases below.
        expect((await putOrg({ toolCallsPerTurn: 3 })).status).toBe(200);
    });

    it('any member who can see the portfolio reads them, and is told whether they may change them', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('reader'));
        const res = await GET(new NextRequest(orgUrl()), orgArgs());
        expect(res.status).toBe(200);
        expect((await res.json()).turnCaps).toEqual({
            delegationsPerTurn: 2, toolCallsPerTurn: 3, canManage: false, workspaceCount: 2,
        });
    });
});

describe('the usecase holds its own gates, whoever calls it', () => {
    it('the read refuses a context that cannot see the portfolio', async () => {
        const ctx = { ...orgCtxAs('reader'), permissions: { ...orgCtxAs('reader').permissions, canViewPortfolio: false } };
        await expect(getOrgAgentTurnCaps(ctx)).rejects.toThrow(/access/i);
    });

    it('the write refuses a context without canManageAgentSwitches, and a value out of range, and writes nothing', async () => {
        const before = await stored();
        await expect(setOrgAgentTurnCaps(orgCtxAs('reader'), { toolCallsPerTurn: 5 })).rejects.toThrow(/organization admin/);
        await expect(setOrgAgentTurnCaps(orgCtxAs('admin'), { toolCallsPerTurn: 0 })).rejects.toThrow(/from 1 to 10/);
        await expect(setOrgAgentTurnCaps(orgCtxAs('admin'), { delegationsPerTurn: 11 })).rejects.toThrow(/from 0 to 10/);
        expect(await stored()).toEqual(before);
    });
});

describe('the CHECKs refuse what no product path can write', () => {
    it.each([
        ['an organization at 0 tool calls', () => prisma.organization.update({ where: { id: orgIds[OTHER_ORG] }, data: { agentMaxToolCallsPerTurn: 0 } })],
        ['an organization at 11 delegations', () => prisma.organization.update({ where: { id: orgIds[OTHER_ORG] }, data: { agentMaxSubagentsPerTurn: 11 } })],
        ['a workspace at 11 tool calls', () => prisma.tenantSecuritySettings.create({ data: { tenantId: T.alone, agentMaxToolCallsPerTurn: 11 } })],
        ['a workspace at -1 delegations', () => prisma.tenantSecuritySettings.create({ data: { tenantId: T.alone, agentMaxSubagentsPerTurn: -1 } })],
    ])('%s', async (_what, write) => {
        await expect(write()).rejects.toThrow();
    });

    it('a workspace row with neither narrowing stores NULL for both: it follows the organization', async () => {
        await prisma.tenantSecuritySettings.create({ data: { tenantId: T.alone } });
        expect(await storedWorkspace(T.alone)).toEqual({ agentMaxSubagentsPerTurn: null, agentMaxToolCallsPerTurn: null });
        await prisma.tenantSecuritySettings.delete({ where: { tenantId: T.alone } });
    });
});

describe('the effect, through the one reader both engines use', () => {
    it('the organization\'s ceiling reaches every workspace under it, and no other', async () => {
        expect(await applies(T.a)).toMatchObject({ delegations: 2, toolCalls: 3 });
        expect(await applies(T.b)).toMatchObject({ delegations: 2, toolCalls: 3 });
        expect(await applies(T.other)).toMatchObject({ delegations: 3, toolCalls: 1 });
        expect(await applies(T.alone)).toMatchObject({ delegations: 3, toolCalls: 1, toolCallsBasis: 'NO_ORGANIZATION' });
    });

    it('another organization\'s change does not reach this one', async () => {
        mockGetOrgCtx.mockResolvedValue({ ...orgCtxAs('admin', OTHER_ORG) });
        expect((await putOrg({ toolCallsPerTurn: 7 }, OTHER_ORG)).status).toBe(200);
        expect(await applies(T.other)).toMatchObject({ toolCalls: 7 });
        expect(await applies(T.a)).toMatchObject({ toolCalls: 3 });
        expect(await orgRows('ORG_AGENT_TURN_CAPS_CHANGED')).toHaveLength(3);
    });
});

describe('the workspace narrows, and only narrows', () => {
    beforeEach(() => mockGetTenantCtx.mockResolvedValue(ownerCtx()));

    it('a value above the organization\'s ceiling is refused, naming the ceiling, and nothing is written', async () => {
        const res = await putWorkspace({ agentMaxToolCallsPerTurn: 4 });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.details).toEqual({
            reason: 'TURN_CAP_ABOVE_ORGANIZATION_CEILING',
            field: 'agentMaxToolCallsPerTurn',
            ceiling: 3,
        });
        expect(await storedWorkspace()).toBeNull();
    });

    it('a value at or below the ceiling is stored, applies to this workspace alone, and is audited with both values', async () => {
        const res = await putWorkspace({ agentMaxToolCallsPerTurn: 2, agentMaxSubagentsPerTurn: 0 });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.agentMaxToolCallsPerTurn).toBe(2);
        expect(body.turnCaps.toolCallsPerTurn).toEqual({ value: 2, basis: 'WORKSPACE', ceiling: 3, workspace: 2 });
        expect(await storedWorkspace()).toEqual({ agentMaxSubagentsPerTurn: 0, agentMaxToolCallsPerTurn: 2 });
        expect(await applies(T.a)).toMatchObject({ delegations: 0, toolCalls: 2, toolCallsBasis: 'WORKSPACE' });
        // Its sibling under the same organization is unmoved.
        expect(await applies(T.b)).toMatchObject({ delegations: 2, toolCalls: 3 });

        const rows = await prisma.auditLog.findMany({ where: { tenantId: T.a, action: 'AGENT_TURN_CAPS_CHANGED' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].detailsJson).toMatchObject({
            changedFields: ['agentMaxSubagentsPerTurn', 'agentMaxToolCallsPerTurn'],
            before: {
                agentMaxSubagentsPerTurn: { stored: null, applies: 2 },
                agentMaxToolCallsPerTurn: { stored: null, applies: 3 },
            },
            after: {
                agentMaxSubagentsPerTurn: { stored: 0, applies: 0 },
                agentMaxToolCallsPerTurn: { stored: 2, applies: 2 },
            },
        });
        expect(await prisma.auditLog.count({ where: { tenantId: T.a, action: 'SECURITY_SETTINGS_UPDATED' } })).toBe(1);
    });

    it('an organization lowering its ceiling narrows the stored value without rewriting it, and raising it restores it', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtxAs('admin'));
        expect((await putOrg({ toolCallsPerTurn: 1 })).status).toBe(200);
        expect(await applies(T.a)).toMatchObject({ toolCalls: 1, toolCallsBasis: 'ORGANIZATION_CEILING' });
        expect(await storedWorkspace()).toMatchObject({ agentMaxToolCallsPerTurn: 2 });

        expect((await putOrg({ toolCallsPerTurn: 5 })).status).toBe(200);
        expect(await applies(T.a)).toMatchObject({ toolCalls: 2, toolCallsBasis: 'WORKSPACE' });
    });

    it('null follows the organization again', async () => {
        const res = await putWorkspace({ agentMaxToolCallsPerTurn: null });
        expect(res.status).toBe(200);
        expect(await storedWorkspace()).toMatchObject({ agentMaxToolCallsPerTurn: null });
        expect(await applies(T.a)).toMatchObject({ toolCalls: 5, toolCallsBasis: 'ORGANIZATION_CEILING' });
    });

    it('a saving of an unrelated field writes no turn-cap event', async () => {
        const before = await prisma.auditLog.count({ where: { tenantId: T.a, action: 'AGENT_TURN_CAPS_CHANGED' } });
        expect((await putWorkspace({ mfaFailClosed: true })).status).toBe(200);
        expect(await prisma.auditLog.count({ where: { tenantId: T.a, action: 'AGENT_TURN_CAPS_CHANGED' } })).toBe(before);
    });
});
