/**
 * POST /api/storage/av-webhook
 *
 * Webhook endpoint for AV scanning results.
 * Called by external scanning services (ClamAV, Windows Defender ATP, etc.)
 * after a file has been scanned.
 *
 * Authentication: HMAC-SHA256 signature in X-AV-Signature header.
 * Payload: { fileId, pathKey, status, details?, engine? }
 *
 * Status transitions:
 *   PENDING → CLEAN     (file is safe)
 *   PENDING → INFECTED  (file contains malware)
 *   PENDING → SKIPPED   (scan was not performed)
 */
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import {
    assessExposureOnInfection,
    type LedgerClient,
} from '@/app-layer/services/file-distribution';

// Use shared prisma instance to ensure audit middleware is active

// ─── Webhook Auth ───

function getWebhookSecret(): string | null {
    return process.env.AV_WEBHOOK_SECRET || null;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
    const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
    // Timing-safe comparison
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expected, 'hex'),
        );
    } catch {
        return false;
    }
}

// ─── Payload Schema ───

interface AVWebhookPayload {
    /** FileRecord ID */
    fileId?: string;
    /** Object key (alternative to fileId) */
    pathKey?: string;
    /** Scan result: clean | infected | skipped */
    status: 'clean' | 'infected' | 'skipped';
    /** Optional scan details (engine output, threat names) */
    details?: string;
    /** Scanning engine name */
    engine?: string;
    /** Timestamp of scan completion */
    scannedAt?: string;
}

const VALID_STATUSES = ['clean', 'infected', 'skipped'] as const;

// ─── Handler ───

export async function POST(req: NextRequest) {
    try {
        const rawBody = await req.text();

        // ─── Authenticate webhook ───
        const secret = getWebhookSecret();
        if (secret) {
            const signature = req.headers.get('x-av-signature') || '';
            if (!signature || !verifySignature(rawBody, signature, secret)) {
                logger.warn('AV webhook: invalid signature', { component: 'av-webhook' });
                return jsonResponse(
                    { error: 'Invalid webhook signature' },
                    { status: 401 }
                );
            }
        } else {
            // No secret configured — check for development bypass
            if (process.env.NODE_ENV === 'production') {
                logger.error('AV webhook: AV_WEBHOOK_SECRET not configured in production', { component: 'av-webhook' });
                return jsonResponse(
                    { error: 'Webhook authentication not configured' },
                    { status: 500 }
                );
            }
            logger.warn('AV webhook: running without signature verification (dev only)', { component: 'av-webhook' });
        }

        // ─── Parse and validate payload ───
        let payload: AVWebhookPayload;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
        }

        if (!payload.status || !VALID_STATUSES.includes(payload.status)) {
            return jsonResponse(
                { error: `Invalid status: must be one of ${VALID_STATUSES.join(', ')}` },
                { status: 400 }
            );
        }

        if (!payload.fileId && !payload.pathKey) {
            return jsonResponse(
                { error: 'Either fileId or pathKey is required' },
                { status: 400 }
            );
        }

        // ─── Lookup file record ───
        let fileRecord: Awaited<ReturnType<typeof prisma.fileRecord.findUnique>> = null;
        if (payload.fileId) {

            fileRecord = await prisma.fileRecord.findUnique({
                where: { id: payload.fileId },
            });
        } else if (payload.pathKey) {

            fileRecord = await prisma.fileRecord.findFirst({
                where: { pathKey: payload.pathKey },
            });
        }

        if (!fileRecord) {
            logger.warn('AV webhook: file not found', {
                component: 'av-webhook',
                fileId: payload.fileId,
                pathKey: payload.pathKey,
            });
            return jsonResponse({ error: 'File not found' }, { status: 404 });
        }

        // ─── Map status ───
        const scanStatusMap: Record<string, string> = {
            clean: 'CLEAN',
            infected: 'INFECTED',
            skipped: 'SKIPPED',
        };
        const scanStatus = scanStatusMap[payload.status];

        // ─── Build scan details ───
        const scanDetails = JSON.stringify({
            engine: payload.engine || 'unknown',
            result: payload.status,
            details: payload.details || null,
            receivedAt: new Date().toISOString(),
        });

        // ─── Update file record ───
        //
        // INFECTED IS TERMINAL. This was an unconditional update with no read
        // of the current verdict, so any later `clean` or `skipped` callback
        // silently un-quarantined an infected file — and the download gates,
        // which trust `scanStatus` alone, would then serve it.
        //
        // The write is a conditional `updateMany` rather than a read-then-
        // write for the usual reason: two callbacks racing on one file would
        // both pass a prior read. The predicate makes the database settle it.
        // Same shape as the invite-redemption claim.
        //
        // Clearing a false positive stays possible, but as an explicit admin
        // action — never as a side effect of whatever the scanner posts last.
        //
        // QUARANTINE RIDES IN THIS SAME STATEMENT. `status: 'FAILED'` used to
        // be a SECOND `update` issued after this claim had already committed.
        // Between the two writes the row was readable in a state neither write
        // intended. A writer that won the `scanStatus` race in that window
        // left `scanStatus: 'CLEAN'` beside `status: 'FAILED'` — a file the
        // download gate serves on a row that says it was quarantined. Today
        // the only other writer is upload; the planned rescan job would be a
        // second racer. Folding both columns into one conditional `updateMany`
        // means the predicate and both writes settle in a single statement:
        // either the row moves to INFECTED *and* FAILED together, or it does
        // not move at all. `status` is only ever SET here, never unset.
        const isInfected = payload.status === 'infected';
        const claimed = await prisma.fileRecord.updateMany({
            where: { id: fileRecord.id, scanStatus: { not: 'INFECTED' } },
            data: {
                scanStatus,
                scanDetails,
                scannedAt: payload.scannedAt ? new Date(payload.scannedAt) : new Date(),
                // Quarantine rides along, so the row can never be observed
                // CLEAN-but-FAILED (or INFECTED-but-not-yet-FAILED) between
                // two statements. Only ever SET, never unset.
                ...(isInfected ? { status: 'FAILED' as const } : {}),
            },
        });

        if (claimed.count === 0) {
            // The row is already INFECTED. Report success — the webhook did
            // its job and a retrying scanner must not be told to retry — but
            // record the refusal, because a scanner reversing an infection
            // verdict is exactly the sequence worth alerting on.
            logger.warn('AV webhook: refused to overwrite an INFECTED verdict', {
                component: 'av-webhook',
                fileId: fileRecord.id,
                tenantId: fileRecord.tenantId,
                attemptedStatus: scanStatus,
                engine: payload.engine,
            });
            return jsonResponse({ ok: true, ignored: 'already_infected' });
        }

        logger.info('AV webhook: scan result recorded', {
            component: 'av-webhook',
            fileId: fileRecord.id,
            tenantId: fileRecord.tenantId,
            scanStatus,
            engine: payload.engine,
        });

        // ─── Handle infected files ───
        //
        // The quarantine WRITE already happened above, inside the same
        // statement that claimed the verdict. What is left here is the
        // out-of-band record of it: the operator log line and the
        // hash-chained audit row. Neither touches the FileRecord, so a
        // failure here cannot leave the two columns disagreeing.
        if (isInfected) {
            logger.warn('AV webhook: INFECTED file detected', {
                component: 'av-webhook',
                fileId: fileRecord.id,
                tenantId: fileRecord.tenantId,
                pathKey: fileRecord.pathKey,
                details: payload.details,
            });

            // Log via the canonical hash-chained audit writer. The
            // earlier cast `prisma.auditEvent.create({...})` hid
            // the fact that no `AuditEvent` model exists — this write
            // never landed. Route to the real `AuditLog` chain so
            // quarantine events are durably evidence-grade.
            await appendAuditEntry({
                tenantId: fileRecord.tenantId,
                userId: fileRecord.uploadedByUserId,
                actorType: 'SYSTEM',
                action: 'FILE_QUARANTINED',
                entity: 'FileRecord',
                entityId: fileRecord.id,
                detailsJson: {
                    category: 'access',
                    engine: payload.engine ?? null,
                    avDetails: payload.details ?? null,
                },
            });

            // ─── What already left? ───
            //
            // Quarantine only refuses FUTURE reads. This verdict may have
            // arrived hours after upload — that asynchrony is the reason this
            // webhook exists — so by now an auditor may be holding a pack ZIP
            // containing these bytes, and a presigned URL minted minutes ago is
            // still working regardless of what the row now says. Answer the
            // question while we have the file's identity in hand: join the
            // distribution ledger on the id AND the content hash (the same
            // bytes can sit under several FileRecord rows) and write the
            // resulting exposure report into the same hash-chained trail, one
            // row after the quarantine.
            //
            // Deliberately after the quarantine write and defensively wrapped:
            // the quarantine has already committed and stands on its own. A
            // scanner told to retry because our reporting failed would be a
            // worse outcome than a missing report.
            try {
                await assessExposureOnInfection({
                    tenantId: fileRecord.tenantId,
                    fileRecordId: fileRecord.id,
                    sha256: fileRecord.sha256,
                    uploadedByUserId: fileRecord.uploadedByUserId,
                    engine: payload.engine ?? null,
                    // The GLOBAL client, and this route means it.
                    //
                    // Nothing on this path binds a tenant context — the whole
                    // handler runs unbound, so there is no `PrismaTx` here to
                    // hand over. Reads stay correct because they filter on
                    // `tenantId` explicitly, which is what scopes them; RLS is
                    // not doing that work on this route.
                    //
                    // Passing it by name is the point. The parameter used to
                    // default to this same client, which made an unbound caller
                    // read as a bound one. Binding the webhook is tracked
                    // separately — this argument surfaces the gap, it does not
                    // close it.
                    client: prisma as unknown as LedgerClient,
                });
            } catch (err) {
                logger.error('AV webhook: exposure assessment failed after quarantine', {
                    component: 'av-webhook',
                    fileId: fileRecord.id,
                    tenantId: fileRecord.tenantId,
                    err: err instanceof Error ? err : new Error(String(err)),
                });
            }
        }

        return jsonResponse({
            success: true,
            fileId: fileRecord.id,
            scanStatus,
        });

    } catch (err) {
        logger.error('AV webhook: unexpected error', {
            component: 'av-webhook',
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return jsonResponse(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
