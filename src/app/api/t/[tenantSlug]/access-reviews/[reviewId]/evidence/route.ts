/**
 * Epic G-4 — Stream the closeout PDF evidence artifact.
 *
 *   GET /api/t/:slug/access-reviews/:reviewId/evidence
 *
 * Resolves the campaign's `evidenceFileRecordId`, fetches the
 * underlying FileRecord (tenant-scoped), and streams the PDF back
 * with the canonical filename. 404 when the campaign has no
 * artifact yet (e.g. closeout PDF generation failed and the
 * regenerate path hasn't run).
 *
 * #3674 — an AGENT campaign's evidence lists its subjects, which are register
 * data, so it is served only to the campaign's reviewer or a holder of
 * `admin.agent_registry`, the narrowing every other read of those subjects
 * takes. Every role holds `access_reviews.view`.
 */
import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { runInTenantContext } from '@/lib/db-context';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getStorageProvider } from '@/lib/storage';
import { isDownloadAllowed, getBlockedReason } from '@/lib/storage/av-scan';
import { withApiErrorHandling } from '@/lib/errors/api';
import { notFound, forbidden } from '@/lib/errors/types';
import { contentDispositionHeader } from '@/lib/http/content-disposition';
import { mayReadAgentSubjects } from '@/lib/access-review/scope';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.view',
        async (_req: NextRequest, { params }, ctx) => {
            const fileRecord = await runInTenantContext(ctx, async (db) => {
                const review = await db.accessReview.findFirst({
                    where: { id: params.reviewId, tenantId: ctx.tenantId },
                    select: { evidenceFileRecordId: true, scope: true, reviewerUserId: true },
                });
                if (!review) throw notFound('Access review not found');
                if (
                    review.scope === 'AGENT'
                    && !mayReadAgentSubjects({
                        userId: ctx.userId,
                        reviewerUserId: review.reviewerUserId,
                        holdsAgentRegistry: ctx.appPermissions?.admin?.agent_registry === true,
                    })
                ) {
                    throw forbidden('An agent campaign’s evidence is readable by its reviewer and by holders of admin.agent_registry');
                }
                if (!review.evidenceFileRecordId) {
                    throw notFound(
                        'No evidence artifact has been generated for this campaign yet.',
                    );
                }
                const fr = await db.fileRecord.findFirst({
                    where: {
                        id: review.evidenceFileRecordId,
                        tenantId: ctx.tenantId,
                    },
                    select: {
                        id: true,
                        pathKey: true,
                        originalName: true,
                        mimeType: true,
                        sizeBytes: true,
                        scanStatus: true,
                    },
                });
                if (!fr) throw notFound('Evidence file not found');
                return fr;
            });

            // R5-P1 #3 — single shared AV gate before serving (files are PENDING
            // the moment they're stored; scanning is async).
            if (!isDownloadAllowed(fileRecord.scanStatus)) {
                throw forbidden(getBlockedReason(fileRecord.scanStatus));
            }

            const storage = getStorageProvider();
            const stream = storage.readStream(fileRecord.pathKey);

            // Convert Node Readable → Web ReadableStream for Next.js Response.
            const webStream = Readable.toWeb(stream) as unknown as ReadableStream;

            return new Response(webStream, {
                status: 200,
                headers: {
                    'Content-Type': fileRecord.mimeType,
                    'Content-Disposition': contentDispositionHeader(fileRecord.originalName),
                    'Content-Length': String(fileRecord.sizeBytes),
                    'Cache-Control': 'private, no-store',
                },
            });
        },
    ),
);
