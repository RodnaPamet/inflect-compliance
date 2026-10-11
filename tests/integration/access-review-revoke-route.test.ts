/**
 * Revoking a recorded verdict over HTTP (#3269) — the route, the two refusals,
 * and the audit row an auditor reads.
 *
 * `revokeDecision` was complete, gated, audited and unit-tested from Audit
 * Coherence S7 and had NO ROUTE. Its eleven unit tests cover the usecase's own
 * gates well; none of them can cover what this file does, because the thing
 * that was missing was reachability.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO REFUSALS ARE DIFFERENT MECHANISMS, AND #3269 CONFLATED THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The issue's acceptance criterion asks for a test proving "a non-reviewer
 * non-admin is refused AND that the refusal writes AUTHZ_DENIED". Both halves
 * cannot hold at once:
 *
 *   `access_reviews.decide` is `true` for ALL FIVE roles — OWNER, ADMIN,
 *   EDITOR, AUDITOR and READER (`permissions.ts:380,408,451,474,497`), because
 *   a reviewer is assigned per CAMPAIGN and a READER can legitimately be the
 *   assigned reviewer.
 *
 * So a non-reviewer non-admin MEMBER holds the key, passes `requirePermission`,
 * and is refused by the usecase — which writes no audit row at all. An
 * `AUTHZ_DENIED` row requires a principal WITHOUT the key, which for a key
 * granted to every role means somebody with no active membership.
 *
 *   no key        -> requirePermission -> 403 + exactly one AUTHZ_DENIED
 *   key, wrong person -> usecase forbidden() -> 403 + NO audit row
 *
 * Both are asserted below, separately and by name. The reason to be explicit
 * rather than to test whichever one passes: a later reader who sees "non-admin
 * refused, no AUTHZ_DENIED" and treats the missing row as the bug has one
 * obvious fix available — narrow the key — and that fix would make a typo'd
 * verdict unfixable for exactly the non-admin reviewers this usecase was
 * written for, sending them back to the admin-plus-database path.
 *
 * Driven through the REAL route handler. Only `getTenantCtx` is mocked, because
 * it is the one thing in the path needing a browser session; `requirePermission`,
 * `parseJsonBody`, the usecase, `logEvent`, the hash chain and RLS are all real,
 * against the real database.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { POST } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/revoke/route';
import { verifyAuditChain } from '@/lib/audit';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import type { RequestContext } from '@/app-layer/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `arrev-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
/** The ASSIGNED REVIEWER, deliberately a READER — the whole point of the key. */
const REVIEWER = `u-rev-${SUITE}`;
/** A member who holds `decide` but is neither the reviewer nor an admin. */
const BYSTANDER = `u-by-${SUITE}`;
const ADMIN = `u-adm-${SUITE}`;
const SUBJECT = `u-sub-${SUITE}`;

let reviewId = '';
let decisionId = '';

const ctxFor = (userId: string, role: string, over: Partial<RequestContext> = {}) =>
    makeRequestContext(role, { tenantId: TENANT, tenantSlug: TENANT, userId, ...over });

/** A principal with the role but WITHOUT the key — no active membership. */
function keylessCtx(): RequestContext {
    const base = getPermissionsForRole('READER');
    return ctxFor(REVIEWER, 'READER', {
        appPermissions: {
            ...base,
            access_reviews: { ...base.access_reviews, decide: false },
        },
    });
}

const path = () => `/api/t/${TENANT}/access-reviews/${reviewId}/decisions/${decisionId}/revoke`;

const req = (body?: unknown): NextRequest =>
    new NextRequest(`http://localhost${path()}`, {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

const routeArgs = () => ({
    params: Promise.resolve({ tenantSlug: TENANT, reviewId, decisionId }),
});

const countDenials = () =>
    prisma.auditLog.count({ where: { tenantId: TENANT, action: 'AUTHZ_DENIED' } });

const countRevokes = () =>
    prisma.auditLog.count({
        where: { tenantId: TENANT, action: 'ACCESS_REVIEW_DECISION_REVOKED' },
    });

/** Put the decision back into the decided state, so each test starts equal. */
async function reDecide(): Promise<void> {
    await prisma.accessReviewDecision.update({
        where: { id: decisionId },
        data: {
            decision: 'CONFIRM',
            decidedAt: new Date(),
            decidedByUserId: REVIEWER,
            notes: 'original verdict',
            executedAt: null,
        },
    });
}

describeFn('POST …/decisions/:id/revoke (real route, real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        for (const [id, role] of [
            [REVIEWER, 'READER'], [BYSTANDER, 'EDITOR'], [ADMIN, 'OWNER'], [SUBJECT, 'READER'],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.upsert({
                where: { id }, update: {},
                create: { id, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId: id } },
                update: { role, status: 'ACTIVE' },
                create: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        const review = await prisma.accessReview.create({
            data: {
                tenantId: TENANT,
                name: `Revoke route ${SUITE}`,
                reviewerUserId: REVIEWER,
                createdByUserId: ADMIN,
                status: 'OPEN',
            },
            select: { id: true },
        });
        reviewId = review.id;
        const decision = await prisma.accessReviewDecision.create({
            data: {
                tenantId: TENANT,
                accessReviewId: reviewId,
                subjectUserId: SUBJECT,
                snapshotRole: 'EDITOR',
                snapshotMembershipStatus: 'ACTIVE',
                decision: 'CONFIRM',
                decidedAt: new Date(),
                decidedByUserId: REVIEWER,
                notes: 'original verdict',
            },
            select: { id: true },
        });
        decisionId = decision.id;
    });

    afterAll(async () => {
        if (TENANT) {
            await prisma.accessReviewDecision.deleteMany({ where: { tenantId: TENANT } });
            await prisma.accessReview.deleteMany({ where: { tenantId: TENANT } });
            // Audit rows BEFORE the parents, not `.catch(() => {})` after them.
            // `AuditLog` has real FKs to Tenant and User, so a swallowed
            // teardown failure here leaks rows into whichever suite shares this
            // shard next (#3343).
            await deleteAuditRowsForTenants(prisma, TENANT);
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT,
                );
            });
            await prisma.tenant.deleteMany({ where: { id: TENANT } });
            await prisma.user.deleteMany({
                where: { id: { in: [REVIEWER, BYSTANDER, ADMIN, SUBJECT] } },
            });
        }
        await prisma.$disconnect();
    });

    it('the declarative map resolves the revoke leaf, and the sibling keeps its own rule', () => {
        // Two mechanisms: the runtime middleware and the map the SDK and docs
        // read. And the sibling assertion is the one that matters — if the
        // revoke pattern were ordered so that it swallowed
        // `…/decisions/:id`, recording a verdict would silently resolve
        // through the wrong rule.
        expect(resolveRoutePermission(path(), 'POST')?.permission)
            .toBe('access_reviews.decide');
        expect(
            resolveRoutePermission(
                `/api/t/${TENANT}/access-reviews/${reviewId}/decisions/${decisionId}`, 'PUT',
            )?.permission,
        ).toBe('access_reviews.decide');
    });

    it('the ASSIGNED REVIEWER, holding only READER, can revoke', async () => {
        // THE POSITIVE CONTROL, and the central claim of the route's docblock:
        // the key is granted to every role precisely so a READER who was
        // assigned the campaign can act. Without this test, every refusal below
        // is equally consistent with a route that refuses everybody.
        await reDecide();
        getTenantCtxMock.mockResolvedValue(ctxFor(REVIEWER, 'READER'));
        const before = await countRevokes();

        const res = await POST(req({ reason: 'Recorded CONFIRM on the wrong row' }), routeArgs());
        expect(res.status).toBe(200);

        const row = await prisma.accessReviewDecision.findUniqueOrThrow({
            where: { id: decisionId },
        });
        expect(row.decision).toBeNull();
        expect(row.notes).toBeNull();
        // The evidentiary half SURVIVES. This is what makes the operation a
        // reset rather than a delete, and why the route is a POST on an action
        // leaf instead of a DELETE on the decision.
        expect(row.snapshotRole).toBe('EDITOR');
        expect(row.snapshotMembershipStatus).toBe('ACTIVE');

        expect(await countRevokes()).toBe(before + 1);
    });

    it('the revoked row carries the REASON, which is what the audit row is for', async () => {
        await reDecide();
        getTenantCtxMock.mockResolvedValue(ctxFor(REVIEWER, 'READER'));

        const reason = `Subject had already left on ${SUITE}`;
        const res = await POST(req({ reason }), routeArgs());
        expect(res.status).toBe(200);

        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'ACCESS_REVIEW_DECISION_REVOKED' },
            orderBy: { createdAt: 'desc' },
        });
        const details = row.detailsJson as Record<string, unknown>;
        expect(details.reason).toBe(reason);
        // The prior verdict too: "it was unwound" is not an answer without
        // "from what".
        expect((details.before as Record<string, unknown>).decision).toBe('CONFIRM');
        expect(details.actorIsAssignedReviewer).toBe(true);
    });

    it('an ADMIN who is not the reviewer can revoke on the reviewer\'s behalf', async () => {
        await reDecide();
        getTenantCtxMock.mockResolvedValue(ctxFor(ADMIN, 'OWNER'));

        const res = await POST(req({ reason: 'Reviewer asked me to unwind it' }), routeArgs());
        expect(res.status).toBe(200);

        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'ACCESS_REVIEW_DECISION_REVOKED' },
            orderBy: { createdAt: 'desc' },
        });
        // Distinguishable from the reviewer's own revoke, which is the point of
        // recording the flag rather than inferring it from the actor.
        expect((row.detailsJson as Record<string, unknown>).actorIsAssignedReviewer).toBe(false);
    });

    it('a MEMBER who holds the key but is neither reviewer nor admin is refused, with NO audit row', async () => {
        // REFUSAL ONE, from the usecase. #3269 expected an `AUTHZ_DENIED` here
        // and there cannot be one: this principal HOLDS `access_reviews.decide`
        // — every role does — so `requirePermission` admits them and the
        // usecase refuses them. Asserting the ABSENCE is the point; see the
        // file docblock for why treating the missing row as a bug would be the
        // expensive mistake.
        await reDecide();
        getTenantCtxMock.mockResolvedValue(ctxFor(BYSTANDER, 'EDITOR'));
        const deniedBefore = await countDenials();

        const res = await POST(req({ reason: 'I think this is wrong' }), routeArgs());
        expect(res.status).toBe(403);
        expect(await countDenials()).toBe(deniedBefore);

        // And it did not take effect.
        const row = await prisma.accessReviewDecision.findUniqueOrThrow({
            where: { id: decisionId },
        });
        expect(row.decision).toBe('CONFIRM');
    });

    it('a principal WITHOUT the key is refused by the gate, with exactly one AUTHZ_DENIED', async () => {
        // REFUSAL TWO, from `requirePermission`. Exactly one, not "at least
        // one": a second gate a layer down would double every denial and make
        // the trail count refusals rather than attempts.
        await reDecide();
        getTenantCtxMock.mockResolvedValue(keylessCtx());
        const before = await countDenials();

        const res = await POST(req({ reason: 'No membership here' }), routeArgs());
        expect(res.status).toBe(403);
        expect(await countDenials()).toBe(before + 1);

        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entity).toBe('Permission');
        expect(row.entityId).toBe('access_reviews.decide');

        // The 403 body must not echo the key, or the permission namespace is
        // enumerable one request at a time.
        expect(JSON.stringify(await res.json())).not.toContain('access_reviews');
    });

    it('a reason under three characters is refused at the route, before the usecase', async () => {
        // The schema is enforced by `parseJsonBody` at the route. Worth its own
        // case because the reason is not decoration: it is what makes the audit
        // row answer "why was this unwound".
        await reDecide();
        getTenantCtxMock.mockResolvedValue(ctxFor(REVIEWER, 'READER'));
        const before = await countRevokes();

        const res = await POST(req({ reason: 'x' }), routeArgs());
        expect(res.status).toBe(400);
        expect(await countRevokes()).toBe(before);
    });

    it('the audit chain still verifies after both refusals and three revokes', async () => {
        // A row appended under a REJECTED request is still a row in the
        // tenant's hash chain. If a denial wrote a row that did not link, every
        // later entry for this tenant would be unverifiable — the trail broken
        // by the control meant to protect it.
        //
        // `prisma` IS PASSED EXPLICITLY. `verifyAuditChain(tenantId)` falls back
        // to the default client, which is a different connection from this
        // suite's — so the call would verify a chain this test never wrote to
        // and report `valid: true` over nothing. A green assertion about the
        // wrong database is worse than no assertion.
        const result = await verifyAuditChain(TENANT, prisma);
        expect(result.valid).toBe(true);
        expect(result.unhashedEntries).toBe(0);

        // The chain holds BOTH kinds of row — the gate's denial and the
        // usecase's revokes. Verifying a chain of one kind proves less than
        // verifying a mixed one, and an empty chain is trivially valid.
        expect(result.hashedEntries).toBeGreaterThanOrEqual(4);
        expect(await countRevokes()).toBe(3);
        expect(await countDenials()).toBe(1);
    });
});
