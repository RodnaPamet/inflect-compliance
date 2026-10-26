/**
 * Creating a LEGACY_APP campaign over HTTP — the real route, the real usecase,
 * the real database.
 *
 * `createLegacyAccessReview` was complete, gated and tested
 * (`legacy-access-review.test.ts` covers its five refusals, the freeze and the
 * coverage) and had NO ROUTE: nothing over HTTP could create a legacy
 * campaign. What this file covers is the thing that was missing — that the
 * route reaches the usecase, and that what the usecase guarantees still holds
 * when it is reached that way.
 *
 * Only `getTenantCtx` is mocked, because it is the one thing in the path that
 * needs a browser session; `requirePermission`, `parseJsonBody`, the usecase,
 * `logEvent`, the hash chain and RLS are all real.
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
import { POST } from '@/app/api/t/[tenantSlug]/access-reviews/legacy/route';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `larr-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ADMIN = `u-adm-${SUITE}`;
const EDITOR = `u-ed-${SUITE}`;
const REVIEWER = `u-rev-${SUITE}`;
const USERS = [ADMIN, EDITOR, REVIEWER];

let connectionId = '';

const ctxFor = (userId: string, role: string, over: Partial<RequestContext> = {}) =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId, ...over });

const PATH = `/api/t/${TENANT}/access-reviews/legacy`;

const req = (body: unknown): NextRequest =>
    new NextRequest(`http://localhost${PATH}`, {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });

const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: TENANT }) });

const campaigns = () => prisma.accessReview.count({ where: { tenantId: TENANT } });
const denials = () => prisma.auditLog.count({ where: { tenantId: TENANT, action: 'AUTHZ_DENIED' } });

const body = (over: Record<string, unknown> = {}) => ({
    name: `Legacy recertification ${SUITE}`,
    connectionId,
    reviewerUserId: REVIEWER,
    ...over,
});

async function clearCampaignRows(): Promise<void> {
    const t = { tenantId: TENANT };
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyAccount.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
}

/** A COMPLETE, fresh, reconciled snapshot — with one account unless told otherwise. */
async function seedReconciledSnapshot(opts: { withAccount?: boolean } = {}) {
    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: TENANT, connectionId, remoteSnapshotId: `snap-${SUITE}-${Date.now()}`,
            mappingVersion: 2, columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'b'.repeat(64), rowCount: 1, rowsReceived: 1,
            status: 'COMPLETE', completedAt: new Date(),
        },
    });
    if (opts.withAccount !== false) {
        await prisma.legacyAccount.create({
            data: {
                tenantId: TENANT, snapshotId: snap.id, accountKey: 'kpatel',
                displayName: 'K Patel', email: `kpatel@${SUITE}.test`,
                status: 'ACTIVE', accountType: 'HUMAN', isPrivileged: false,
                entitlements: ['ledger.read'], lastLoginAt: new Date(),
            },
        });
    }
    const exec = await prisma.integrationExecution.create({
        data: {
            tenantId: TENANT, connectionId, status: 'PASSED',
            provider: 'legacy-mcp', automationKey: 'legacy-mcp.reconcile',
            executedAt: new Date(), completedAt: new Date(),
        },
    });
    await prisma.legacyAccountResolution.create({
        data: {
            tenantId: TENANT, executionId: exec.id, snapshotId: snap.id,
            accountKey: 'kpatel', outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
            signalsJson: [], candidatesJson: [], vetoesJson: [],
        },
    });
    return snap;
}

describeFn('POST /access-reviews/legacy (real route, real usecase, real DB)', () => {
    beforeAll(async () => {
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        for (const [id, role] of [[ADMIN, 'ADMIN'], [EDITOR, 'EDITOR'], [REVIEWER, 'READER']] as const) {
            await prisma.user.upsert({
                where: { id }, update: {},
                create: { id, email: `${id}@example.test`, name: id },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId: id } },
                update: { role, status: 'ACTIVE' },
                create: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        connectionId = (await prisma.integrationConnection.create({
            data: { tenantId: TENANT, provider: 'legacy-mcp', name: `legacy-${SUITE}`, configJson: {} },
        })).id;
    });

    beforeEach(async () => {
        await clearCampaignRows();
        getTenantCtxMock.mockReset();
    });

    afterAll(async () => {
        await clearCampaignRows();
        await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
        // Audit rows BEFORE the parents: `AuditLog` has real FKs to Tenant and User.
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    });

    it('an ADMIN creates the campaign: 201, LEGACY_APP, its subjects frozen with their provenance', async () => {
        const snap = await seedReconciledSnapshot();
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'ADMIN'));

        const res = await POST(req(body()), routeArgs());
        expect(res.status).toBe(201);
        const out = await res.json();
        expect(out).toMatchObject({
            snapshotId: snap.id,
            subjectCount: 1,
            snapshotTruncated: false,
            // #3325: no transport observes the whole table, so the creator is
            // told the coverage is unverified at the moment they create it.
            populationCoverage: 'UNKNOWN',
        });

        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: out.accessReviewId } });
        expect(review.tenantId).toBe(TENANT);
        expect(review.scope).toBe('LEGACY_APP');
        expect(review.reviewerUserId).toBe(REVIEWER);
        expect(review.createdByUserId).toBe(ADMIN);

        const subjects = await prisma.accessReviewConnectedDecision.findMany({
            where: { tenantId: TENANT, accessReviewId: review.id },
        });
        expect(subjects).toHaveLength(1);
        expect(subjects[0].subjectRef).toBe(`${connectionId}:kpatel`);
        expect(subjects[0].connectedAccountId).toBeNull();
        const provenance = (subjects[0].snapshotJson as { provenance: Record<string, unknown> }).provenance;
        expect(provenance).toMatchObject({
            snapshotId: snap.id,
            payloadHash: 'b'.repeat(64),
            connectionId,
            populationCoverage: 'UNKNOWN',
        });

        expect(await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'LEGACY_ACCESS_REVIEW_CREATED', entityId: review.id },
        })).toBe(1);
    });

    it('a member without access_reviews.create is refused at the gate: 403, one AUTHZ_DENIED, nothing created', async () => {
        await seedReconciledSnapshot();
        getTenantCtxMock.mockResolvedValue(ctxFor(EDITOR, 'EDITOR'));
        const deniedBefore = await denials();

        const res = await POST(req(body()), routeArgs());

        expect(res.status).toBe(403);
        expect(await denials()).toBe(deniedBefore + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entityId).toBe('access_reviews.create');
        expect(await campaigns()).toBe(0);
    });

    it('zero subjects is refused at creation over HTTP too (invariant 5): 400 NO_SUBJECTS, nothing created', async () => {
        await seedReconciledSnapshot({ withAccount: false });
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'ADMIN'));

        const res = await POST(req(body()), routeArgs());

        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toMatch(/^NO_SUBJECTS: /);
        expect(await campaigns()).toBe(0);
    });

    it('a connection that was never pulled is refused: 400 NO_SNAPSHOT, nothing created', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'ADMIN'));

        const res = await POST(req(body()), routeArgs());

        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toMatch(/^NO_SNAPSHOT: /);
        expect(await campaigns()).toBe(0);
    });

    it('a body naming a key the route does not take is a 400, and nothing is created', async () => {
        await seedReconciledSnapshot();
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'ADMIN'));

        const res = await POST(req(body({ scope: 'LEGACY_APP' })), routeArgs());

        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
        expect(await campaigns()).toBe(0);
    });
});
