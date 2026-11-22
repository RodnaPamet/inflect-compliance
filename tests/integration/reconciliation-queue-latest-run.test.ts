/**
 * #5695, owner decisions 2026-11-15 — the run the reconciliation queue opens,
 * read under the queue's own key, `identity_reconciliation.view`, which OWNER,
 * ADMIN and AUDITOR hold ("Auditors only").
 *
 * Real route, real `requirePermission`, real usecase, real database and RLS.
 * Only `getTenantCtx` is mocked: it is the one thing in the path that needs a
 * browser session.
 *
 *   · OWNER, ADMIN and AUDITOR get the latest PASSED match run of their OWN
 *     tenant's connection — an AUDITOR included, whom the admin connection read
 *     (`admin.manage`) refuses;
 *   · EDITOR, READER and AI_ADMIN, which no longer hold the key, are a 403
 *     with exactly one `AUTHZ_DENIED` row;
 *   · another tenant's connection is a 404 and its newer run never appears;
 *   · a member whose custom role withholds the key is a 403 with exactly one
 *     `AUTHZ_DENIED` row;
 *   · a non-legacy connection is a 404, so the key reads no other integration.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole } from '@/lib/permissions';
import { GET } from '@/app/api/t/[tenantSlug]/admin/legacy-access/queue/latest-run/route';
import { getReconciliationQueueRun } from '@/app-layer/usecases/legacy-reconcile-run';
import { GET as ADMIN_LATEST } from '@/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/executions/latest/route';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rqlr-${randomUUID().slice(0, 8)}`;
const A = `ta-${SUITE}`;
const B = `tb-${SUITE}`;
const TENANTS = [A, B];
const RECONCILE = 'legacy-mcp.reconcile';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN' as Role];
const HOLDERS: Role[] = ['OWNER', 'ADMIN', 'AUDITOR'];
const NON_HOLDERS: Role[] = ['EDITOR', 'READER', 'AI_ADMIN' as Role];

let connA = '';
let connB = '';
let otherA = '';
let runA = '';
let runB = '';
const users: Record<string, string> = {};
const userIds: string[] = [];

const ctxAs = (role: Role, tenantId = A, overrides: Parameters<typeof makeRequestContext>[1] = {}) =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId: users[`${tenantId}:${role}`], membershipRole: role, ...overrides });

const get = (tenantSlug: string, connectionId: string | null) =>
    GET(
        new NextRequest(
            `http://localhost/api/t/${tenantSlug}/admin/legacy-access/queue/latest-run`
            + (connectionId === null ? '' : `?connectionId=${encodeURIComponent(connectionId)}`),
        ),
        { params: Promise.resolve({ tenantSlug }) },
    );

const denialsBy = (userId: string) =>
    prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED', userId } });

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000);

async function run(tenantId: string, connectionId: string, automationKey: string, status: 'PASSED' | 'PARTIAL', when: Date) {
    return (
        await prisma.integrationExecution.create({
            data: {
                tenantId, connectionId, provider: 'legacy-mcp', automationKey, status,
                triggeredBy: 'manual', executedAt: when, completedAt: when,
                errorMessage: status === 'PARTIAL' ? 'NO_FRESH_ROSTER' : null,
            },
            select: { id: true },
        })
    ).id;
}

describeFn('the reconciliation queue run, read under the view key (#5695)', () => {
    beforeAll(async () => {
        for (const id of TENANTS) {
            await prisma.tenant.create({ data: { id, name: id, slug: id } });
        }
        for (const tenantId of TENANTS) {
            for (const role of ROLES) {
                const email = `${role.toLowerCase()}@${tenantId}.test`;
                const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
                userIds.push(user.id);
                users[`${tenantId}:${role}`] = user.id;
                await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
            }
        }
        connA = (await prisma.integrationConnection.create({
            data: { tenantId: A, provider: 'legacy-mcp', name: `payroll-${SUITE}`, configJson: {} },
        })).id;
        connB = (await prisma.integrationConnection.create({
            data: { tenantId: B, provider: 'legacy-mcp', name: `secret-b-${SUITE}`, configJson: {} },
        })).id;
        otherA = (await prisma.integrationConnection.create({
            data: { tenantId: A, provider: 'okta', name: `okta-${SUITE}`, configJson: {} },
        })).id;

        runA = await run(A, connA, RECONCILE, 'PASSED', at(0));
        // Newer, but not the queue's: a refused match run and a pull.
        await run(A, connA, RECONCILE, 'PARTIAL', at(10));
        await run(A, connA, 'legacy-mcp.pull', 'PASSED', at(20));
        // Another tenant's match run, newer than anything in A.
        runB = await run(B, connB, RECONCILE, 'PASSED', at(1000));
    });

    beforeEach(() => getTenantCtxMock.mockReset());

    afterAll(async () => {
        const t = { tenantId: { in: TENANTS } };
        await prisma.integrationExecution.deleteMany({ where: t });
        await prisma.integrationConnection.deleteMany({ where: t });
        await deleteAuditRowsForTenants(prisma, TENANTS);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
        });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    });

    it.each(HOLDERS)('%s holds the view key and gets its own tenant\'s latest PASSED match run', async (role) => {
        expect(getPermissionsForRole(role).identity_reconciliation.view).toBe(true);
        getTenantCtxMock.mockResolvedValue(ctxAs(role));

        const res = await get(A, connA);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            connection: { id: connA, name: `payroll-${SUITE}` },
            execution: { id: runA, automationKey: RECONCILE, status: 'PASSED', executedAt: at(0).toISOString() },
        });
        expect(await denialsBy(users[`${A}:${role}`])).toBe(0);
    });

    it.each(NON_HOLDERS)('%s does not hold the view key: a 403 with exactly one AUTHZ_DENIED row', async (role) => {
        expect(getPermissionsForRole(role).identity_reconciliation.view).toBe(false);
        const userId = users[`${A}:${role}`];
        const before = await denialsBy(userId);
        getTenantCtxMock.mockResolvedValue(ctxAs(role));

        const res = await get(A, connA);

        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(runA);
        expect((await denialsBy(userId)) - before).toBe(1);
    });

    it('the admin connection read the page used to call still refuses an AUDITOR (admin.manage)', async () => {
        const before = await denialsBy(users[`${A}:AUDITOR`]);
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR'));
        const res = await ADMIN_LATEST(
            new NextRequest(
                `http://localhost/api/t/${A}/admin/integrations/${connA}/executions/latest?automationKey=${RECONCILE}&status=PASSED`,
            ),
            { params: Promise.resolve({ tenantSlug: A, connectionId: connA }) },
        );
        expect(res.status).toBe(403);
        expect((await denialsBy(users[`${A}:AUDITOR`])) - before).toBe(1);
    });

    it('another tenant\'s connection is not found, and its newer run never appears', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR'));
        const res = await get(A, connB);
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(text).not.toContain(runB);
        expect(text).not.toContain(`secret-b-${SUITE}`);
    });

    it('each tenant reads its own run on its own connection', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR', B));
        const body = await (await get(B, connB)).json();
        expect(body.execution.id).toBe(runB);
        expect(body.connection.id).toBe(connB);
    });

    it('a connection with no PASSED match run answers null, not an older or refused run', async () => {
        const empty = (await prisma.integrationConnection.create({
            data: { tenantId: A, provider: 'legacy-mcp', name: `empty-${SUITE}`, configJson: {} },
        })).id;
        await run(A, empty, RECONCILE, 'PARTIAL', at(5));
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR'));
        const body = await (await get(A, empty)).json();
        expect(body).toEqual({ connection: { id: empty, name: `empty-${SUITE}` }, execution: null });
    });

    it('a connection that is not a legacy connection is not found: the key reads no other integration', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR'));
        const res = await get(A, otherA);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain(`okta-${SUITE}`);
    });

    it('the usecase asserts the view key itself, so no other caller reads around the route', async () => {
        const noKey = ctxAs('AUDITOR', A, {
            appPermissions: { ...getPermissionsForRole('AUDITOR'), identity_reconciliation: { view: false, confirm: false } },
        });
        await expect(getReconciliationQueueRun(noKey, connA)).rejects.toThrow('identity_reconciliation.view is required');
        await expect(getReconciliationQueueRun(ctxAs('AUDITOR'), connA)).resolves.toMatchObject({ execution: { id: runA } });
    });

    it('a missing connectionId is a 400', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('AUDITOR'));
        expect((await get(A, null)).status).toBe(400);
    });

    it.each(['AUDITOR', 'ADMIN', 'OWNER'] as Role[])(
        'a %s membership whose custom role withholds the view key is refused with exactly one AUTHZ_DENIED row',
        async (role) => {
            const userId = users[`${A}:${role}`];
            const before = await denialsBy(userId);
            getTenantCtxMock.mockResolvedValue(
                ctxAs(role, A, {
                    appPermissions: {
                        ...getPermissionsForRole(role),
                        identity_reconciliation: { view: false, confirm: false },
                    },
                }),
            );

            const res = await get(A, connA);

            expect(res.status).toBe(403);
            expect(await res.text()).not.toContain(runA);
            expect((await denialsBy(userId)) - before).toBe(1);
        },
    );
});
