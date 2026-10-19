/**
 * The monthly token budget's writer (#3777), proved on real rows.
 *
 *   - THE SETTER: `PATCH admin/agents/budget` is the only product path to the
 *     column, beside the concurrency cap and under its key. OWNER, ADMIN and
 *     AI_ADMIN set it; EDITOR, READER and AUDITOR are refused at the route with
 *     exactly one `AUTHZ_DENIED` row each; every change writes an audit row
 *     with both values.
 *   - THE BOUNDS: a budget above 0 and below one run's ceiling, a negative, and
 *     one past the maximum are refused and nothing is written.
 *   - THE READERS SEE IT: the budget gate refuses a run under a budget of 0 and
 *     admits one under a budget of one run's ceiling, and the GET reports this
 *     month's spend only where there is a budget.
 *   - TWO TENANTS: one tenant's budget never reaches the other.
 *
 * Only `getTenantCtx` is mocked, the one thing in the path that needs a
 * browser session; `requirePermission`, the audit writer and the gate are real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { GET, PATCH } from '@/app/api/t/[tenantSlug]/admin/agents/budget/route';
import { assertWithinMonthlyBudget } from '@/lib/agentic/monthly-budget-policy';
import { BUDGET_RUN_TOKEN_CEILING, MAX_MONTHLY_TOKEN_BUDGET } from '@/lib/agentic/monthly-budget';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `budget-a-${SUITE}`;
const B = `budget-b-${SUITE}`;
const TENANTS = [A, B];

const PEOPLE = ['owner', 'admin', 'aiAdmin', 'editor', 'reader', 'auditor'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE_OF: Record<Person, Role> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    aiAdmin: 'AI_ADMIN' as Role,
    editor: 'EDITOR',
    reader: 'READER',
    auditor: 'AUDITOR',
};
const users = {} as Record<Person, string>;
let bOwner = '';
const userIds: string[] = [];

function ctxAs(who: Person, tenantId = A): RequestContext {
    return makeRequestContext(ROLE_OF[who], { tenantId, tenantSlug: tenantId, userId: users[who] });
}

function patch(body: unknown, tenantSlug = A): NextRequest {
    return new NextRequest(`http://localhost/api/t/${tenantSlug}/admin/agents/budget`, {
        method: 'PATCH',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
}
const get = (tenantSlug = A) => new NextRequest(`http://localhost/api/t/${tenantSlug}/admin/agents/budget`);
const routeArgs = (tenantSlug = A) => ({ params: Promise.resolve({ tenantSlug }) });

const stored = async (tenantId = A) =>
    (await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { agentMonthlyTokenBudget: true } }))
        ?.agentMonthlyTokenBudget ?? null;
const countDenials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });
const budgetEvents = () =>
    prisma.auditLog.findMany({
        where: { tenantId: A, action: 'AGENT_MONTHLY_TOKEN_BUDGET_SET' },
        orderBy: { createdAt: 'asc' },
        take: 20,
    });

async function setAs(who: Person, budget: number | null) {
    getTenantCtxMock.mockResolvedValue(ctxAs(who));
    return PATCH(patch({ budget }), routeArgs());
}

async function person(tenantId: string, label: string, role: Role) {
    const email = `${label}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
    return user.id;
}

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of PEOPLE) users[who] = await person(A, who, ROLE_OF[who]);
    bOwner = await person(B, 'owner', 'OWNER');
});

afterAll(async () => {
    const t = { tenantId: { in: TENANTS } };
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('the setter: admin.agent_registry, at the route, audited', () => {
    it.each(['editor', 'reader', 'auditor'] as const)(
        '%s is refused with exactly one AUTHZ_DENIED row, and nothing is written',
        async (who) => {
            expect(ctxAs(who).appPermissions.admin.agent_registry).toBe(false);
            const before = await countDenials();
            const res = await setAs(who, 1_000_000);
            expect(res.status).toBe(403);
            expect((await countDenials()) - before).toBe(1);
            expect(await stored()).toBeNull();
        },
    );

    it.each(['owner', 'admin', 'aiAdmin'] as const)('%s sets it, and the column holds it', async (who) => {
        const value = { owner: 1_000_000, admin: 2_000_000, aiAdmin: 3_000_000 }[who];
        const res = await setAs(who, value);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ budget: value });
        expect(await stored()).toBe(value);
    });

    it('every change is audited with the value it replaced and the value it set', async () => {
        const events = await budgetEvents();
        expect(events.map((e) => e.detailsJson)).toEqual([
            { previousBudget: null, budget: 1_000_000 },
            { previousBudget: 1_000_000, budget: 2_000_000 },
            { previousBudget: 2_000_000, budget: 3_000_000 },
        ]);
        expect(events.map((e) => e.userId)).toEqual([users.owner, users.admin, users.aiAdmin]);
    });

    it('null clears it, which is "no budget", not zero', async () => {
        expect((await setAs('owner', null)).status).toBe(200);
        expect(await stored()).toBeNull();
        expect((await budgetEvents()).at(-1)?.detailsJson).toEqual({ previousBudget: 3_000_000, budget: null });
    });
});

describe('the bounds: a budget that can never admit a run is refused, and nothing is written', () => {
    it.each([
        ['one token below one run\'s ceiling', BUDGET_RUN_TOKEN_CEILING - 1],
        ['a single token', 1],
        ['a negative', -1],
        ['past the maximum', MAX_MONTHLY_TOKEN_BUDGET + 1],
    ])('%s', async (_label, value) => {
        const eventsBefore = (await budgetEvents()).length;
        const res = await setAs('owner', value);
        expect(res.status).toBe(400);
        expect(await stored()).toBeNull();
        expect((await budgetEvents()).length).toBe(eventsBefore);
    });

    it('a fractional budget is refused at the route\'s schema', async () => {
        expect((await setAs('owner', 250_000.5)).status).toBe(400);
        expect(await stored()).toBeNull();
    });
});

describe('the readers see what the setter wrote', () => {
    it('a budget of 0 refuses a run at the gate; one run\'s ceiling admits it', async () => {
        await setAs('owner', 0);
        await expect(assertWithinMonthlyBudget(ctxAs('owner'))).rejects.toThrow(/monthly_token_budget_exceeded/);

        await setAs('owner', BUDGET_RUN_TOKEN_CEILING);
        await expect(assertWithinMonthlyBudget(ctxAs('owner'))).resolves.toMatchObject({ allowed: true });
    });

    it('the GET reports this month\'s spend only where there is a budget', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        await expect((await GET(get(), routeArgs())).json()).resolves.toEqual({
            budget: BUDGET_RUN_TOKEN_CEILING,
            spentThisMonth: 0,
            runTokenCeiling: BUDGET_RUN_TOKEN_CEILING,
        });

        await setAs('owner', null);
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        await expect((await GET(get(), routeArgs())).json()).resolves.toMatchObject({ budget: null, spentThisMonth: null });
    });

    it('a reader holding only the view key cannot read it through the route either', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('auditor'));
        expect((await GET(get(), routeArgs())).status).toBe(403);
    });
});

describe('two tenants', () => {
    it('one tenant\'s budget never reaches the other', async () => {
        await setAs('owner', 4_000_000);
        expect(await stored(B)).toBeNull();

        const bCtx = makeRequestContext('OWNER', { tenantId: B, tenantSlug: B, userId: bOwner });
        getTenantCtxMock.mockResolvedValue(bCtx);
        expect((await PATCH(patch({ budget: 0 }, B), routeArgs(B))).status).toBe(200);
        expect(await stored(B)).toBe(0);
        expect(await stored(A)).toBe(4_000_000);
        await expect(assertWithinMonthlyBudget(ctxAs('owner'))).resolves.toMatchObject({ allowed: true });
        await expect(assertWithinMonthlyBudget(bCtx)).rejects.toThrow(/monthly_token_budget_exceeded/);
    });
});
