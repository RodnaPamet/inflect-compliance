/**
 * NIS2 Article 23 incident-response — usecase + deadline-clock
 * integration tests. Hit a real database (project convention —
 * integration tests never mock Prisma) so RLS, field encryption, the
 * deadline arithmetic, and the status transitions are exercised
 * end-to-end.
 *
 * Coverage
 * --------
 *   1. createIncident assigns a tenant-scoped reference + seeds a
 *      DETECTION-phase timeline entry.
 *   2. markReportable creates EXACTLY three notification deadlines with
 *      dueAt = detectedAt + {24h, 72h, 1 month}.
 *   3. The deadline-clock job flips the 24h early-warning OVERDUE once
 *      `now` passes its dueAt without a submission, and fires an
 *      INCIDENT_DEADLINE_OVERDUE notification to the owner + admins.
 *   4. submitNotification marks the 72h report SUBMITTED.
 *   5. advancePhase walks the seven-phase flow + appends timeline.
 *   6. listIncidents requires incidents.view; mutations require manage.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createIncident,
    markReportable,
    submitNotification,
    advancePhase,
    listIncidents,
    getIncident,
} from '@/app-layer/usecases/incident';
import { processIncidentNotificationDeadlines } from '@/app-layer/jobs/incident-notification-deadlines';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `inc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;

function ctxFor(userId: string, role: Role = Role.OWNER) {
    return makeRequestContext(role, {
        tenantId: TENANT_ID,
        tenantSlug: SUITE_TAG,
        userId,
    });
}

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('NIS2 incident-response integration', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
    });

    afterAll(async () => {
        await globalPrisma.notification.deleteMany({ where: { tenantId: TENANT_ID } });
        // Cascade deletes notifications + timeline.
        await globalPrisma.incident.deleteMany({ where: { tenantId: TENANT_ID } });
        // session_replication_role=replica bypasses the AuditLog
        // immutability trigger AND the last-OWNER guard so the fixture
        // tears down cleanly.
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                TENANT_ID,
            );
        });
        await globalPrisma.user.deleteMany({
            where: { id: { in: [ownerUserId, readerUserId] } },
        });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('runs the full reportable → overdue → submit lifecycle', async () => {
        const ctx = ctxFor(ownerUserId);
        // Fixed detection time so the deadline math is deterministic.
        const detectedAt = new Date('2026-06-01T00:00:00.000Z');

        const incident = await createIncident(ctx, {
            title: 'Ransomware on the billing cluster',
            description: '<script>alert(1)</script>Encrypted the primary billing DB.',
            severity: 'CRITICAL',
            incidentType: 'RANSOMWARE',
            detectedAt: detectedAt.toISOString(),
            ownerUserId,
        });

        // Reference is INC-2026-NNN, DETECTION phase, with a seed
        // timeline entry.
        expect(incident.reference).toMatch(/^INC-2026-\d{3}$/);
        expect(incident.phase).toBe('DETECTION');

        const afterCreate = await getIncident(ctx, incident.id);
        expect(afterCreate.timeline.length).toBeGreaterThanOrEqual(1);
        // Encryption: the raw column must NOT contain the plaintext, and
        // sanitisation must have stripped the <script>.
        const raw = await globalPrisma.incident.findUniqueOrThrow({
            where: { id: incident.id },
            select: { description: true },
        });
        expect(raw.description.startsWith('v')).toBe(true); // v1:/v2: envelope
        expect(afterCreate.description).not.toContain('<script>');

        // 2. markReportable → exactly three deadlines at +24h/+72h/+1mo.
        await markReportable(ctx, incident.id, { reportable: true });
        const withDeadlines = await getIncident(ctx, incident.id);
        expect(withDeadlines.reportable).toBe(true);
        expect(withDeadlines.notifications).toHaveLength(3);

        const byKind = Object.fromEntries(
            withDeadlines.notifications.map((n) => [n.kind, n]),
        );
        expect(new Date(byKind.EARLY_WARNING_24H.dueAt).toISOString()).toBe(
            '2026-06-02T00:00:00.000Z',
        );
        expect(new Date(byKind.DETAILED_72H.dueAt).toISOString()).toBe(
            '2026-06-04T00:00:00.000Z',
        );
        expect(new Date(byKind.FINAL_1MONTH.dueAt).toISOString()).toBe(
            '2026-07-01T00:00:00.000Z',
        );
        for (const n of withDeadlines.notifications) {
            expect(n.status).toBe('PENDING');
        }

        // 3. Run the deadline clock 25h after detection — the 24h early
        //    warning lapses → OVERDUE + a notification fires.
        const now = new Date('2026-06-02T01:00:00.000Z');
        const result = await processIncidentNotificationDeadlines(globalPrisma, {
            tenantId: TENANT_ID,
            now,
        });
        expect(result.becameOverdue).toBeGreaterThanOrEqual(1);

        const afterClock = await getIncident(ctx, incident.id);
        const ew = afterClock.notifications.find((n) => n.kind === 'EARLY_WARNING_24H');
        expect(ew?.status).toBe('OVERDUE');

        const overdueNotifs = await globalPrisma.notification.findMany({
            where: { tenantId: TENANT_ID, type: 'INCIDENT_DEADLINE_OVERDUE' },
        });
        expect(overdueNotifs.length).toBeGreaterThanOrEqual(1);
        // Owner is a recipient.
        expect(overdueNotifs.some((n) => n.userId === ownerUserId)).toBe(true);

        // 4. Submit the 72h detailed report → SUBMITTED.
        await submitNotification(ctx, incident.id, {
            kind: 'DETAILED_72H',
            reportText: 'Full forensic report attached.',
            submissionRef: 'CCB-2026-0042',
        });
        const afterSubmit = await getIncident(ctx, incident.id);
        const detailed = afterSubmit.notifications.find((n) => n.kind === 'DETAILED_72H');
        expect(detailed?.status).toBe('SUBMITTED');
        expect(detailed?.submittedAt).toBeTruthy();
        expect(afterSubmit.reportedAt).toBeTruthy();
    });

    it('advances through the seven-phase flow + appends timeline', async () => {
        const ctx = ctxFor(ownerUserId);
        const incident = await createIncident(ctx, {
            title: 'Phishing wave',
            severity: 'MEDIUM',
            incidentType: 'UNAUTHORIZED_ACCESS',
        });
        await advancePhase(ctx, incident.id, {});
        const a = await getIncident(ctx, incident.id);
        expect(a.phase).toBe('CLASSIFICATION');

        await advancePhase(ctx, incident.id, { toPhase: 'CONTAINMENT', note: 'isolated hosts' });
        const b = await getIncident(ctx, incident.id);
        expect(b.phase).toBe('CONTAINMENT');
        // Each advance appends a timeline entry.
        expect(b.timeline.length).toBeGreaterThanOrEqual(3);
    });

    it('enforces permissions — a READER cannot create, can view', async () => {
        const reader = ctxFor(readerUserId, Role.READER);
        await expect(
            createIncident(reader, {
                title: 'nope',
                severity: 'LOW',
                incidentType: 'OTHER',
            }),
        ).rejects.toThrow(/permission/i);
        // READER can list (view).
        await expect(listIncidents(reader)).resolves.toBeDefined();
    });
});
