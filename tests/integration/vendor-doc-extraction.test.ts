/**
 * Vendor-doc extraction (integration) — the propose-not-commit contract
 * against a real DB with RLS live:
 *   - extractVendorDocument persists an extraction and (with the stub AI,
 *     no key) writes NO VendorAssessmentAnswer;
 *   - approving a proposal is the ONLY path that materialises a real answer;
 *   - rejecting a proposal writes nothing.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import {
    extractVendorDocument,
    approveProposal,
    rejectProposal,
} from '@/app-layer/usecases/vendor-doc-extraction';
import { extractDocument, type ExtractResult as AiExtractResult } from '@/app-layer/ai/vendor-doc';

// The stub AI (no key) extracts nothing, so the control→question mapping
// branch never runs. Mock ONLY extractDocument (sanitizeDocText et al. stay
// real via requireActual) so we can drive controlled extractions through the
// mapping and assert the G-3 vs legacy proposal keying.
jest.mock('@/app-layer/ai/vendor-doc', () => ({
    ...jest.requireActual('@/app-layer/ai/vendor-doc'),
    extractDocument: jest.fn(),
}));

/** A successful extraction carrying the given SOC 2 controls. */
function extractionWith(
    controls: Array<{ ref: string; description: string; result: 'IN_PLACE' | 'EXCEPTION' | 'NOT_TESTED' }>,
): AiExtractResult {
    return {
        ok: true,
        provider: 'stub',
        model: null,
        data: {
            reportType: 'SOC2_TYPE2',
            auditPeriodStart: '2025-01-01',
            auditPeriodEnd: '2025-12-31',
            scope: null,
            auditor: null,
            trustServiceCriteria: [],
            controls,
            exceptions: [],
        },
    };
}

jest.setTimeout(30_000);
const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `vdoc-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describeFn('vendor-doc extraction (integration)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let userId: string;
    let ctx: RequestContext;
    let vendorId: string;
    let documentId: string;
    let assessmentId: string;
    let questionId: string;
    let legacyTemplateId: string;
    // Approval fixtures live on their own template version (#5068).
    let apprTemplateId: string;
    let apprSectionId: string;
    // G-3 (template-version) fixtures.
    let g3AssessmentId: string;
    let g3QuestionId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const suffix = `vdoc-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: 'VDoc Co', slug: suffix });
        tenantId = tenant.id;
        const user = await prisma.user.create({ data: { email: `u-${suffix}@example.com`, name: 'Reviewer' } });
        userId = user.id;
        ctx = ctxFor(tenantId, userId);

        vendorId = (await prisma.vendor.create({ data: { tenantId, name: `Acme ${suffix}` } })).id;
        documentId = (
            await prisma.vendorDocument.create({
                data: { tenantId, vendorId, type: 'SOC2', title: 'SOC 2 Type II', uploadedByUserId: userId },
            })
        ).id;
        const template = await prisma.questionnaireTemplate.create({ data: { key: `tpl-${suffix}`, name: 'Security' } });
        legacyTemplateId = template.id;
        // ── `VendorAssessmentAnswer.questionId` holds a TEMPLATE-question id
        //    (#5068), so the approval fixtures below are template questions.
        //    They sit on their OWN template version, not on `g3Template`,
        //    whose question population two mapping tests assert is exactly 1. ──
        const apprTemplate = await prisma.vendorAssessmentTemplate.create({
            data: { tenantId, key: `appr-${suffix}`, name: 'Approval fixtures', isPublished: true },
        });
        apprTemplateId = apprTemplate.id;
        apprSectionId = (
            await prisma.vendorAssessmentTemplateSection.create({
                data: { tenantId, templateId: apprTemplate.id, title: 'Security' },
            })
        ).id;
        questionId = (
            await prisma.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId,
                    templateId: apprTemplate.id,
                    sectionId: apprSectionId,
                    prompt: 'Do you enforce access control?',
                    answerType: 'YES_NO',
                },
            })
        ).id;
        assessmentId = (
            await prisma.vendorAssessment.create({
                data: { tenantId, vendorId, templateId: template.id, requestedByUserId: userId },
            })
        ).id;

        // ── G-3 fixtures: a template version + section + question. The
        //    assessment pins templateVersionId and leaves templateId null,
        //    so the mapping resolves questions from
        //    VendorAssessmentTemplateQuestion (not the legacy table). ──
        const g3Template = await prisma.vendorAssessmentTemplate.create({
            data: { tenantId, key: `g3-${suffix}`, name: 'G-3 Security', isPublished: true },
        });
        const g3Section = await prisma.vendorAssessmentTemplateSection.create({
            data: { tenantId, templateId: g3Template.id, title: 'Security' },
        });
        g3QuestionId = (
            await prisma.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId,
                    templateId: g3Template.id,
                    sectionId: g3Section.id,
                    prompt: 'Do you enforce access control?',
                    answerType: 'YES_NO',
                },
            })
        ).id;
        g3AssessmentId = (
            await prisma.vendorAssessment.create({
                data: { tenantId, vendorId, templateVersionId: g3Template.id, requestedByUserId: userId },
            })
        ).id;
    });

    beforeEach(() => {
        // Default: an empty extraction (mirrors the real stub) so unrelated
        // tests see no controls. Mapping tests override per-test.
        jest.mocked(extractDocument).mockResolvedValue(extractionWith([]));
    });

    afterAll(async () => {
        try {
            // Guarded: on a failed `beforeAll` this bare `let` is still
            // undefined, and Prisma DROPS an undefined filter value rather
            // than rejecting it, so the unguarded form is an unpredicated
            // DELETE — see the teardown note in ./db-helper.ts.
            if (tenantId) {
                await prisma.finding.deleteMany({ where: { tenantId, sourceKind: 'VENDOR_DOC_EXCEPTION' } });
                await prisma.vendorAnswerProposal.deleteMany({ where: { tenantId } });
                await prisma.vendorDocExtraction.deleteMany({ where: { tenantId } });
                await prisma.vendorAssessmentAnswer.deleteMany({ where: { tenantId } });
            }
        } catch {
            /* best-effort */
        }
    });

    it('re-extracting the same report raises each exception once, not once per run (#5157)', async () => {
        const base = extractionWith([]);
        if (!base.ok) throw new Error('fixture');
        jest.mocked(extractDocument).mockResolvedValue({
            ...base,
            data: {
                ...base.data,
                exceptions: [
                    { control: 'CC6.1', description: 'Two terminated users kept access for 40 days.' },
                    { control: 'CC6.1', description: 'A second note on the same control.' },
                    { control: 'CC7.2', description: 'Alerts were not reviewed for one week.' },
                ],
            },
        });
        const first = await extractVendorDocument(ctx, { documentId, text: 'SOC 2 Type II', materializeExceptions: true });
        const second = await extractVendorDocument(ctx, { documentId, text: 'SOC 2 Type II', materializeExceptions: true });
        expect(first.findingsProposed).toBe(2);
        expect(second.findingsProposed).toBe(0);
        const refs = await prisma.finding.findMany({
            where: { tenantId, sourceKind: 'VENDOR_DOC_EXCEPTION', deletedAt: null },
            select: { sourceRef: true },
        });
        expect(refs.map((r) => r.sourceRef).sort()).toEqual([`${documentId}:CC6.1`, `${documentId}:CC7.2`]);
    });

    it('extract persists an extraction and writes NO assessment answer (stub AI)', async () => {
        const res = await extractVendorDocument(ctx, {
            documentId,
            assessmentId,
            text: 'SOC 2 Type II report. Controls CC6.1 access control operating effectively.',
        });
        expect(res.extractionId).toBeTruthy();
        expect(res.status).toBe('EXTRACTED');
        // Stub AI extracts nothing → no proposals, and CRUCIALLY no answer.
        const answers = await prisma.vendorAssessmentAnswer.count({ where: { tenantId, assessmentId } });
        expect(answers).toBe(0);
    });

    it('approving a proposal is the ONLY path that materialises an answer', async () => {
        const extraction = await prisma.vendorDocExtraction.create({
            data: { tenantId, vendorId, documentId, assessmentId, status: 'EXTRACTED', createdByUserId: userId },
        });
        const proposal = await prisma.vendorAnswerProposal.create({
            data: {
                tenantId,
                extractionId: extraction.id,
                assessmentId,
                questionId,
                // A G-3 proposal carries the template-question id in BOTH
                // fields (vendor-doc-extraction.ts:213-215), and that is the
                // only shape the mapping can produce (#5068).
                templateQuestionId: questionId,
                proposedAnswerJson: { value: 'YES', controls: ['CC6.1'] },
                confidence: 'high',
                sourceCitation: 'SOC 2 CC6.1 — no exceptions, period 2025..2026',
                status: 'PENDING',
            },
        });

        // Before approval: no answer exists.
        expect(await prisma.vendorAssessmentAnswer.count({ where: { tenantId, assessmentId } })).toBe(0);

        const { answerId } = await approveProposal(ctx, proposal.id);
        expect(answerId).toBeTruthy();

        const answer = await prisma.vendorAssessmentAnswer.findFirst({ where: { id: answerId } });
        expect(answer).not.toBeNull();
        expect(answer!.questionId).toBe(questionId);
        const updatedProposal = await prisma.vendorAnswerProposal.findFirst({ where: { id: proposal.id } });
        expect(updatedProposal!.status).toBe('ACCEPTED');
        expect(updatedProposal!.createdAnswerId).toBe(answerId);
    });

    it.each(['REVIEWED', 'CLOSED'] as const)(
        'refuses to approve a proposal onto a %s assessment, leaving its answers alone (#4936)',
        async (status) => {
            const frozenId = (
                await prisma.vendorAssessment.create({
                    data: { tenantId, vendorId, templateId: legacyTemplateId, requestedByUserId: userId, status },
                })
            ).id;
            const extraction = await prisma.vendorDocExtraction.create({
                data: { tenantId, vendorId, documentId, assessmentId: frozenId, status: 'EXTRACTED', createdByUserId: userId },
            });
            const proposal = await prisma.vendorAnswerProposal.create({
                data: {
                    tenantId,
                    extractionId: extraction.id,
                    assessmentId: frozenId,
                    questionId,
                    templateQuestionId: questionId,
                    proposedAnswerJson: { value: 'YES' },
                    confidence: 'high',
                    sourceCitation: 'SOC 2 CC6.1',
                    status: 'PENDING',
                },
            });

            await expect(approveProposal(ctx, proposal.id)).rejects.toMatchObject({ status: 409 });
            expect(await prisma.vendorAssessmentAnswer.count({ where: { tenantId, assessmentId: frozenId } })).toBe(0);
            expect((await prisma.vendorAnswerProposal.findFirst({ where: { id: proposal.id } }))!.status).toBe('PENDING');
        },
    );

    describe('an approved proposal is a scored answer in the question\'s vocabulary (#5156)', () => {
        async function proposalFor(questionRef: string, value: string, status = 'PENDING') {
            const scoredAssessment = (
                await prisma.vendorAssessment.create({
                    data: { tenantId, vendorId, templateId: legacyTemplateId, requestedByUserId: userId },
                })
            ).id;
            const extraction = await prisma.vendorDocExtraction.create({
                data: { tenantId, vendorId, documentId, assessmentId: scoredAssessment, status: 'EXTRACTED', createdByUserId: userId },
            });
            const proposal = await prisma.vendorAnswerProposal.create({
                data: {
                    tenantId,
                    extractionId: extraction.id,
                    assessmentId: scoredAssessment,
                    questionId: questionRef,
                    templateQuestionId: questionRef,
                    proposedAnswerJson: { value },
                    sourceCitation: 'SOC 2 CC6.1',
                    status,
                },
            });
            return { proposal, scoredAssessment };
        }

        it('scores the answer by the question\'s own points and stores lowercase yes/no', async () => {
            const scored = await prisma.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId,
                    templateId: apprTemplateId,
                    sectionId: apprSectionId,
                    prompt: 'Are production changes reviewed?',
                    answerType: 'YES_NO',
                    riskPointsJson: { YES: 0, NO: 10 },
                },
            });
            const { proposal } = await proposalFor(scored.id, 'NO');
            const { answerId } = await approveProposal(ctx, proposal.id);
            const answer = await prisma.vendorAssessmentAnswer.findFirst({ where: { id: answerId } });
            expect(answer!.computedPoints).toBe(10);
            expect(answer!.answerJson).toEqual({ value: 'no' });
        });

        it('refuses a value the question does not offer, until the reviewer edits it', async () => {
            const { proposal, scoredAssessment } = await proposalFor(questionId, 'PARTIAL');
            await expect(approveProposal(ctx, proposal.id)).rejects.toMatchObject({ status: 400 });
            expect(await prisma.vendorAssessmentAnswer.count({ where: { tenantId, assessmentId: scoredAssessment } })).toBe(0);
            expect((await prisma.vendorAnswerProposal.findFirst({ where: { id: proposal.id } }))!.status).toBe('PENDING');

            await expect(approveProposal(ctx, proposal.id, { value: 'yes' })).resolves.toMatchObject({ answerId: expect.any(String) });
        });

        it.each(['REJECTED', 'ACCEPTED'])('refuses a %s proposal and writes nothing', async (status) => {
            const { proposal, scoredAssessment } = await proposalFor(questionId, 'YES', status);
            await expect(approveProposal(ctx, proposal.id)).rejects.toMatchObject({ status: 409 });
            expect(await prisma.vendorAssessmentAnswer.count({ where: { tenantId, assessmentId: scoredAssessment } })).toBe(0);
        });
    });

    it('rejecting a proposal writes no answer', async () => {
        const extraction = await prisma.vendorDocExtraction.create({
            data: { tenantId, vendorId, documentId, status: 'EXTRACTED', createdByUserId: userId },
        });
        const proposal = await prisma.vendorAnswerProposal.create({
            data: {
                tenantId,
                extractionId: extraction.id,
                assessmentId,
                questionId,
                proposedAnswerJson: { value: 'YES' },
                sourceCitation: 'SOC 2 CC7.2',
                status: 'PENDING',
            },
        });
        await rejectProposal(ctx, proposal.id);
        const updated = await prisma.vendorAnswerProposal.findFirst({ where: { id: proposal.id } });
        expect(updated!.status).toBe('REJECTED');
        expect(updated!.createdAnswerId).toBeNull();
    });

    it('G-3 mapping: proposal carries questionId === templateQuestionId === the template-question id', async () => {
        jest
            .mocked(extractDocument)
            .mockResolvedValue(extractionWith([{ ref: 'CC6.1', description: '', result: 'IN_PLACE' }]));

        const res = await extractVendorDocument(ctx, {
            documentId,
            assessmentId: g3AssessmentId,
            text: 'SOC 2 Type II — CC6.1 access control operating effectively.',
        });

        expect(res.proposalsCreated).toBe(1);
        const proposals = await prisma.vendorAnswerProposal.findMany({
            where: { tenantId, extractionId: res.extractionId },
            take: 10,
        });
        expect(proposals).toHaveLength(1);
        // For G-3, approveProposal upserts VendorAssessmentAnswer on
        // (assessmentId, questionId) using proposal.questionId, and G-3 answers
        // key BOTH fields to the VendorAssessmentTemplateQuestion.id — so the
        // proposal must carry that id in questionId AND templateQuestionId.
        expect(proposals[0].questionId).toBe(g3QuestionId);
        expect(proposals[0].templateQuestionId).toBe(g3QuestionId);
    });

    it('a legacy proposal is still MAPPED, but can no longer be approved (#5068)', async () => {
        // The legacy branch of the mapping is reachable only for an assessment
        // whose templateId names a QuestionnaireTemplate that HAS questions,
        // and the product has no writer for that table: the only seed that
        // writes it (prisma/seed-vendor-questionnaire.ts, via a nested
        // `questions: { create: … }`) is unwired and run by hand, while the
        // one the container entrypoint runs
        // (scripts/seed-vendor-questionnaires.ts) writes the G-3 tables. So
        // this fixture is a hand-seeded shape, created and removed here rather
        // than in `beforeAll` — the row is GLOBAL (no tenantId), so leaving it
        // behind would leak into every other suite on the shared test DB.
        const legacyQuestionId = (
            await prisma.questionnaireQuestion.create({
                data: { templateId: legacyTemplateId, section: 'Security', prompt: 'Do you enforce access control?', answerType: 'YES_NO' },
            })
        ).id;
        try {
            jest
                .mocked(extractDocument)
                .mockResolvedValue(extractionWith([{ ref: 'CC6.1', description: '', result: 'IN_PLACE' }]));

            const res = await extractVendorDocument(ctx, {
                documentId,
                assessmentId, // legacy assessment — templateId set, templateVersionId null
                text: 'SOC 2 Type II — CC6.1 access control operating effectively.',
            });

            // Mapping is unchanged: it still proposes against the legacy set.
            expect(res.proposalsCreated).toBe(1);
            const proposals = await prisma.vendorAnswerProposal.findMany({
                where: { tenantId, extractionId: res.extractionId },
                take: 10,
            });
            expect(proposals).toHaveLength(1);
            expect(proposals[0].questionId).toBe(legacyQuestionId);
            expect(proposals[0].templateQuestionId).toBeNull();

            // Approving it is the dead end this change creates, and it is the
            // mirror of the bug it fixes: `VendorAssessmentAnswer.questionId`
            // now references VendorAssessmentTemplateQuestion, so a legacy
            // question id in that column is refused by the database. Asserted
            // on the CODE, not the prose, so a reworded driver message cannot
            // turn this green.
            await expect(approveProposal(ctx, proposals[0].id)).rejects.toMatchObject({ code: 'P2003' });
            // Keyed on the LEGACY question, not on the assessment: an earlier
            // test in this suite approves a proposal onto the same assessment,
            // so an assessment-wide count of 0 would be false for a reason
            // that has nothing to do with this refusal.
            expect(
                await prisma.vendorAssessmentAnswer.count({ where: { tenantId, questionId: legacyQuestionId } }),
            ).toBe(0);
        } finally {
            await prisma.vendorAnswerProposal.deleteMany({ where: { tenantId, questionId: legacyQuestionId } });
            await prisma.questionnaireQuestion.delete({ where: { id: legacyQuestionId } });
        }
    });
});
