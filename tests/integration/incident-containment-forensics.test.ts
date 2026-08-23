/**
 * Integration test — incident containment runbook + forensic evidence
 * linking (Prompt 3, P2 + P3), end-to-end against a real DB.
 *
 *   1. toggleContainmentStep persists the step + appends a timeline entry,
 *      and rejects a step key that isn't in the incident type's runbook.
 *   2. linkEvidence attaches a tenant Evidence record (+ timeline), and
 *      rejects a foreign / non-existent evidence id.
 *   3. unlinkEvidence removes the link.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createIncident,
    toggleContainmentStep,
    linkEvidence,
    unlinkEvidence,
    getIncident,
} from '@/app-layer/usecases/incident';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `inc-cf-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('incident containment + forensic linking (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        const email = `${SUITE_TAG}-owner@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: ownerUserId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
    });

    afterAll(async () => {
        await globalPrisma.incidentEvidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.incident.deleteMany({ where: { tenantId: TENANT_ID } });
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

    it('toggles a containment step (persists + timelines) and rejects unknown steps', async () => {
        const incident = await createIncident(ctx, {
            title: 'Ransomware on the file server',
            severity: 'CRITICAL',
            incidentType: 'RANSOMWARE',
        });

        await toggleContainmentStep(ctx, incident.id, { stepKey: 'RANSOMWARE-1', completed: true });
        const after = await getIncident(ctx, incident.id);
        expect(after.completedContainmentSteps).toContain('RANSOMWARE-1');
        // The completion is recorded on the timeline.
        expect(after.timeline.some((t) => /containment step completed/i.test(t.entry))).toBe(true);

        // Un-completing removes it.
        await toggleContainmentStep(ctx, incident.id, { stepKey: 'RANSOMWARE-1', completed: false });
        const reopened = await getIncident(ctx, incident.id);
        expect(reopened.completedContainmentSteps).not.toContain('RANSOMWARE-1');

        // A step from another type's runbook is rejected.
        await expect(
            toggleContainmentStep(ctx, incident.id, { stepKey: 'DDOS-1', completed: true }),
        ).rejects.toThrow();
    });

    it('links + unlinks forensic evidence, rejecting unknown evidence ids', async () => {
        const incident = await createIncident(ctx, {
            title: 'Suspicious access',
            severity: 'HIGH',
            incidentType: 'UNAUTHORIZED_ACCESS',
        });
        const evidence = await globalPrisma.evidence.create({
            data: { tenantId: TENANT_ID, type: 'LINK', title: 'Auth logs export', status: 'DRAFT' },
        });

        await linkEvidence(ctx, incident.id, {
            evidenceId: evidence.id,
            forensicCategory: 'SYSTEM_LOGS',
        });
        const withEvidence = await getIncident(ctx, incident.id);
        expect(withEvidence.evidenceLinks).toHaveLength(1);
        expect(withEvidence.evidenceLinks[0].evidenceId).toBe(evidence.id);
        expect(withEvidence.evidenceLinks[0].forensicCategory).toBe('SYSTEM_LOGS');

        // Foreign / unknown evidence id is rejected.
        await expect(
            linkEvidence(ctx, incident.id, { evidenceId: 'does-not-exist' }),
        ).rejects.toThrow();

        await unlinkEvidence(ctx, incident.id, evidence.id);
        const cleared = await getIncident(ctx, incident.id);
        expect(cleared.evidenceLinks).toHaveLength(0);
    });
});
