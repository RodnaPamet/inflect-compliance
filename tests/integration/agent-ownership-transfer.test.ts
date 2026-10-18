/**
 * AGENT OWNERSHIP TRANSFER (#3698) — the two-step handover, proved on real rows.
 *
 * An agent's accountable owner moves only when TWO people act: one holder of
 * `admin.tenant_lifecycle` proposes it, and the person it names accepts it. The
 * person who started it can never complete it. This suite owns the rows: every
 * refusal step 0e and the issue name, the step-two re-checks, expiry and
 * cancellation, the retirement cascade's cancel, the database backstops (CHECKs,
 * partial unique index, one-way and insert triggers, no DELETE for `app_user`),
 * and two-tenant isolation under `app_user` + RLS.
 *
 * Fixtures: in each of two tenants, three OWNERs (A owns the agents, B and C
 * receive or propose), an ADMIN (holds the register key, NOT tenant lifecycle),
 * a DEACTIVATED owner, and two members holding the same CUSTOM role — built on
 * READER, carrying the key. One is an ADMIN membership, the other a READER one,
 * and only the first is a legitimate recipient: the transfer routes sit under
 * `/api/t/:slug/admin/`, where the edge refuses a non-ADMIN/OWNER built-in role
 * before the route's `requirePermission` ever runs.
 *
 * Every context is resolved by the real `resolveTenantContext` from the
 * membership rows, so a custom role reaches the usecase exactly as production
 * hands it over — `role` and `permissions` from the custom role's BASE role,
 * `appPermissions` from its JSON.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import {
    cancelAgentOwnershipTransfer,
    completeAgentOwnershipTransfer,
    getAgentOwnershipTransfers,
    proposeAgentOwnershipTransfer,
} from '@/app-layer/usecases/agent-ownership-transfer';
import { retireRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { AGENT_OWNERSHIP_TRANSFER_CLOSED_DB_REFUSAL } from '@/lib/agentic/ownership-transfer';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'owner-transfer-one';
const T2 = 'owner-transfer-two';
const TENANTS = [T1, T2];

type Person =
    | 'ownerA'
    | 'ownerB'
    | 'ownerC'
    | 'admin'
    | 'deactivated'
    | 'adminCustodian'
    | 'readerCustodian';
const PEOPLE: Person[] = [
    'ownerA',
    'ownerB',
    'ownerC',
    'admin',
    'deactivated',
    'adminCustodian',
    'readerCustodian',
];
/** The built-in membership role each person holds. */
const MEMBERSHIP_ROLE: Record<Person, Role> = {
    ownerA: Role.OWNER,
    ownerB: Role.OWNER,
    ownerC: Role.OWNER,
    admin: Role.ADMIN,
    deactivated: Role.OWNER,
    adminCustodian: Role.ADMIN,
    readerCustodian: Role.READER,
};
const CUSTODIANS: Person[] = ['adminCustodian', 'readerCustodian'];
const users: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Partial<Record<Person, RequestContext>>> = {};
let seq = 0;

const DAY = 24 * 60 * 60 * 1000;

const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;

/** A person's request context, as `resolveTenantContext` built it from their membership in `beforeAll`. */
function ctxAs(tenantId: string, who: Person): RequestContext {
    const ctx = contexts[tenantId][who];
    if (!ctx) throw new Error(`no request context for ${who}: a deactivated member cannot make a request`);
    return ctx;
}

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    // The test client is the table owner, so it holds the DELETE `app_user` does not.
    await prisma.agentOwnershipTransfer.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.tenantCustomRole.deleteMany({ where: t });
    await prisma.user.deleteMany({
        where: {
            emailHash: {
                in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))),
            },
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

/** A fresh ACTIVE agent owned by ownerA. `RegisteredAgent.aiSystemId` is UNIQUE, so each gets a host. */
async function makeAgent(tenantId: string, extra: { status?: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' } = {}) {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `transfer host ${seq}`, ownerUserId: users[tenantId].ownerA },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `transfer probe ${seq}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users[tenantId].ownerA,
            status: extra.status ?? 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

const ownerOf = async (agentId: string) =>
    (await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } })).ownerUserId;
const transferRow = (id: string) => prisma.agentOwnershipTransfer.findUniqueOrThrow({ where: { id } });

/** Move a PENDING transfer's window into the past (the one-way trigger permits a PENDING row). */
async function lapse(transferId: string) {
    await prisma.agentOwnershipTransfer.update({
        where: { id: transferId },
        data: { createdAt: new Date(Date.now() - 8 * DAY), expiresAt: new Date(Date.now() - DAY) },
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const lifecycleRole = await prisma.tenantCustomRole.create({
            data: {
                tenantId,
                name: 'Agent custodian',
                baseRole: Role.READER,
                permissionsJson: { admin: { tenant_lifecycle: true } },
            },
        });
        users[tenantId] = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[tenantId][who] = user.id;
            await prisma.tenantMembership.create({
                data: {
                    tenantId,
                    userId: user.id,
                    role: MEMBERSHIP_ROLE[who],
                    status: who === 'deactivated' ? MembershipStatus.DEACTIVATED : MembershipStatus.ACTIVE,
                    customRoleId: CUSTODIANS.includes(who) ? lifecycleRole.id : null,
                },
            });
        }
        contexts[tenantId] = {};
        for (const who of PEOPLE.filter((p) => p !== 'deactivated')) {
            const resolved = await resolveTenantContext({ tenantId }, users[tenantId][who]);
            contexts[tenantId][who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[tenantId][who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─── Step one ──────────────────────────────────────────────────────

describe('step one records the proposed owner, and nothing else moves', () => {
    it('proposes to an OWNER: PENDING, a seven-day window, an audit row, the owner unchanged', async () => {
        const agent = await makeAgent(T1);
        const before = Date.now();
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });

        const row = await transferRow(proposed.id);
        expect(row).toMatchObject({
            tenantId: T1,
            agentId: agent.id,
            fromOwnerUserId: users[T1].ownerA,
            toOwnerUserId: users[T1].ownerB,
            initiatedByUserId: users[T1].ownerA,
            status: 'PENDING',
            completedAt: null,
            completedByUserId: null,
        });
        const windowMs = row.expiresAt.getTime() - before;
        expect(windowMs).toBeGreaterThan(7 * DAY - 60_000);
        expect(windowMs).toBeLessThanOrEqual(7 * DAY + 60_000);
        expect(proposed.effectiveStatus).toBe('PENDING');

        // Step one moves NOTHING on the agent.
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: proposed.id, action: 'AGENT_OWNERSHIP_TRANSFER_PROPOSED' },
        });
        expect((audit.detailsJson as Record<string, unknown>).targetUserId).toBe(users[T1].ownerB);
    });

    it('an ADMIN whose custom role carries tenant lifecycle receives an agent and completes the transfer', async () => {
        // The positive half of the narrowing, end to end. The edge admits the
        // ADMIN membership; the route admits the key; and the usecase admits a
        // context whose coarse tier is the custom role's READER base
        // (`canWrite: false`) — so this is also what holds the usecase to
        // `assertCanRead` rather than `assertCanWrite`.
        const custodian = ctxAs(T1, 'adminCustodian');
        expect(custodian.permissions.canWrite).toBe(false);
        expect(custodian.appPermissions.admin.tenant_lifecycle).toBe(true);

        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, {
            toOwnerUserId: users[T1].adminCustodian,
        });
        expect(proposed.status).toBe('PENDING');
        await expect(
            completeAgentOwnershipTransfer(custodian, agent.id, { transferId: proposed.id }),
        ).resolves.toMatchObject({ ownerUserId: users[T1].adminCustodian });
        expect(await ownerOf(agent.id)).toBe(users[T1].adminCustodian);
    });

    it('refuses a READER whose custom role carries the key — the edge would refuse them at step two', async () => {
        // Same custom role, READER membership. `requirePermission` would admit
        // them; the edge's admin-path gate reads the built-in role and never
        // lets the request reach it. An offer they can never accept would hold
        // the agent's one open slot for seven days, so step one refuses it.
        const agent = await makeAgent(T1);
        const err = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, {
            toOwnerUserId: users[T1].readerCustodian,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(/an OWNER, or an ADMIN whose custom role carries/);
        expect(await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id } })).toBe(0);
    });

    it('a SUSPENDED or DRAFT agent can be transferred — the departed-owner remedy needs it', async () => {
        for (const status of ['SUSPENDED', 'DRAFT'] as const) {
            const agent = await makeAgent(T1, { status });
            await expect(
                proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
                    toOwnerUserId: users[T1].ownerB,
                }),
            ).resolves.toMatchObject({ status: 'PENDING' });
        }
    });

    it.each([
        ['the current owner', 'ownerA', /already owns/],
        ['the proposer themselves', 'ownerC', /cannot propose yourself/],
        ['a DEACTIVATED member', 'deactivated', /active member/],
        ['an ADMIN, who lacks the tenant lifecycle key', 'admin', /tenant lifecycle permission/],
    ] as const)('refuses proposing %s', async (_label, who, message) => {
        const agent = await makeAgent(T1);
        const err = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, {
            toOwnerUserId: users[T1][who],
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toEqual(expect.stringMatching(message));
        expect(await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id } })).toBe(0);
    });

    it('refuses a non-member — another tenant’s user is not an owner here', async () => {
        const agent = await makeAgent(T1);
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
                toOwnerUserId: users[T2].ownerB,
            }),
        ).rejects.toThrow(/active member/);
    });

    it('refuses a RETIRED agent, and a removed one reads as not found', async () => {
        const retired = await makeAgent(T1);
        await retireRegisteredAgent(ctxAs(T1, 'ownerA'), retired.id);
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), retired.id, {
                toOwnerUserId: users[T1].ownerB,
            }),
        ).rejects.toBeInstanceOf(ConflictError);

        const removed = await makeAgent(T1);
        await prisma.registeredAgent.update({ where: { id: removed.id }, data: { deletedAt: new Date() } });
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), removed.id, {
                toOwnerUserId: users[T1].ownerB,
            }),
        ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuses a second open transfer for the same agent', async () => {
        const agent = await makeAgent(T1);
        await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { toOwnerUserId: users[T1].ownerB });
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { toOwnerUserId: users[T1].ownerC }),
        ).rejects.toThrow(/already waiting/);
        expect(await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id } })).toBe(1);
    });

    it('two proposals at the same moment leave exactly one open — the partial unique index decides', async () => {
        const agent = await makeAgent(T1);
        const results = await Promise.allSettled([
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { toOwnerUserId: users[T1].ownerB }),
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, { toOwnerUserId: users[T1].ownerB }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictError);
        expect(
            await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id, status: 'PENDING' } }),
        ).toBe(1);
    });

    it('refuses an unknown field rather than ignoring it', async () => {
        const agent = await makeAgent(T1);
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
                toOwnerUserId: users[T1].ownerB,
                completeImmediately: true,
            }),
        ).rejects.toThrow();
        expect(await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id } })).toBe(0);
    });
});

// ─── Step two ──────────────────────────────────────────────────────

describe('step two is completed by the person it names, and never by the person who started it', () => {
    it('the initiator is refused; the named person completes, and ownership moves', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });

        // THE TWO-PERSON RULE. A started it; A cannot finish it.
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect((await transferRow(proposed.id)).status).toBe('PENDING');
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);

        // A third holder of the key is not the person it names either.
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ForbiddenError);

        const done = await completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, {
            transferId: proposed.id,
        });
        expect(done).toEqual({
            transferId: proposed.id,
            agentId: agent.id,
            ownerUserId: users[T1].ownerB,
            previousOwnerUserId: users[T1].ownerA,
        });
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerB);
        const row = await transferRow(proposed.id);
        expect(row.status).toBe('COMPLETED');
        expect(row.completedByUserId).toBe(users[T1].ownerB);

        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: agent.id, action: 'AGENT_OWNERSHIP_TRANSFERRED' },
        });
        const details = audit.detailsJson as Record<string, unknown>;
        expect(details.before).toEqual({ ownerUserId: users[T1].ownerA });
        expect(details.after).toEqual({ ownerUserId: users[T1].ownerB });
        expect(details.initiatedByUserId).toBe(users[T1].ownerA);
        expect(details.transferId).toBe(proposed.id);
        // The AI-system owner is recorded, not moved.
        expect(details.aiSystemOwnerUserId).toBe(users[T1].ownerA);

        // A completed transfer cannot be completed again.
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ConflictError);
    });

    it('an initiator who is not the owner is refused too — the rule is about who started it', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, { transferId: proposed.id }),
        ).rejects.toThrow(/You started this transfer/);
        // The current owner is not the person it names.
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { transferId: proposed.id }),
        ).rejects.toThrow(/Only the person this transfer names/);
        await completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id });
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerB);
    });

    it('re-checks the person completing: deactivated after step one, they cannot complete', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerC,
        });
        await prisma.tenantMembership.update({
            where: { tenantId_userId: { tenantId: T1, userId: users[T1].ownerC } },
            data: { status: MembershipStatus.DEACTIVATED },
        });
        try {
            await expect(
                completeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, { transferId: proposed.id }),
            ).rejects.toThrow(/active member/);
            expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
            expect((await transferRow(proposed.id)).status).toBe('PENDING');
        } finally {
            await prisma.tenantMembership.update({
                where: { tenantId_userId: { tenantId: T1, userId: users[T1].ownerC } },
                data: { status: MembershipStatus.ACTIVE },
            });
        }
    });

    it('re-checks the key: demoted to ADMIN after step one, they cannot complete', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerC,
        });
        await prisma.tenantMembership.update({
            where: { tenantId_userId: { tenantId: T1, userId: users[T1].ownerC } },
            data: { role: Role.ADMIN },
        });
        try {
            await expect(
                completeAgentOwnershipTransfer(ctxAs(T1, 'ownerC'), agent.id, { transferId: proposed.id }),
            ).rejects.toThrow(/tenant lifecycle permission/);
            expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
        } finally {
            await prisma.tenantMembership.update({
                where: { tenantId_userId: { tenantId: T1, userId: users[T1].ownerC } },
                data: { role: Role.OWNER },
            });
        }
    });

    it('re-checks the agent: re-owned since step one, nothing changes', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        // A privileged writer moved the owner underneath the open transfer.
        await prisma.registeredAgent.update({ where: { id: agent.id }, data: { ownerUserId: users[T1].ownerC } });
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toThrow(/changed owner after the transfer was proposed/);
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerC);
        expect((await transferRow(proposed.id)).status).toBe('PENDING');
    });

    it('re-checks the agent: removed since step one, nothing changes', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await prisma.registeredAgent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
    });

    it('retiring the agent cancels its open transfer, and step two is then refused', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        const retired = await retireRegisteredAgent(ctxAs(T1, 'ownerC'), agent.id);
        expect(retired.cascade.ownershipTransferCancelled).toBe(proposed.id);

        const row = await transferRow(proposed.id);
        expect(row.status).toBe('CANCELLED');
        // Attributed to the retiring actor, not to the parties of the transfer.
        expect(row.cancelledByUserId).toBe(users[T1].ownerC);
        await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: agent.id, action: 'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED' },
        });

        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
    });

    it('an expired transfer is refused, stamped EXPIRED, and a fresh proposal then succeeds', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await lapse(proposed.id);

        // Before anybody stamps it, the read already reports it as over.
        const read = await getAgentOwnershipTransfers(ctxAs(T1, 'ownerB'), agent.id);
        expect(read.open).toBeNull();
        expect(read.history[0]).toMatchObject({ id: proposed.id, status: 'PENDING', effectiveStatus: 'EXPIRED' });

        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toThrow(/expired/);
        // The stamp committed even though the request was refused.
        expect((await transferRow(proposed.id)).status).toBe('EXPIRED');
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);

        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { toOwnerUserId: users[T1].ownerB }),
        ).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('a lapsed transfer frees the slot for a new proposal without anybody stamping it first', async () => {
        const agent = await makeAgent(T1);
        const first = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await lapse(first.id);
        const second = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerC,
        });
        expect((await transferRow(first.id)).status).toBe('EXPIRED');
        expect((await transferRow(second.id)).status).toBe('PENDING');
    });

    it('a transfer of another agent, or an unknown id, is not found', async () => {
        const agent = await makeAgent(T1);
        const other = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), other.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: 'no-such-transfer' }),
        ).rejects.toBeInstanceOf(NotFoundError);
    });
});

// ─── Cancellation ──────────────────────────────────────────────────

describe('cancellation: the initiator withdraws, the recipient declines', () => {
    it('the initiator withdraws it; step two is then refused', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        const cancelled = await cancelAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            transferId: proposed.id,
        });
        expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledByUserId: users[T1].ownerA });
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: proposed.id, action: 'AGENT_OWNERSHIP_TRANSFER_CANCELLED' },
        });
        expect(audit.detailsJson).toMatchObject({ withdrawn: true, declined: false });

        await expect(
            completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ConflictError);
        await expect(
            cancelAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { transferId: proposed.id }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(await ownerOf(agent.id)).toBe(users[T1].ownerA);
    });

    it('the person it names declines it', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await cancelAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id });
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: proposed.id, action: 'AGENT_OWNERSHIP_TRANSFER_CANCELLED' },
        });
        expect(audit.detailsJson).toMatchObject({ withdrawn: false, declined: true });
        expect((await transferRow(proposed.id)).cancelledByUserId).toBe(users[T1].ownerB);
    });

    it('a lapsed transfer is stamped EXPIRED, not CANCELLED, and the refusal comes after the stamp commits', async () => {
        // It was already over; recording a cancellation would attribute to a
        // person an act on an offer that had ended. And the refusal is thrown
        // AFTER the transaction commits — inside, it would roll the stamp back.
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await lapse(proposed.id);

        const err = await cancelAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            transferId: proposed.id,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as Error).message).toMatch(/already expired/);

        const row = await transferRow(proposed.id);
        expect(row.status).toBe('EXPIRED');
        expect(row.cancelledAt).toBeNull();
        expect(row.cancelledByUserId).toBeNull();
        expect(
            await prisma.auditLog.count({
                where: { tenantId: T1, entityId: proposed.id, action: 'AGENT_OWNERSHIP_TRANSFER_CANCELLED' },
            }),
        ).toBe(0);
    });
});

// ─── Concurrency: the agent row first, then the transfer row ───────

describe('a proposal and a retirement in flight together serialise, and never deadlock', () => {
    /**
     * Hold a transaction that has written the agent's status — the first write
     * retirement makes, which holds the agent row until commit — and hand back
     * a function that runs more statements in it and then releases it.
     */
    async function holdRetirement(agentId: string) {
        let markUpdated!: () => void;
        const updated = new Promise<void>((resolve) => (markUpdated = resolve));
        let next!: (fn: ((tx: PrismaClient) => Promise<void>) | null) => void;
        const step = new Promise<((tx: PrismaClient) => Promise<void>) | null>((resolve) => (next = resolve));
        const done = prisma.$transaction(
            async (tx) => {
                await tx.registeredAgent.update({ where: { id: agentId }, data: { status: 'RETIRED' } });
                markUpdated();
                const then = await step;
                if (then) await then(tx as unknown as PrismaClient);
            },
            { timeout: 30_000, maxWait: 10_000 },
        );
        await updated;
        return { done, finish: (then: ((tx: PrismaClient) => Promise<void>) | null = null) => next(then) };
    }

    /** Settle a promise into a value, recording whether it has settled yet. */
    function track<T>(p: Promise<T>) {
        const state = { settled: false };
        const outcome = p.then(
            (v) => {
                state.settled = true;
                return { ok: true as const, value: v };
            },
            (err: unknown) => {
                state.settled = true;
                return { ok: false as const, err };
            },
        );
        return { state, outcome };
    }

    it('a proposal for an agent with a LAPSED transfer waits for the retirement, then is refused', async () => {
        // The interleaving that deadlocked when step one stamped the lapsed row
        // BEFORE it locked the agent: retirement holds the agent row; step one
        // stamps the lapsed row and waits on the agent row; retirement then
        // reaches for that same transfer row. Postgres broke the cycle by
        // aborting one side with 40P01. Taking the agent row first, step one
        // touches no transfer row until the retirement has committed.
        const agent = await makeAgent(T1);
        const lapsed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await lapse(lapsed.id);

        const retiring = await holdRetirement(agent.id);
        const proposing = track(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, { toOwnerUserId: users[T1].ownerC }),
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(proposing.state.settled).toBe(false);

        // The retirement's own write to the transfer row — what the cascade does
        // with a lapsed row. With the old order this waited on the proposal's
        // stamp while the proposal waited on the agent row.
        retiring.finish(async (tx) => {
            await tx.agentOwnershipTransfer.updateMany({
                where: { id: lapsed.id, status: 'PENDING' },
                data: { status: 'EXPIRED' },
            });
        });
        await expect(retiring.done).resolves.toBeUndefined();

        const result = await proposing.outcome;
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.err).toBeInstanceOf(ConflictError);
        expect((result.ok ? null : (result.err as Error))?.message).toMatch(/retired/);
        expect(
            await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id, status: 'PENDING' } }),
        ).toBe(0);
    });

    it('a transfer insert racing the retirement waits on the trigger, then is refused', async () => {
        // The insert trigger's own `FOR SHARE`, on a raw insert that skips the
        // usecase's locking read. Without it the insert would read the
        // committed ACTIVE status under its own snapshot, not wait, and leave a
        // PENDING transfer on a RETIRED agent that the cascade never saw.
        const agent = await makeAgent(T1);
        const retiring = await holdRetirement(agent.id);
        const inserting = track(
            asTenant(T1, (tx) =>
                tx.agentOwnershipTransfer.create({
                    data: {
                        tenantId: T1,
                        agentId: agent.id,
                        fromOwnerUserId: users[T1].ownerA,
                        toOwnerUserId: users[T1].ownerB,
                        initiatedByUserId: users[T1].ownerC,
                        expiresAt: new Date(Date.now() + DAY),
                    },
                }),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(inserting.state.settled).toBe(false);

        retiring.finish();
        await retiring.done;
        const result = await inserting.outcome;
        expect(result.ok).toBe(false);
        expect(String((result.ok ? null : (result.err as Error))?.message)).toContain('AGENT_RETIRED');
        expect(await prisma.agentOwnershipTransfer.count({ where: { agentId: agent.id } })).toBe(0);
    });

    it('retiring an agent whose open transfer has lapsed stamps it EXPIRED, not CANCELLED', async () => {
        // A retired agent holds no PENDING transfer at all. The lapsed one
        // ended on its own, so it is closed the way any request closes it — no
        // actor, no cancellation row.
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await lapse(proposed.id);
        const retired = await retireRegisteredAgent(ctxAs(T1, 'ownerC'), agent.id);
        expect(retired.cascade.ownershipTransferCancelled).toBeNull();
        const row = await transferRow(proposed.id);
        expect(row.status).toBe('EXPIRED');
        expect(row.cancelledByUserId).toBeNull();
        expect(
            await prisma.auditLog.count({
                where: { tenantId: T1, entityId: agent.id, action: 'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED' },
            }),
        ).toBe(0);
    });
});

// ─── The database backstops ────────────────────────────────────────

describe('the database refuses what the usecase refuses, from any writer', () => {
    async function rawTransfer(agentId: string, data: Record<string, unknown> = {}) {
        return prisma.agentOwnershipTransfer.create({
            data: {
                tenantId: T1,
                agentId,
                fromOwnerUserId: users[T1].ownerA,
                toOwnerUserId: users[T1].ownerB,
                initiatedByUserId: users[T1].ownerC,
                expiresAt: new Date(Date.now() + DAY),
                ...data,
            },
        });
    }

    it('the initiator can never be the recipient, nor complete it (CHECKs)', async () => {
        const agent = await makeAgent(T1);
        await expect(rawTransfer(agent.id, { initiatedByUserId: users[T1].ownerB })).rejects.toThrow(
            /initiator_is_not_recipient|check constraint/i,
        );
        const row = await rawTransfer(agent.id);
        await expect(
            prisma.agentOwnershipTransfer.update({
                where: { id: row.id },
                data: { status: 'COMPLETED', completedAt: new Date(), completedByUserId: users[T1].ownerC },
            }),
        ).rejects.toThrow(/completion_shape|check constraint/i);
        expect((await transferRow(row.id)).status).toBe('PENDING');
    });

    it('a transfer to the current owner, or an unknown status, is unrepresentable', async () => {
        const agent = await makeAgent(T1);
        await expect(rawTransfer(agent.id, { toOwnerUserId: users[T1].ownerA })).rejects.toThrow(
            /moves_ownership|check constraint/i,
        );
        await expect(rawTransfer(agent.id, { status: 'APPROVED' })).rejects.toThrow(
            /status_known|check constraint/i,
        );
    });

    it('one PENDING transfer per agent, any number over its life (partial unique index)', async () => {
        const agent = await makeAgent(T1);
        const first = await rawTransfer(agent.id);
        await expect(rawTransfer(agent.id)).rejects.toThrow();
        await prisma.agentOwnershipTransfer.update({ where: { id: first.id }, data: { status: 'EXPIRED' } });
        await expect(rawTransfer(agent.id)).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('a row that has left PENDING cannot be changed, even by the table owner (trigger)', async () => {
        const agent = await makeAgent(T1);
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), agent.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), agent.id, { transferId: proposed.id });
        await expect(
            prisma.agentOwnershipTransfer.update({
                where: { id: proposed.id },
                data: { toOwnerUserId: users[T1].ownerC, completedByUserId: users[T1].ownerC },
            }),
        ).rejects.toThrow(AGENT_OWNERSHIP_TRANSFER_CLOSED_DB_REFUSAL);
        await expect(
            prisma.agentOwnershipTransfer.update({ where: { id: proposed.id }, data: { status: 'PENDING' } }),
        ).rejects.toThrow(AGENT_OWNERSHIP_TRANSFER_CLOSED_DB_REFUSAL);
        expect((await transferRow(proposed.id)).status).toBe('COMPLETED');
    });

    it('no transfer can be opened on a RETIRED agent (insert trigger)', async () => {
        const agent = await makeAgent(T1);
        await retireRegisteredAgent(ctxAs(T1, 'ownerA'), agent.id);
        await expect(rawTransfer(agent.id)).rejects.toThrow(/AGENT_RETIRED/);
    });

    it('app_user can read, open and close a transfer, but never delete one', async () => {
        const agent = await makeAgent(T1);
        const row = await rawTransfer(agent.id);
        await expect(
            asTenant(T1, (tx) => tx.agentOwnershipTransfer.deleteMany({ where: { id: row.id } })),
        ).rejects.toThrow(/permission denied/i);
        expect(await prisma.agentOwnershipTransfer.count({ where: { id: row.id } })).toBe(1);
    });
});

// ─── Two-tenant isolation ──────────────────────────────────────────

describe('two-tenant isolation on AgentOwnershipTransfer', () => {
    let a1 = '';
    let a2 = '';
    let t1Transfer = '';
    let t2Transfer = '';

    beforeAll(async () => {
        a1 = (await makeAgent(T1)).id;
        a2 = (await makeAgent(T2)).id;
        t1Transfer = (
            await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), a1, { toOwnerUserId: users[T1].ownerB })
        ).id;
        t2Transfer = (
            await proposeAgentOwnershipTransfer(ctxAs(T2, 'ownerA'), a2, { toOwnerUserId: users[T2].ownerB })
        ).id;
    });

    it('under app_user, each tenant sees only its own rows, and an unbound session sees none', async () => {
        const seenBy = async (tenantId: string) =>
            asTenant(tenantId, (tx) =>
                tx.agentOwnershipTransfer.findMany({ where: { id: { in: [t1Transfer, t2Transfer] } } }),
            );
        expect((await seenBy(T1)).map((r) => r.id)).toEqual([t1Transfer]);
        expect((await seenBy(T2)).map((r) => r.id)).toEqual([t2Transfer]);
        expect(await seenBy('')).toEqual([]);
    });

    it('under app_user, a row cannot be written into another tenant', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.agentOwnershipTransfer.create({
                    data: {
                        tenantId: T2,
                        agentId: a2,
                        fromOwnerUserId: users[T2].ownerA,
                        toOwnerUserId: users[T2].ownerC,
                        initiatedByUserId: users[T1].ownerA,
                        expiresAt: new Date(Date.now() + DAY),
                    },
                }),
            ),
        ).rejects.toThrow(/row-level security/i);
        // …nor can an open row of another tenant be closed: it matches nothing.
        const closed = await asTenant(T1, (tx) =>
            tx.agentOwnershipTransfer.updateMany({
                where: { id: t2Transfer },
                data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: users[T1].ownerA },
            }),
        );
        expect(closed.count).toBe(0);
        expect((await transferRow(t2Transfer)).status).toBe('PENDING');
    });

    it("every usecase refuses another tenant's agent or transfer as not found", async () => {
        const t1Owner = ctxAs(T1, 'ownerB');
        await expect(getAgentOwnershipTransfers(t1Owner, a2)).rejects.toBeInstanceOf(NotFoundError);
        await expect(
            proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), a2, { toOwnerUserId: users[T1].ownerB }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
            completeAgentOwnershipTransfer(t1Owner, a2, { transferId: t2Transfer }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
            cancelAgentOwnershipTransfer(t1Owner, a2, { transferId: t2Transfer }),
        ).rejects.toBeInstanceOf(NotFoundError);
        // Naming the foreign transfer against one's OWN agent finds nothing either.
        await expect(
            completeAgentOwnershipTransfer(t1Owner, a1, { transferId: t2Transfer }),
        ).rejects.toBeInstanceOf(NotFoundError);

        expect((await transferRow(t2Transfer)).status).toBe('PENDING');
        expect(await ownerOf(a2)).toBe(users[T2].ownerA);
    });
});
