/**
 * Trust-center gated-document admin (PR-8) — tenant-scoped management of
 * documents + access requests. Public visitor flows (request + download) live
 * in the isolated `@/lib/trust-center/gated` module.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';

const DOWNLOAD_TOKEN_TTL_DAYS = 7;
const hashToken = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

export const AddDocumentSchema = z.object({ label: z.string().min(1).max(200), fileRecordId: z.string().min(1), gated: z.boolean().default(true) });

export async function addTrustCenterDocument(ctx: RequestContext, input: z.infer<typeof AddDocumentSchema>) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const tc = await db.trustCenter.findFirst({ where: { tenantId: ctx.tenantId }, select: { id: true } });
        if (!tc) throw badRequest('Create the trust center before adding documents.');
        const file = await db.fileRecord.findFirst({ where: { id: input.fileRecordId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!file) throw badRequest('Unknown file.');
        const doc = await db.trustCenterDocument.create({
            data: { tenantId: ctx.tenantId, trustCenterId: tc.id, label: sanitizePlainText(input.label), fileRecordId: input.fileRecordId, gated: input.gated },
        });
        await logEvent(db, ctx, { action: 'CREATE', entityType: 'TrustCenterDocument', entityId: doc.id, details: `Added trust-center document: ${doc.label}`, detailsJson: { category: 'entity_lifecycle', entityName: 'TrustCenterDocument', operation: 'created', after: { label: doc.label, gated: doc.gated }, summary: `Added trust-center document: ${doc.label}` } });
        return doc;
    });
}

export async function listTrustCenterDocuments(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.trustCenterDocument.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, label: true, gated: true, fileRecordId: true, createdAt: true }, orderBy: { label: 'asc' }, take: 200 }),
    );
}

export async function listTrustCenterAccessRequests(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.trustCenterAccessRequest.findMany({
            where: { tenantId: ctx.tenantId },
            // downloadTokenHash intentionally omitted (credential).
            select: { id: true, requesterName: true, requesterEmail: true, company: true, status: true, ndaSignedAt: true, grantedAt: true, expiresAt: true, downloadedAt: true, createdAt: true, document: { select: { label: true } } },
            orderBy: { createdAt: 'desc' },
            take: 500,
        }),
    );
}

export interface ApproveResult {
    requestId: string;
    downloadToken: string;
}

/**
 * Approve a REQUESTED access request, or issue a new link for an APPROVED one
 * (#4824): a single-use token that expires in 7 days, returned once.
 *
 * A new link REPLACES the stored hash, so the old link stops working the
 * moment the new one exists: there is never more than one live link per
 * request. That is what lets an administrator re-send a link that lapsed, was
 * used, or was lost, without widening anybody's access. A DENIED request is
 * final; the visitor can ask again, which is a new request.
 */
export async function approveTrustCenterAccessRequest(ctx: RequestContext, requestId: string, now: Date = new Date()): Promise<ApproveResult> {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const req = await db.trustCenterAccessRequest.findFirst({ where: { id: requestId, tenantId: ctx.tenantId }, select: { id: true, status: true } });
        if (!req) throw notFound('Access request not found.');
        if (req.status === 'DENIED') throw badRequest('This request was denied. The visitor can ask again from the public page.');
        const reissue = req.status === 'APPROVED';
        const downloadToken = `ictc_${crypto.randomBytes(24).toString('hex')}`;
        const claimed = await db.trustCenterAccessRequest.updateMany({
            // The status read above is re-asserted here, so a request denied
            // in between is never approved over the denial.
            where: { id: requestId, tenantId: ctx.tenantId, status: req.status },
            data: { status: 'APPROVED', grantedAt: now, expiresAt: new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000), downloadTokenHash: hashToken(downloadToken), downloadedAt: null },
        });
        if (claimed.count === 0) throw badRequest('This request changed while you were looking at it. Reload the page and try again.');
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'TrustCenterAccessRequest',
            entityId: requestId,
            details: reissue ? 'Issued a new trust-center download link' : 'Approved trust-center access request',
            detailsJson: {
                category: 'access',
                entityName: 'TrustCenterAccessRequest',
                operation: reissue ? 'link_reissued' : 'approved',
                summary: reissue ? 'Issued a new download link; the previous one no longer works' : 'Approved gated-document access request',
            },
        });
        return { requestId, downloadToken };
    });
}

/**
 * Deny a REQUESTED access request (#4824). Only a request still waiting can be
 * denied: an approved one has already had a link issued, and denying it would
 * read as taking back a file that may already have been downloaded.
 */
export async function denyTrustCenterAccessRequest(ctx: RequestContext, requestId: string): Promise<{ requestId: string }> {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const req = await db.trustCenterAccessRequest.findFirst({ where: { id: requestId, tenantId: ctx.tenantId }, select: { id: true, status: true } });
        if (!req) throw notFound('Access request not found.');
        if (req.status !== 'REQUESTED') throw badRequest('Only a request that is still waiting can be denied.');
        const claimed = await db.trustCenterAccessRequest.updateMany({
            where: { id: requestId, tenantId: ctx.tenantId, status: 'REQUESTED' },
            data: { status: 'DENIED' },
        });
        if (claimed.count === 0) throw badRequest('This request changed while you were looking at it. Reload the page and try again.');
        await logEvent(db, ctx, { action: 'UPDATE', entityType: 'TrustCenterAccessRequest', entityId: requestId, details: 'Denied trust-center access request', detailsJson: { category: 'access', entityName: 'TrustCenterAccessRequest', operation: 'denied', summary: 'Denied gated-document access request' } });
        return { requestId };
    });
}

/**
 * Remove a document on request from the trust center (#4824). Its access
 * requests go with it (the foreign key cascades), so every link issued for it
 * stops working at once. The uploaded file stays in the evidence library,
 * where it was stored; only its listing on the trust center is removed.
 */
export async function removeTrustCenterDocument(ctx: RequestContext, documentId: string): Promise<{ documentId: string }> {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const doc = await db.trustCenterDocument.findFirst({ where: { id: documentId, tenantId: ctx.tenantId }, select: { id: true, label: true, gated: true } });
        if (!doc) throw notFound('Document not found.');
        const requests = await db.trustCenterAccessRequest.count({ where: { tenantId: ctx.tenantId, documentId } });
        await db.trustCenterDocument.deleteMany({ where: { id: documentId, tenantId: ctx.tenantId } });
        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'TrustCenterDocument',
            entityId: documentId,
            details: `Removed trust-center document: ${doc.label}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TrustCenterDocument',
                operation: 'deleted',
                before: { label: doc.label, gated: doc.gated },
                summary: `Removed trust-center document: ${doc.label} (${requests} access request${requests === 1 ? '' : 's'} removed with it)`,
            },
        });
        return { documentId };
    });
}
