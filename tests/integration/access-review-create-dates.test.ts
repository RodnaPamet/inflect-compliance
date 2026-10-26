/**
 * Every campaign create route refuses a date that is not one, and a period
 * that ends before it begins: a 400, and nothing written. Real routes, real
 * usecases, real database; only `getTenantCtx` is mocked.
 *
 * Before the shared `DateField`, the connected, agent and legacy creates
 * coerced their dates with `new Date(input)`, so `dueAt: null` created a
 * campaign due on 1970-01-01, and a period running backwards was stored and
 * printed on the evidence as it was given. The member create already refused
 * both; it is in the table so the four are held to one rule.
 *
 * Each route also gets a positive control: the same body with valid dates gets
 * past validation (201, or for the agent create a later refusal that is not a
 * validation error). Without it, "nothing written" would be equally true of a
 * route that refuses everything.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { ensureTenantDek } from '@/lib/security/tenant-key-manager';
import { POST as CREATE_MEMBER } from '@/app/api/t/[tenantSlug]/access-reviews/route';
import { POST as CREATE_CONNECTED } from '@/app/api/t/[tenantSlug]/access-reviews/connected/route';
import { POST as CREATE_AGENTS } from '@/app/api/t/[tenantSlug]/access-reviews/agents/route';
import { POST as CREATE_LEGACY } from '@/app/api/t/[tenantSlug]/access-reviews/legacy/route';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `arcd-${randomUUID().slice(0, 8)}`;
const T = `t-${SUITE}`;
const ADMIN = `u-adm-${SUITE}`;
const REVIEWER = `u-rev-${SUITE}`;

let legacyConnectionId = '';

type RouteHandler = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;

const ROUTES: ReadonlyArray<[string, RouteHandler, string, () => Record<string, unknown>]> = [
    ['POST /access-reviews', CREATE_MEMBER as RouteHandler, '', () => ({ name: `members ${SUITE}`, reviewerUserId: REVIEWER })],
    ['POST /access-reviews/connected', CREATE_CONNECTED as RouteHandler, '/connected', () => ({ name: `connected ${SUITE}`, reviewerUserId: REVIEWER })],
    ['POST /access-reviews/agents', CREATE_AGENTS as RouteHandler, '/agents', () => ({ name: `agents ${SUITE}`, reviewerUserId: REVIEWER, preparerAgentId: 'agent-not-registered' })],
    ['POST /access-reviews/legacy', CREATE_LEGACY as RouteHandler, '/legacy', () => ({ name: `legacy ${SUITE}`, reviewerUserId: REVIEWER, connectionId: legacyConnectionId })],
];

const post = (handler: RouteHandler, leaf: string, body: unknown): Promise<Response> =>
    handler(
        new NextRequest(`http://localhost/api/t/${T}/access-reviews${leaf}`, {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ tenantSlug: T }) },
    );

/** Everything a create could have written in T, audit rows of any kind included. */
async function writtenInT() {
    const where = { tenantId: T };
    return {
        campaigns: await prisma.accessReview.count({ where }),
        memberSubjects: await prisma.accessReviewDecision.count({ where }),
        connectedSubjects: await prisma.accessReviewConnectedDecision.count({ where }),
        audits: await prisma.auditLog.count({ where }),
    };
}

async function clearCampaigns(): Promise<void> {
    const where = { tenantId: T };
    await prisma.accessReviewDecision.deleteMany({ where });
    await prisma.accessReviewConnectedDecision.deleteMany({ where });
    await prisma.accessReview.deleteMany({ where });
}

describeFn('campaign create routes refuse a date that is not one (real routes, real DB)', () => {
    beforeAll(async () => {
        await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, name: T, slug: T } });
        // Provisioned now: the lazy provisioning on a first usecase call writes
        // an audit row of its own, which "nothing written" would count.
        await ensureTenantDek(T);
        for (const [id, role] of [[ADMIN, 'ADMIN'], [REVIEWER, 'READER']] as const) {
            await prisma.user.upsert({ where: { id }, update: {}, create: { id, email: `${id}@example.test`, name: id } });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: T, userId: id } },
                update: { role, status: 'ACTIVE' },
                create: { tenantId: T, userId: id, role, status: 'ACTIVE' },
            });
        }
        const okta = await prisma.integrationConnection.create({
            data: { tenantId: T, provider: 'okta', name: `okta-${SUITE}` },
        });
        await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: T, provider: 'okta', externalUserId: `okta-${SUITE}`, email: `okta@${SUITE}.test`,
                connectionId: okta.id, syncedAt: new Date(),
            },
        });
        legacyConnectionId = (await prisma.integrationConnection.create({
            data: { tenantId: T, provider: 'legacy-mcp', name: `legacy-${SUITE}`, configJson: {} },
        })).id;
        const snap = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: T, connectionId: legacyConnectionId, remoteSnapshotId: `snap-${SUITE}`,
                mappingVersion: 1, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: 'd'.repeat(64), rowCount: 1, rowsReceived: 1,
                status: 'COMPLETE', completedAt: new Date(),
            },
        });
        await prisma.legacyAccount.create({
            data: {
                tenantId: T, snapshotId: snap.id, accountKey: 'kpatel', displayName: 'K Patel',
                email: `kpatel@${SUITE}.test`, status: 'ACTIVE', accountType: 'HUMAN',
                isPrivileged: false, entitlements: [], lastLoginAt: new Date(),
            },
        });
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: T, connectionId: legacyConnectionId, status: 'PASSED', provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', executedAt: new Date(), completedAt: new Date(),
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T, executionId: exec.id, snapshotId: snap.id, accountKey: 'kpatel',
                outcome: 'UNMATCHED', method: 'NO_CANDIDATES', signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });
    });

    beforeEach(async () => {
        await clearCampaigns();
        getTenantCtxMock.mockReset();
        getTenantCtxMock.mockResolvedValue(makeRequestContext('ADMIN', { tenantId: T, tenantSlug: T, userId: ADMIN }));
    });

    afterAll(async () => {
        await clearCampaigns();
        const where = { tenantId: T };
        await prisma.legacyAccountResolution.deleteMany({ where });
        await prisma.legacyAccount.deleteMany({ where });
        await prisma.legacyAccessSnapshot.deleteMany({ where });
        await prisma.integrationExecution.deleteMany({ where });
        await prisma.connectedIdentityAccount.deleteMany({ where });
        await prisma.integrationConnection.deleteMany({ where });
        // Audit rows BEFORE the parents: `AuditLog` has real FKs to Tenant and User.
        await deleteAuditRowsForTenants(prisma, T);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
        });
        await prisma.tenant.deleteMany({ where: { id: T } });
        await prisma.user.deleteMany({ where: { id: { in: [ADMIN, REVIEWER] } } });
    });

    describe.each(ROUTES)('%s', (_name, handler, leaf, body) => {
        it.each([
            ['dueAt: null (was stored as 1970-01-01)', { dueAt: null }, 'dueAt'],
            ['dueAt: true', { dueAt: true }, 'dueAt'],
            ['periodStartAt: 0', { periodStartAt: 0 }, 'periodStartAt'],
            ['a period that ends before it begins', {
                periodStartAt: '2026-10-02T00:00:00.000Z', periodEndAt: '2026-10-01T00:00:00.000Z',
            }, 'periodEndAt'],
        ])('%s → 400 VALIDATION_ERROR on that field, and nothing written', async (_label, dates, field) => {
            const before = await writtenInT();
            const res = await post(handler, leaf, { ...body(), ...dates });
            expect(res.status).toBe(400);
            const payload = await res.json();
            expect(payload.error.code).toBe('VALIDATION_ERROR');
            expect(payload.error.details.map((d: { path: string[] }) => d.path[0])).toContain(field);
            expect(await writtenInT()).toEqual(before);
        });

        it('valid dates get past validation (the positive control)', async () => {
            const res = await post(handler, leaf, {
                ...body(),
                dueAt: '2026-12-01T00:00:00.000Z',
                periodStartAt: '2026-07-01T00:00:00.000Z',
                periodEndAt: '2026-09-30T00:00:00.000Z',
            });
            const payload = await res.json();
            if (leaf === '/agents') {
                // This tenant registers no agent, so the create is refused for
                // its empty population — a refusal that comes after the dates.
                expect(payload.error?.code).not.toBe('VALIDATION_ERROR');
                expect(payload.error?.message).toMatch(/^NO_SUBJECTS: /);
                return;
            }
            expect(res.status).toBe(201);
            const row = await prisma.accessReview.findUniqueOrThrow({ where: { id: payload.accessReviewId } });
            expect(row.dueAt).toEqual(new Date('2026-12-01T00:00:00.000Z'));
            expect(row.periodStartAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
            expect(row.periodEndAt).toEqual(new Date('2026-09-30T00:00:00.000Z'));
        });
    });
});
