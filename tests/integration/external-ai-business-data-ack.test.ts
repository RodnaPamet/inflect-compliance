/**
 * THE BUSINESS-DATA TRANSFER ACKNOWLEDGEMENT (M5, #3872), proved on real rows.
 *
 *   - WHO: OWNER and ADMIN record it; EDITOR, READER, AUDITOR and AI_ADMIN are
 *     refused at the route with exactly one `AUTHZ_DENIED` row each. An API-KEY
 *     context holding `admin.manage` is refused too — a credential cannot accept
 *     a data transfer on a company's behalf.
 *   - WHAT: both columns move together, and each change audits with its before
 *     and after. A withdrawal of an absent acknowledgement is a no-op and
 *     writes nothing, because no transfer stopped being permitted.
 *   - THE DATABASE: the CHECK refuses a half-set row from a writer that bypasses
 *     the usecase, so an anonymous consent is unrepresentable rather than merely
 *     unwritten.
 *   - THE GATE reads what was stored: unacknowledged refuses an EXTERNAL run
 *     over a business-system connection, acknowledged permits it.
 *   - TWO TENANTS: one workspace's acknowledgement never reaches another's.
 *
 * The route is driven through its REAL handler. Only `getTenantCtx` is mocked —
 * the one thing in the path that needs a browser session; `requirePermission`,
 * the audit writer, the usecase and RLS are all real.
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
import { PUT } from '@/app/api/t/[tenantSlug]/admin/security-settings/external-ai-acknowledgement/route';
import { setExternalAiBusinessDataAcknowledgement } from '@/app-layer/usecases/tenant-security-settings';
import {
    acknowledgementFrom,
    externalResidencyRefusal,
    EXTERNAL_AI_ACK_SELECT,
} from '@/lib/agentic/external-residency-gate';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

// Unique per run: `resetDatabase` does not truncate Tenant or User.
const SUITE = randomUUID().slice(0, 8);
const A = `extack-a-${SUITE}`;
const B = `extack-b-${SUITE}`;
const TENANTS = [A, B];

const PEOPLE = ['owner', 'admin', 'editor', 'reader', 'auditor', 'aiAdmin'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE_OF: Record<Person, Role> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    editor: 'EDITOR',
    reader: 'READER',
    auditor: 'AUDITOR',
    aiAdmin: 'AI_ADMIN' as Role,
};
const users = {} as Record<Person, string>;
let bOwner = '';

const ctxAs = (who: Person, tenantId = A): RequestContext =>
    makeRequestContext(ROLE_OF[who], { tenantId, tenantSlug: tenantId, userId: users[who] });

const put = (body: unknown): NextRequest =>
    new NextRequest(`http://localhost/api/t/${A}/admin/security-settings/external-ai-acknowledgement`, {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: A }) });

const stored = async (tenantId = A) =>
    prisma.tenantSecuritySettings.findUnique({
        where: { tenantId },
        select: EXTERNAL_AI_ACK_SELECT,
    });

const countDenials = (tenantId = A) =>
    prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
const ackEvents = (tenantId = A) =>
    prisma.auditLog.findMany({
        where: {
            tenantId,
            action: {
                in: [
                    'EXTERNAL_AI_BUSINESS_DATA_ACKNOWLEDGED',
                    'EXTERNAL_AI_BUSINESS_DATA_ACKNOWLEDGEMENT_WITHDRAWN',
                ],
            },
        },
        orderBy: { createdAt: 'asc' },
    });

async function person(tenantId: string, label: string, role: Role): Promise<string> {
    const email = `${label}-${SUITE}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
    return user.id;
}

/** One offered tool on a connection the tenant has marked as a business system. */
const businessTool = () => ({
    name: 'sap__read_orders',
    connectionId: 'conn-sap',
    connectionName: 'SAP production',
    reachesBusinessSystem: true,
});

beforeAll(async () => {
    // Audit rows FIRST: `AuditLog` holds real foreign keys to `Tenant`, so the
    // tenant delete below fails while any row from a previous run survives.
    await deleteAuditRowsForTenants(prisma, TENANTS);
    for (const t of TENANTS) {
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: t } });
        await prisma.tenantMembership.deleteMany({ where: { tenantId: t } });
        await prisma.tenant.deleteMany({ where: { id: t } });
        await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    }
    for (const who of PEOPLE) users[who] = await person(A, who, ROLE_OF[who]);
    bOwner = await person(B, 'owner', 'OWNER');
}, 120_000);

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
});

beforeEach(() => {
    getTenantCtxMock.mockReset();
});

describe('who may record it', () => {
    it.each(['owner', 'admin'] as const)('%s records it, and both columns move together', async (who) => {
        getTenantCtxMock.mockResolvedValue(ctxAs(who));
        const res = await PUT(put({ acknowledged: true }), routeArgs());
        expect(res.status).toBe(200);

        const row = await stored();
        expect(row?.externalAiBusinessDataAckAt).not.toBeNull();
        expect(row?.externalAiBusinessDataAckByUserId).toBe(users[who]);

        // Reset for the next parameterised case.
        await prisma.tenantSecuritySettings.update({
            where: { tenantId: A },
            data: { externalAiBusinessDataAckAt: null, externalAiBusinessDataAckByUserId: null },
        });
    });

    it.each(['editor', 'reader', 'auditor', 'aiAdmin'] as const)(
        '%s is refused at the route, with exactly one AUTHZ_DENIED row',
        async (who) => {
            const before = await countDenials();
            getTenantCtxMock.mockResolvedValue(ctxAs(who));
            const res = await PUT(put({ acknowledged: true }), routeArgs());
            expect(res.status).toBe(403);
            expect(await countDenials()).toBe(before + 1);
            expect((await stored())?.externalAiBusinessDataAckAt ?? null).toBeNull();
        },
    );

    it('an API KEY holding admin.manage is refused, even carrying a user id', async () => {
        // The narrowing that is NOT the permission. `*`-scoped keys exist, so
        // the settings key alone would let a credential accept a data transfer
        // on a company's behalf.
        //
        // The `userId` is SET here on purpose, and that is what gives this case
        // its teeth. A first version passed `userId: undefined`, and removing
        // the `isPersonContext` check left it green — the usecase's separate
        // "an acknowledgement needs an author" guard fired instead, with the
        // same reason, so the probe could not tell the two worlds apart. A key
        // minted by a person plausibly carries their id, which is exactly the
        // context the person check exists to refuse.
        const keyCtx = { ...ctxAs('owner'), apiKeyId: 'key-1' } as RequestContext;
        expect(keyCtx.userId).toBeTruthy();
        await expect(setExternalAiBusinessDataAcknowledgement(keyCtx, { acknowledged: true })).rejects.toMatchObject({
            details: { reason: 'NOT_A_PERSON' },
        });
        expect((await stored())?.externalAiBusinessDataAckAt ?? null).toBeNull();
    });

    it('and an AGENT or JOB context is refused on the same rule', async () => {
        // `isPersonContext` is one predicate over three non-person kinds; the
        // key case above would pass if it only excluded keys.
        for (const over of [{ agentId: 'agent-1' }, { actorType: 'JOB' as const }]) {
            const ctx = { ...ctxAs('owner'), ...over } as RequestContext;
            await expect(
                setExternalAiBusinessDataAcknowledgement(ctx, { acknowledged: true }),
            ).rejects.toMatchObject({ details: { reason: 'NOT_A_PERSON' } });
        }
        expect((await stored())?.externalAiBusinessDataAckAt ?? null).toBeNull();
    });
});

describe('what it writes, and what it does not', () => {
    it('audits the acknowledgement and the withdrawal, each with its before and after', async () => {
        const start = (await ackEvents()).length;

        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: true });
        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: false });

        const events = (await ackEvents()).slice(start);
        expect(events.map((e) => e.action)).toEqual([
            'EXTERNAL_AI_BUSINESS_DATA_ACKNOWLEDGED',
            'EXTERNAL_AI_BUSINESS_DATA_ACKNOWLEDGEMENT_WITHDRAWN',
        ]);
        const withdrawal = events[1]?.detailsJson as { before?: Record<string, unknown> } | null;
        // The withdrawal names what WAS permitted, which is the fact an auditor
        // needs: "nothing is acknowledged now" does not say when it stopped.
        expect(withdrawal?.before?.acknowledgedByUserId).toBe(users.owner);

        const row = await stored();
        expect(row?.externalAiBusinessDataAckAt).toBeNull();
        expect(row?.externalAiBusinessDataAckByUserId).toBeNull();
    });

    it('withdrawing an absent acknowledgement writes NO audit row', async () => {
        // Not pedantry: an audit trail where "withdrew consent" appears for a
        // workspace that never gave any is a trail that cannot be read. Nothing
        // stopped being permitted, so nothing is recorded.
        const before = (await ackEvents()).length;
        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: false });
        expect((await ackEvents()).length).toBe(before);
    });
});

describe('the database refuses an anonymous consent', () => {
    it('a half-set row is rejected even from a raw writer that bypasses the usecase', async () => {
        // The usecase always writes both. This proves the CHECK, so a future raw
        // UPDATE, a migration or a second writer cannot produce an
        // acknowledgement nobody can attribute.
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "TenantSecuritySettings" SET "externalAiBusinessDataAckAt" = now(),
                 "externalAiBusinessDataAckByUserId" = NULL WHERE "tenantId" = $1`,
                A,
            ),
        ).rejects.toThrow(/external_ai_ack_attributed/);
    });
});

describe('the gate reads what was stored', () => {
    it('refuses an EXTERNAL run over a business-system connection until it is acknowledged, then permits it', async () => {
        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: false });
        const gate = async () =>
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [businessTool()],
                acknowledgement: acknowledgementFrom(await stored()),
            });

        expect((await gate())?.reason).toBe('EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED');

        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: true });
        expect(await gate()).toBeNull();

        // And back: withdrawing re-refuses, so the acknowledgement is a live
        // term rather than a one-way latch.
        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: false });
        expect((await gate())?.reason).toBe('EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED');
    });
});

describe('two-tenant isolation', () => {
    it("A's acknowledgement does not permit B's run", async () => {
        await setExternalAiBusinessDataAcknowledgement(ctxAs('owner'), { acknowledged: true });

        const bCtx = makeRequestContext('OWNER', { tenantId: B, tenantSlug: B, userId: bOwner });
        expect(bCtx.tenantId).toBe(B);
        const bRow = await stored(B);
        expect(bRow?.externalAiBusinessDataAckAt ?? null).toBeNull();

        const refusal = externalResidencyRefusal({
            providerId: FLUE_PROVIDER_IDS.external,
            offered: [businessTool()],
            acknowledgement: acknowledgementFrom(bRow),
        });
        expect(refusal?.reason).toBe('EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED');

        // The control: A, acknowledged, proceeds on the same offered set — so
        // the assertion above is about B's row and not about the gate refusing
        // everything.
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [businessTool()],
                acknowledgement: acknowledgementFrom(await stored(A)),
            }),
        ).toBeNull();
    });
});
