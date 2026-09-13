/**
 * Integration test for the Epic G-3 vendor-assessment lifecycle.
 *
 * Replaces the legacy World-A start→save→submit→decide flow (removed
 * when the four legacy usecases were retired). Drives the real G-3
 * state machine over a live Postgres connection:
 *
 *   sendAssessment    (usecases/vendor-assessment-send)      → SENT
 *   submitResponse    (usecases/vendor-assessment-response)  → SUBMITTED
 *   reviewAssessment  (usecases/vendor-assessment-review)    → REVIEWED
 *   closeAssessment   (usecases/vendor-assessment-review)    → CLOSED
 *
 * Asserts every status transition and that the review engine produces
 * a numeric score.
 *
 * Seeding note: `VendorAssessmentAnswer.questionId` is a non-null FK to
 * the legacy `QuestionnaireQuestion` table, and `submitResponse` writes
 * the template-question id into BOTH `questionId` and the G-3
 * `templateQuestionId`. So the fixture creates a legacy
 * `QuestionnaireQuestion` and the G-3 `VendorAssessmentTemplateQuestion`
 * with the SAME explicit id — that shared id is what an answer row
 * references on submit, satisfying both foreign keys.
 *
 * RUN: npx jest tests/integration/vendor-assessment-lifecycle.test.ts
 */
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { sendAssessment } from '@/app-layer/usecases/vendor-assessment-send';
import { submitResponse } from '@/app-layer/usecases/vendor-assessment-response';
import {
    reviewAssessment,
    closeAssessment,
    listVendorAssessments,
} from '@/app-layer/usecases/vendor-assessment-review';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

// Route writes through the PII-encryption-enabled client (emailHash on
// User is NOT NULL at the DB but populated by middleware).
const prisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic G-3 — vendor assessment lifecycle (integration)', () => {
    const runId = randomUUID().slice(0, 12);
    // Shared id for the legacy QuestionnaireQuestion + the G-3 template
    // question (see the seeding note at the top of the file).
    const questionId = randomUUID();
    let tenantId = '';
    let userId = '';
    let vendorId = '';
    let templateId = ''; // doubles as templateVersionId for the G-3 send
    let legacyTemplateId = '';

    beforeAll(async () => {
        const user = await prisma.user.create({
            data: { email: `g3-life-${runId}@test.com`, name: 'G-3 Lifecycle User' },
        });
        userId = user.id;

        // The public submit flow stamps the synthetic actor
        // `external-respondent` on its audit row (AuditLog.userId FK).
        // Seed that sentinel user so the real submit audit resolves.
        await prisma.user.upsert({
            where: { id: 'external-respondent' },
            update: {},
            create: {
                id: 'external-respondent',
                email: 'external-respondent@system.local',
                name: 'External Respondent',
            },
        });

        const tenant = await prisma.tenant.create({
            data: {
                name: `G-3 Lifecycle Tenant ${runId}`,
                slug: `g3-life-${runId}`,
                industry: 'Tech',
                maxRiskScale: 5,
            },
        });
        tenantId = tenant.id;

        const vendor = await prisma.vendor.create({
            data: { tenantId, name: `G-3 Vendor ${runId}` },
        });
        vendorId = vendor.id;

        // Legacy questionnaire template + question. The question is
        // created with an EXPLICIT id so the G-3 template question can
        // reuse it (submitResponse writes this id into the answer's
        // legacy `questionId` FK).
        const legacy = await prisma.questionnaireTemplate.create({
            data: { key: `g3-life-legacy-${runId}`, name: 'Legacy stub', isGlobal: true },
        });
        legacyTemplateId = legacy.id;
        await prisma.questionnaireQuestion.create({
            data: {
                id: questionId,
                templateId: legacy.id,
                section: 'A',
                prompt: 'Do you encrypt data at rest?',
                answerType: 'YES_NO',
                weight: 1,
                riskPointsJson: { yes: 0, no: 10 },
                sortOrder: 0,
            },
        });

        // Published G-3 template with one section + one required YES_NO
        // question (sharing the id above). `no` maps to 10 risk points so
        // the submit produces a non-zero provisional score.
        const template = await prisma.vendorAssessmentTemplate.create({
            data: {
                tenantId,
                key: `g3-life-${runId}`,
                version: 1,
                name: 'Security baseline',
                description: 'G-3 lifecycle questionnaire',
                isPublished: true,
                createdByUserId: userId,
            },
        });
        templateId = template.id;

        const section = await prisma.vendorAssessmentTemplateSection.create({
            data: {
                tenantId,
                templateId: template.id,
                sortOrder: 0,
                title: 'Information security',
            },
        });

        await prisma.vendorAssessmentTemplateQuestion.create({
            data: {
                id: questionId,
                tenantId,
                templateId: template.id,
                sectionId: section.id,
                sortOrder: 0,
                prompt: 'Do you encrypt data at rest?',
                answerType: 'YES_NO',
                required: true,
                weight: 1,
                riskPointsJson: { yes: 0, no: 10 },
            },
        });
    });

    afterAll(async () => {
        try {
            await deleteAuditRowsForTenants(prisma, tenantId);
            await prisma.$transaction(async (tx: typeof prisma) => {
                await tx.$executeRawUnsafe(
                    `SET LOCAL session_replication_role = 'replica'`,
                );
                // Child-first order under disabled triggers/FKs so audit
                // + evidence rows the usecases wrote don't block cleanup.
                for (const table of [
                    'VendorAssessmentAnswer',
                    'VendorEvidenceBundleItem',
                    'VendorEvidenceBundle',
                    'Evidence',
                    'VendorAssessment',
                    'VendorAssessmentTemplateQuestion',
                    'VendorAssessmentTemplateSection',
                    'VendorAssessmentTemplate',
                    // Vendor-risk writeback artefacts (post-commit): the
                    // auto-created register Risk + its opening ledger event
                    // + the RISK VendorLink.
                    'VendorLink',
                    'RiskScoreEvent',
                    'Risk',
                    'Vendor',
                    'NotificationOutbox',
                    'Notification',
                ]) {
                    await tx.$executeRawUnsafe(
                        `DELETE FROM "${table}" WHERE "tenantId" = $1`,
                        tenantId,
                    );
                }
                // Legacy questionnaire rows are not tenant-scoped.
                await tx.$executeRawUnsafe(
                    `DELETE FROM "QuestionnaireQuestion" WHERE "templateId" = $1`,
                    legacyTemplateId,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "QuestionnaireTemplate" WHERE "id" = $1`,
                    legacyTemplateId,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "Tenant" WHERE "id" = $1`,
                    tenantId,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "User" WHERE "id" = $1`,
                    userId,
                );
            });
        } catch (e) {
            console.warn('[g3-lifecycle] cleanup error:', e);
        }
        await prisma.$disconnect();
    });

    test('send → submit → review → close transitions with a produced score', async () => {
        const ctx = makeRequestContext(Role.ADMIN, { userId, tenantId });

        // ── send: template instance created directly in SENT ──
        const sent = await sendAssessment(ctx, vendorId, templateId, {
            respondentEmail: 'respondent@example.test',
            respondentName: 'Vendor Team',
            appOriginOverride: 'http://localhost:3000',
        });
        expect(sent.assessmentId).toBeTruthy();
        expect(sent.externalAccessToken).toBeTruthy();

        const afterSend = await prisma.vendorAssessment.findUnique({
            where: { id: sent.assessmentId },
        });
        expect(afterSend?.status).toBe('SENT');

        // ── submit: public flow with the raw token → SUBMITTED ──
        const submitted = await submitResponse(
            sent.externalAccessToken,
            sent.assessmentId,
            [{ questionId, answerJson: { value: 'no' } }],
        );
        expect(submitted.status).toBe('SUBMITTED');
        expect(typeof submitted.provisionalScore).toBe('number');

        const afterSubmit = await prisma.vendorAssessment.findUnique({
            where: { id: sent.assessmentId },
        });
        expect(afterSubmit?.status).toBe('SUBMITTED');

        // ── review: scoring engine runs, SUBMITTED → REVIEWED ──
        const reviewed = await reviewAssessment(ctx, sent.assessmentId, {});
        expect(reviewed.status).toBe('REVIEWED');
        expect(typeof reviewed.score).toBe('number');

        const afterReview = await prisma.vendorAssessment.findUnique({
            where: { id: sent.assessmentId },
        });
        expect(afterReview?.status).toBe('REVIEWED');

        // ── close: terminal REVIEWED → CLOSED ──
        const closed = await closeAssessment(ctx, sent.assessmentId);
        expect(closed.status).toBe('CLOSED');

        const afterClose = await prisma.vendorAssessment.findUnique({
            where: { id: sent.assessmentId },
        });
        expect(afterClose?.status).toBe('CLOSED');
    });

    test('review writeback: sets vendor inherentRisk + lastAssessmentReviewedAt, and auto-creates exactly one register Risk on HIGH (idempotent on re-review)', async () => {
        const ctx = makeRequestContext(Role.ADMIN, { userId, tenantId });

        // Dedicated vendor so RISK-link / Risk counts are unpolluted by
        // the lifecycle test's own review above.
        const wbVendor = await prisma.vendor.create({
            data: { tenantId, name: `G-3 WB Vendor ${runId}` },
        });

        // send → submit → review(HIGH) for `wbVendor`, returning the
        // assessment id. Forces a HIGH rating via the finalRiskRating
        // override so the outcome is deterministic regardless of scoring.
        async function sendSubmitReviewHigh() {
            const sent = await sendAssessment(ctx, wbVendor.id, templateId, {
                respondentEmail: 'respondent@example.test',
                respondentName: 'Vendor Team',
                appOriginOverride: 'http://localhost:3000',
            });
            await submitResponse(sent.externalAccessToken, sent.assessmentId, [
                { questionId, answerJson: { value: 'no' } },
            ]);
            const reviewed = await reviewAssessment(ctx, sent.assessmentId, {
                finalRiskRating: 'HIGH',
            });
            expect(reviewed.riskRating).toBe('HIGH');
            return reviewed;
        }

        // ── First review → writeback + auto-risk ──
        const reviewed1 = await sendSubmitReviewHigh();

        const vendorAfter1 = await prisma.vendor.findUnique({
            where: { id: wbVendor.id },
        });
        // (a) inherentRisk mirrors the resolved rating; timestamp stamped.
        expect(vendorAfter1?.inherentRisk).toBe('HIGH');
        expect(vendorAfter1?.lastAssessmentReviewedAt).toBeTruthy();
        // residualRisk stays manually-owned — untouched by the writeback.
        expect(vendorAfter1?.residualRisk).toBeNull();
        // PR-S — nextReviewAt is rolled forward from the review (was unset).
        expect(vendorAfter1?.nextReviewAt).toBeTruthy();

        const linksAfter1 = await prisma.vendorLink.findMany({
            where: { tenantId, vendorId: wbVendor.id, entityType: 'RISK' },
        });
        // (b) exactly one Risk + one RISK VendorLink created, marked as
        // assessment-sourced (PR-S), and surfaced back to the reviewer.
        expect(linksAfter1).toHaveLength(1);
        expect(linksAfter1[0].relation).toBe('ASSESSMENT_SOURCED');
        const riskId = linksAfter1[0].entityId;
        expect(reviewed1.autoCreatedRiskId).toBe(riskId);
        const risk = await prisma.risk.findUnique({ where: { id: riskId } });
        expect(risk).toBeTruthy();
        expect(risk?.category).toBe('Third-party');
        expect(risk?.title).toContain(wbVendor.name);
        expect(risk?.title).toContain('HIGH');

        // ── Second review of a NEW HIGH assessment on the same vendor ──
        // Idempotent: the pre-existing RISK link short-circuits the
        // auto-create, so no duplicate Risk / link appears.
        await sendSubmitReviewHigh();

        const linksAfter2 = await prisma.vendorLink.findMany({
            where: { tenantId, vendorId: wbVendor.id, entityType: 'RISK' },
        });
        expect(linksAfter2).toHaveLength(1);
        expect(linksAfter2[0].entityId).toBe(riskId);

        const riskCount = await prisma.risk.count({
            where: { tenantId, title: { contains: wbVendor.name } },
        });
        expect(riskCount).toBe(1);
    });

    test('PR-S idempotency fix: an UNRELATED manual RISK link does NOT suppress assessment-sourced auto-risk', async () => {
        const ctx = makeRequestContext(Role.ADMIN, { userId, tenantId });
        const vendor = await prisma.vendor.create({
            data: { tenantId, name: `G-3 Manual-link Vendor ${runId}` },
        });

        // A manual, UNRELATED risk linked to the vendor (relation RELATED).
        const manualRisk = await prisma.risk.create({
            data: { tenantId, title: `Manual unrelated risk ${runId}`, category: 'Operational' },
        });
        await prisma.vendorLink.create({
            data: { tenantId, vendorId: vendor.id, entityType: 'RISK', entityId: manualRisk.id, relation: 'RELATED' },
        });

        // Under the OLD "any RISK link" check this would suppress the auto-risk.
        const sent = await sendAssessment(ctx, vendor.id, templateId, {
            respondentEmail: 'respondent@example.test',
            respondentName: 'Vendor Team',
            appOriginOverride: 'http://localhost:3000',
        });
        await submitResponse(sent.externalAccessToken, sent.assessmentId, [
            { questionId, answerJson: { value: 'no' } },
        ]);
        const reviewed = await reviewAssessment(ctx, sent.assessmentId, { finalRiskRating: 'HIGH' });

        // The auto-risk IS materialized despite the unrelated manual link.
        expect(reviewed.autoCreatedRiskId).toBeTruthy();
        const riskLinks = await prisma.vendorLink.findMany({
            where: { tenantId, vendorId: vendor.id, entityType: 'RISK' },
        });
        expect(riskLinks).toHaveLength(2); // the manual one + the assessment-sourced one
        const sourced = riskLinks.filter((l: { relation: string; entityId: string }) => l.relation === 'ASSESSMENT_SOURCED');
        expect(sourced).toHaveLength(1);
        expect(sourced[0].entityId).toBe(reviewed.autoCreatedRiskId);
    });

    test('PR-S listVendorAssessments: returns all statuses with the template name resolved via templateVersion', async () => {
        const ctx = makeRequestContext(Role.ADMIN, { userId, tenantId });
        const vendor = await prisma.vendor.create({
            data: { tenantId, name: `G-3 List Vendor ${runId}` },
        });
        // A G-3 row: templateId null, templateVersionId set → name via templateVersion.
        await sendAssessment(ctx, vendor.id, templateId, {
            respondentEmail: 'respondent@example.test',
            respondentName: 'Vendor Team',
            appOriginOverride: 'http://localhost:3000',
        });

        const rows = await listVendorAssessments(ctx, vendor.id);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const g3 = rows[0];
        expect(g3.status).toBe('SENT');
        // The regression showed "—"; the fix resolves the G-3 name.
        expect(g3.templateName).toBeTruthy();
        expect(g3.sentAt).toBeTruthy();
        expect(g3.respondentEmail).toBe('respondent@example.test');
    });
});
