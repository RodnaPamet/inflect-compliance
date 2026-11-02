/**
 * PATCH  /api/t/[tenantSlug]/vendor-assessment-templates/[templateId]/sections/[sectionId]
 *        Body: UpdateVendorAssessmentTemplateSectionSchema
 * DELETE /api/t/[tenantSlug]/vendor-assessment-templates/[templateId]/sections/[sectionId]
 *
 * Edit or remove a section of a DRAFT template (#4934); removing it removes
 * its questions. Gated `vendors.edit`, the key the usecase's
 * `assertCanManageVendorAssessmentTemplates` reads, through
 * `requirePermission` so a refusal writes an AUTHZ_DENIED row; the usecase
 * then refuses a published template (`assertEditable`).
 */
import { deleteSection, updateSection } from '@/app-layer/usecases/vendor-assessment-template';
import { UpdateVendorAssessmentTemplateSectionSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; templateId: string; sectionId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, UpdateVendorAssessmentTemplateSectionSchema);
        const section = await updateSection(ctx, params.templateId, params.sectionId, body);
        return jsonResponse(section);
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (_req, { params }, ctx) => {
        const result = await deleteSection(ctx, params.templateId, params.sectionId);
        return jsonResponse(result);
    }),
);
