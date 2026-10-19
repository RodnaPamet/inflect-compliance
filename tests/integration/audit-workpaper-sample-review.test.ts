/**
 * INTERNAL AUDIT SAMPLES THE AUDITOR'S WORKPAPERS (#3677, step 3d) — proved on
 * real rows, under `app_user` + RLS wherever the claim is about the database.
 *
 *   • The sweep draws every workpaper at the pilot's 100% (any rate below it
 *     reproducibly, from the epoch), and assigns each to an ACTIVE third-line
 *     member who does not own the auditor agent — or records it UNASSIGNED with
 *     a named reason, and re-draws it once somebody is eligible.
 *   • Only the assigned reviewer, a person, still third-line and not the
 *     auditor's owner, answers; once; in codes, never prose. The database
 *     refuses the same answers the usecase refuses.
 *   • A DISSENTED answer queues exactly ONE finding proposal through the
 *     ordinary queue, which a person decides; a re-run raises nothing twice.
 *   • The agreement rate counts concluded reviews only, and a window with none
 *     reports no rate rather than "100% agreement".
 *   • A second tenant sees, reads and answers none of it.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import {
    getMyWorkpaperReview,
    getWorkpaperReviewRate,
    listMyWorkpaperReviews,
    raiseDissentFindingProposal,
    recordWorkpaperReview,
} from '@/app-layer/usecases/audit-workpaper-sample-review';
import * as agentProposals from '@/app-layer/usecases/agent-proposals';
import { buildWorkpaperReviewReport } from '@/app-layer/usecases/agent-governance-reports';
import { runAuditWorkpaperSampleReview } from '@/app-layer/jobs/audit-workpaper-sample-review';
import {
    assignReviewer,
    assignmentPoolDigest,
    dissentProposalOriginRef,
    drawWorkpapersForReview,
    WORKPAPER_REVIEW_FINDING_SOURCE_KIND,
    workpaperReviewEpoch,
    workpaperReviewSeedFingerprint,
} from '@/lib/agentic/workpaper-review-sampling';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'wp-review-one';
const T2 = 'wp-review-two';
/** No third-line member to begin with. */
const T3 = 'wp-review-three';
const TENANTS = [T1, T2, T3];
const SEED = 'test-seed-for-workpaper-review';
const HEX = 'a'.repeat(64);

type Person = 'ownerA' | 'second' | 'thirdA' | 'thirdB' | 'first' | 'admin';
const PEOPLE: Person[] = ['ownerA', 'second', 'thirdA', 'thirdB', 'first', 'admin'];
const ROLE: Record<Person, Role> = {
    ownerA: Role.OWNER,
    second: Role.READER,
    thirdA: Role.AUDITOR,
    thirdB: Role.READER,
    first: Role.READER,
    admin: Role.ADMIN,
};
/** T1 and T2: two internal auditors. T3: none (declared later by the test). */
const LINES: Record<string, Partial<Record<Person, 'FIRST' | 'SECOND' | 'THIRD'>>> = {
    [T1]: { second: 'SECOND', thirdA: 'THIRD', thirdB: 'THIRD', first: 'FIRST' },
    [T2]: { second: 'SECOND', thirdA: 'THIRD', thirdB: 'THIRD', first: 'FIRST' },
    [T3]: { second: 'SECOND', first: 'FIRST' },
};

interface TenantFixture {
    users: Record<Person, string>;
    memberships: Record<Person, string>;
    contexts: Record<Person, RequestContext>;
    auditorId: string;
    runId: string;
}
const fx: Record<string, TenantFixture> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.controlTestRun.deleteMany({ where: t });
    await prisma.controlTestPlan.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
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

/** A valid PASS workpaper, written straight to the table (the insert guard still runs). */
async function makeWorkpaper(tenantId: string, periodLabel: string) {
    seq += 1;
    return prisma.auditWorkpaper.create({
        data: {
            tenantId,
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel,
            populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
            populationCount: 4,
            populationDigest: HEX,
            sampleEpoch: `iam.leaver_timeliness@${periodLabel}`,
            seedFingerprint: HEX,
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            attributesTested: ['L1', 'L2'],
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: 'PASS', code: null },
                { unitId: 'emp_2', outcome: 'PASS', code: null },
            ],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId: fx[tenantId].auditorId,
            controlTestRunId: fx[tenantId].runId,
        },
        select: { id: true, tenantId: true, periodLabel: true, auditorAgentId: true },
    });
}

function sweep(tenantId: string, now = new Date()) {
    return runAuditWorkpaperSampleReview(prisma, { tenantId, now, seed: SEED });
}

async function reviewOf(workpaperId: string) {
    return prisma.auditWorkpaperSampleReview.findFirstOrThrow({ where: { workpaperId } });
}

async function reasonOf(p: Promise<unknown>, type: typeof ForbiddenError | typeof ConflictError): Promise<string | undefined> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(type);
    return ((err as ForbiddenError).details as { reason?: string } | undefined)?.reason;
}

/** The person a review is assigned to, by fixture name. */
function personOf(tenantId: string, userId: string | null): Person | null {
    if (!userId) return null;
    return (Object.entries(fx[tenantId].users).find(([, id]) => id === userId)?.[0] as Person) ?? null;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const users = {} as Record<Person, string>;
        const memberships = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[who] = user.id;
            const m = await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
            memberships[who] = m.id;
        }
        const contexts = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[who]);
            contexts[who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
        for (const [who, line] of Object.entries(LINES[tenantId]) as [Person, 'FIRST' | 'SECOND' | 'THIRD'][]) {
            await setMembershipLineOfDefence(contexts.ownerA, memberships[who], { lineOfDefence: line });
        }
        seq += 1;
        const sys = await prisma.aiSystem.create({ data: { tenantId, name: `wpr host ${seq}`, ownerUserId: users.second } });
        const auditor = await prisma.registeredAgent.create({
            data: {
                tenantId,
                aiSystemId: sys.id,
                name: `wpr auditor ${seq}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: users.second,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
                isAuditor: true,
            },
        });
        const control = await prisma.control.create({
            data: { tenantId, name: `wpr control ${tenantId}`, createdByUserId: users.admin },
        });
        const plan = await prisma.controlTestPlan.create({
            data: { tenantId, controlId: control.id, name: 'Leaver timeliness', createdByUserId: users.admin },
        });
        const run = await prisma.controlTestRun.create({
            data: { tenantId, controlId: control.id, testPlanId: plan.id, createdByUserId: users.admin },
        });
        fx[tenantId] = { users, memberships, contexts, auditorId: auditor.id, runId: run.id };
    }
});

afterAll(async () => {
    jest.restoreAllMocks();
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─── The draw ───────────────────────────────────────────────────────

describe('the sweep draws every workpaper in the pilot and assigns it only to internal audit', () => {
    it('draws all of them at 100%, each once, each to an ACTIVE THIRD-line member who does not own the auditor', async () => {
        const papers = [];
        for (let i = 0; i < 6; i++) papers.push(await makeWorkpaper(T1, i % 2 === 0 ? '2026-07' : '2026-Q2'));

        const first = await sweep(T1);
        expect(first.drawn).toBe(6);
        expect(first.unassigned).toBe(0);

        const rows = await prisma.auditWorkpaperSampleReview.findMany({ where: { tenantId: T1 } });
        expect(rows.map((r) => r.workpaperId).sort()).toEqual(papers.map((p) => p.id).sort());
        for (const row of rows) {
            expect(['thirdA', 'thirdB']).toContain(personOf(T1, row.assignedToUserId));
            expect(row.outcome).toBe('PENDING');
            expect(row.samplePercent).toBe(100);
            expect(row.unassignedReason).toBeNull();
        }
        // The auditor's owner (SECOND line), FIRST line, OWNER and ADMIN are never assigned.
        const assigned = new Set(rows.map((r) => r.assignedToUserId));
        for (const who of ['second', 'first', 'ownerA', 'admin'] as Person[]) {
            expect(assigned.has(fx[T1].users[who])).toBe(false);
        }
        const sampled = await prisma.auditLog.findMany({ where: { tenantId: T1, action: 'AUDIT_WORKPAPER_SAMPLED' } });
        expect(sampled).toHaveLength(6);
        expect(sampled.every((a) => a.actorType === 'SYSTEM' && a.userId === null)).toBe(true);

        // Idempotent: nothing is drawn twice and nothing valid is moved.
        const again = await sweep(T1);
        expect(again.drawn).toBe(0);
        expect(again.reassigned).toBe(0);
        expect(await prisma.auditWorkpaperSampleReview.count({ where: { tenantId: T1 } })).toBe(6);
    });

    it('the database refuses an assignee who is not an ACTIVE third-line member, or who owns the auditor', async () => {
        const wp = await makeWorkpaper(T1, '2026-08');
        const base = {
            tenantId: T1,
            workpaperId: wp.id,
            samplingEpoch: workpaperReviewEpoch('2026-08'),
            seedFingerprint: HEX,
            samplePercent: 100,
            assignmentPoolSize: 1,
            assignmentPoolDigest: HEX,
        };
        for (const who of ['first', 'second', 'admin'] as Person[]) {
            await expect(
                asTenant(T1, (tx) => tx.auditWorkpaperSampleReview.create({ data: { ...base, assignedToUserId: fx[T1].users[who] } })),
            ).rejects.toThrow(/AUDIT_WORKPAPER_REVIEWER_NOT_THIRD_LINE/);
        }
        // A row that names nobody must name why.
        await expect(
            asTenant(T1, (tx) => tx.auditWorkpaperSampleReview.create({ data: { ...base, assignmentPoolSize: 0 } })),
        ).rejects.toThrow(/AuditWorkpaperSampleReview_assigned_or_reasoned/);
        // The epoch is fixed by the workpaper's period.
        await expect(
            asTenant(T1, (tx) =>
                tx.auditWorkpaperSampleReview.create({
                    data: { ...base, samplingEpoch: workpaperReviewEpoch('2026-07'), assignedToUserId: fx[T1].users.thirdA },
                }),
            ),
        ).rejects.toThrow(/AUDIT_WORKPAPER_SAMPLE_REVIEW_EPOCH/);
        await sweep(T1);
    });

    it('records an item UNASSIGNED with a named reason when nobody is eligible, and assigns it once somebody is', async () => {
        const wp = await makeWorkpaper(T3, '2026-07');
        const now = new Date();
        await sweep(T3, now);
        let row = await reviewOf(wp.id);
        expect(row.assignedToUserId).toBeNull();
        expect(row.unassignedReason).toBe('NO_THIRD_LINE_MEMBER');
        expect(row.assignmentPoolSize).toBe(0);

        // The auditor's owner moves to THIRD (an independence break, which raises
        // a finding and refuses nothing). They are THIRD now and still never eligible.
        await setMembershipLineOfDefence(fx[T3].contexts.ownerA, fx[T3].memberships.second, { lineOfDefence: 'THIRD' });
        const second = await sweep(T3);
        expect(second.reassigned).toBe(1);
        row = await reviewOf(wp.id);
        expect(row.assignedToUserId).toBeNull();
        expect(row.unassignedReason).toBe('ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR');

        // Somebody eligible appears: the next sweep assigns them.
        await setMembershipLineOfDefence(fx[T3].contexts.ownerA, fx[T3].memberships.first, { lineOfDefence: 'THIRD' });
        await sweep(T3);
        row = await reviewOf(wp.id);
        expect(personOf(T3, row.assignedToUserId)).toBe('first');
        expect(row.unassignedReason).toBeNull();
        const moves = await prisma.auditLog.findMany({
            where: { tenantId: T3, entityId: row.id, action: 'AUDIT_WORKPAPER_SAMPLE_REASSIGNED' },
        });
        expect(moves).toHaveLength(2);

        // An UNASSIGNED item cannot be answered; nobody is anybody's assignee.
        const other = await makeWorkpaper(T3, '2026-08');
        await setMembershipLineOfDefence(fx[T3].contexts.ownerA, fx[T3].memberships.first, { lineOfDefence: 'FIRST' });
        await sweep(T3);
        const unassigned = await reviewOf(other.id);
        expect(unassigned.unassignedReason).toBe('ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR');
        expect(await reasonOf(recordWorkpaperReview(fx[T3].contexts.first, unassigned.id, { outcome: 'CONCURRED' }), ConflictError)).toBe(
            'UNASSIGNED',
        );
    });
});

describe('the sample is reproducible from its epoch', () => {
    it('re-derives the same draw and the same reviewer from (seed, epoch, workpaper, rate, pool)', async () => {
        await prisma.tenantSecuritySettings.create({ data: { tenantId: T2, workpaperReviewSamplePercent: 50 } });
        const papers = [];
        for (let i = 0; i < 16; i++) papers.push(await makeWorkpaper(T2, i < 8 ? '2026-05' : '2026-06'));

        await sweep(T2);
        const rows = await prisma.auditWorkpaperSampleReview.findMany({ where: { tenantId: T2 } });
        const expected = drawWorkpapersForReview(papers, { seed: SEED, samplePercent: 50 });
        // A real sample: some drawn, some not, and exactly the pure rule's.
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(papers.length);
        expect(rows.map((r) => r.workpaperId).sort()).toEqual(expected.map((p) => p.id).sort());

        const members = Object.entries(LINES[T2])
            .filter(([, line]) => line === 'THIRD')
            .map(([who]) => ({ userId: fx[T2].users[who as Person], status: 'ACTIVE', lineOfDefence: 'THIRD' }));
        for (const row of rows) {
            const wp = papers.find((p) => p.id === row.workpaperId)!;
            expect(row.samplingEpoch).toBe(workpaperReviewEpoch(wp.periodLabel));
            expect(row.seedFingerprint).toBe(workpaperReviewSeedFingerprint(SEED));
            expect(row.samplePercent).toBe(50);
            const again = assignReviewer({
                seed: SEED,
                epoch: row.samplingEpoch,
                workpaperId: row.workpaperId,
                auditorOwnerUserId: fx[T2].users.second,
                members,
            });
            expect(again.assignedToUserId).toBe(row.assignedToUserId);
            expect(again.poolDigest).toBe(row.assignmentPoolDigest);
            expect(row.assignmentPoolDigest).toBe(assignmentPoolDigest(members.map((m) => m.userId)));
        }

        // A later sweep re-decides every workpaper the same way: none it passed
        // over is drawn now, so the sample does not creep towards everything.
        const later = await sweep(T2);
        expect(later.drawn).toBe(0);
        // A different seed is a different draw — the seed is what the epoch is keyed under.
        expect(drawWorkpapersForReview(papers, { seed: 'another-seed', samplePercent: 50 }).map((p) => p.id)).not.toEqual(
            expected.map((p) => p.id),
        );
    });
});

// ─── Who may answer ─────────────────────────────────────────────────

describe('only the assigned third-line reviewer, a person who does not own the auditor, answers', () => {
    let row: Awaited<ReturnType<typeof reviewOf>>;
    let assignee: Person;
    let other: Person;

    beforeAll(async () => {
        const wp = await makeWorkpaper(T1, '2026-09');
        await sweep(T1);
        row = await reviewOf(wp.id);
        assignee = personOf(T1, row.assignedToUserId) as Person;
        other = assignee === 'thirdA' ? 'thirdB' : 'thirdA';
    });

    it('lists the review for its assignee only, and refuses the queue nothing but the reason to anyone outside internal audit', async () => {
        const mine = await listMyWorkpaperReviews(fx[T1].contexts[assignee]);
        expect(mine.reviewer).toEqual({ eligible: true, reason: null });
        expect(mine.rows.map((r) => r.id)).toContain(row.id);
        const theirs = await listMyWorkpaperReviews(fx[T1].contexts[other]);
        expect(theirs.rows.map((r) => r.id)).not.toContain(row.id);
        const firstLine = await listMyWorkpaperReviews(fx[T1].contexts.first);
        expect(firstLine).toEqual({ reviewer: { eligible: false, reason: 'REVIEWER_LINE_NOT_THIRD' }, rows: [], truncated: false });
    });

    it('refuses a credential, an agent and a job outright', async () => {
        const ctx = fx[T1].contexts[assignee];
        for (const variant of [{ apiKeyId: 'k-1' }, { agentId: fx[T1].auditorId }, { actorType: 'JOB' as const }]) {
            await expect(recordWorkpaperReview({ ...ctx, ...variant }, row.id, { outcome: 'CONCURRED' })).rejects.toBeInstanceOf(
                ForbiddenError,
            );
        }
    });

    it('refuses anybody but the assignee, with a named reason and an AUTHZ_DENIED row', async () => {
        for (const who of [other, 'second', 'first', 'admin', 'ownerA'] as Person[]) {
            expect(await reasonOf(recordWorkpaperReview(fx[T1].contexts[who], row.id, { outcome: 'CONCURRED' }), ForbiddenError)).toBe(
                'NOT_ASSIGNED_REVIEWER',
            );
        }
        expect(await reasonOf(getMyWorkpaperReview(fx[T1].contexts[other], row.id), ForbiddenError)).toBe('NOT_ASSIGNED_REVIEWER');
        const denied = await prisma.auditLog.count({ where: { tenantId: T1, entityId: row.id, action: 'AUTHZ_DENIED' } });
        expect(denied).toBeGreaterThanOrEqual(6);
    });

    it('the auditor agent’s owner can never review its workpapers — in the usecase, in the database, and by re-assignment', async () => {
        // Ownership moves to the assignee after the draw.
        await prisma.registeredAgent.update({ where: { id: fx[T1].auditorId }, data: { ownerUserId: row.assignedToUserId as string } });
        try {
            expect(
                await reasonOf(recordWorkpaperReview(fx[T1].contexts[assignee], row.id, { outcome: 'CONCURRED' }), ForbiddenError),
            ).toBe('REVIEWER_OWNS_AUDITOR');
            const listed = await listMyWorkpaperReviews(fx[T1].contexts[assignee]);
            expect(listed.rows.find((r) => r.id === row.id)).toMatchObject({ answerable: false, refusal: 'REVIEWER_OWNS_AUDITOR' });
            // Below the usecase: an answer by the owner is refused for app_user.
            await expect(
                asTenant(T1, (tx) =>
                    tx.auditWorkpaperSampleReview.update({
                        where: { id: row.id },
                        data: { outcome: 'CONCURRED', reviewedByUserId: row.assignedToUserId, reviewedAt: new Date() },
                    }),
                ),
            ).rejects.toThrow(/AUDIT_WORKPAPER_REVIEWER_OWNS_AUDITOR/);
            // The sweep moves it to somebody who can answer it.
            const moved = await sweep(T1);
            expect(moved.reassigned).toBeGreaterThanOrEqual(1);
            const after = await reviewOf(row.workpaperId);
            expect(personOf(T1, after.assignedToUserId)).toBe(other);
        } finally {
            await prisma.registeredAgent.update({ where: { id: fx[T1].auditorId }, data: { ownerUserId: fx[T1].users.second } });
        }
        row = await reviewOf(row.workpaperId);
        assignee = other;
        other = assignee === 'thirdA' ? 'thirdB' : 'thirdA';
    });

    it('refuses an assignee whose line moved off THIRD since the draw', async () => {
        await setMembershipLineOfDefence(fx[T1].contexts.ownerA, fx[T1].memberships[assignee], { lineOfDefence: 'SECOND' });
        try {
            expect(
                await reasonOf(recordWorkpaperReview(fx[T1].contexts[assignee], row.id, { outcome: 'CONCURRED' }), ForbiddenError),
            ).toBe('REVIEWER_LINE_NOT_THIRD');
        } finally {
            await setMembershipLineOfDefence(fx[T1].contexts.ownerA, fx[T1].memberships[assignee], { lineOfDefence: 'THIRD' });
        }
    });

    it('accepts the assignee’s answer once, stamps the workpaper, and freezes the row for every role', async () => {
        const detail = await getMyWorkpaperReview(fx[T1].contexts[assignee], row.id);
        expect(detail.workpaper.id).toBe(row.workpaperId);
        expect(detail.workpaper.sampledUnitIds).toEqual(['emp_1', 'emp_2']);

        const answer = await recordWorkpaperReview(fx[T1].contexts[assignee], row.id, { outcome: 'CONCURRED' });
        expect(answer).toEqual({ id: row.id, outcome: 'CONCURRED', workpaperStamped: true, findingProposal: null });
        const stored = await reviewOf(row.workpaperId);
        expect(stored).toMatchObject({ outcome: 'CONCURRED', reviewedByUserId: row.assignedToUserId, dissentCodes: [] });
        const wp = await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: row.workpaperId } });
        expect(wp.reviewedByUserId).toBe(row.assignedToUserId);

        expect(await reasonOf(recordWorkpaperReview(fx[T1].contexts[assignee], row.id, { outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED'] }), ConflictError)).toBe(
            'ALREADY_REVIEWED',
        );
        // Write-once below the usecase too, for app_user and for the table owner.
        await expect(
            asTenant(T1, (tx) => tx.auditWorkpaperSampleReview.update({ where: { id: row.id }, data: { outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED'] } })),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW/);
        await expect(
            prisma.auditWorkpaperSampleReview.update({ where: { id: row.id }, data: { outcome: 'INDETERMINATE' } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_SAMPLE_REVIEW/);
        await expect(
            asTenant(T1, (tx) => tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaperSampleReview" WHERE id = $1`, row.id)),
        ).rejects.toThrow(/permission denied/);
        const recorded = await prisma.auditLog.findFirst({
            where: { tenantId: T1, entityId: row.id, action: 'AUDIT_WORKPAPER_SAMPLE_REVIEW_RECORDED' },
        });
        expect(recorded?.userId).toBe(row.assignedToUserId);
    });
});

describe('dissent is stable codes, never free text', () => {
    let reviewId: string;
    let ctx: RequestContext;

    beforeAll(async () => {
        const wp = await makeWorkpaper(T1, '2026-10');
        await sweep(T1);
        const row = await reviewOf(wp.id);
        reviewId = row.id;
        ctx = fx[T1].contexts[personOf(T1, row.assignedToUserId) as Person];
    });

    it('refuses prose, an undeclared key, a dissent with no code and a code with no dissent', async () => {
        const bad = [
            { outcome: 'DISSENTED', dissentCodes: ['the auditor missed two leavers in March'] },
            { outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED'], note: 'see emp_1' },
            { outcome: 'CONCURRED', comment: 'fine' },
            { outcome: 'DISSENTED' },
            { outcome: 'DISSENTED', dissentCodes: [] },
            { outcome: 'CONCURRED', dissentCodes: ['EXCEPTION_MISSED'] },
            { outcome: 'PENDING' },
        ];
        for (const body of bad) {
            await expect(recordWorkpaperReview(ctx, reviewId, body)).rejects.toMatchObject({ status: 400 });
        }
        expect((await prisma.auditWorkpaperSampleReview.findUniqueOrThrow({ where: { id: reviewId } })).outcome).toBe('PENDING');
    });

    it('the column itself holds only the vocabulary, and the table has no free-text column', async () => {
        await expect(
            prisma.auditWorkpaperSampleReview.update({
                where: { id: reviewId },
                data: { outcome: 'DISSENTED', dissentCodes: ['free text here'], reviewedByUserId: ctx.userId, reviewedAt: new Date() },
            }),
        ).rejects.toThrow(/AuditWorkpaperSampleReview_answer_shapes/);
        const columns = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'AuditWorkpaperSampleReview'`,
        );
        const text = columns.filter((c) => c.data_type === 'text').map((c) => c.column_name).sort();
        // Every text column is an identifier, a code or a digest — each pinned by
        // a CHECK or a trigger. No note, comment, reason-in-prose or rationale.
        expect(text).toEqual([
            'assignedToUserId',
            'assignmentPoolDigest',
            'findingProposalId',
            'id',
            'reviewedByUserId',
            'samplingEpoch',
            'seedFingerprint',
            'tenantId',
            'unassignedReason',
            'workpaperId',
        ]);
    });
});

// ─── A dissent queues a finding proposal ────────────────────────────

describe('a DISSENTED review queues exactly one finding proposal, which a person decides', () => {
    it('raises it through the ordinary queue, names the workpaper, the codes and the reviewer, and writes no finding', async () => {
        const wp = await makeWorkpaper(T1, '2026-11');
        await sweep(T1);
        const row = await reviewOf(wp.id);
        const reviewer = fx[T1].contexts[personOf(T1, row.assignedToUserId) as Person];
        const findingsBefore = await prisma.finding.count({ where: { tenantId: T1 } });

        const answer = await recordWorkpaperReview(reviewer, row.id, {
            outcome: 'DISSENTED',
            dissentCodes: ['EXCEPTION_MISSED', 'CONCLUSION_NOT_SUPPORTED'],
        });
        expect(answer.findingProposal?.status).toBe('RAISED');
        const proposalId = answer.findingProposal?.proposalId as string;

        const proposals = await prisma.agentProposal.findMany({
            where: { tenantId: T1, proposedBySessionRef: dissentProposalOriginRef(row.id) },
        });
        expect(proposals).toHaveLength(1);
        expect(proposals[0]).toMatchObject({
            id: proposalId,
            kind: 'FINDING',
            operation: 'CREATE',
            status: 'PENDING',
            agentId: null,
            policyCardVersion: 0,
            requiredApprovals: 1,
            proposedViaKeyId: null,
        });
        const decrypted = await agentProposals.getAgentProposal(fx[T1].contexts.admin, proposalId);
        const payload = JSON.parse(decrypted.payloadJson) as Record<string, string>;
        expect(payload.sourceKind).toBe(WORKPAPER_REVIEW_FINDING_SOURCE_KIND);
        expect(payload.sourceRef).toBe(row.id);
        expect(payload.description).toContain(wp.id);
        expect(payload.description).toContain('EXCEPTION_MISSED, CONCLUSION_NOT_SUPPORTED');
        expect(payload.description).toContain(`reviewer ${reviewer.userId}`);
        expect((await reviewOf(wp.id)).findingProposalId).toBe(proposalId);
        // Raised by the reviewer as a person, not as an API key or the auditor.
        const created = await prisma.auditLog.findFirst({ where: { tenantId: T1, entityId: proposalId, action: 'AGENT_PROPOSAL_CREATED' } });
        expect(created?.actorType).toBe('USER');
        // Nothing has been written to the finding register yet.
        expect(await prisma.finding.count({ where: { tenantId: T1 } })).toBe(findingsBefore);

        // A re-run — the answer path's raise again, and the sweep's heal —
        // raises nothing twice.
        expect(await raiseDissentFindingProposal(reviewer, row.id)).toEqual({ proposalId, raised: false });
        const healed = await sweep(T1);
        expect(healed.proposalsRaised).toBe(0);
        expect(await prisma.agentProposal.count({ where: { tenantId: T1, proposedBySessionRef: dissentProposalOriginRef(row.id) } })).toBe(1);

        // A person decides it, through the queue's own approval.
        const outcome = await agentProposals.approveAgentProposal(fx[T1].contexts.admin, proposalId);
        expect(agentProposals.wasApplied(outcome)).toBe(true);
        const finding = await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceKind: WORKPAPER_REVIEW_FINDING_SOURCE_KIND, sourceRef: row.id } });
        expect(finding.type).toBe('NONCONFORMITY');
        expect(await prisma.finding.count({ where: { tenantId: T1 } })).toBe(findingsBefore + 1);
    });

    it('a raise that failed after the answer committed is raised by the next sweep, once', async () => {
        const wp = await makeWorkpaper(T1, '2026-12');
        await sweep(T1);
        const row = await reviewOf(wp.id);
        const reviewer = fx[T1].contexts[personOf(T1, row.assignedToUserId) as Person];

        const spy = jest.spyOn(agentProposals, 'createAgentProposal').mockRejectedValueOnce(new Error('queue down'));
        const answer = await recordWorkpaperReview(reviewer, row.id, { outcome: 'DISSENTED', dissentCodes: ['ITEM_OUTCOME_WRONG'] });
        spy.mockRestore();
        expect(answer.findingProposal).toEqual({ status: 'NOT_RAISED', proposalId: null });
        expect((await reviewOf(wp.id)).outcome).toBe('DISSENTED');
        expect(await prisma.agentProposal.count({ where: { tenantId: T1, proposedBySessionRef: dissentProposalOriginRef(row.id) } })).toBe(0);

        const healed = await sweep(T1);
        expect(healed.proposalsRaised).toBe(1);
        const again = await sweep(T1);
        expect(again.proposalsRaised).toBe(0);
        const proposals = await prisma.agentProposal.findMany({ where: { tenantId: T1, proposedBySessionRef: dissentProposalOriginRef(row.id) } });
        expect(proposals).toHaveLength(1);
        expect((await reviewOf(wp.id)).findingProposalId).toBe(proposals[0].id);
        // Raised by the sweep, and labelled so.
        const created = await prisma.auditLog.findFirst({ where: { tenantId: T1, entityId: proposals[0].id, action: 'AGENT_PROPOSAL_CREATED' } });
        expect(created?.actorType).toBe('JOB');
    });

    it('a raise interrupted between the queue and the link links the proposal it already raised', async () => {
        const wp = await makeWorkpaper(T2, '2026-12');
        await prisma.tenantSecuritySettings.update({ where: { tenantId: T2 }, data: { workpaperReviewSamplePercent: 100 } });
        await sweep(T2);
        const row = await reviewOf(wp.id);
        const reviewer = fx[T2].contexts[personOf(T2, row.assignedToUserId) as Person];

        // The answer lands; the raise reaches the queue and dies before the link.
        const spy = jest.spyOn(agentProposals, 'createAgentProposal').mockRejectedValueOnce(new Error('crash'));
        await recordWorkpaperReview(reviewer, row.id, { outcome: 'DISSENTED', dissentCodes: ['EVIDENCE_INSUFFICIENT'] });
        spy.mockRestore();
        const orphan = await agentProposals.createAgentProposal(reviewer, {
            kind: 'FINDING',
            payload: { title: 'raised before the crash', severity: 'MEDIUM', type: 'NONCONFORMITY' },
            policyCardVersion: 0,
            proposedBySessionRef: dissentProposalOriginRef(row.id),
        });

        expect(await raiseDissentFindingProposal(reviewer, row.id)).toEqual({ proposalId: orphan.id, raised: false });
        expect(await prisma.agentProposal.count({ where: { tenantId: T2, proposedBySessionRef: dissentProposalOriginRef(row.id) } })).toBe(1);
        expect((await reviewOf(wp.id)).findingProposalId).toBe(orphan.id);
    });
});

// ─── The number ─────────────────────────────────────────────────────

describe('the agreement rate counts concluded reviews only', () => {
    it('a drawn but unreviewed workpaper never counts toward agreement, and INDETERMINATE and UNASSIGNED are excluded', async () => {
        const rate = await getWorkpaperReviewRate(fx[T1].contexts.admin);
        const rows = await prisma.auditWorkpaperSampleReview.findMany({ where: { tenantId: T1 } });
        const count = (o: string) => rows.filter((r) => r.outcome === o).length;
        expect(rate.drawn).toBe(rows.length);
        expect(rate.awaiting).toBe(rows.filter((r) => r.outcome === 'PENDING' && r.assignedToUserId).length);
        expect(rate.awaiting).toBeGreaterThan(0);
        expect(rate.concurred).toBe(count('CONCURRED'));
        expect(rate.dissented).toBe(count('DISSENTED'));
        expect(rate.concluded).toBe(rate.concurred + rate.dissented);
        expect(rate.agreementRate).toBeCloseTo(rate.concurred / rate.concluded);
        expect(rate.disagreementRate).toBeCloseTo(rate.dissented / rate.concluded);

        // One more INDETERMINATE answer moves neither rate.
        const pending = rows.find((r) => r.outcome === 'PENDING' && r.assignedToUserId)!;
        await recordWorkpaperReview(fx[T1].contexts[personOf(T1, pending.assignedToUserId) as Person], pending.id, {
            outcome: 'INDETERMINATE',
        });
        const after = await getWorkpaperReviewRate(fx[T1].contexts.admin);
        expect(after.indeterminate).toBe(rate.indeterminate + 1);
        expect(after.awaiting).toBe(rate.awaiting - 1);
        expect(after.agreementRate).toBe(rate.agreementRate);
        expect(after.concluded).toBe(rate.concluded);

        // T3: drawn and UNASSIGNED rows, nothing concluded — no rate at all.
        const none = await getWorkpaperReviewRate(fx[T3].contexts.admin);
        expect(none.drawn).toBeGreaterThan(0);
        expect(none.unassigned).toBeGreaterThan(0);
        expect(none.concluded).toBe(0);
        expect(none.agreementRate).toBeNull();
        expect(none.disagreementRate).toBeNull();
    });

    it('the report carries the rate with its definition, and reports NOT_ASSESSED — never 100% — over nothing concluded', async () => {
        const report = await buildWorkpaperReviewReport(fx[T3].contexts.admin);
        expect(report.reportId).toBe('workpaper-review');
        expect(report.metrics['assurance.workpaper_reperformance_agreement_rate']).toEqual({
            state: 'NOT_ASSESSED',
            value: null,
            basis: 'NO_CONCLUDED_WORKPAPER_REVIEWS',
        });
        expect(report.definitions.map((d) => d.id).sort()).toEqual(Object.keys(report.metrics).sort());

        const definition = METRIC_DEFINITIONS['assurance.workpaper_reperformance_agreement_rate'];
        const excludes = definition.excludes.join(' | ');
        expect(excludes).toMatch(/drawn but unreviewed/);
        expect(excludes).toMatch(/INDETERMINATE/);
        expect(excludes).toMatch(/UNASSIGNED/);
        expect(excludes).toMatch(/100% agreement/);

        const measured = await buildWorkpaperReviewReport(fx[T1].contexts.admin);
        expect(measured.metrics['assurance.workpaper_reperformance_agreement_rate']?.state).toBe('MEASURED');
        expect(measured.body.samplePercent).toBe(100);
    });
});

// ─── Isolation ──────────────────────────────────────────────────────

describe('a second tenant sees, reads and answers none of it', () => {
    it('lists none of T1’s reviews, reads none, answers none, and RLS hides every row', async () => {
        const t1Ids = (await prisma.auditWorkpaperSampleReview.findMany({ where: { tenantId: T1 }, select: { id: true } })).map((r) => r.id);
        expect(t1Ids.length).toBeGreaterThan(0);

        for (const who of ['thirdA', 'thirdB'] as Person[]) {
            const listed = await listMyWorkpaperReviews(fx[T2].contexts[who]);
            expect(listed.rows.some((r) => t1Ids.includes(r.id))).toBe(false);
            await expect(getMyWorkpaperReview(fx[T2].contexts[who], t1Ids[0])).rejects.toBeInstanceOf(NotFoundError);
            await expect(recordWorkpaperReview(fx[T2].contexts[who], t1Ids[0], { outcome: 'CONCURRED' })).rejects.toBeInstanceOf(
                NotFoundError,
            );
        }
        const seen = await asTenant(T2, (tx) => tx.auditWorkpaperSampleReview.findMany({ where: { id: { in: t1Ids } } }));
        expect(seen).toEqual([]);
        await expect(
            asTenant(T2, (tx) =>
                tx.auditWorkpaperSampleReview.create({
                    data: {
                        tenantId: T1,
                        workpaperId: 'x',
                        samplingEpoch: workpaperReviewEpoch('2026-07'),
                        seedFingerprint: HEX,
                        samplePercent: 100,
                        unassignedReason: 'NO_THIRD_LINE_MEMBER',
                        assignmentPoolSize: 0,
                        assignmentPoolDigest: HEX,
                    },
                }),
            ),
        ).rejects.toThrow();
        // T2's rate is T2's.
        const t2 = await getWorkpaperReviewRate(fx[T2].contexts.admin);
        expect(t2.drawn).toBe(await prisma.auditWorkpaperSampleReview.count({ where: { tenantId: T2 } }));
    });
});
