import { NextRequest, NextResponse } from 'next/server';
import { consumeDownloadToken } from '@/lib/trust-center/gated';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { logger } from '@/lib/observability/logger';

/** PR-8 — PUBLIC: download a gated document via a single-use, expiring token. */
export const GET = withApiErrorHandling(async (_req: NextRequest, { params: p }: { params: Promise<{ token: string }> }) => {
    const { token } = await p;
    const resolved = await consumeDownloadToken(token);
    if (!resolved) return jsonResponse({ error: 'invalid_or_expired' }, { status: 404 });
    const file = await prisma.fileRecord.findUnique({
        where: { id: resolved.fileRecordId },
        // scanStatus / status / deletedAt are SELECTED so they can be gated on
        // below. Selecting only pathKey + originalName is what made this route
        // serve INFECTED, mid-scan and soft-deleted files: a column you don't
        // load is a gate you can't apply.
        select: { pathKey: true, originalName: true, scanStatus: true, status: true, deletedAt: true },
    });
    if (!file) return jsonResponse({ error: 'not_found' }, { status: 404 });

    // ─── Single shared AV + lifecycle gate ───
    // The same three-part predicate the internal serving paths use
    // (audit-pack-sharepoint-export, downloadEvidenceFile, downloadFile).
    // This is the only UNAUTHENTICATED serving path in the repo, so it is the
    // one that least deserves a weaker gate than its authenticated siblings.
    //
    // 404, not 403: an authenticated route can afford to say "this exists but
    // you may not have it". Here the caller is anonymous, so a distinguishable
    // 403 would confirm that a document exists behind a token someone guessed
    // or replayed. Indistinguishable from the not-found branch above by design.
    if (file.status !== 'STORED' || file.deletedAt || !isDownloadAllowed(file.scanStatus)) {
        logger.warn('trust-center download blocked', {
            component: 'trust-center',
            fileRecordId: resolved.fileRecordId,
            status: file.status,
            scanStatus: file.scanStatus,
            softDeleted: Boolean(file.deletedAt),
        });
        return jsonResponse({ error: 'not_found' }, { status: 404 });
    }

    const url = await getStorageProvider().createSignedDownloadUrl(file.pathKey, { downloadFilename: file.originalName });
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, no-store' } });
});
