/**
 * ONLY THE AUDITOR'S OWNER SWITCHES OFF AN AUDIT PROCEDURE'S PLAN
 * (#3676, owner decision 6, 2026-10-19).
 *
 * A control-test plan whose `automationConfig` names an audit procedure is the
 * auditor agent at work. The audited first line holds `tests.create`, and often
 * `admin.manage`; without a gate it could pause, archive, unschedule or delete
 * the plan that audits it. Every one of those paths is driven here through its
 * REAL route handler (only `getTenantCtx` is stubbed, to choose who is asking),
 * against a real database, and every refusal must carry the named reason
 * `AUDIT_PROCEDURE_PLAN_OWNER_ONLY` and leave the plan exactly as it was.
 *
 * The control owner and the other admin both hold ADMIN here, so no refusal
 * below can be a missing permission's: each is this gate's. The API key is the
 * auditor owner's OWN key, so the refusal is about the credential, not the
 * person behind it.
 *
 * And a plan with no procedure must behave exactly as it did: the same callers
 * pause, archive and delete it, and an EDITOR is still refused the bulk delete
 * by the route's own permission, with no reason attached.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';
import { NextRequest } from 'next/server';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import type { RequestContext } from '@/app-layer/types';
import { PATCH as patchPlan } from '@/app/api/t/[tenantSlug]/tests/plans/[planId]/route';
import { PUT as putSchedule } from '@/app/api/t/[tenantSlug]/tests/plans/[planId]/schedule/route';
import { POST as postBulkStatus } from '@/app/api/t/[tenantSlug]/tests/plans/bulk/status/route';
import { POST as postBulkDelete } from '@/app/api/t/[tenantSlug]/tests/plans/bulk/delete/route';
import { updateTestPlan } from '@/app-layer/usecases/control';
import { AUDIT_PROCEDURE_PLAN_OWNER_ONLY } from '@/app-layer/usecases/audit-procedure-plans';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `apgate-${randomUUID().slice(0, 8)}`;
const TENANT = SUITE;
const U_AUDITOR_OWNER = `${SUITE}-auditor-owner`;
const U_OTHER_ADMIN = `${SUITE}-other-admin`;
const U_CONTROL_OWNER = `${SUITE}-control-owner`;
const U_EDITOR = `${SUITE}-editor`;

let auditorId = '';
let controlId = '';

const ROLE: Record<string, Role> = {
    [U_AUDITOR_OWNER]: 'ADMIN',
    [U_OTHER_ADMIN]: 'ADMIN',
    [U_CONTROL_OWNER]: 'ADMIN',
    [U_EDITOR]: 'EDITOR',
};
const as = (userId: string, extra: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(ROLE[userId], { tenantId: TENANT, tenantSlug: TENANT, userId, ...extra });
const auditorOwner = () => as(U_AUDITOR_OWNER);
/** The auditor owner's own API key: same user, but a credential, not the person. */
const auditorOwnersApiKey = () => as(U_AUDITOR_OWNER, { apiKeyId: `${SUITE}-key` });

const REFUSED = [
    ['another ADMIN', () => as(U_OTHER_ADMIN)],
    ['the control owner', () => as(U_CONTROL_OWNER)],
    ["the auditor owner's API key", auditorOwnersApiKey],
] as const;

async function seedUser(id: string): Promise<void> {
    const email = `${id}@example.test`;
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, email, emailHash: hashForLookup(email) } });
}

let seq = 0;
async function seedPlans(): Promise<{ procedurePlan: string; plainPlan: string }> {
    seq += 1;
    const base = {
        tenantId: TENANT,
        controlId,
        createdByUserId: U_CONTROL_OWNER,
        ownerUserId: U_CONTROL_OWNER,
        automationType: 'INTEGRATION' as const,
        status: 'ACTIVE' as const,
        schedule: '0 3 * * *',
    };
    const procedurePlan = await prisma.controlTestPlan.create({
        data: {
            ...base,
            name: `leaver timeliness ${seq}`,
            automationConfig: {
                procedure: 'iam.leaver_timeliness',
                auditorAgentId: auditorId,
                parameters: { leaverWindowHours: 24 },
            },
        },
    });
    const plainPlan = await prisma.controlTestPlan.create({
        data: { ...base, name: `ordinary ${seq}`, automationConfig: { connector: 'none' } },
    });
    return { procedurePlan: procedurePlan.id, plainPlan: plainPlan.id };
}

async function stateOf(planId: string) {
    return prisma.controlTestPlan.findFirstOrThrow({
        where: { id: planId },
        select: { status: true, schedule: true, automationType: true, deletedAt: true },
    });
}
const UNTOUCHED = { status: 'ACTIVE', schedule: '0 3 * * *', automationType: 'INTEGRATION', deletedAt: null };

function request(method: string, path: string, body: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/t/${TENANT}/tests/plans/${path}`, {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
}

type RouteResult = { status: number; body: { error?: { details?: { reason?: string; change?: string } } } };
/** Every route here reads at most these two segments; the bulk routes ignore `planId`. */
type Segments = { tenantSlug: string; planId: string };
async function call(
    ctx: RequestContext,
    handler: (req: NextRequest, args: { params: Promise<Segments> }) => Promise<Response>,
    req: NextRequest,
    params: { planId?: string } = {},
): Promise<RouteResult> {
    getTenantCtxMock.mockResolvedValue(ctx);
    const res = await handler(req, { params: Promise.resolve({ tenantSlug: TENANT, planId: params.planId ?? '' }) });
    return { status: res.status, body: (await res.json()) as RouteResult['body'] };
}

/** Every path that stops a plan running, as a route call on `planId`. */
const STOPS = {
    'PATCH status PAUSED': (planId: string) =>
        [patchPlan, request('PATCH', planId, { status: 'PAUSED' }), { planId }, 'PAUSE'] as const,
    'PATCH status ARCHIVED': (planId: string) =>
        [patchPlan, request('PATCH', planId, { status: 'ARCHIVED' }), { planId }, 'ARCHIVE'] as const,
    'bulk status PAUSED': (planId: string) =>
        [postBulkStatus, request('POST', 'bulk/status', { planIds: [planId], status: 'PAUSED' }), {}, 'PAUSE'] as const,
    'bulk status ARCHIVED': (planId: string) =>
        [postBulkStatus, request('POST', 'bulk/status', { planIds: [planId], status: 'ARCHIVED' }), {}, 'ARCHIVE'] as const,
    'schedule cleared to MANUAL': (planId: string) =>
        [
            putSchedule,
            request('PUT', `${planId}/schedule`, { schedule: null, automationType: 'MANUAL' }),
            { planId },
            'SCHEDULE',
        ] as const,
    'bulk delete': (planId: string) =>
        [postBulkDelete, request('POST', 'bulk/delete', { planIds: [planId] }), {}, 'DELETE'] as const,
};

describeFn("an audit procedure's plan is switched off only by the auditor's owner", () => {
    beforeAll(async () => {
        for (const u of [U_AUDITOR_OWNER, U_OTHER_ADMIN, U_CONTROL_OWNER, U_EDITOR]) await seedUser(u);
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        await prisma.tenantMembership.createMany({
            data: [
                { tenantId: TENANT, userId: U_AUDITOR_OWNER, role: 'ADMIN', status: 'ACTIVE', lineOfDefence: 'SECOND' },
                { tenantId: TENANT, userId: U_OTHER_ADMIN, role: 'ADMIN', status: 'ACTIVE', lineOfDefence: 'FIRST' },
                { tenantId: TENANT, userId: U_CONTROL_OWNER, role: 'ADMIN', status: 'ACTIVE', lineOfDefence: 'FIRST' },
                { tenantId: TENANT, userId: U_EDITOR, role: 'EDITOR', status: 'ACTIVE' },
            ],
        });
        const sys = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: `${TENANT} host`, ownerUserId: U_AUDITOR_OWNER },
        });
        const auditor = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: sys.id,
                name: `${TENANT} auditor`,
                autonomyLevel: 2,
                dataAccessScope: 'WRITE_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: U_AUDITOR_OWNER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
                isAuditor: true,
            },
        });
        auditorId = auditor.id;
        const control = await prisma.control.create({
            data: { tenantId: TENANT, name: 'leaver control', createdByUserId: U_CONTROL_OWNER, ownerUserId: U_CONTROL_OWNER },
        });
        controlId = control.id;
    });

    describe.each(Object.entries(STOPS))('%s', (_label, build) => {
        it.each(REFUSED)('refuses %s with the named reason, and the plan keeps running', async (_who, ctx) => {
            const { procedurePlan } = await seedPlans();
            const [handler, req, params, change] = build(procedurePlan);
            const r = await call(ctx(), handler, req, params);
            expect(r.status).toBe(403);
            expect(r.body.error?.details).toEqual({ reason: AUDIT_PROCEDURE_PLAN_OWNER_ONLY, change });
            expect(await stateOf(procedurePlan)).toEqual(UNTOUCHED);
        });

        it("lets the auditor's owner do it", async () => {
            const { procedurePlan } = await seedPlans();
            const [handler, req, params] = build(procedurePlan);
            const r = await call(auditorOwner(), handler, req, params);
            expect(r.status).toBe(200);
            expect(await stateOf(procedurePlan)).not.toEqual(UNTOUCHED);
        });

        it('leaves a plan with no procedure exactly as it was: the same callers may do it', async () => {
            for (const [, ctx] of REFUSED) {
                const { plainPlan } = await seedPlans();
                const [handler, req, params] = build(plainPlan);
                const r = await call(ctx(), handler, req, params);
                expect(r.status).toBe(200);
                expect(await stateOf(plainPlan)).not.toEqual(UNTOUCHED);
            }
        });
    });

    it('refuses a mixed batch whole, so the ordinary plan in it is not switched off either', async () => {
        const { procedurePlan, plainPlan } = await seedPlans();
        const pause = await call(
            as(U_OTHER_ADMIN),
            postBulkStatus,
            request('POST', 'bulk/status', { planIds: [plainPlan, procedurePlan], status: 'PAUSED' }),
        );
        expect(pause.status).toBe(403);
        expect(pause.body.error?.details?.reason).toBe(AUDIT_PROCEDURE_PLAN_OWNER_ONLY);
        const del = await call(
            as(U_CONTROL_OWNER),
            postBulkDelete,
            request('POST', 'bulk/delete', { planIds: [plainPlan, procedurePlan] }),
        );
        expect(del.status).toBe(403);
        expect(await stateOf(plainPlan)).toEqual(UNTOUCHED);
        expect(await stateOf(procedurePlan)).toEqual(UNTOUCHED);
    });

    it('keeps each path\'s own permission: an EDITOR is refused the bulk delete of an ordinary plan, with no reason', async () => {
        const { plainPlan } = await seedPlans();
        const r = await call(as(U_EDITOR), postBulkDelete, request('POST', 'bulk/delete', { planIds: [plainPlan] }));
        expect(r.status).toBe(403);
        expect(r.body.error?.details).toBeUndefined();
        expect(await stateOf(plainPlan)).toEqual(UNTOUCHED);
    });

    it('holds a change of automation type, which the PATCH body cannot carry but the usecase accepts', async () => {
        const { procedurePlan, plainPlan } = await seedPlans();
        await expect(updateTestPlan(as(U_OTHER_ADMIN), procedurePlan, { automationType: 'MANUAL' })).rejects.toMatchObject({
            status: 403,
            details: { reason: AUDIT_PROCEDURE_PLAN_OWNER_ONLY, change: 'AUTOMATION_CHANGE' },
        });
        await expect(
            updateTestPlan(as(U_OTHER_ADMIN, { agentId: `${SUITE}-agent` }), procedurePlan, { status: 'PAUSED' }),
        ).rejects.toMatchObject({ details: { reason: AUDIT_PROCEDURE_PLAN_OWNER_ONLY } });
        expect(await stateOf(procedurePlan)).toEqual(UNTOUCHED);
        await expect(updateTestPlan(as(U_OTHER_ADMIN), plainPlan, { automationType: 'MANUAL' })).resolves.toBeTruthy();
    });

    it('leaves a resume and the plan\'s other fields open to the plan\'s managers', async () => {
        const { procedurePlan } = await seedPlans();
        await prisma.controlTestPlan.update({ where: { id: procedurePlan }, data: { status: 'PAUSED' } });
        const resume = await call(
            as(U_CONTROL_OWNER),
            patchPlan,
            request('PATCH', procedurePlan, { status: 'ACTIVE', frequency: 'QUARTERLY' }),
            { planId: procedurePlan },
        );
        expect(resume.status).toBe(200);
        expect(await stateOf(procedurePlan)).toEqual(UNTOUCHED);
    });
});
