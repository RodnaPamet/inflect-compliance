/**
 * Branch coverage for the evidence retention notification job
 * (`src/app-layer/jobs/retention-notifications.ts`).
 *
 * DB-backed: the executor drives `@/lib/prisma` directly. We seed real
 * Evidence/Task/TenantMembership rows and assert the reminder Tasks,
 * task links, outbox rows, and audit entries it produces.
 *
 * `emitAutomationEvent` runs against the real DB — with no automation
 * rules configured it is a no-op (fire-and-forget, swallowed), so it
 * never affects assertions.
 *
 * Branches exercised:
 *   - empty batch (no expiring evidence) → scanned 0.
 *   - found row with an evidence owner (ownerUserId) → Task + link +
 *     audit + EVIDENCE_EXPIRING_SOON; daysLeft<=7 → P1 priority.
 *   - actor fallback to the tenant's first ACTIVE OWNER when the
 *     evidence has no ownerUserId.
 *   - skip-no-actor branch: no ownerUserId AND no tenant OWNER → the
 *     row is skipped (skippedNoActor) and no task is created.
 *   - idempotency: an existing non-terminal EVIDENCE_EXPIRY-source task
 *     linked to the evidence → skippedDuplicate, no second task.
 *   - notifications disabled → outbox suppressed (still creates task).
 *   - already-expired evidence → EVIDENCE_EXPIRED trigger pass.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `rn-${randomUUID().slice(0, 8)}`;

/** A retentionUntil within the default 30-day window (and > now). */
function soon(days: number): Date {
    return new Date(Date.now() + days * 86_400_000);
}

describeFn('runEvidenceRetentionNotifications (real DB)', () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    /** Fresh isolated tenant per test so OWNER-fallback + counts are clean. */
    async function freshTenant(): Promise<string> {
        const id = `t-${SUITE}-${randomUUID().slice(0, 8)}`;
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        return id;
    }

    async function makeUser(tag: string): Promise<string> {
        const email = `${SUITE}-${tag}-${randomUUID().slice(0, 6)}@example.test`;
        const u = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        return u.id;
    }

    async function cleanup(tenantId: string): Promise<void> {
        // AuditLog has an immutability trigger and TenantMembership has the
        // last-OWNER guard trigger — both reject ordinary DELETEs. Bypass
        // both with session_replication_role=replica (same pattern the
        // RLS suites use). Done inside one replica transaction so the FK
        // order (links → tasks → evidence → memberships → settings →
        // tenant) is satisfied.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "Evidence" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantNotificationSettings" WHERE "tenantId" = $1`, tenantId);
        });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }

    it('returns scanned=0 when no evidence is expiring', async () => {
        const tenantId = await freshTenant();
        try {
            const res = await runEvidenceRetentionNotifications({ tenantId });
            expect(res).toEqual({ scanned: 0, tasksCreated: 0, skippedDuplicate: 0 });
        } finally {
            await cleanup(tenantId);
        }
    });

    it('creates a reminder Task + link + outbox + audit for expiring evidence (owner present, P1 when <=7d)', async () => {
        const tenantId = await freshTenant();
        try {
            const ownerId = await makeUser('owner');
            // An ADMIN member with an email so the outbox enqueue branch runs.
            await prisma.tenantMembership.create({
                data: { tenantId, userId: ownerId, role: 'ADMIN', status: 'ACTIVE' },
            });
            const ev = await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'expiring-soon',
                    retentionUntil: soon(3), // <=7 → P1
                    isArchived: false, ownerUserId: ownerId,
                },
            });

            const res = await runEvidenceRetentionNotifications({ tenantId, days: 30 });
            expect(res.scanned).toBe(1);
            expect(res.tasksCreated).toBe(1);
            expect(res.skippedDuplicate).toBe(0);

            const task = await prisma.task.findFirst({
                where: { tenantId, source: 'EVIDENCE_EXPIRY' },
            });
            expect(task).not.toBeNull();
            expect(task?.type).toBe('TASK');
            expect(task?.source).toBe('EVIDENCE_EXPIRY');
            expect(task?.priority).toBe('P1');
            expect(task?.createdByUserId).toBe(ownerId);
            // TP-5 — assigned to the evidence owner when present.
            expect(task?.assigneeUserId).toBe(ownerId);

            const link = await prisma.taskLink.findFirst({
                where: { tenantId, entityType: 'EVIDENCE', entityId: ev.id },
            });
            expect(link).not.toBeNull();

            const outbox = await prisma.notificationOutbox.findMany({
                where: { tenantId, type: 'EVIDENCE_EXPIRING' },
            });
            expect(outbox.length).toBeGreaterThanOrEqual(1);

            const audit = await prisma.auditLog.findMany({
                where: { tenantId, action: 'EVIDENCE_EXPIRING_SOON', entityId: ev.id },
            });
            expect(audit).toHaveLength(1);
        } finally {
            await cleanup(tenantId);
        }
    });

    it('falls back to the first ACTIVE OWNER when evidence has no ownerUserId', async () => {
        const tenantId = await freshTenant();
        try {
            const ownerId = await makeUser('tenantowner');
            await prisma.tenantMembership.create({
                data: { tenantId, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
            });
            await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'no-owner',
                    retentionUntil: soon(20), // >7 → P2
                    isArchived: false, ownerUserId: null,
                },
            });

            const res = await runEvidenceRetentionNotifications({ tenantId });
            expect(res.tasksCreated).toBe(1);
            const task = await prisma.task.findFirst({ where: { tenantId, source: 'EVIDENCE_EXPIRY' } });
            expect(task?.createdByUserId).toBe(ownerId);
            expect(task?.priority).toBe('P2');
            // No evidence owner → nothing to assign (created-by still the
            // fallback tenant OWNER).
            expect(task?.assigneeUserId).toBeNull();
        } finally {
            await cleanup(tenantId);
        }
    });

    it('skips the row when there is neither an evidence owner nor a tenant OWNER', async () => {
        const tenantId = await freshTenant();
        try {
            await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'orphan',
                    retentionUntil: soon(10), isArchived: false, ownerUserId: null,
                },
            });
            const res = await runEvidenceRetentionNotifications({ tenantId });
            expect(res.scanned).toBe(1);
            expect(res.tasksCreated).toBe(0);
            const tasks = await prisma.task.findMany({ where: { tenantId } });
            expect(tasks).toHaveLength(0);
        } finally {
            await cleanup(tenantId);
        }
    });

    it('is idempotent: an existing non-terminal EVIDENCE_EXPIRY task linked to the evidence is skipped', async () => {
        const tenantId = await freshTenant();
        try {
            const ownerId = await makeUser('owner');
            const ev = await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'dup',
                    retentionUntil: soon(5), isArchived: false, ownerUserId: ownerId,
                },
            });
            // Pre-existing OPEN EVIDENCE_EXPIRY task linked to the evidence.
            const existing = await prisma.task.create({
                data: {
                    tenantId, type: 'TASK', source: 'EVIDENCE_EXPIRY', title: 'pre-existing',
                    status: 'OPEN', priority: 'P2', createdByUserId: ownerId,
                },
            });
            await prisma.taskLink.create({
                data: { taskId: existing.id, tenantId, entityType: 'EVIDENCE', entityId: ev.id },
            });

            const res = await runEvidenceRetentionNotifications({ tenantId });
            expect(res.scanned).toBe(1);
            expect(res.skippedDuplicate).toBe(1);
            expect(res.tasksCreated).toBe(0);
            // Still only the one task.
            const tasks = await prisma.task.findMany({ where: { tenantId, source: 'EVIDENCE_EXPIRY' } });
            expect(tasks).toHaveLength(1);
        } finally {
            await cleanup(tenantId);
        }
    });

    it('suppresses the outbox enqueue when notifications are disabled (task still created)', async () => {
        const tenantId = await freshTenant();
        try {
            const ownerId = await makeUser('owner');
            await prisma.tenantMembership.create({
                data: { tenantId, userId: ownerId, role: 'ADMIN', status: 'ACTIVE' },
            });
            await prisma.tenantNotificationSettings.create({
                // defaultFromEmail has no column default any more (#2296) —
                // the sender is a deployment fact the caller must supply.
                data: { tenantId, enabled: false, defaultFromEmail: 'fixture@example.test' },
            });
            await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'suppressed',
                    retentionUntil: soon(4), isArchived: false, ownerUserId: ownerId,
                },
            });

            const res = await runEvidenceRetentionNotifications({ tenantId });
            expect(res.tasksCreated).toBe(1);
            // No outbox row — the disabled branch.
            const outbox = await prisma.notificationOutbox.findMany({ where: { tenantId } });
            expect(outbox).toHaveLength(0);
        } finally {
            await cleanup(tenantId);
        }
    });

    it('processes already-expired evidence for the EVIDENCE_EXPIRED trigger pass', async () => {
        const tenantId = await freshTenant();
        try {
            // Not in the expiring window (no future retentionUntil) but
            // expiredAt in the past → only the second loop touches it.
            await prisma.evidence.create({
                data: {
                    tenantId, type: 'FILE', title: 'already-expired',
                    isArchived: false, deletedAt: null,
                    expiredAt: new Date(Date.now() - 86_400_000),
                },
            });
            const res = await runEvidenceRetentionNotifications({ tenantId });
            // It's not "expiring" (no retentionUntil) → scanned 0 reminders.
            expect(res.scanned).toBe(0);
            expect(res.tasksCreated).toBe(0);
            // The expired-trigger loop ran without throwing (best-effort).
        } finally {
            await cleanup(tenantId);
        }
    });
});
