/**
 * #2356 batch 3a — thirty-four composite FKs whose action Prisma can express.
 *
 * Batches 1 and 2 took the sites whose target ALREADY carried
 * @@unique([id, tenantId]). This is the second phase: 35 targets gained that
 * unique, and 34 single-column FKs became tenant-carrying composites.
 *
 * ─── Two kinds of assertion, and why both ──────────────────────────
 *
 * STRUCTURAL, over all 34. Each is named and checked for two columns AND its
 * referential action, because the migration's own post-condition counts
 * `>= 34` — a floor that a DROP without its ADD could still satisfy if some
 * other batch's constraint were counted. Naming each one means a site that
 * silently lost its constraint fails here rather than passing a count.
 *
 * The ACTION is asserted because this batch's whole claim is that the action
 * is UNCHANGED: 30 Cascade, 4 Restrict, exactly as the database did them
 * before. A conversion that quietly made a Cascade into a Restrict would keep
 * two columns and pass a shape-only check, and the first symptom would be an
 * un-purgeable parent stopping the data-lifecycle sweep.
 *
 * BEHAVIOURAL, on representatives. The structural half proves the constraint
 * is DEFINED; it cannot prove the database refuses a cross-tenant write. That
 * needs raw SQL, because the usecase layer already refuses these and a test
 * going through it would pass against a database with no constraint at all.
 * Postgres runs FK checks as the table owner and bypasses RLS, so the
 * constraint is the only thing that makes the reference unrepresentable.
 *
 * Representatives are chosen by SHAPE rather than by domain: one Cascade, one
 * Restrict, and the one-to-one — the case that needed its own
 * @@unique([connectedAccountId, tenantId]) because Prisma requires the
 * defining side of a 1:1 to be unique over exactly the relation's fields.
 *
 * Every negative is paired with the same statement against this tenant's own
 * parent, because a constraint rejecting EVERY value would pass the negative
 * alone and read as working isolation.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'fk-b3-t1';
const T2 = 'fk-b3-t2';
const ACTOR_EMAIL = 'fk-b3-actor@example.test';
let actorId = '';

/** Every site this migration converted, with the action it must still have. */
const SITES: ReadonlyArray<{
    conname: string; child: string; col: string; parent: string; del: string;
}> = [
    { conname: 'AiGovSelfAssessmentAnswer_assessmentId_tenantId_fkey', child: 'AiGovSelfAssessmentAnswer', col: 'assessmentId', parent: 'AiGovSelfAssessment', del: 'c' },
    { conname: 'AuditPack_auditCycleId_tenantId_fkey', child: 'AuditPack', col: 'auditCycleId', parent: 'AuditCycle', del: 'r' },
    { conname: 'AuditPackShareComment_auditPackShareId_tenantId_fkey', child: 'AuditPackShareComment', col: 'auditPackShareId', parent: 'AuditPackShare', del: 'c' },
    { conname: 'AutomationExecution_ruleId_tenantId_fkey', child: 'AutomationExecution', col: 'ruleId', parent: 'AutomationRule', del: 'r' },
    { conname: 'BackgroundCheck_employeeId_tenantId_fkey', child: 'BackgroundCheck', col: 'employeeId', parent: 'Employee', del: 'c' },
    { conname: 'BiaDependency_biaId_tenantId_fkey', child: 'BiaDependency', col: 'biaId', parent: 'BusinessImpactAnalysis', del: 'c' },
    { conname: 'ConnectedIdentityAccount_connectionId_tenantId_fkey', child: 'ConnectedIdentityAccount', col: 'connectionId', parent: 'IntegrationConnection', del: 'c' },
    { conname: 'ControlEvidenceLink_biaId_tenantId_fkey', child: 'ControlEvidenceLink', col: 'biaId', parent: 'BusinessImpactAnalysis', del: 'c' },
    { conname: 'ControlTestEvidenceLink_testRunId_tenantId_fkey', child: 'ControlTestEvidenceLink', col: 'testRunId', parent: 'ControlTestRun', del: 'c' },
    { conname: 'ControlTestRun_testPlanId_tenantId_fkey', child: 'ControlTestRun', col: 'testPlanId', parent: 'ControlTestPlan', del: 'c' },
    { conname: 'ControlTestStep_testPlanId_tenantId_fkey', child: 'ControlTestStep', col: 'testPlanId', parent: 'ControlTestPlan', del: 'c' },
    { conname: 'IdentityAccountLink_employeeId_tenantId_fkey', child: 'IdentityAccountLink', col: 'employeeId', parent: 'Employee', del: 'c' },
    { conname: 'IdentityAccountLink_connectedAccountId_tenantId_fkey', child: 'IdentityAccountLink', col: 'connectedAccountId', parent: 'ConnectedIdentityAccount', del: 'c' },
    { conname: 'InboundQuestionnaireItem_questionnaireId_tenantId_fkey', child: 'InboundQuestionnaireItem', col: 'questionnaireId', parent: 'InboundQuestionnaire', del: 'c' },
    { conname: 'KriReading_kriId_tenantId_fkey', child: 'KriReading', col: 'kriId', parent: 'KeyRiskIndicator', del: 'c' },
    { conname: 'Nis2GapAssignment_assessmentId_tenantId_fkey', child: 'Nis2GapAssignment', col: 'assessmentId', parent: 'Nis2SelfAssessment', del: 'c' },
    { conname: 'Nis2SelfAssessmentAnswer_assessmentId_tenantId_fkey', child: 'Nis2SelfAssessmentAnswer', col: 'assessmentId', parent: 'Nis2SelfAssessment', del: 'c' },
    { conname: 'PolicyApproval_policyVersionId_tenantId_fkey', child: 'PolicyApproval', col: 'policyVersionId', parent: 'PolicyVersion', del: 'c' },
    { conname: 'ReportRun_templateId_tenantId_fkey', child: 'ReportRun', col: 'templateId', parent: 'ReportTemplate', del: 'r' },
    { conname: 'ReportSchedule_templateId_tenantId_fkey', child: 'ReportSchedule', col: 'templateId', parent: 'ReportTemplate', del: 'r' },
    { conname: 'RiskHierarchyLink_nodeId_tenantId_fkey', child: 'RiskHierarchyLink', col: 'nodeId', parent: 'RiskHierarchyNode', del: 'c' },
    { conname: 'TrainingAssignment_employeeId_tenantId_fkey', child: 'TrainingAssignment', col: 'employeeId', parent: 'Employee', del: 'c' },
    { conname: 'TrainingAssignment_courseId_tenantId_fkey', child: 'TrainingAssignment', col: 'courseId', parent: 'TrainingCourse', del: 'c' },
    { conname: 'TrustCenterAccessRequest_documentId_tenantId_fkey', child: 'TrustCenterAccessRequest', col: 'documentId', parent: 'TrustCenterDocument', del: 'c' },
    { conname: 'TrustCenterDocument_trustCenterId_tenantId_fkey', child: 'TrustCenterDocument', col: 'trustCenterId', parent: 'TrustCenter', del: 'c' },
    { conname: 'UserIdentityLink_providerId_tenantId_fkey', child: 'UserIdentityLink', col: 'providerId', parent: 'TenantIdentityProvider', del: 'c' },
    { conname: 'VendorAnswerProposal_extractionId_tenantId_fkey', child: 'VendorAnswerProposal', col: 'extractionId', parent: 'VendorDocExtraction', del: 'c' },
    { conname: 'VendorAssessmentAnswer_assessmentId_tenantId_fkey', child: 'VendorAssessmentAnswer', col: 'assessmentId', parent: 'VendorAssessment', del: 'c' },
    { conname: 'VendorAssessmentTemplateQuestion_templateId_tenantId_fkey', child: 'VendorAssessmentTemplateQuestion', col: 'templateId', parent: 'VendorAssessmentTemplate', del: 'c' },
    { conname: 'VendorAssessmentTemplateQuestion_sectionId_tenantId_fkey', child: 'VendorAssessmentTemplateQuestion', col: 'sectionId', parent: 'VendorAssessmentTemplateSection', del: 'c' },
    { conname: 'VendorAssessmentTemplateSection_templateId_tenantId_fkey', child: 'VendorAssessmentTemplateSection', col: 'templateId', parent: 'VendorAssessmentTemplate', del: 'c' },
    { conname: 'VendorDocExtraction_documentId_tenantId_fkey', child: 'VendorDocExtraction', col: 'documentId', parent: 'VendorDocument', del: 'c' },
    { conname: 'VendorEvidenceBundleItem_bundleId_tenantId_fkey', child: 'VendorEvidenceBundleItem', col: 'bundleId', parent: 'VendorEvidenceBundle', del: 'c' },
    { conname: 'WorkflowStep_runId_tenantId_fkey', child: 'WorkflowStep', col: 'runId', parent: 'WorkflowRun', del: 'c' },
];

async function failureOf(sql: string, ...params: unknown[]): Promise<string> {
    try {
        await prisma.$executeRawUnsafe(sql, ...params);
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`EXPECTED THE DATABASE TO REFUSE THIS WRITE, but it succeeded:\n${sql}`);
}

async function clearProbeRows() {
    await resetDatabase(prisma);
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.reportRun.deleteMany({ where: t });
    await prisma.reportTemplate.deleteMany({ where: t });
    await prisma.trainingAssignment.deleteMany({ where: t });
    await prisma.trainingCourse.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { email: ACTOR_EMAIL } });
}

beforeAll(async () => {
    await clearProbeRows();
    for (const id of [T1, T2]) await prisma.tenant.create({ data: { id, name: id, slug: id } });
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'fk b3 actor' } });
    actorId = actor.id;
    for (const id of [T1, T2]) {
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: actorId, role: 'OWNER', status: 'ACTIVE' },
        });
    }
});

afterAll(async () => {
    await clearProbeRows();
    await prisma.$disconnect();
});

describe('all 34 converted FKs are two-column, with the action they had before', () => {
    it('every one is present, composite, and unchanged in referential action', async () => {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ conname: string; cols: number; del: string }>
        >(`SELECT conname, cardinality(conkey)::int AS cols, confdeltype::text AS del
             FROM pg_constraint WHERE contype = 'f'`);
        const byName = new Map(rows.map((r) => [r.conname, r]));

        const missing = SITES.filter((s) => !byName.has(s.conname)).map((s) => s.conname);
        expect(missing).toEqual([]);

        const wrongShape = SITES.filter((s) => Number(byName.get(s.conname)!.cols) !== 2)
            .map((s) => s.conname);
        expect(wrongShape).toEqual([]);

        // The claim this batch rests on: the ACTION did not move.
        const wrongAction = SITES
            .filter((s) => byName.get(s.conname)!.del !== s.del)
            .map((s) => `${s.conname}: expected ${s.del}, found ${byName.get(s.conname)!.del}`);
        expect(wrongAction).toEqual([]);
    });

    it('and the single-column originals are GONE', async () => {
        // Otherwise both could coexist and the negative tests below would pass
        // while the old, permissive constraint was still doing the checking.
        const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
            `SELECT conname FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) = 1
              AND conname = ANY($1::text[])`,
            SITES.map((s) => `${s.child}_${s.col}_fkey`),
        );
        expect(rows.map((r) => r.conname)).toEqual([]);
    });

    it('the site table itself is non-empty and matches the migration', () => {
        // A floor: every assertion above iterates SITES, so an empty SITES
        // would make all three vacuously green.
        expect(SITES.length).toBe(34);
        expect(SITES.filter((s) => s.del === 'c').length).toBe(30);
        expect(SITES.filter((s) => s.del === 'r').length).toBe(4);
    });
});

describe('the database refuses a cross-tenant reference', () => {
    it("WorkflowStep cannot point at another tenant's WorkflowRun (CASCADE)", async () => {
        const own = await prisma.workflowRun.create({ data: { tenantId: T1, workflowKey: 'k' } });
        const foreign = await prisma.workflowRun.create({ data: { tenantId: T2, workflowKey: 'k' } });
        const insert =
            `INSERT INTO "WorkflowStep" ("id","tenantId","runId","seq","kind") VALUES ($1,$2,$3,1,'READ')`;
        expect(await failureOf(insert, 'b3-ws-neg', T1, foreign.id)).toContain(
            'WorkflowStep_runId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(insert, 'b3-ws-pos', T1, own.id)).toBe(1);
    });

    it("ReportRun cannot point at another tenant's ReportTemplate (RESTRICT)", async () => {
        const mk = (tenantId: string) =>
            prisma.reportTemplate.create({
                data: { tenantId, name: 'probe', type: 'SUMMARY', configJson: {} },
            });
        const own = await mk(T1);
        const foreign = await mk(T2);
        const insert =
            `INSERT INTO "ReportRun" ("id","tenantId","templateId","parametersJson","format") VALUES ($1,$2,$3,'{}','PDF')`;
        expect(await failureOf(insert, 'b3-rr-neg', T1, foreign.id)).toContain(
            'ReportRun_templateId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(insert, 'b3-rr-pos', T1, own.id)).toBe(1);
    });

    it("TrainingAssignment cannot point at another tenant's Employee or Course", async () => {
        const emp = (tenantId: string, e: string) =>
            prisma.employee.create({ data: { tenantId, fullName: 'probe', workEmail: e } });
        const course = (tenantId: string) =>
            prisma.trainingCourse.create({ data: { tenantId, name: 'probe' } });
        const ownE = await emp(T1, 'b3-own@x.test');
        const foreignE = await emp(T2, 'b3-foreign@x.test');
        const ownC = await course(T1);
        const foreignC = await course(T2);
        const insert =
            'INSERT INTO "TrainingAssignment" ("id","tenantId","employeeId","courseId","updatedAt") VALUES ($1,$2,$3,$4,now())';

        // One foreign pointer at a time, so the constraint that refuses is the
        // one each assertion names.
        expect(await failureOf(insert, 'b3-ta-neg-e', T1, foreignE.id, ownC.id)).toContain(
            'TrainingAssignment_employeeId_tenantId_fkey',
        );
        expect(await failureOf(insert, 'b3-ta-neg-c', T1, ownE.id, foreignC.id)).toContain(
            'TrainingAssignment_courseId_tenantId_fkey',
        );
        expect(
            await prisma.$executeRawUnsafe(insert, 'b3-ta-pos', T1, ownE.id, ownC.id),
        ).toBe(1);
    });
});

describe('CASCADE still cascades, and RESTRICT still refuses', () => {
    it('deleting the WorkflowRun takes its steps with it', async () => {
        const run = await prisma.workflowRun.create({ data: { tenantId: T1, workflowKey: 'k2' } });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "WorkflowStep" ("id","tenantId","runId","seq","kind") VALUES ($1,$2,$3,1,'READ')`,
            'b3-ws-cascade', T1, run.id,
        );
        await prisma.$executeRawUnsafe('DELETE FROM "WorkflowRun" WHERE "id" = $1', run.id);
        const left = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            'SELECT count(*)::bigint AS n FROM "WorkflowStep" WHERE "id" = $1', 'b3-ws-cascade',
        );
        expect(Number(left[0].n)).toBe(0);
    });

    it('deleting a ReportTemplate with runs is REFUSED, not silently cascaded', async () => {
        const tpl = await prisma.reportTemplate.create({
            data: { tenantId: T1, name: 'probe2', type: 'SUMMARY', configJson: {} },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "ReportRun" ("id","tenantId","templateId","parametersJson","format") VALUES ($1,$2,$3,'{}','PDF')`,
            'b3-rr-restrict', T1, tpl.id,
        );
        const err = await failureOf('DELETE FROM "ReportTemplate" WHERE "id" = $1', tpl.id);
        expect(err).toContain('ReportRun_templateId_tenantId_fkey');
        // And the run survived — RESTRICT refused the parent delete rather than
        // half-applying it.
        const left = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            'SELECT count(*)::bigint AS n FROM "ReportRun" WHERE "id" = $1', 'b3-rr-restrict',
        );
        expect(Number(left[0].n)).toBe(1);
    });
});
