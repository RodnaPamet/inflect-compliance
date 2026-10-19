/**
 * AUDITOR INDEPENDENCE (#3675, step 3b) — "the auditor is not the auditee",
 * proved on real rows.
 *
 * An agent marked as an auditor may be registered, amended into an auditor or
 * put ACTIVE only when its owner holds an ACTIVE membership whose line of
 * defence an OWNER declared SECOND, and owns none of the audited agents (every
 * other non-auditor agent that is not RETIRED — DRAFT and SUSPENDED count). A
 * NULL line never satisfies it. A LATER change that breaks it — a completed
 * ownership transfer, a new agent registered to the auditor's owner, the
 * owner's line moved off SECOND, another auditor unmarked — raises one HIGH
 * finding against the auditor and does not suspend it.
 *
 * Every context is resolved by the real `resolveTenantContext` from membership
 * rows. Lines of defence are set through `setMembershipLineOfDefence` by an
 * OWNER, so the fixture uses the product's own writer.
 *
 * People, in each tenant (role · line):
 *   ownerA       OWNER · undeclared  — sets lines; owns the audited agents
 *   ownerB       OWNER · FIRST       — a transfer recipient who is not second line
 *   secondOwner  OWNER · SECOND      — an auditor owner who can RECEIVE a transfer
 *   second       READER · SECOND     — an auditor owner
 *   first        READER · FIRST
 *   third        READER · THIRD
 *   undeclared   READER · undeclared
 *   admin        ADMIN               — runs the register
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { runInTenantContext } from '@/lib/db-context';
import {
    activateRegisteredAgent,
    createRegisteredAgent,
    registerAgent,
    retireRegisteredAgent,
    suspendRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import {
    completeAgentOwnershipTransfer,
    proposeAgentOwnershipTransfer,
} from '@/app-layer/usecases/agent-ownership-transfer';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import {
    auditorIndependenceLockKey,
    evaluateOwnerIndependenceInTx,
} from '@/app-layer/usecases/auditor-independence';
import { RegistrationIntakeSchema } from '@/app-layer/schemas/agent-registry.schemas';
import { AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND } from '@/lib/agentic/auditor-independence';
import { ConflictError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'auditor-indep-one';
const T2 = 'auditor-indep-two';
const TENANTS = [T1, T2];

type Person = 'ownerA' | 'ownerB' | 'secondOwner' | 'second' | 'first' | 'third' | 'undeclared' | 'admin';
const PEOPLE: Person[] = ['ownerA', 'ownerB', 'secondOwner', 'second', 'first', 'third', 'undeclared', 'admin'];
const ROLE: Record<Person, Role> = {
    ownerA: Role.OWNER,
    ownerB: Role.OWNER,
    secondOwner: Role.OWNER,
    second: Role.READER,
    first: Role.READER,
    third: Role.READER,
    undeclared: Role.READER,
    admin: Role.ADMIN,
};
const LINE: Record<Person, 'FIRST' | 'SECOND' | 'THIRD' | null> = {
    ownerA: null,
    ownerB: 'FIRST',
    secondOwner: 'SECOND',
    second: 'SECOND',
    first: 'FIRST',
    third: 'THIRD',
    undeclared: null,
    admin: null,
};

const users: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Record<Person, RequestContext>> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
const ctxAs = (tenantId: string, who: Person) => contexts[tenantId][who];
let seq = 0;

const REG = {
    autonomyLevel: 1,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'REVERSIBLE',
    provenance: 'FIRST_PARTY',
} as const;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.agentOwnershipTransfer.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

/** Put every person back on their fixture line, through the product's writer. */
async function resetLines(tenantId: string): Promise<void> {
    for (const who of PEOPLE) {
        const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId, userId: users[tenantId][who] } });
        if (m.lineOfDefence === LINE[who]) continue;
        // ownerA cannot set its own line; ownerB sets ownerA's.
        const setter = who === 'ownerA' ? 'ownerB' : 'ownerA';
        await setMembershipLineOfDefence(ctxAs(tenantId, setter), m.id, { lineOfDefence: LINE[who] });
    }
}

async function membershipOf(tenantId: string, who: Person) {
    return prisma.tenantMembership.findFirstOrThrow({ where: { tenantId, userId: users[tenantId][who] } });
}

/** A plain (audited) agent owned by `who`, in the given status. */
async function makeAudited(
    tenantId: string,
    who: Person,
    status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED' = 'DRAFT',
) {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `audited host ${seq}`, ownerUserId: users[tenantId][who] },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `audited ${seq}`,
            ...REG,
            ownerUserId: users[tenantId][who],
            status,
            ...(status === 'ACTIVE' ? { riskTier: 'LOW' as const, riskTierScoredAt: new Date() } : {}),
        },
    });
}

/** Register an auditor through the product, owned by `who`. */
function registerAuditor(tenantId: string, who: Person) {
    seq += 1;
    return registerAgent(ctxAs(tenantId, 'admin'), {
        name: `IAM auditor ${seq}`,
        ...REG,
        ownerUserId: users[tenantId][who],
        isAuditor: true,
    });
}

/** Score an agent so activation reaches the independence check. */
async function score(agentId: string) {
    await prisma.registeredAgent.update({
        where: { id: agentId },
        data: { riskTier: 'LOW', riskTierScoredAt: new Date() },
    });
}

/** An ACTIVE, independent auditor owned by `who`. */
async function activeAuditor(tenantId: string, who: Person) {
    const reg = await registerAuditor(tenantId, who);
    await score(reg.id);
    await activateRegisteredAgent(ctxAs(tenantId, 'admin'), reg.id);
    return reg;
}

async function expectNotIndependent(p: Promise<unknown>, reasons: string[]) {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toMatchObject({
        reason: 'AUDITOR_NOT_INDEPENDENT',
        independenceReasons: reasons,
    });
}

/**
 * The auditor's independence findings, read through the product's tenant
 * client: `Finding.description` is encrypted at rest, and only that client
 * decrypts it.
 */
const independenceFindings = (tenantId: string, agentId: string) =>
    runInTenantContext(ctxAs(tenantId, 'admin'), (db) =>
        db.finding.findMany({
            where: { tenantId, sourceKind: AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND, sourceRef: agentId },
            take: 10,
        }),
    );

/** Clear the agents and findings between tests; people and lines stay. */
async function clearAgents(tenantId: string) {
    await prisma.finding.deleteMany({ where: { tenantId } });
    await prisma.agentOwnershipTransfer.deleteMany({ where: { tenantId } });
    await prisma.aiSystemRequirementLink.deleteMany({ where: { tenantId } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId } });
    await prisma.aiSystem.deleteMany({ where: { tenantId } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        users[tenantId] = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[tenantId][who] = user.id;
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
        }
        contexts[tenantId] = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[tenantId][who]);
            contexts[tenantId][who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[tenantId][who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
        await resetLines(tenantId);
    }
});

beforeEach(async () => {
    for (const tenantId of TENANTS) {
        await clearAgents(tenantId);
        await resetLines(tenantId);
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─── Registration ───────────────────────────────────────────────────

describe('an auditor agent is refused at registration unless its owner is independent', () => {
    it('a NULL line never satisfies the check — and nothing is written', async () => {
        const before = await prisma.aiSystem.count({ where: { tenantId: T1 } });
        await expectNotIndependent(registerAuditor(T1, 'undeclared'), ['OWNER_LINE_UNDECLARED']);
        expect(await prisma.registeredAgent.count({ where: { tenantId: T1 } })).toBe(0);
        expect(await prisma.aiSystem.count({ where: { tenantId: T1 } })).toBe(before);
    });

    it('a FIRST-line owner is refused, and so is a THIRD-line one', async () => {
        await expectNotIndependent(registerAuditor(T1, 'first'), ['OWNER_NOT_SECOND_LINE']);
        await expectNotIndependent(registerAuditor(T1, 'third'), ['OWNER_NOT_SECOND_LINE']);
    });

    it.each(['DRAFT', 'ACTIVE', 'SUSPENDED'] as const)(
        'an owner who owns a %s audited agent is refused',
        async (status) => {
            await makeAudited(T1, 'second', status);
            await expectNotIndependent(registerAuditor(T1, 'second'), ['OWNER_OWNS_AUDITED_AGENT']);
        },
    );

    it('a RETIRED agent, and another auditor, are not audited agents', async () => {
        await makeAudited(T1, 'second', 'RETIRED');
        await registerAuditor(T1, 'second');
        const second = await registerAuditor(T1, 'second');
        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id: second.id } });
        expect(row).toMatchObject({ isAuditor: true, status: 'DRAFT', ownerUserId: users[T1].second });
    });

    it('a SECOND-line owner who owns nothing registers an auditor, DRAFT, and the audit row says so', async () => {
        const reg = await registerAuditor(T1, 'second');
        expect(reg).toMatchObject({ isAuditor: true, status: 'DRAFT' });
        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: T1, entityId: reg.id, action: 'AGENT_REGISTERED' },
        });
        expect((audit?.detailsJson as { after?: { isAuditor?: boolean } })?.after?.isAuditor).toBe(true);
    });

    it('another tenant owner never satisfies it: a T2 member is not an active member of T1', async () => {
        const err = await registerAgent(ctxAs(T1, 'admin'), {
            name: 'cross-tenant auditor',
            ...REG,
            ownerUserId: users[T2].second,
            isAuditor: true,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(await prisma.registeredAgent.count({ where: { tenantId: T1 } })).toBe(0);
    });
});

describe('no path around the registration check', () => {
    it('the registration intake cannot mark an agent as an auditor: its schema refuses the key', () => {
        const result = RegistrationIntakeSchema.safeParse({
            findingId: 'f',
            ownerUserId: 'u',
            confirmOwner: true,
            name: 'shadow',
            ...REG,
            isAuditor: true,
        });
        expect(result.success).toBe(false);
    });

    it('the pre-classified create seam does not take the mark: the agent lands as an audited agent', async () => {
        const sys = await prisma.aiSystem.create({
            data: { tenantId: T1, name: 'create-seam host', ownerUserId: users[T1].undeclared },
        });
        const created = await createRegisteredAgent(ctxAs(T1, 'admin'), {
            aiSystemId: sys.id,
            name: 'create-seam agent',
            ...REG,
            ownerUserId: users[T1].undeclared,
            isAuditor: true,
        } as Record<string, unknown>);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: created.id } })).isAuditor).toBe(false);
    });

    it('amending an agent into an auditor asks the check of its current owner', async () => {
        const audited = await makeAudited(T1, 'first', 'DRAFT');
        await expectNotIndependent(
            updateRegisteredAgent(ctxAs(T1, 'admin'), audited.id, { isAuditor: true }),
            ['OWNER_NOT_SECOND_LINE'],
        );
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: audited.id } })).isAuditor).toBe(false);

        // The agent itself is never its own auditee: a SECOND owner whose only
        // agent is this one may make it an auditor.
        const own = await makeAudited(T1, 'second', 'DRAFT');
        await updateRegisteredAgent(ctxAs(T1, 'admin'), own.id, { isAuditor: true });
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: own.id } })).isAuditor).toBe(true);
    });

    it('a retired agent cannot be marked', async () => {
        const retired = await makeAudited(T1, 'second', 'RETIRED');
        await expect(
            updateRegisteredAgent(ctxAs(T1, 'admin'), retired.id, { isAuditor: true }),
        ).rejects.toBeInstanceOf(ConflictError);
    });

    it('the database refuses the same rows for a writer that skips the usecase', async () => {
        const sys = await prisma.aiSystem.create({
            data: { tenantId: T1, name: 'raw host', ownerUserId: users[T1].undeclared },
        });
        await expect(
            prisma.registeredAgent.create({
                data: {
                    tenantId: T1,
                    aiSystemId: sys.id,
                    name: 'raw auditor',
                    ...REG,
                    ownerUserId: users[T1].undeclared,
                    isAuditor: true,
                },
            }),
        ).rejects.toThrow(/AUDITOR_NOT_INDEPENDENT: OWNER_LINE_UNDECLARED/);

        // And going ACTIVE: an independent auditor whose owner then takes on
        // an audited agent cannot be stamped ACTIVE by a raw UPDATE.
        const reg = await registerAuditor(T1, 'second');
        await score(reg.id);
        await makeAudited(T1, 'second', 'DRAFT');
        await expect(
            prisma.registeredAgent.update({ where: { id: reg.id }, data: { status: 'ACTIVE' } }),
        ).rejects.toThrow(/AUDITOR_NOT_INDEPENDENT: OWNER_OWNS_AUDITED_AGENT/);
    });
});

describe('the usecase and the trigger read the same rule under the same lock', () => {
    it('the trigger locks the key the usecases lock', async () => {
        const [fn] = await prisma.$queryRaw<Array<{ src: string }>>`
            SELECT prosrc AS src FROM pg_proc WHERE proname = 'registered_agent_auditor_independence'`;
        expect(auditorIndependenceLockKey(T1)).toBe(`auditor-independence:${T1}`);
        expect(fn.src).toContain(`hashtext('auditor-independence:' || NEW."tenantId")`);
    });

    it('evaluates an owner as the auditor sees them, leaving the auditor itself out', async () => {
        const own = await makeAudited(T1, 'second', 'DRAFT');
        const verdict = (agentId: string | null) =>
            runInTenantContext(ctxAs(T1, 'admin'), (db) =>
                evaluateOwnerIndependenceInTx(db, ctxAs(T1, 'admin'), { ownerUserId: users[T1].second, agentId }),
            );
        expect(await verdict(own.id)).toEqual({ independent: true });
        expect(await verdict(null)).toMatchObject({
            independent: false,
            reasons: ['OWNER_OWNS_AUDITED_AGENT'],
            auditedAgentIds: [own.id],
        });
    });
});

// ─── Activation ─────────────────────────────────────────────────────

describe('an auditor agent is refused at activation unless its owner is independent', () => {
    it('activates an auditor whose owner is independent', async () => {
        const reg = await activeAuditor(T1, 'second');
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe('ACTIVE');
    });

    it('refuses once the owner owns an audited agent — and nothing moves', async () => {
        const reg = await registerAuditor(T1, 'second');
        await score(reg.id);
        await makeAudited(T1, 'second', 'SUSPENDED');
        await expectNotIndependent(activateRegisteredAgent(ctxAs(T1, 'admin'), reg.id), [
            'OWNER_OWNS_AUDITED_AGENT',
        ]);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe('DRAFT');
    });

    it('refuses once an OWNER clears the owner\'s line: NULL never satisfies it', async () => {
        const reg = await registerAuditor(T1, 'second');
        await score(reg.id);
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), (await membershipOf(T1, 'second')).id, {
            lineOfDefence: null,
        });
        await expectNotIndependent(activateRegisteredAgent(ctxAs(T1, 'admin'), reg.id), ['OWNER_LINE_UNDECLARED']);
    });

    it('refuses once the owner is moved to FIRST', async () => {
        const reg = await registerAuditor(T1, 'second');
        await score(reg.id);
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), (await membershipOf(T1, 'second')).id, {
            lineOfDefence: 'FIRST',
        });
        await expectNotIndependent(activateRegisteredAgent(ctxAs(T1, 'admin'), reg.id), ['OWNER_NOT_SECOND_LINE']);
    });

    it('re-asks the check when a suspended auditor comes back', async () => {
        const reg = await activeAuditor(T1, 'second');
        await suspendRegisteredAgent(ctxAs(T1, 'admin'), reg.id);
        await makeAudited(T1, 'second', 'DRAFT');
        await expectNotIndependent(activateRegisteredAgent(ctxAs(T1, 'admin'), reg.id), [
            'OWNER_OWNS_AUDITED_AGENT',
        ]);
    });
});

// ─── A later change raises a finding ────────────────────────────────

describe('a later change that breaks independence raises a finding, and suspends nothing', () => {
    it('an audited agent transferred TO the auditor\'s owner raises one HIGH finding', async () => {
        const auditor = await activeAuditor(T1, 'secondOwner');
        const audited = await makeAudited(T1, 'ownerA', 'ACTIVE');
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), audited.id, {
            toOwnerUserId: users[T1].secondOwner,
        });
        const done = await completeAgentOwnershipTransfer(ctxAs(T1, 'secondOwner'), audited.id, {
            transferId: proposed.id,
        });

        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ status: 'OPEN', severity: 'HIGH', type: 'NONCONFORMITY' });
        expect(findings[0].description).toContain('OWNER_OWNS_AUDITED_AGENT');
        expect(findings[0].description).toContain(audited.id);
        expect(done.independenceFindingIds).toEqual([findings[0].id]);
        // Not suspended: the issue asks for a finding.
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: auditor.id } })).status).toBe('ACTIVE');
        // The transfer itself stood.
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: audited.id } })).ownerUserId).toBe(
            users[T1].secondOwner,
        );
    });

    it('the auditor transferred to a FIRST-line owner raises a finding', async () => {
        const auditor = await activeAuditor(T1, 'secondOwner');
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'secondOwner'), auditor.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        await completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), auditor.id, { transferId: proposed.id });
        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(findings[0].description).toContain('OWNER_NOT_SECOND_LINE');
    });

    it('a transfer that leaves the auditor independent raises nothing', async () => {
        const auditor = await activeAuditor(T1, 'second');
        // An audited agent moving between two owners neither of whom owns an
        // auditor touches no auditor's standing.
        const audited = await makeAudited(T1, 'ownerA', 'ACTIVE');
        const proposed = await proposeAgentOwnershipTransfer(ctxAs(T1, 'ownerA'), audited.id, {
            toOwnerUserId: users[T1].ownerB,
        });
        const done = await completeAgentOwnershipTransfer(ctxAs(T1, 'ownerB'), audited.id, {
            transferId: proposed.id,
        });
        expect(done.independenceFindingIds).toEqual([]);
        expect(await independenceFindings(T1, auditor.id)).toHaveLength(0);
    });

    it("an OWNER moving the auditor owner's line off SECOND raises a finding; the change stands", async () => {
        const auditor = await activeAuditor(T1, 'second');
        const m = await membershipOf(T1, 'second');
        const result = await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), m.id, { lineOfDefence: 'THIRD' });
        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(findings[0].description).toContain('OWNER_NOT_SECOND_LINE');
        expect(result).toMatchObject({ changed: true, lineOfDefence: 'THIRD', independenceFindingIds: [findings[0].id] });
        expect((await membershipOf(T1, 'second')).lineOfDefence).toBe('THIRD');
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: auditor.id } })).status).toBe('ACTIVE');
    });

    it("registering an agent to an ACTIVE auditor's owner raises a finding, and through the intake's recipe too", async () => {
        const auditor = await activeAuditor(T1, 'second');
        const reg = await registerAgent(ctxAs(T1, 'admin'), {
            name: 'business agent',
            ...REG,
            ownerUserId: users[T1].second,
        });
        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(findings[0].description).toContain(reg.id);
        expect(reg.independenceFindingIds).toEqual([findings[0].id]);
    });

    it('unmarking another auditor of the same owner raises a finding against the one in service', async () => {
        const auditor = await activeAuditor(T1, 'second');
        const other = await registerAuditor(T1, 'second');
        expect(await independenceFindings(T1, auditor.id)).toHaveLength(0);
        const result = await updateRegisteredAgent(ctxAs(T1, 'admin'), other.id, { isAuditor: false });
        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(result.independenceFindingIds).toEqual([findings[0].id]);
        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: T1, entityId: other.id, action: 'AGENT_AUDITOR_UNMARKED' },
        });
        expect(audit).not.toBeNull();
    });

    it('one finding per auditor: a second break while it is open adds none, and a closed one reopens', async () => {
        const auditor = await activeAuditor(T1, 'second');
        await registerAgent(ctxAs(T1, 'admin'), { name: 'first break', ...REG, ownerUserId: users[T1].second });
        await registerAgent(ctxAs(T1, 'admin'), { name: 'second break', ...REG, ownerUserId: users[T1].second });
        const open = await independenceFindings(T1, auditor.id);
        expect(open).toHaveLength(1);

        await prisma.finding.update({ where: { id: open[0].id }, data: { status: 'CLOSED' } });
        await registerAgent(ctxAs(T1, 'admin'), { name: 'third break', ...REG, ownerUserId: users[T1].second });
        const after = await independenceFindings(T1, auditor.id);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: open[0].id, status: 'OPEN' });
    });

    it('a DRAFT auditor raises no finding: activation asks the whole rule again', async () => {
        const draft = await registerAuditor(T1, 'second');
        await registerAgent(ctxAs(T1, 'admin'), { name: 'audited', ...REG, ownerUserId: users[T1].second });
        expect(await independenceFindings(T1, draft.id)).toHaveLength(0);
    });

    it('retiring the audited agent does not close the finding: closing is a person\'s act', async () => {
        const auditor = await activeAuditor(T1, 'second');
        const reg = await registerAgent(ctxAs(T1, 'admin'), { name: 'audited', ...REG, ownerUserId: users[T1].second });
        await retireRegisteredAgent(ctxAs(T1, 'admin'), reg.id);
        const findings = await independenceFindings(T1, auditor.id);
        expect(findings).toHaveLength(1);
        expect(findings[0].status).toBe('OPEN');
    });

    it('a break in one tenant raises nothing in the other', async () => {
        const auditorT2 = await activeAuditor(T2, 'second');
        await activeAuditor(T1, 'second');
        await registerAgent(ctxAs(T1, 'admin'), { name: 'T1 audited', ...REG, ownerUserId: users[T1].second });
        expect(await independenceFindings(T2, auditorT2.id)).toHaveLength(0);
        expect(await prisma.finding.count({ where: { tenantId: T2 } })).toBe(0);
    });
});
