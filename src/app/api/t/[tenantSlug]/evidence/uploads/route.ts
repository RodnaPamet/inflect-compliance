/**
 * POST /api/t/[tenantSlug]/evidence/uploads
 * Multipart upload: file + optional metadata fields.
 * Creates FileRecord + Evidence(FILE) in one flow.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// R5-P3 #6 — the metadata fields were raw formData.get casts with no
// validation: the 120-char folder cap, the reviewCycle enum, and a parseable
// nextReviewDate were all bypassable (nextReviewDate reached `new Date()`
// unchecked). Validate them here (the file itself is checked in the usecase).
const empty = (v: FormDataEntryValue | null): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s.length > 0 ? s : undefined;
};
const UploadMetadataSchema = z.object({
    title: z.string().max(500).optional(),
    controlId: z.string().max(64).optional(),
    taskId: z.string().max(64).optional(),
    riskId: z.string().max(64).optional(),
    assetId: z.string().max(64).optional(),
    category: z.string().max(200).optional(),
    folder: z.string().max(120).optional(),
    owner: z.string().max(200).optional(),
    reviewCycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY']).optional(),
    nextReviewDate: z.string().refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date').optional(),
}).strip();

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
        return jsonResponse(
            { error: 'Missing or invalid file in form data' },
            { status: 400 },
        );
    }

    const parsed = UploadMetadataSchema.safeParse({
        title: empty(formData.get('title')),
        controlId: empty(formData.get('controlId')),
        taskId: empty(formData.get('taskId')),
        riskId: empty(formData.get('riskId')),
        assetId: empty(formData.get('assetId')),
        category: empty(formData.get('category')),
        folder: empty(formData.get('folder')),
        owner: empty(formData.get('owner')),
        reviewCycle: empty(formData.get('reviewCycle')),
        nextReviewDate: empty(formData.get('nextReviewDate')),
    });
    if (!parsed.success) {
        return jsonResponse({ error: 'Invalid upload metadata', details: parsed.error.flatten() }, { status: 400 });
    }

    // EP-3 — support many controls: repeated `controlIds` fields OR a single
    // legacy `controlId`. Both feed the many-to-many join in the usecase.
    const controlIds = formData.getAll('controlIds').map((v) => String(v)).filter(Boolean);

    const metadata = {
        ...parsed.data,
        controlIds: controlIds.length > 0 ? controlIds : undefined,
        // B8 follow-up — folder rides with the upload form so a
        // batch upload writes the same folder onto every row.
    };

    const evidence = await uploadEvidenceFile(ctx, file, metadata);
    return jsonResponse(evidence, { status: 201 });
});
