import { NextRequest, NextResponse } from 'next/server';
import { consumeDownloadToken } from '@/lib/trust-center/gated';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { recordFileDistribution } from '@/app-layer/services/file-distribution';
import { logger } from '@/lib/observability/logger';

/**
 * Lifetime of the signed URL this route redirects to, in SECONDS — the unit
 * `DownloadUrlOptions.expiresIn` takes, forwarded verbatim to the S3
 * presigner (`s3-provider.ts::createSignedDownloadUrl`).
 *
 * Spelled out because the provider's fallback is `?? 3600`, and taking it by
 * OMISSION is what made the repo's only unauthenticated serving path twelve
 * times more generous than its authenticated sibling: `downloadEvidenceFile`
 * asks for 300 explicitly. Nothing here justified the asymmetry — it was the
 * absence of an argument, not a decision.
 *
 * The single-use token is already consumed by the time we get here, so from
 * this point the signed URL IS the bearer credential: shareable, replayable by
 * anyone who sees it, recorded in intermediary logs, and outside our
 * revocation. It must never outlive the authenticated path's, so it matches
 * it. Shortening this is safe; lengthening it needs a reason written here.
 */
const TRUST_DOWNLOAD_URL_TTL_SECONDS = 300;

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
        // id / tenantId / sha256 are selected for the distribution ledger
        // below: the exposure report joins on the CONTENT HASH, so a row that
        // does not carry it cannot be answered for later.
        select: {
            id: true, tenantId: true, sha256: true,
            pathKey: true, originalName: true, scanStatus: true, status: true, deletedAt: true,
        },
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

    const url = await getStorageProvider().createSignedDownloadUrl(file.pathKey, {
        expiresIn: TRUST_DOWNLOAD_URL_TTL_SECONDS,
        downloadFilename: file.originalName,
    });

    // ─── Distribution ledger ───
    // This is the only unauthenticated egress in the repo, and from here the
    // signed URL is the bearer credential. Record that the bytes left, and
    // WHEN the URL dies — that instant is what turns "a URL is out there"
    // into a bounded window if the file is later condemned. Fail-safe by
    // construction: the recorder never throws, so a ledger problem cannot
    // deny a requester the document a human already approved.
    //
    // The context is the ACCESS REQUEST, not the document. That is what makes
    // "who received it" answerable: the request row carries the approved
    // requester, so an exposure report on this channel can name a person
    // rather than only a file. Recording the fileRecordId as context would
    // have said nothing the entry does not already carry.
    await recordFileDistribution({
        tenantId: file.tenantId,
        fileRecordId: file.id,
        sha256: file.sha256,
        channel: 'TRUST_CENTER_DOWNLOAD',
        contextType: 'TrustCenterAccessRequest',
        contextId: resolved.accessRequestId,
        signedUrlExpiresAt: new Date(Date.now() + TRUST_DOWNLOAD_URL_TTL_SECONDS * 1000),
    });

    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, no-store' } });
});
