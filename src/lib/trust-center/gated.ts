/**
 * Public gated-document access for the Trust Center (PR-8).
 *
 * SECURITY CONTRACT (same isolation as public.ts):
 *   - Imports NOTHING from the tenant-data layer — only `prisma` + `crypto`.
 *   - Every query is scoped to an ENABLED TrustCenter resolved by public slug,
 *     and touches ONLY TrustCenter / TrustCenterDocument / TrustCenterAccessRequest.
 *   - A disabled / missing slug or document returns null — never discloses
 *     existence.
 *   - Download tokens are SHA-256-hashed at rest, single-use (consumed on
 *     first download), and expiring.
 *
 * Runs through the prisma singleton without a tenant context (superuser_bypass
 * RLS applies under the table-owner role, like getPublicTrustCenter).
 */
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';

export interface PublicGatedDocument {
    id: string;
    label: string;
    gated: boolean;
}

function hashToken(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Documents published on an ENABLED trust center (labels + gating only — never fileRecordId). */
export async function listPublicTrustCenterDocuments(slug: string): Promise<PublicGatedDocument[]> {
    const tc = await prisma.trustCenter.findFirst({ where: { slug, enabled: true }, select: { id: true } });
    if (!tc) return [];
    const docs = await prisma.trustCenterDocument.findMany({
        where: { trustCenterId: tc.id },
        select: { id: true, label: true, gated: true },
        orderBy: { label: 'asc' },
        take: 200,
    });
    return docs;
}

export interface AccessRequestInput {
    requesterName: string;
    requesterEmail: string;
    company?: string;
    ndaAccepted?: boolean;
}
export interface AccessRequestResult {
    status: 'APPROVED' | 'REQUESTED';
    /** Present only when auto-approved — plaintext download token, shown once. */
    downloadToken?: string;
}

/**
 * A visitor requests access to a gated document. The request is ALWAYS recorded
 * as REQUESTED for human (admin) approval — H4: the previous auto-approve
 * trusted a visitor-SUPPLIED email domain against the allowlist and returned
 * the plaintext download token inline, so anyone who knew an allowlisted
 * customer domain (`x@allowlisted.com`) instantly obtained a token to the gated
 * SOC 2 / pentest with no proof of mailbox control and no audit trail. A token
 * is now only ever issued by the authenticated, audited admin-approval flow
 * (`approveTrustCenterAccessRequest`), which can deliver it to the verified
 * requester out of band.
 *
 * Returns null for a missing/disabled slug or unknown/ungated document (no
 * existence disclosure). On a valid request the caller returns a UNIFORM
 * "request received" response regardless of allowlist/NDA state, so the
 * endpoint can't be used as an allowlist-probing oracle.
 */
export async function requestTrustCenterAccess(slug: string, documentId: string, input: AccessRequestInput, now: Date = new Date()): Promise<AccessRequestResult | null> {
    const tc = await prisma.trustCenter.findFirst({ where: { slug, enabled: true }, select: { id: true, tenantId: true, ndaRequired: true } });
    if (!tc) return null;
    const doc = await prisma.trustCenterDocument.findFirst({ where: { id: documentId, trustCenterId: tc.id, gated: true }, select: { id: true } });
    if (!doc) return null;

    const email = input.requesterEmail.trim().toLowerCase();

    await prisma.trustCenterAccessRequest.create({
        data: {
            tenantId: tc.tenantId,
            documentId: doc.id,
            requesterName: input.requesterName.slice(0, 200),
            requesterEmail: email.slice(0, 320),
            company: input.company ? input.company.slice(0, 200) : null,
            // Always pending human approval — never auto-granted, never a token here.
            status: 'REQUESTED',
            ndaSignedAt: input.ndaAccepted ? now : null,
            grantedAt: null,
            expiresAt: null,
            downloadTokenHash: null,
        },
    });

    // Uniform outcome — no APPROVED/token signal that would leak allowlist membership.
    return { status: 'REQUESTED' };
}

export interface ResolvedDownload {
    fileRecordId: string;
    /**
     * The TrustCenterAccessRequest this token belonged to. Carried out so the
     * distribution ledger can name WHO received the bytes on the repo's only
     * unauthenticated egress — the request row holds the approved requester.
     */
    accessRequestId: string;
}

/**
 * Resolve + CONSUME a download token: hash lookup, must be APPROVED, not
 * expired, not already downloaded. Marks it downloaded (single-use) and
 * returns the fileRecordId plus the request it came from. Returns null on any
 * failure (no disclosure).
 */
export async function consumeDownloadToken(token: string, now: Date = new Date()): Promise<ResolvedDownload | null> {
    if (!token || !token.startsWith('ictc_')) return null;
    const req = await prisma.trustCenterAccessRequest.findUnique({
        where: { downloadTokenHash: hashToken(token) },
        select: { id: true, status: true, expiresAt: true, downloadedAt: true, document: { select: { fileRecordId: true } } },
    });
    if (!req || req.status !== 'APPROVED') return null;
    if (req.downloadedAt) return null; // single-use — already consumed
    if (req.expiresAt && req.expiresAt < now) return null;

    // Consume atomically: only succeeds if still un-downloaded.
    const claim = await prisma.trustCenterAccessRequest.updateMany({
        where: { id: req.id, downloadedAt: null },
        data: { downloadedAt: now },
    });
    if (claim.count === 0) return null; // lost the race
    return { fileRecordId: req.document.fileRecordId, accessRequestId: req.id };
}
