/**
 * `RegisteredAgent` — two-tenant isolation, and the refusals written in DDL.
 *
 * The structural guardrail (`rls-coverage`) certifies the policies EXIST. This
 * is conduct: it drives the real agent-registry usecases under two tenant
 * contexts and asserts what a tenant-B caller can actually do to tenant A's
 * agents — read, update, retire — and what the database refuses underneath.
 *
 * The stakes are specific and they are not the usual ones. This table is the
 * register of which autonomous agents hold what authority over a tenant's data,
 * who is accountable for each, and which of them are currently switched off. A
 * cross-tenant READ is one customer learning another's automation surface; a
 * cross-tenant WRITE is one customer un-suspending another's kill switch.
 *
 * Stage 1 ships the model plus the write seam the encryption manifest requires,
 * so the usecases driven here are the create/list/get/update/retire set. The
 * HTTP surface lands on top of them and extends this suite rather than
 * replacing it.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createRegisteredAgent,
    getRegisteredAgent,
    listRegisteredAgents,
    retireRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(30_000);

const T1 = 'regagent-tenant-one';
const T2 = 'regagent-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** `app_user` with NO tenant bound — the "context never got set" case. */
async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role
 * = 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both
 * fire on an ordinary DELETE and would take the teardown — and therefore the
 * whole suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { agentId: string; aiSystemId: string; ownerUserId: string }> = {};
const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        // Every agent is an entry in the EU AI Act register — the link is
        // required, so the fixture cannot skip it. That is the model saying what
        // it means, not ceremony.
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: user.id },
        });
        seeded[id] = { agentId: '', aiSystemId: aiSystem.id, ownerUserId: user.id };
    }

    for (const t of [T1, T2]) {
        const created = await createRegisteredAgent(ctxFor(t), {
            aiSystemId: seeded[t].aiSystemId,
            name: `Ops agent ${t}`,
            description: `<script>alert(1)</script>Reconciles ${t} controls`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: seeded[t].ownerUserId,
        });
        seeded[t].agentId = created.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a registered agent arrives unscored and switched off', () => {
    it('lands DRAFT with a NULL tier — never a plausible-looking low one', async () => {
        const row = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T1].agentId },
        });
        expect(row.status).toBe('DRAFT');
        expect(row.riskTier).toBeNull();
        expect(row.riskTierScoredAt).toBeNull();
        expect(row.isLegacyPlaceholder).toBe(false);
    });

    it('the free-text description is sanitised before it is stored', async () => {
        const agent = await getRegisteredAgent(ctxFor(T1), seeded[T1].agentId);
        expect(agent.description).toBe(`Reconciles ${T1} controls`);
    });
});

describe('a tenant sees only its own agents', () => {
    it('BOTH rows really exist — otherwise every assertion below is vacuous', async () => {
        // `toHaveLength(1)` passes just as happily when the other tenant's row
        // was never created. Read as superuser so the rows RLS hides are proven
        // to be there.
        const all = await prisma.registeredAgent.findMany({ where: { tenantId: { in: [T1, T2] } } });
        expect(all).toHaveLength(2);
        expect(all.map((r) => r.tenantId).sort()).toEqual([T1, T2]);
    });

    it('each tenant lists exactly its own through the usecase', async () => {
        for (const t of [T1, T2]) {
            const rows = await listRegisteredAgents(ctxFor(t));
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(seeded[t].agentId);
        }
    });

    it("naming the OTHER tenant's agent by id is a not-found, not a read", async () => {
        await expect(getRegisteredAgent(ctxFor(T1), seeded[T2].agentId)).rejects.toThrow(
            /not found/i,
        );
    });

    it('a direct query under app_user with NO tenant context returns zero rows', async () => {
        // The unset-context case: RLS compares against a NULL setting, matches
        // nothing, and the caller gets an empty list rather than everything.
        const rows = await asAppUserWithNoTenant((tx) => tx.registeredAgent.findMany({}));
        expect(rows).toEqual([]);
    });
});

describe("a tenant cannot change another tenant's agent", () => {
    it('UPDATE through the usecase is refused and the row is untouched', async () => {
        await expect(
            updateRegisteredAgent(ctxFor(T1), seeded[T2].agentId, { name: 'Seized by T1' }),
        ).rejects.toThrow(/not found/i);

        const after = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T2].agentId },
        });
        expect(after.name).toBe(`Ops agent ${T2}`);
    });

    it('RETIRE through the usecase is refused and the status is untouched', async () => {
        // Retiring someone else's agent is the interesting direction: it is a
        // denial of service against their automation, not a data read.
        await expect(retireRegisteredAgent(ctxFor(T1), seeded[T2].agentId)).rejects.toThrow(
            /not found/i,
        );

        const after = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T2].agentId },
        });
        expect(after.status).toBe('DRAFT');
    });

    it('a raw INSERT with a foreign tenantId is refused by RLS', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.registeredAgent.create({
                    data: {
                        tenantId: T2,
                        aiSystemId: seeded[T2].aiSystemId,
                        name: 'Smuggled',
                        autonomyLevel: 0,
                        dataAccessScope: 'NONE',
                        reversibility: 'REVERSIBLE',
                        provenance: 'FIRST_PARTY',
                        ownerUserId: seeded[T2].ownerUserId,
                    },
                }),
            ),
        ).rejects.toThrow();
    });

    it('a raw UPDATE of the other tenant\'s row changes nothing', async () => {
        const res = await asTenant(T1, (tx) =>
            tx.registeredAgent.updateMany({
                where: { id: seeded[T2].agentId },
                data: { status: 'ACTIVE' },
            }),
        );
        expect(res.count).toBe(0);
        const after = await prisma.registeredAgent.findUniqueOrThrow({
            where: { id: seeded[T2].agentId },
        });
        expect(after.status).toBe('DRAFT');
    });

    it('cannot reassign its OWN agent to another tenant', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.registeredAgent.update({
                    where: { id: seeded[T1].agentId },
                    data: { tenantId: T2 },
                }),
            ),
        ).rejects.toThrow();
    });
});

describe('the refusals that live in DDL, not in a usecase', () => {
    const base = (tenantId: string) => ({
        tenantId,
        aiSystemId: seeded[tenantId].aiSystemId,
        name: 'Constraint probe',
        autonomyLevel: 1,
        dataAccessScope: 'NONE' as const,
        reversibility: 'REVERSIBLE' as const,
        provenance: 'FIRST_PARTY' as const,
        ownerUserId: seeded[tenantId].ownerUserId,
    });

    it('autonomyLevel outside 0-6 is refused', async () => {
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-autonomy-high', autonomyLevel: 7 },
            }),
        ).rejects.toThrow();
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-autonomy-low', autonomyLevel: -1 },
            }),
        ).rejects.toThrow();
    });

    it('a THIRD_PARTY agent with no vendor is refused', async () => {
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-thirdparty', provenance: 'THIRD_PARTY' },
            }),
        ).rejects.toThrow();
    });

    it('a tier without the time it was scored is refused, and vice versa', async () => {
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-tier-nostamp', riskTier: 'LOW' },
            }),
        ).rejects.toThrow();
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-stamp-notier', riskTierScoredAt: new Date() },
            }),
        ).rejects.toThrow();
    });

    it('a second agent cannot claim an AI-system entry that is already claimed', async () => {
        await expect(
            prisma.registeredAgent.create({
                data: { ...base(T1), id: 'probe-duplicate-link' },
            }),
        ).rejects.toThrow();
    });

    it('deleting the AI system an agent governs is REFUSED, not cascaded', async () => {
        // RESTRICT, not CASCADE: losing the register entry must not silently
        // take the agent that governs it with it.
        await expect(
            prisma.aiSystem.delete({ where: { id: seeded[T1].aiSystemId } }),
        ).rejects.toThrow();
        const stillThere = await prisma.registeredAgent.findUnique({
            where: { id: seeded[T1].agentId },
        });
        expect(stillThere).not.toBeNull();
    });

    it('an AgentProposal cannot attribute itself to another tenant\'s agent', async () => {
        // The composite FK (agentId, tenantId) → (id, tenantId) is what makes
        // this a foreign-key failure rather than a plausible-looking row.
        await expect(
            prisma.agentProposal.create({
                data: {
                    tenantId: T1,
                    kind: 'RISK',
                    payloadJson: '{}',
                    agentId: seeded[T2].agentId,
                },
            }),
        ).rejects.toThrow();
    });
});
