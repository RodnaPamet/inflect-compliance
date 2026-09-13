/**
 * Branch-coverage integration test for the incident usecases — exercises
 * the error paths and conditional branches the happy-path suites skip
 * (advance-on-CLOSED, mark-reportable false / reactivation, submit
 * without a deadline, update field three-states, control validation,
 * containment + evidence not-found / unknown-step, permission denials).
 *
 * Hits a real DB (project convention). Lifts incident-usecase branch
 * coverage back over the ratcheted floor.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createIncident,
    updateIncident,
    getIncident,
    listIncidents,
    advancePhase,
    markReportable,
    submitNotification,
    addTimelineEntry,
    linkControls,
    toggleContainmentStep,
    linkEvidence,
    unlinkEvidence,
} from '@/app-layer/usecases/incident';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `inc-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let controlId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('incident usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-1', name: 'Test control' },
        });
        controlId = control.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.incidentEvidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.incident.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('not-found paths throw across read + mutation usecases', async () => {
        await expect(getIncident(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(updateIncident(ctx, 'nope', { title: 'x' })).rejects.toThrow(/not found/i);
        await expect(advancePhase(ctx, 'nope', {})).rejects.toThrow(/not found/i);
        await expect(markReportable(ctx, 'nope', { reportable: true })).rejects.toThrow(/not found/i);
        await expect(
            submitNotification(ctx, 'nope', { kind: 'DETAILED_72H', reportText: 'x' }),
        ).rejects.toThrow(/not found/i);
        await expect(addTimelineEntry(ctx, 'nope', { entry: 'x' })).rejects.toThrow(/not found/i);
        await expect(linkControls(ctx, 'nope', { controlIds: [] })).rejects.toThrow(/not found/i);
        await expect(
            toggleContainmentStep(ctx, 'nope', { stepKey: 'RANSOMWARE-1', completed: true }),
        ).rejects.toThrow(/not found/i);
        await expect(linkEvidence(ctx, 'nope', { evidenceId: 'x' })).rejects.toThrow(/not found/i);
        await expect(unlinkEvidence(ctx, 'nope', 'x')).rejects.toThrow(/not found/i);
        expect(Array.isArray(await listIncidents(ctx))).toBe(true);
    });

    it('updateIncident handles the field three-states + addTimelineEntry', async () => {
        const inc = await createIncident(ctx, {
            // No detectedAt → exercises the default-now branch.
            title: 'Update target',
            description: 'desc',
            severity: 'LOW',
            incidentType: 'OTHER',
            linkedControlIds: [controlId],
        });
        // set containedAt/resolvedAt, change severity/type/owner/title/description.
        const u1 = await updateIncident(ctx, inc.id, {
            title: 'Renamed',
            description: 'new desc',
            severity: 'MEDIUM',
            incidentType: 'DDOS',
            ownerUserId,
            containedAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
        });
        expect(u1?.title).toBe('Renamed');
        // null-out the date fields (the null branch).
        const u2 = await updateIncident(ctx, inc.id, { containedAt: null, resolvedAt: null });
        expect(u2?.containedAt).toBeNull();
        // addTimelineEntry happy path.
        const entry = await addTimelineEntry(ctx, inc.id, { entry: 'manual note' });
        expect(entry.id).toBeTruthy();
        // linkControls: a real control id is kept, a bogus one is filtered out.
        const linked = await linkControls(ctx, inc.id, { controlIds: [controlId, 'bogus-id'] });
        expect(linked?.linkedControlIds).toEqual([controlId]);
    });

    it('advancePhase covers explicit toPhase, note, CLOSED + same-phase errors', async () => {
        const inc = await createIncident(ctx, { title: 'Phase', severity: 'LOW', incidentType: 'OTHER' });
        // explicit toPhase + note branch.
        const a = await advancePhase(ctx, inc.id, { toPhase: 'CONTAINMENT', note: 'isolated' });
        expect(a?.phase).toBe('CONTAINMENT');
        // same phase → badRequest.
        await expect(advancePhase(ctx, inc.id, { toPhase: 'CONTAINMENT' })).rejects.toThrow(/already in that phase/i);
        // jump to CLOSED, then advancing past it → badRequest (nextPhase null).
        await advancePhase(ctx, inc.id, { toPhase: 'CLOSED' });
        await expect(advancePhase(ctx, inc.id, {})).rejects.toThrow(/final phase/i);
    });

    it('markReportable false + reactivate, submit-without-deadline, and full submit flow', async () => {
        const inc = await createIncident(ctx, {
            title: 'Reportable flows',
            severity: 'HIGH',
            incidentType: 'DATA_BREACH',
            detectedAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        });
        // submit before reportable → no deadline → badRequest.
        await expect(
            submitNotification(ctx, inc.id, { kind: 'EARLY_WARNING_24H', reportText: 'early' }),
        ).rejects.toThrow(/mark the incident reportable/i);

        // mark reportable=false first (NOT_REQUIRED branch — no deadlines exist yet, no-op update).
        await markReportable(ctx, inc.id, { reportable: false, note: 'not yet' });
        // mark reportable=true (creates deadlines).
        await markReportable(ctx, inc.id, { reportable: true, note: 'DPO confirmed' });
        // mark reportable=false (deadlines → NOT_REQUIRED), then true again (NOT_REQUIRED → PENDING reactivation).
        await markReportable(ctx, inc.id, { reportable: false });
        await markReportable(ctx, inc.id, { reportable: true });

        // submit two kinds → first stamps reportedAt, second hits the already-set branch + submissionRef branch.
        await submitNotification(ctx, inc.id, { kind: 'EARLY_WARNING_24H', reportText: 'early warning' });
        await submitNotification(ctx, inc.id, {
            kind: 'DETAILED_72H',
            reportText: 'detailed report',
            submissionRef: 'CSIRT-1',
        });
        const after = await getIncident(ctx, inc.id);
        const ew = after.notifications.find((n) => n.kind === 'EARLY_WARNING_24H');
        const dt = after.notifications.find((n) => n.kind === 'DETAILED_72H');
        expect(ew?.status).toBe('SUBMITTED');
        expect(dt?.submissionRef).toBe('CSIRT-1');
        expect(after.reportedAt).toBeTruthy();
    });

    it('containment toggle (complete + uncomplete) and evidence link/unlink branches', async () => {
        const inc = await createIncident(ctx, { title: 'C', severity: 'CRITICAL', incidentType: 'RANSOMWARE' });
        await toggleContainmentStep(ctx, inc.id, { stepKey: 'RANSOMWARE-2', completed: true });
        // toggling the same key true again (wasCompleted branch — no duplicate timeline).
        await toggleContainmentStep(ctx, inc.id, { stepKey: 'RANSOMWARE-2', completed: true });
        await toggleContainmentStep(ctx, inc.id, { stepKey: 'RANSOMWARE-2', completed: false });
        const after = await getIncident(ctx, inc.id);
        expect(after.completedContainmentSteps).not.toContain('RANSOMWARE-2');

        const ev = await globalPrisma.evidence.create({
            data: { tenantId: TENANT_ID, type: 'TEXT', title: 'IOC list', status: 'DRAFT' },
        });
        // link without a forensic category (the null branch), then unlink.
        await linkEvidence(ctx, inc.id, { evidenceId: ev.id });
        const linked = await getIncident(ctx, inc.id);
        expect(linked.evidenceLinks).toHaveLength(1);
        await unlinkEvidence(ctx, inc.id, ev.id);
        const cleared = await getIncident(ctx, inc.id);
        expect(cleared.evidenceLinks).toHaveLength(0);
    });

    it('READER is denied manage actions, allowed reads', async () => {
        const inc = await createIncident(ctx, { title: 'Perm', severity: 'LOW', incidentType: 'OTHER' });
        await expect(advancePhase(reader, inc.id, {})).rejects.toThrow(/permission/i);
        await expect(
            toggleContainmentStep(reader, inc.id, { stepKey: 'RANSOMWARE-1', completed: true }),
        ).rejects.toThrow(/permission/i);
        await expect(linkEvidence(reader, inc.id, { evidenceId: 'x' })).rejects.toThrow(/permission/i);
        await expect(markReportable(reader, inc.id, { reportable: true })).rejects.toThrow(/permission/i);
        // reads allowed.
        await expect(getIncident(reader, inc.id)).resolves.toBeTruthy();
        await expect(listIncidents(reader)).resolves.toBeDefined();
    });
});
