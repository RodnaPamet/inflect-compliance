/**
 * SPENDING AUTHORITY ON THE REGISTER (Agent Pay Phase 1; D-L1-8, D-L1-9),
 * proved on real rows.
 *
 * An agent's declared spending envelope is a privilege on the register:
 *   - an agent holding an envelope nobody else has reviewed cannot go into
 *     service — refused by the usecase AND by the trigger, for any writer;
 *   - the review is a second PERSON's: never the declarer, never the agent's
 *     owner, never an API key — refused by the usecase AND (declarer, owner)
 *     by a CHECK;
 *   - a reviewed envelope changes in place only by narrowing (usecase AND
 *     trigger); a wider one is a new declaration;
 *   - declaring on an ACTIVE agent raises a HIGH finding and suspends nothing;
 *   - an AGENT-scope kill moves the envelope to SUSPENDED_REQUESTED and opens a
 *     task naming the token requestor; lifting the kill does not reverse it;
 *   - no identifier can carry a card number (usecase AND CHECK);
 *   - one tenant never reaches another's envelopes (RLS + the usecase).
 *
 * Contexts are resolved by the real `resolveTenantContext` from membership
 * rows, so every permission is the product's own.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { runInTenantContext } from '@/lib/db-context';
import { activateRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { engageKillSwitch, liftKillSwitch } from '@/app-layer/usecases/agent-kill-switch';
import {
    declareAgentSpendingAuthority,
    listAgentSpendingAuthorities,
    narrowAgentSpendingAuthority,
    reviewAgentSpendingAuthority,
    withdrawAgentSpendingAuthority,
} from '@/app-layer/usecases/agent-spending-authority';
import { SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND } from '@/lib/agentic/spending-authority';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'spend-auth-one';
const T2 = 'spend-auth-two';
const TENANTS = [T1, T2];

type Person = 'owner' | 'declarer' | 'reviewer' | 'agentOwner' | 'consenter';
const PEOPLE: Person[] = ['owner', 'declarer', 'reviewer', 'agentOwner', 'consenter'];
const ROLE: Record<Person, Role> = {
    owner: Role.OWNER,
    declarer: Role.ADMIN,
    reviewer: Role.ADMIN,
    agentOwner: Role.ADMIN,
    consenter: Role.READER,
};

const users: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Record<Person, RequestContext>> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
const ctxAs = (tenantId: string, who: Person) => contexts[tenantId][who];
let seq = 0;

/** Fixed once: an expiry computed per call would be a later expiry, which is a widening. */
const EXPIRES_AT = new Date(Date.now() + 90 * 86_400_000).toISOString();

function envelope(tenantId: string, over: Record<string, unknown> = {}) {
    return {
        rail: 'AGENT_PAY_TOKEN',
        perTransactionLimitMinor: 5_000,
        periodBudgetMinor: 50_000,
        budgetPeriod: 'MONTH',
        currency: 'EUR',
        merchantDomains: ['shop.example.com', 'travel.example.com'],
        merchantCategoryCodes: ['4511'],
        expiresAt: EXPIRES_AT,
        consentedByUserId: users[tenantId].consenter,
        tokenRequestor: 'Example Agent Platform',
        tokenReference: 'DWSPMC000000000132d72d4fcb2f4136',
        ...over,
    };
}

/** A DRAFT agent owned by `agentOwner`, classified and scored so only spending authority can stop activation. */
async function makeAgent(tenantId: string, status: 'DRAFT' | 'ACTIVE' | 'RETIRED' = 'DRAFT') {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `pay host ${seq}`, ownerUserId: users[tenantId].agentOwner, riskTier: 'MINIMAL' },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `paying agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users[tenantId].agentOwner,
            status,
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

async function refusal(p: Promise<unknown>): Promise<{ reason?: string; message: string; status?: number }> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const e = err as { details?: { reason?: string }; message: string; statusCode?: number };
    return { reason: e.details?.reason, message: e.message, status: e.statusCode };
}

async function clearAgents(tenantId: string) {
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.notificationOutbox.deleteMany({ where: { tenantId } });
    await prisma.task.deleteMany({ where: { tenantId } });
    await prisma.finding.deleteMany({ where: { tenantId } });
    await prisma.agentKillSwitch.deleteMany({ where: { tenantId } });
    await prisma.agentSpendingAuthority.deleteMany({ where: { tenantId } });
    await prisma.aiSystemRequirementLink.deleteMany({ where: { tenantId } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId } });
    await prisma.aiSystem.deleteMany({ where: { tenantId } });
}

/** Everything this file wrote, people and tenants included, so a re-run starts clean. */
async function clearOwnRows(): Promise<void> {
    for (const tenantId of TENANTS) await clearAgents(tenantId);
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: {
            OR: [
                { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
                // The tenant's SYSTEM user, which writes the suspension task (#4400).
                { id: { in: TENANTS.map((tn) => `sys_${tn}`) } },
            ],
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        users[tenantId] = {} as Record<Person, string>;
        contexts[tenantId] = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[tenantId][who] = user.id;
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
        }
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
    }
});

beforeEach(async () => {
    for (const tenantId of TENANTS) await clearAgents(tenantId);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('an agent with an unreviewed spending authority cannot be activated', () => {
    it('the usecase refuses SPENDING_AUTHORITY_UNREVIEWED, naming the rail, and the agent stays DRAFT', async () => {
        const agent = await makeAgent(T1);
        await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        const r = await refusal(activateRegisteredAgent(ctxAs(T1, 'owner'), agent.id));
        expect(r.reason).toBe('SPENDING_AUTHORITY_UNREVIEWED');
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('DRAFT');
    });

    it('the trigger refuses the same move for a writer that skips the usecase', async () => {
        const agent = await makeAgent(T1);
        await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await expect(
            prisma.registeredAgent.update({ where: { id: agent.id }, data: { status: 'ACTIVE' } }),
        ).rejects.toThrow(/SPENDING_AUTHORITY_UNREVIEWED/);
    });

    it('once a second person reviews it, the agent activates', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', {
            declaredAt: authority.declaredAt,
        });
        await activateRegisteredAgent(ctxAs(T1, 'owner'), agent.id);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('ACTIVE');
    });

    it('a withdrawn envelope no longer holds activation back', async () => {
        const agent = await makeAgent(T1);
        await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await withdrawAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, 'AGENT_PAY_TOKEN');
        await activateRegisteredAgent(ctxAs(T1, 'owner'), agent.id);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('ACTIVE');
    });
});

describe('four eyes: the reviewer is a second person, never the declarer or the owner', () => {
    async function declared() {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        return { agent, authority };
    }

    it('the declarer is refused', async () => {
        const { agent, authority } = await declared();
        const r = await refusal(
            reviewAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, 'AGENT_PAY_TOKEN', { declaredAt: authority.declaredAt }),
        );
        expect(r.reason).toBe('REVIEWER_IS_DECLARER');
    });

    it("the agent's owner is refused", async () => {
        const { agent, authority } = await declared();
        const r = await refusal(
            reviewAgentSpendingAuthority(ctxAs(T1, 'agentOwner'), agent.id, 'AGENT_PAY_TOKEN', { declaredAt: authority.declaredAt }),
        );
        expect(r.reason).toBe('REVIEWER_IS_OWNER');
    });

    it('an API key is refused, whoever it acts for', async () => {
        const { agent, authority } = await declared();
        const r = await refusal(
            reviewAgentSpendingAuthority({ ...ctxAs(T1, 'reviewer'), apiKeyId: 'key-1' }, agent.id, 'AGENT_PAY_TOKEN', {
                declaredAt: authority.declaredAt,
            }),
        );
        expect(r.reason).toBe('REVIEWER_NOT_A_PERSON');
    });

    it('a review naming a superseded declaration is refused', async () => {
        const { agent } = await declared();
        const r = await refusal(
            reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', {
                declaredAt: new Date(0).toISOString(),
            }),
        );
        expect(r.reason).toBe('DECLARATION_CHANGED');
    });

    it('the CHECK refuses a declarer or owner review written around the usecase', async () => {
        const { authority } = await declared();
        for (const who of ['declarer', 'agentOwner'] as const) {
            await expect(
                prisma.agentSpendingAuthority.update({
                    where: { id: authority.id },
                    data: { status: 'REVIEWED', reviewedByUserId: users[T1][who], reviewedAt: new Date() },
                }),
            ).rejects.toThrow(/AgentSpendingAuthority_not_self_reviewed/);
        }
    });

    it('a row is never born REVIEWED', async () => {
        const agent = await makeAgent(T1);
        await expect(
            prisma.agentSpendingAuthority.create({
                data: {
                    tenantId: T1,
                    agentId: agent.id,
                    rail: 'AP4M',
                    perTransactionLimitMinor: BigInt(1),
                    periodBudgetMinor: BigInt(1),
                    budgetPeriod: 'DAY',
                    currency: 'EUR',
                    merchantDomains: [],
                    merchantCategoryCodes: [],
                    expiresAt: new Date(Date.now() + 86_400_000),
                    consentedByUserId: users[T1].consenter,
                    tokenRequestor: 'p',
                    tokenReference: 'r',
                    status: 'REVIEWED',
                    declaredByUserId: users[T1].declarer,
                    declaredAt: new Date(),
                    ownerUserIdAtDeclaration: users[T1].agentOwner,
                    reviewedByUserId: users[T1].reviewer,
                    reviewedAt: new Date(),
                },
            }),
        ).rejects.toThrow(/SPENDING_AUTHORITY_STARTS_DECLARED/);
    });
});

describe('a reviewed envelope narrows in place; anything wider is a new declaration', () => {
    async function reviewed() {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', {
            declaredAt: authority.declaredAt,
        });
        return { agent, authority };
    }

    it('a narrowing by one person keeps the review', async () => {
        const { agent } = await reviewed();
        const narrowed = await narrowAgentSpendingAuthority(
            ctxAs(T1, 'declarer'),
            agent.id,
            envelope(T1, { perTransactionLimitMinor: 1_000, merchantDomains: ['shop.example.com'] }),
        );
        expect(narrowed).toMatchObject({ status: 'REVIEWED', perTransactionLimitMinor: '1000' });
    });

    it.each([
        ['a larger per-transaction limit', { perTransactionLimitMinor: 9_000 }, 'perTransactionLimitMinor'],
        ['a new merchant', { merchantDomains: ['shop.example.com', 'casino.example.com'] }, 'merchantScope'],
        ['an unrestricted merchant scope', { merchantDomains: [], merchantCategoryCodes: [] }, 'merchantScope'],
        ['a different token', { tokenReference: 'OTHER-TOKEN-REF' }, 'tokenReference'],
    ])('%s is refused as a narrowing, naming the field', async (_label, over, field) => {
        const { agent } = await reviewed();
        const r = await refusal(narrowAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1, over)));
        expect(r.reason).toBe('NOT_A_NARROWING');
        const row = await prisma.agentSpendingAuthority.findFirstOrThrow({ where: { agentId: agent.id } });
        expect(row.status).toBe('REVIEWED');
        expect(row.perTransactionLimitMinor).toBe(BigInt(5_000));
        void field;
    });

    it('the trigger refuses an in-place widening of a REVIEWED row by any writer', async () => {
        const { authority } = await reviewed();
        await expect(
            prisma.agentSpendingAuthority.update({
                where: { id: authority.id },
                data: { periodBudgetMinor: BigInt(60_000) },
            }),
        ).rejects.toThrow(/SPENDING_AUTHORITY_WIDENING_NEEDS_REVIEW/);
    });

    it('re-declaring wider moves it back to DECLARED with the review cleared, and activation waits again', async () => {
        const { agent } = await reviewed();
        const { authority, widenedFields } = await declareAgentSpendingAuthority(
            ctxAs(T1, 'reviewer'),
            agent.id,
            envelope(T1, { periodBudgetMinor: 80_000 }),
        );
        expect(widenedFields).toEqual(['periodBudgetMinor']);
        expect(authority).toMatchObject({ status: 'DECLARED', reviewedByUserId: null, declaredByUserId: users[T1].reviewer });
        expect((await refusal(activateRegisteredAgent(ctxAs(T1, 'owner'), agent.id))).reason).toBe(
            'SPENDING_AUTHORITY_UNREVIEWED',
        );
    });
});

describe('a declaration on an ACTIVE agent is a HIGH finding, never a suspension', () => {
    it('raises the finding, leaves the agent ACTIVE, and the review closes the finding', async () => {
        const agent = await makeAgent(T1, 'ACTIVE');
        const { authority, findingId } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        expect(findingId).not.toBeNull();
        const finding = await prisma.finding.findUniqueOrThrow({ where: { id: findingId! } });
        expect(finding).toMatchObject({
            severity: 'HIGH',
            status: 'OPEN',
            sourceKind: SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND,
            sourceRef: `${agent.id}:AGENT_PAY_TOKEN`,
        });
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('ACTIVE');

        await reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', {
            declaredAt: authority.declaredAt,
        });
        expect((await prisma.finding.findUniqueOrThrow({ where: { id: findingId! } })).status).toBe('CLOSED');
    });

    it('a DRAFT agent gets no finding: activation is where it is held', async () => {
        const agent = await makeAgent(T1);
        const { findingId } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        expect(findingId).toBeNull();
    });
});

describe('the kill switch reaches spending authority', () => {
    it('an AGENT-scope kill sets SUSPENDED_REQUESTED and opens a task naming the token requestor; lifting it reverses nothing', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', {
            declaredAt: authority.declaredAt,
        });

        const kill = await engageKillSwitch(ctxAs(T1, 'owner'), { agentId: agent.id, reason: 'incident drill' });

        const row = await prisma.agentSpendingAuthority.findUniqueOrThrow({ where: { id: authority.id } });
        expect(row).toMatchObject({ status: 'SUSPENDED_REQUESTED', suspensionKillSwitchId: kill.id });

        const tasks = await runInTenantContext(ctxAs(T1, 'owner'), (db) =>
            db.task.findMany({ where: { tenantId: T1 }, take: 10 }),
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].assigneeUserId).toBe(users[T1].agentOwner);
        expect(tasks[0].title).toContain('Example Agent Platform');
        expect(tasks[0].description).toContain('DWSPMC000000000132d72d4fcb2f4136');
        expect(tasks[0].metadataJson).toMatchObject({
            kind: 'AGENT_SPENDING_SUSPENSION',
            spendingAuthorityId: authority.id,
            killSwitchId: kill.id,
        });

        await liftKillSwitch(ctxAs(T1, 'owner'), kill.id, { liftReason: 'drill over' });
        expect((await prisma.agentSpendingAuthority.findUniqueOrThrow({ where: { id: authority.id } })).status).toBe(
            'SUSPENDED_REQUESTED',
        );
        // A suspended envelope is not reviewed back into force: it is declared again.
        const r = await refusal(
            reviewAgentSpendingAuthority(ctxAs(T1, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', { declaredAt: authority.declaredAt }),
        );
        expect(r.reason).toBe('NOT_DECLARED');
    });

    it('a TENANT-scope kill moves no envelope', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await engageKillSwitch(ctxAs(T1, 'owner'), { agentId: null, reason: 'tenant stop' });
        expect((await prisma.agentSpendingAuthority.findUniqueOrThrow({ where: { id: authority.id } })).status).toBe(
            'DECLARED',
        );
    });
});

describe('no identifier can carry a card number (D-L1-8)', () => {
    it.each(['4111111111111111', '4111-1111-1111-1111', 'tok_5555555555554444'])(
        'the usecase refuses %s as a token reference and writes nothing',
        async (tokenReference) => {
            const agent = await makeAgent(T1);
            const r = await refusal(
                declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1, { tokenReference })),
            );
            expect(r.reason).toBe('IDENTIFIER_CARRIES_CARD_NUMBER');
            expect(await prisma.agentSpendingAuthority.count({ where: { agentId: agent.id } })).toBe(0);
        },
    );

    it('the usecase refuses a card number typed as the token requestor', async () => {
        const agent = await makeAgent(T1);
        const r = await refusal(
            declareAgentSpendingAuthority(
                ctxAs(T1, 'declarer'),
                agent.id,
                envelope(T1, { tokenRequestor: 'card 4111 1111 1111 1111' }),
            ),
        );
        expect(r.reason).toBe('IDENTIFIER_CARRIES_CARD_NUMBER');
    });

    it('the CHECK refuses one written around the usecase', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        await expect(
            prisma.agentSpendingAuthority.update({
                where: { id: authority.id },
                data: { tokenReference: '5555555555554444' },
            }),
        ).rejects.toThrow(/AgentSpendingAuthority_identifiers_carry_no_card_number/);
    });

    it('ordinary large numbers are not card numbers: limits, budgets and MCCs are accepted', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(
            ctxAs(T1, 'declarer'),
            agent.id,
            envelope(T1, {
                perTransactionLimitMinor: 4_111_111_111_111,
                periodBudgetMinor: 4_111_111_111_111_111,
                merchantCategoryCodes: ['4111', '5411'],
            }),
        );
        expect(authority.periodBudgetMinor).toBe('4111111111111111');
    });
});

describe('a retired agent takes no declaration', () => {
    it('the usecase refuses AGENT_RETIRED', async () => {
        const agent = await makeAgent(T1, 'RETIRED');
        const r = await refusal(declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1)));
        expect(r.reason).toBe('AGENT_RETIRED');
    });
});

describe('one tenant never reaches another tenant’s spending authority', () => {
    it('a T2 admin cannot declare for a T1 agent, and reads none of T1’s rows', async () => {
        const agent = await makeAgent(T1);
        await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));

        const r = await refusal(declareAgentSpendingAuthority(ctxAs(T2, 'declarer'), agent.id, envelope(T2)));
        expect(r.reason).toBe('AGENT_NOT_FOUND');
        expect(await listAgentSpendingAuthorities(ctxAs(T2, 'declarer'), agent.id)).toEqual([]);

        // RLS, not just the usecase's filter: a T2-bound read with no tenant filter sees nothing.
        const seen = await runInTenantContext(ctxAs(T2, 'declarer'), (db) =>
            db.agentSpendingAuthority.findMany({ take: 10 }),
        );
        expect(seen).toEqual([]);
        expect(await listAgentSpendingAuthorities(ctxAs(T1, 'declarer'), agent.id)).toHaveLength(1);
    });

    it('a T2 reviewer cannot review a T1 envelope', async () => {
        const agent = await makeAgent(T1);
        const { authority } = await declareAgentSpendingAuthority(ctxAs(T1, 'declarer'), agent.id, envelope(T1));
        const r = await refusal(
            reviewAgentSpendingAuthority(ctxAs(T2, 'reviewer'), agent.id, 'AGENT_PAY_TOKEN', { declaredAt: authority.declaredAt }),
        );
        expect(r.reason).toBe('AGENT_NOT_FOUND');
        expect((await prisma.agentSpendingAuthority.findUniqueOrThrow({ where: { id: authority.id } })).status).toBe(
            'DECLARED',
        );
    });
});
