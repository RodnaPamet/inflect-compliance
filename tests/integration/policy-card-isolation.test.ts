/**
 * The agent POLICY CARD — tenant isolation, and the two properties that only a
 * real database can prove.
 *
 * Three things are under test here, and none of them can be established by a
 * unit test:
 *
 *   1. ISOLATION. A card is the machine-readable statement of how much authority
 *      one customer's agent holds. A cross-tenant read publishes what another
 *      customer's agents may reach; a cross-tenant WRITE sets it. Driven through
 *      the real usecases under two tenant contexts, plus raw reads under
 *      `app_user` with and without a tenant bound.
 *
 *   2. APPEND-ONLY. A version row is pinned by the runs and proposals that
 *      executed under it, so editing one rewrites what the rules WERE. The
 *      property is enforced twice — no `UPDATE` privilege for `app_user`, and a
 *      trigger that refuses one from ANY role — and both halves are asserted,
 *      because either alone would leave the other's absence invisible.
 *
 *   3. THE LADDER, THROUGH THE REAL WRITE PATH. `checkLadderStep` is unit-tested
 *      on values; this asserts the usecase actually asks it, and that a refused
 *      edit leaves NO new version behind — a ladder that refuses the response
 *      while writing the row would pass any assertion about the error alone.
 *
 *   4. THE PIN RESOLVER'S OWN SCOPE. `resolvePolicyCardPin` is what stamps a
 *      version onto a `WorkflowRun` or an `AgentProposal`, and like the
 *      boundary's read it runs with no `RequestContext` — so its `tenantId`
 *      argument is the only isolation it has. Asserted directly rather than
 *      inferred from the usecase's, because the two take different paths to the
 *      same table.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    createAgentPolicyCard,
    getAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { loadPolicyCardInForce, reserveDailyAction } from '@/lib/agentic/policy-card-store';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';

/**
 * Every escalation trigger, spelled out.
 *
 * Not decoration: DROPPING a trigger is a WIDENING (the card stops asking to be
 * told), so an edit below that quietly shortened this list would be refused by
 * the ladder for a reason that has nothing to do with what the test is about.
 * Learned the hard way — the first draft of the append-only test dropped four of
 * them and failed on the ladder instead of proving anything about immutability.
 */
const ALL_TRIGGERS = [
    'TOOL_NOT_PERMITTED',
    'DATA_SCOPE_EXCEEDED',
    'AUTONOMY_EXCEEDED',
    'RUN_ACTION_CAP_EXCEEDED',
    'DAILY_ACTION_CAP_EXCEEDED',
] as const;

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'policycard-tenant-one';
const T2 = 'policycard-tenant-two';

/** `app_user` with NO tenant bound — the "context never got set" case. */
async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** `app_user` bound to one tenant — what a real request looks like. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
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
    await prisma.agentPolicyCardVersion.deleteMany({ where: t });
    await prisma.agentPolicyCard.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { agentId: string; aiSystemId: string; ownerUserId: string; cardId: string }> = {};

/**
 * The version currently in force for tenant one, read fresh.
 *
 * Every edit below composes against this rather than a hard-coded number. A
 * literal would couple each test to how many edits the tests above it happened
 * to make — so running one test on its own, or adding a case in the middle,
 * would fail on the stale-version conflict instead of on what the test is about.
 */
async function headVersion(tenantId = T1): Promise<number> {
    const head = await prisma.agentPolicyCard.findUnique({
        where: { tenantId_agentId: { tenantId, agentId: seeded[tenantId].agentId } },
        select: { currentVersion: true },
    });
    return head?.currentVersion ?? 0;
}
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
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: user.id },
        });
        seeded[id] = { agentId: '', aiSystemId: aiSystem.id, ownerUserId: user.id, cardId: '' };
    }

    for (const t of [T1, T2]) {
        const created = await createRegisteredAgent(ctxFor(t), {
            aiSystemId: seeded[t].aiSystemId,
            name: `Ops agent ${t}`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: seeded[t].ownerUserId,
        });
        seeded[t].agentId = created.id;

        // A card is refused for an UNSCORED agent — the tier is where its
        // autonomy cap, its budgets and its approval rung all come from. The
        // scorer is exercised in `agent-assessment-isolation.test.ts`; here the
        // tier is set directly so this suite is about the card.
        await prisma.registeredAgent.update({
            where: { id: created.id },
            data: { riskTier: 'LOW', riskTierScoredAt: new Date() },
        });

        // One granted tool per tenant, so the seeded card is not empty and a
        // leak between the two lists would be legible.
        await prisma.registeredAgentTool.create({
            data: {
                tenantId: t,
                agentId: created.id,
                toolName: 'list_risks',
                grantedByUserId: seeded[t].ownerUserId,
            },
        });

        const card = await createAgentPolicyCard(ctxFor(t), created.id);
        seeded[t].cardId = card.cardId;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a policy card belongs to exactly one tenant', () => {
    it('BOTH tenants really have a card — otherwise every assertion below is vacuous', async () => {
        const cards = await prisma.agentPolicyCard.findMany({
            where: { tenantId: { in: [T1, T2] } },
        });
        expect(cards).toHaveLength(2);
        const versions = await prisma.agentPolicyCardVersion.findMany({
            where: { tenantId: { in: [T1, T2] } },
        });
        expect(versions).toHaveLength(2);
        expect(versions.every((v) => v.version === 1 && v.seeded)).toBe(true);
    });

    it("tenant B cannot READ tenant A's card through the usecase", async () => {
        await expect(
            getAgentPolicyCard(ctxFor(T2), seeded[T1].agentId),
        ).rejects.toThrow(/not found/i);
    });

    it("tenant B cannot EDIT tenant A's card through the usecase", async () => {
        await expect(
            updateAgentPolicyCard(ctxFor(T2), seeded[T1].agentId, {
                expectedVersion: 1,
                card: {
                    permittedTools: [],
                    maxDataScope: 'NONE',
                    maxAutonomyLevel: 0,
                    maxActionsPerRun: 0,
                    maxActionsPerDay: 0,
                    escalationTriggers: [],
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).rejects.toThrow(/not found/i);

        // …and tenant A's card is untouched, which the rejection alone does not
        // establish: a write that threw AFTER landing would look identical.
        const stillOne = await prisma.agentPolicyCard.findUnique({
            where: { tenantId_agentId: { tenantId: T1, agentId: seeded[T1].agentId } },
            select: { currentVersion: true },
        });
        expect(stillOne?.currentVersion).toBe(1);
    });

    it('an app_user session with NO tenant context reads ZERO rows from both tables', async () => {
        const [cards, versions] = await asAppUserWithNoTenant(async (tx) => [
            await tx.agentPolicyCard.findMany(),
            await tx.agentPolicyCardVersion.findMany(),
        ]);
        expect(cards).toHaveLength(0);
        expect(versions).toHaveLength(0);
    });

    it('a tenant-bound app_user reads its own card and only its own', async () => {
        const one = await asTenant(T1, (tx) => tx.agentPolicyCard.findMany());
        expect(one).toHaveLength(1);
        expect(one[0].tenantId).toBe(T1);

        const two = await asTenant(T2, (tx) => tx.agentPolicyCardVersion.findMany());
        expect(two).toHaveLength(1);
        expect(two[0].tenantId).toBe(T2);
    });

    it("the boundary's own uncached read is tenant-scoped too", async () => {
        // `loadPolicyCardInForce` runs at the MCP tool boundary with no
        // `RequestContext` and therefore no tenant transaction — the `tenantId`
        // predicate is the ONLY isolation on that path, so it is asserted
        // directly rather than inferred from the usecase's.
        await expect(loadPolicyCardInForce(T1, seeded[T1].agentId)).resolves.toMatchObject({
            version: 1,
        });
        await expect(loadPolicyCardInForce(T2, seeded[T1].agentId)).resolves.toBeNull();
    });

    it("the daily reservation refuses to spend another tenant's budget", async () => {
        // MAX_SAFE_INTEGER is the "matched no row" answer, and it refuses rather
        // than passes — the fail direction that makes an unreservable budget
        // safe.
        await expect(reserveDailyAction(T2, seeded[T1].cardId, new Date())).resolves.toBe(
            Number.MAX_SAFE_INTEGER,
        );
        await expect(reserveDailyAction(T1, seeded[T1].cardId, new Date())).resolves.toBe(1);
        await expect(reserveDailyAction(T1, seeded[T1].cardId, new Date())).resolves.toBe(2);
    });
});

describe('a version row is APPEND-ONLY, at two levels', () => {
    it('the trigger refuses an UPDATE even from the privileged role', async () => {
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "AgentPolicyCardVersion" SET "maxAutonomyLevel" = 6 WHERE "tenantId" = $1`,
                T1,
            ),
        ).rejects.toThrow(/IMMUTABLE_POLICY_CARD_VERSION/);
    });

    it('and app_user holds no UPDATE privilege on the table at all', async () => {
        // Belt and braces, and they cover different paths: the privilege stops
        // the ordinary application, the trigger stops migrations, scripts and a
        // superuser session. A test for only one of them would stay green while
        // the other was removed.
        await expect(
            asTenant(T1, (tx) =>
                tx.$executeRawUnsafe(
                    `UPDATE "AgentPolicyCardVersion" SET "maxAutonomyLevel" = 6`,
                ),
            ),
        ).rejects.toThrow(/permission denied|IMMUTABLE_POLICY_CARD_VERSION/i);
    });

    it('so an edit APPENDS — the old version is still readable, verbatim', async () => {
        const before = await prisma.agentPolicyCardVersion.findFirst({
            where: { tenantId: T1, version: 1 },
        });
        expect(before?.maxAutonomyLevel).toBe(4);

        const at = await headVersion();
        await updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
            expectedVersion: at,
            card: {
                permittedTools: ['list_risks'],
                maxDataScope: 'READ_TENANT_DATA',
                // One rung DOWN. Narrowing, so the ladder does not object.
                maxAutonomyLevel: 3,
                maxActionsPerRun: 50,
                maxActionsPerDay: 500,
                escalationTriggers: ALL_TRIGGERS,
                approvalRung: 'SECOND_APPROVER',
            },
        });

        const after = await prisma.agentPolicyCardVersion.findFirst({
            where: { tenantId: T1, version: 1 },
        });
        expect(after).toEqual(before);

        const head = await prisma.agentPolicyCard.findUnique({
            where: { tenantId_agentId: { tenantId: T1, agentId: seeded[T1].agentId } },
            select: { currentVersion: true },
        });
        expect(head?.currentVersion).toBe(at + 1);
    });
});

describe('the ladder is enforced on the real write path', () => {
    it('a TWO-rung widen is refused AND leaves no version behind', async () => {
        const versionsBefore = await prisma.agentPolicyCardVersion.count({
            where: { tenantId: T1 },
        });
        const at = await headVersion();

        await expect(
            updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
                expectedVersion: at,
                card: {
                    permittedTools: ['list_risks'],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 3,
                    // 50 → 250 on the action-cap ladder. TWO rungs, and a 5x
                    // increase in authority that would have had no rung count at
                    // all if the budget were compared as a plain integer.
                    //
                    // Deliberately not the autonomy dimension: 3 → 5 would trip
                    // the TIER cap first (LOW stops at 4) and the assertion
                    // would pass on the wrong refusal.
                    maxActionsPerRun: 250,
                    maxActionsPerDay: 500,
                    escalationTriggers: ALL_TRIGGERS,
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).rejects.toThrow(/one rung at a time/);

        // The half a message alone would not catch: a refusal that still wrote
        // the row, or still moved the head.
        expect(await prisma.agentPolicyCardVersion.count({ where: { tenantId: T1 } })).toBe(
            versionsBefore,
        );
        const head = await prisma.agentPolicyCard.findUnique({
            where: { tenantId_agentId: { tenantId: T1, agentId: seeded[T1].agentId } },
            select: { currentVersion: true },
        });
        expect(head?.currentVersion).toBe(at);
    });

    it('an edit composed against a STALE version is refused', async () => {
        const stale = (await headVersion()) - 1;
        await expect(
            updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
                expectedVersion: stale,
                card: {
                    permittedTools: ['list_risks'],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 3,
                    maxActionsPerRun: 50,
                    maxActionsPerDay: 500,
                    escalationTriggers: ALL_TRIGGERS,
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).rejects.toThrow(new RegExp(`composed against version ${stale}`));
    });

    it('a card cannot be widened past the tier cap the boundary already enforces', async () => {
        // LOW caps autonomy at 4. A card naming 5 is a promise the tool boundary
        // breaks on the first call, so it is refused where it is written.
        const at = await headVersion();
        await expect(
            updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
                expectedVersion: at,
                card: {
                    permittedTools: ['list_risks'],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 4,
                    maxActionsPerRun: 50,
                    maxActionsPerDay: 500,
                    escalationTriggers: ALL_TRIGGERS,
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).resolves.toMatchObject({ version: at + 1 });

        await expect(
            updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
                expectedVersion: at + 1,
                card: {
                    permittedTools: ['list_risks'],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 5,
                    maxActionsPerRun: 50,
                    maxActionsPerDay: 500,
                    escalationTriggers: ALL_TRIGGERS,
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).rejects.toThrow(/caps it at 4/);
    });

    it('a card may not permit a tool its own ceilings would refuse on every call', async () => {
        await expect(
            updateAgentPolicyCard(ctxFor(T1), seeded[T1].agentId, {
                expectedVersion: await headVersion(),
                card: {
                    // `list_risks` reaches READ_TENANT_DATA on every call, so a
                    // metadata ceiling makes the grant permanently inert.
                    permittedTools: ['list_risks'],
                    maxDataScope: 'READ_METADATA',
                    maxAutonomyLevel: 4,
                    maxActionsPerRun: 50,
                    maxActionsPerDay: 500,
                    escalationTriggers: ALL_TRIGGERS,
                    approvalRung: 'SECOND_APPROVER',
                },
            }),
        ).rejects.toThrow(/refuses on every call/);
    });
});

describe('creating a card', () => {
    it('is refused for an UNSCORED agent', async () => {
        const agent = await createRegisteredAgent(ctxFor(T2), {
            aiSystemId: (
                await prisma.aiSystem.create({
                    data: { tenantId: T2, name: 'Second host', ownerUserId: seeded[T2].ownerUserId },
                })
            ).id,
            name: 'Unscored agent',
            autonomyLevel: 2,
            dataAccessScope: 'READ_METADATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: seeded[T2].ownerUserId,
        });

        await expect(createAgentPolicyCard(ctxFor(T2), agent.id)).rejects.toThrow(
            /has not been risk-assessed/,
        );
        expect(
            await prisma.agentPolicyCard.count({ where: { tenantId: T2, agentId: agent.id } }),
        ).toBe(0);
    });

    it('is refused twice for the same agent', async () => {
        await expect(createAgentPolicyCard(ctxFor(T2), seeded[T2].agentId)).rejects.toThrow(
            /already has a policy card/,
        );
    });
});

describe('the version pin resolves within one tenant and no further', () => {
    it("each tenant's agent resolves to its OWN card version", async () => {
        // Both cards are at version 1 here, which is exactly why the negative
        // case below is the load-bearing one: equal numbers cannot distinguish
        // "read the right card" from "read any card".
        await expect(resolvePolicyCardPin(T1, seeded[T1].agentId)).resolves.toBe(
            await headVersion(T1),
        );
        await expect(resolvePolicyCardPin(T2, seeded[T2].agentId)).resolves.toBe(
            await headVersion(T2),
        );
    });

    it("tenant A's id with tenant B's agent resolves to NO card, not to B's version", async () => {
        // The pin is written onto a row that is then read back as evidence. A
        // resolver that ignored its tenant argument would stamp one customer's
        // policy version onto another customer's run — and because both cards
        // are at version 1, the wrong answer here would be numerically
        // indistinguishable from the right one on any single-tenant fixture.
        await expect(resolvePolicyCardPin(T1, seeded[T2].agentId)).resolves.toBe(NO_POLICY_CARD);
        await expect(resolvePolicyCardPin(T2, seeded[T1].agentId)).resolves.toBe(NO_POLICY_CARD);
    });

    it('an absent agent resolves to NO card without a query', async () => {
        // The human path — a workflow run somebody started, or the in-product
        // assistant. It records the sentinel rather than NULL, because "no card
        // governed this" is a fact about the row and NULL is a fact about when
        // the code was deployed.
        await expect(resolvePolicyCardPin(T1, null)).resolves.toBe(NO_POLICY_CARD);
        await expect(resolvePolicyCardPin(T1, undefined)).resolves.toBe(NO_POLICY_CARD);
    });
});
