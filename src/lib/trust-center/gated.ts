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

export interface PublicGatedListing {
    /** Whether a request must accept the trust center's non-disclosure terms. */
    ndaRequired: boolean;
    /** The GATED documents, by id and label only — never fileRecordId. */
    documents: Array<{ id: string; label: string }>;
}

/**
 * What the public page offers on request (#4649): an ENABLED trust center's
 * gated documents, and whether a request must accept its NDA. Null for a
 * missing or disabled slug, like every read here.
 */
export async function getPublicGatedDocuments(slug: string): Promise<PublicGatedListing | null> {
    const tc = await prisma.trustCenter.findFirst({ where: { slug, enabled: true }, select: { id: true, ndaRequired: true } });
    if (!tc) return null;
    const documents = await prisma.trustCenterDocument.findMany({
        where: { trustCenterId: tc.id, gated: true },
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
        take: 200,
    });
    return { ndaRequired: tc.ndaRequired, documents };
}

export interface AccessRequestInput {
    requesterName: string;
    requesterEmail: string;
    company?: string;
    ndaAccepted?: boolean;
}
export interface AccessRequestResult {
    /**
     * `REQUESTED` — recorded, waiting for an admin to approve it.
     *
     * `NDA_REQUIRED` — REFUSED and nothing recorded: the trust center requires
     * its non-disclosure terms and the request did not accept them (#5613).
     * Distinguishable from the uniform outcome on purpose, which does not make
     * this an oracle: `ndaRequired` is already handed to the public page by
     * {@link getPublicGatedDocuments}, and the refusal is decided before any
     * document is looked up, so it says nothing about which documents exist.
     */
    status: 'APPROVED' | 'REQUESTED' | 'NDA_REQUIRED';
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

    // The NDA is a SERVER rule (#5613). `ndaRequired` was selected here and
    // then never read: the only thing that decided `ndaSignedAt` was
    // `input.ndaAccepted`, a field of the request body, so removing the
    // checkbox from the form — or never using the form — recorded a request
    // with no NDA against a center that requires one. The admin queue cannot
    // catch it either, because the approval reads neither column.
    //
    // Refused BEFORE the document lookup, so this discloses only `ndaRequired`
    // (public) and nothing about which documents exist.
    if (tc.ndaRequired && !input.ndaAccepted) return { status: 'NDA_REQUIRED' };

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
 * RESOLVE a download token without spending it: hash lookup, must be APPROVED,
 * its trust center enabled, not already downloaded, not expired. Returns the
 * fileRecordId plus the request it came from, or null on any failure (no
 * disclosure).
 *
 * Spending is a SEPARATE act ({@link spendDownloadToken}) because a refusal
 * must not cost the requester their one use (#5614). #5385 already established
 * that for the `enabled` check below — it sits here, above the claim, so an
 * unpublished center does not burn the token — but the AV and lifecycle gate
 * lives in the route, and consuming first meant a file that was merely
 * mid-scan or awaiting a rescan spent the token on a 404 that would have
 * succeeded minutes later. The two refusals differed only in which side of
 * this module boundary they fell on.
 *
 * So: the caller resolves, applies its own gates, and spends only once it is
 * actually about to serve the bytes.
 */
export async function resolveDownloadToken(token: string, now: Date = new Date()): Promise<ResolvedDownload | null> {
    if (!token || !token.startsWith('ictc_')) return null;
    const req = await prisma.trustCenterAccessRequest.findUnique({
        where: { downloadTokenHash: hashToken(token) },
        select: {
            id: true,
            status: true,
            expiresAt: true,
            downloadedAt: true,
            document: { select: { fileRecordId: true, trustCenter: { select: { enabled: true } } } },
        },
    });
    if (!req || req.status !== 'APPROVED') return null;
    // The contract above: only an ENABLED trust center serves anything. An
    // unpublished one serves no document, whatever token was issued while it
    // was live. The token is not spent, so it works again if the trust center
    // is republished before it expires.
    if (!req.document.trustCenter.enabled) return null;
    if (req.downloadedAt) return null; // single-use — already consumed
    if (req.expiresAt && req.expiresAt < now) return null;

    return { fileRecordId: req.document.fileRecordId, accessRequestId: req.id };
}

/**
 * SPEND a resolved download token, atomically. Only succeeds if the request is
 * still un-downloaded, so two callers that both resolved and both passed their
 * gates race here exactly as they raced when resolve and spend were one call —
 * one wins, the other is told it lost.
 *
 * Returns true when this caller took the single use. A false means somebody
 * else did, and the caller must serve nothing.
 */
export async function spendDownloadToken(accessRequestId: string, now: Date = new Date()): Promise<boolean> {
    const claim = await prisma.trustCenterAccessRequest.updateMany({
        where: { id: accessRequestId, downloadedAt: null },
        data: { downloadedAt: now },
    });
    return claim.count > 0;
}
