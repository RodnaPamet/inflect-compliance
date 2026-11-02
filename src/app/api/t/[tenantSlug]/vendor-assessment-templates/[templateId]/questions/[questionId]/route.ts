/**
 * PATCH  /api/t/[tenantSlug]/vendor-assessment-templates/[templateId]/questions/[questionId]
 *        Body: UpdateVendorAssessmentTemplateQuestionSchema
 * DELETE /api/t/[tenantSlug]/vendor-assessment-templates/[templateId]/questions/[questionId]
 *
 * Edit or remove a question of a DRAFT template (#4934). A question is
 * addressed by its template rather than its section, because the reorder can
 * move it between sections. Gated `vendors.edit`, the key the usecase's
 * `assertCanManageVendorAssessmentTemplates` reads, through
 * `requirePermission` so a refusal writes an AUTHZ_DENIED row; the usecase
 * then refuses a published template (`assertEditable`).
 */
import { deleteQuestion, updateQuestion } from '@/app-layer/usecases/vendor-assessment-template';
import { UpdateVendorAssessmentTemplateQuestionSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import type { AnswerType } from '@prisma/client';

type Params = { tenantSlug: string; templateId: string; questionId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, UpdateVendorAssessmentTemplateQuestionSchema);
        const question = await updateQuestion(ctx, params.templateId, params.questionId, {
            ...body,
            answerType: body.answerType as AnswerType | undefined,
        });
        return jsonResponse(question);
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (_req, { params }, ctx) => {
        const result = await deleteQuestion(ctx, params.templateId, params.questionId);
        return jsonResponse(result);
    }),
);
