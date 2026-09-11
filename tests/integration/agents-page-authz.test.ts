/**
 * THE AGENT REGISTER'S READ GATE, AND ITS TWO-TENANT ISOLATION (#2433).
 *
 * Two claims, and the first is the one that moving the page created.
 *
 * ── AN `admin.view` HOLDER WITHOUT THE AGENT PERMISSION CANNOT READ THE LIST ──
 *
 * `listRegisteredAgents` asserted only `assertCanRead` — which every role in
 * the tenant holds — while `admin.agent_registry` gated the ADD button. So the
 * key whose own docstring says it decides "which autonomous agents may act
 * inside the tenant at all" governed a button, and the record of what is
 * running was readable by anybody who could read anything.
 *
 * That was survivable while the page was an `/admin` leaf behind an ancestor
 * `admin.view` layout guard: the layout refused everyone the usecase let
 * through, so the weak assertion never decided anything. `/agents` has no such
 * ancestor. A move that silently widens a read is the worst kind of routing
 * change, so the gate moved into the usecase in the same diff — and this is the
 * test that says so from the outside.
 *
 * The principal the first block drives is the one that matters: a caller WITH
 * `admin.view` and WITHOUT `admin.agent_registry`. A READER would be refused by
 * either gate, so a test that used one could not tell the two apart.
 *
 * ── TWO-TENANT ISOLATION ─────────────────────────────────────────────────────
 *
 * Driven through the real usecases under two tenant contexts. The stakes are
 * not the usual ones: this table is the register of which autonomous agents
 * hold what authority over a tenant's data and which are switched off, so a
 * cross-tenant read is one customer learning another's automation surface.
 * Asserted on the LIST, the KPI COUNTS and the GOVERNANCE STATUS — all three,
 * because each is a separate query and the counts are aggregates that would
 * leak a shape rather than a row.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    getAgentGovernanceStatus,
    listAgentKpiCounts,
    listRegisteredAgents,
} from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'agentauthz-tenant-one';
const T2 = 'agentauthz-tenant-two';

const seeded: Record<string, { ownerUserId: string; agentId: string; agentName: string }> =
    {};

/** OWNER — holds `admin.agent_registry`. */
const ownerCtx = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

/**
 * The principal this file is about: `admin.view` YES,
 * `admin.agent_registry` NO.
 *
 * Built from the real ADMIN permission set with ONE key turned off, rather
 * than hand-rolled — so it stays a plausible principal as the permission
 * model grows, and so the thing under test is the single key rather than a
 * bag that happens to be missing several.
 */
const adminWithoutRegisterCtx = (tenantId: string) => {
    const admin = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
        appPermissions: {
            ...admin,
            admin: { ...admin.admin, view: true, agent_registry: false },
        },
    });
};

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [
        [T1, 'Authz tenant one'],
        [T2, 'Authz tenant two'],
    ] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: {
                tenantId: id,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: user.id },
        });
        const agentName = `Ops agent ${id}`;
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: id,
                aiSystemId: aiSystem.id,
                name: agentName,
                autonomyLevel: 3,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                status: 'ACTIVE',
                ownerUserId: user.id,
                createdByUserId: user.id,
            },
        });
        seeded[id] = { ownerUserId: user.id, agentId: agent.id, agentName };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('an admin.view holder WITHOUT the agent permission cannot read the register', () => {
    it('the LIST is refused', async () => {
        await expect(listRegisteredAgents(adminWithoutRegisterCtx(T1), {})).rejects.toThrow(
            /permission to view the agent register/,
        );
    });

    it('the KPI COUNTS are refused — aggregates leak a shape, not a row', async () => {
        // "47 agents, 12 unscored" is the shape of the answer somebody was
        // refused. A gate on the list alone would hand the same caller the
        // census.
        await expect(listAgentKpiCounts(adminWithoutRegisterCtx(T1))).rejects.toThrow(
            /permission to view the agent register/,
        );
    });

    it('the GOVERNANCE STATUS is refused', async () => {
        await expect(
            getAgentGovernanceStatus(adminWithoutRegisterCtx(T1)),
        ).rejects.toThrow(/permission to view the agent register/);
    });

    it('and the SAME principal with the key granted succeeds', async () => {
        // The paired positive, over the same tenant and the same user — so the
        // three refusals above are the KEY doing the work rather than a broken
        // context, a missing seed or an RLS accident.
        const admin = getPermissionsForRole('ADMIN');
        const withKey = makeRequestContext('ADMIN', {
            tenantId: T1,
            tenantSlug: T1,
            userId: seeded[T1].ownerUserId,
            appPermissions: {
                ...admin,
                admin: { ...admin.admin, view: true, agent_registry: true },
            },
        });
        const rows = await listRegisteredAgents(withKey, {});
        expect(rows.map((r) => r.name)).toEqual([seeded[T1].agentName]);
    });

    it('a READER is refused too, and for the register key rather than for canRead', async () => {
        // READER holds `canRead` and not `admin.agent_registry`, so the
        // MESSAGE says which gate refused. Without this, the two gates are
        // indistinguishable from outside and a future change that dropped the
        // register check would still look correct for this principal.
        await expect(
            listRegisteredAgents(makeRequestContext('READER', {
                tenantId: T1,
                tenantSlug: T1,
                userId: seeded[T1].ownerUserId,
            }), {}),
        ).rejects.toThrow(/permission to view the agent register/);
    });
});

describe('two-tenant isolation on every read the register page makes', () => {
    it('each tenant’s LIST holds only its own agent', async () => {
        const one = await listRegisteredAgents(ownerCtx(T1), {});
        const two = await listRegisteredAgents(ownerCtx(T2), {});
        // Exact lists, both ways round. `not.toContain` alone would pass for a
        // read that returned nothing at all.
        expect(one.map((r) => r.name)).toEqual([seeded[T1].agentName]);
        expect(two.map((r) => r.name)).toEqual([seeded[T2].agentName]);
    });

    it('the KPI COUNTS are per-tenant — neither sees the other’s row in its total', async () => {
        const one = await listAgentKpiCounts(ownerCtx(T1));
        const two = await listAgentKpiCounts(ownerCtx(T2));
        expect(one).toEqual({ total: 1, active: 1, unscored: 1, egress: 0 });
        expect(two).toEqual({ total: 1, active: 1, unscored: 1, egress: 0 });
        // Two tenants, one agent each. A leak would make either total 2 — and
        // the assertion above is exact, so it cannot be satisfied by a count
        // that merely happens to be non-zero.
    });

    it('the GOVERNANCE STATUS is per-tenant', async () => {
        const one = await getAgentGovernanceStatus(ownerCtx(T1));
        const two = await getAgentGovernanceStatus(ownerCtx(T2));
        // An ABSENT `TenantSecuritySettings` row reads as ENFORCING — the
        // documented fail direction, and what every unconfigured tenant is in.
        expect(one.enforcing).toBe(true);
        expect(two.enforcing).toBe(true);
        expect(one.unboundCredentials).toBe(0);
        expect(two.unboundCredentials).toBe(0);
    });

    it('a tenant-A read cannot be widened by naming tenant B in a filter', async () => {
        // The filters are enum members, so there is no tenant term to inject —
        // but the predicate builder always writes `tenantId: ctx.tenantId`, and
        // this is the assertion that says a filter cannot displace it.
        const rows = await listRegisteredAgents(ownerCtx(T1), {
            filters: { status: ['ACTIVE'] },
            take: 500,
        });
        expect(rows.map((r) => r.tenantId)).toEqual([T1]);
    });
});
