/**
 * EP-4 Part 1 — evidence retention/KPI aggregate reflects the FULL dataset
 * (integration).
 *
 * Proves, against a real DB, that `getEvidenceRetentionMetrics` computes
 * authoritative tenant-wide counts by DB aggregate — NOT from the ≤100-row
 * SSR page the list loads. Before EP-4 the Evidence list KPI strips counted
 * the loaded rows client-side, so past the 100-row cap they silently
 * under-reported. EP-4 moves the tiles to this server aggregate.
 *
 * The tenant is seeded with 140 non-deleted rows (well over the 100 cap) plus
 * 3 soft-deleted rows, spread across statuses / expiries / archive states.
 * The bucket definitions mirror `evidenceFreshnessBucket`, so the assertions
 * below pin the exact partition the list KPI cards render.
 *
 * Hits a real DB (project convention). Won't run without a live test DB.
 */
import { PrismaClient, Role, MembershipStatus, EvidenceType, EvidenceStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getEvidenceRetentionMetrics } from '@/app-layer/usecases/evidence';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `ev-ret-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: ReturnType<typeof makeRequestContext>;
let ownerUserId: string;

// Seed shape (non-deleted totals; deleted rows are separate + excluded):
const DRAFT_PLAIN = 60; // DRAFT, no expiry/review        → current
const SUBMITTED_PLAIN = 30; // SUBMITTED                   → current
const APPROVED_PLAIN = 20; // APPROVED, no expiry/review   → current
const REJECTED_PLAIN = 5; // REJECTED                      → current
const NEEDS_REVIEW = 8; // NEEDS_REVIEW (wins the bucket)  → needsReview
const APPROVED_EXPIRED = 6; // APPROVED, expiredAt in past → expired
const APPROVED_EXPIRING = 7; // APPROVED, nextReviewDate +10d → expiringSoon
const APPROVED_ARCHIVED = 4; // APPROVED, archived, no expiry → archived + current bucket
const DELETED = 3; // DRAFT, soft-deleted                  → excluded everywhere

const EXPECTED_TOTAL = DRAFT_PLAIN + SUBMITTED_PLAIN + APPROVED_PLAIN + REJECTED_PLAIN + NEEDS_REVIEW + APPROVED_EXPIRED + APPROVED_EXPIRING + APPROVED_ARCHIVED; // 140
const EXPECTED_APPROVED = APPROVED_PLAIN + APPROVED_EXPIRED + APPROVED_EXPIRING + APPROVED_ARCHIVED; // 37
const EXPECTED_ACTIVE = EXPECTED_TOTAL - APPROVED_ARCHIVED - APPROVED_EXPIRED; // not archived, not expiredAt
const EXPECTED_EXPIRED = APPROVED_EXPIRED; // 6
const EXPECTED_EXPIRING = APPROVED_EXPIRING; // 7
const EXPECTED_NEEDS_REVIEW = NEEDS_REVIEW; // 8
const EXPECTED_CURRENT = EXPECTED_TOTAL - EXPECTED_NEEDS_REVIEW - EXPECTED_EXPIRED - EXPECTED_EXPIRING; // 119

interface SeedRow {
    n: number;
    status: EvidenceStatus;
    expiredAt?: Date | null;
    nextReviewDate?: Date | null;
    isArchived?: boolean;
    deletedAt?: Date | null;
}

async function seed(rows: SeedRow[]): Promise<void> {
    const data: Array<Record<string, unknown>> = [];
    let i = 0;
    for (const r of rows) {
        for (let k = 0; k < r.n; k++) {
            data.push({
                tenantId: TENANT_ID,
                type: EvidenceType.TEXT,
                title: `${TAG}-${i++}`,
                status: r.status,
                expiredAt: r.expiredAt ?? null,
                nextReviewDate: r.nextReviewDate ?? null,
                isArchived: r.isArchived ?? false,
                deletedAt: r.deletedAt ?? null,
            });
        }
    }
    // createMany bypasses the app soft-delete/encryption middleware (raw
    // client), so expiredAt / deletedAt land verbatim — exactly the state
    // the aggregate must partition.
    await globalPrisma.evidence.createMany({ data: data as never });
}

describeFn('evidence retention metrics — full-dataset aggregate (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
        });
        const email = `${TAG}-owner@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: TAG, userId: u.id });

        const past = new Date(Date.now() - 5 * DAY_MS);
        const soon = new Date(Date.now() + 10 * DAY_MS);
        await seed([
            { n: DRAFT_PLAIN, status: EvidenceStatus.DRAFT },
            { n: SUBMITTED_PLAIN, status: EvidenceStatus.SUBMITTED },
            { n: APPROVED_PLAIN, status: EvidenceStatus.APPROVED },
            { n: REJECTED_PLAIN, status: EvidenceStatus.REJECTED },
            { n: NEEDS_REVIEW, status: EvidenceStatus.NEEDS_REVIEW },
            { n: APPROVED_EXPIRED, status: EvidenceStatus.APPROVED, expiredAt: past },
            { n: APPROVED_EXPIRING, status: EvidenceStatus.APPROVED, nextReviewDate: soon },
            { n: APPROVED_ARCHIVED, status: EvidenceStatus.APPROVED, isArchived: true },
            { n: DELETED, status: EvidenceStatus.DRAFT, deletedAt: new Date() },
        ]);
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) {
            await globalPrisma.$disconnect();
            return;
        }
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        // AuditLog is append-only + TenantMembership is last-OWNER-guarded;
        // drop them inside a `session_replication_role = 'replica'` tx (the
        // canonical teardown, mirrors task-filters.test.ts).
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (ownerUserId) {
            await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('returns the true tenant-wide totals (not the ≤100 SSR slice)', async () => {
        const m = await getEvidenceRetentionMetrics(ctx);
        expect(m.total).toBe(EXPECTED_TOTAL);
        expect(m.byStatus).toEqual({
            DRAFT: DRAFT_PLAIN,
            SUBMITTED: SUBMITTED_PLAIN,
            APPROVED: EXPECTED_APPROVED,
            REJECTED: REJECTED_PLAIN,
            NEEDS_REVIEW: NEEDS_REVIEW,
        });
        // total sums the five status buckets — the aggregate isn't capped.
        const statusSum = Object.values(m.byStatus).reduce((a, b) => a + b, 0);
        expect(statusSum).toBe(EXPECTED_TOTAL);
        expect(EXPECTED_TOTAL).toBeGreaterThan(100); // guards the "past the cap" premise
    });

    it('partitions the expiry / freshness buckets exactly (mirrors evidenceFreshnessBucket)', async () => {
        const m = await getEvidenceRetentionMetrics(ctx);
        expect(m.active).toBe(EXPECTED_ACTIVE);
        expect(m.archived).toBe(APPROVED_ARCHIVED);
        expect(m.expired).toBe(EXPECTED_EXPIRED);
        expect(m.expiringSoon).toBe(EXPECTED_EXPIRING);
        expect(m.needsReview).toBe(EXPECTED_NEEDS_REVIEW);
        expect(m.current).toBe(EXPECTED_CURRENT);
        // The freshness buckets partition every non-deleted row exactly once.
        expect(m.current + m.expiringSoon + m.expired + m.needsReview).toBe(EXPECTED_TOTAL);
    });

    it('excludes soft-deleted rows from every count', async () => {
        const m = await getEvidenceRetentionMetrics(ctx);
        // 3 deleted DRAFT rows exist but must not inflate total or byStatus.DRAFT.
        expect(m.total).toBe(EXPECTED_TOTAL);
        expect(m.byStatus.DRAFT).toBe(DRAFT_PLAIN);
    });
});
