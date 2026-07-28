/**
 * Vendor-document text extraction — the plumbing that turns a stored
 * VendorDocument file (usually a SOC 2 / ISO / pen-test PDF) into raw text
 * for the AI extractor. Kept separate from the AI + usecase layers so the
 * PDF dependency is isolated and swappable.
 */
import type { PrismaClient } from '@prisma/client';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getProviderByName, assertTenantKey } from '@/lib/storage';
import { isDownloadAllowed, getBlockedReason } from '@/lib/storage/av-scan';
import type { StorageProviderType } from '@/lib/storage/types';
import { forbidden } from '@/lib/errors/types';

/** The subset of the client this service needs — accepts a tx client too. */
type FileReader = { fileRecord: Pick<PrismaClient['fileRecord'], 'findFirst'> };

/**
 * Hard ceiling on bytes pulled out of storage for text extraction.
 *
 * `pdf-parse` is a synchronous CPU-bound parser: handing it an arbitrarily
 * large buffer blocks the event loop for as long as it takes. The read is
 * also fully buffered in memory before parsing, so an oversized object is a
 * memory event as well as a latency one. 25 MB comfortably covers a SOC 2 /
 * pen-test report while bounding both.
 */
const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;

/**
 * Wall-clock ceiling for the storage read. A provider that accepts the
 * connection and then stalls would otherwise hold the extraction job open
 * indefinitely — the stream has no inherent timeout.
 */
const READ_TIMEOUT_MS = 30_000;

/** Pages beyond this are ignored — a defence against pathological PDFs. */
const MAX_PDF_PAGES = 500;

/** Extract text from a PDF buffer. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
    const result = await pdfParse(buffer, { max: MAX_PDF_PAGES });
    return result.text ?? '';
}

/**
 * Collect a readable stream into a Buffer, bounded in both size and time.
 *
 * Aborts as soon as the accumulated length crosses the cap rather than
 * after the fact, so an oversized object never fully materialises.
 */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    const deadline = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('vendor-doc-text: storage read timed out')),
            READ_TIMEOUT_MS,
        );
        if (typeof timer.unref === 'function') timer.unref();
    });

    const collect = (async () => {
        for await (const chunk of stream) {
            const buf =
                typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
            total += buf.length;
            if (total > MAX_EXTRACT_BYTES) {
                throw new Error(
                    `vendor-doc-text: file exceeds the ${MAX_EXTRACT_BYTES}-byte extraction limit`,
                );
            }
            chunks.push(buf);
        }
        return Buffer.concat(chunks);
    })();

    return Promise.race([collect, deadline]);
}

/**
 * Read the text of a stored file by its FileRecord id. Parses PDFs via
 * pdf-parse; returns other mime types' bytes as UTF-8 text (plain-text
 * reports). Returns null when the file can't be resolved.
 */
export async function getFileRecordText(
    db: FileReader,
    tenantId: string,
    fileId: string,
): Promise<string | null> {
    const file = await db.fileRecord.findFirst({
        where: { id: fileId, tenantId },
        select: {
            pathKey: true,
            mimeType: true,
            storageProvider: true,
            status: true,
            scanStatus: true,
        },
    });
    if (!file) return null;

    // Only fully-stored files have a byte stream worth reading. An UPLOADING
    // or QUARANTINED row has a pathKey but not necessarily an object behind
    // it. Matches the download gate in evidence.ts.
    if (file.status !== 'STORED') return null;

    // AV gate. Extraction feeds the document text to the AI extractor and
    // persists it for the reviewer, so a malicious payload here reaches both
    // a model prompt and a human surface — the same shared predicate the
    // evidence download path uses, not a local reimplementation.
    if (!isDownloadAllowed(file.scanStatus)) {
        throw forbidden(getBlockedReason(file.scanStatus));
    }

    // The row was fetched scoped to tenantId, but the pathKey it carries is
    // what actually addresses storage — and nothing so far has checked that
    // the two agree. A pathKey pointing at another tenant's prefix (bad
    // backfill, a bug in an upload path, a tampered row) would otherwise be
    // read straight out of the wrong bucket. This is the guard evidence.ts
    // and file.ts already apply before any storage operation.
    assertTenantKey(file.pathKey, tenantId);

    const provider = getProviderByName((file.storageProvider ?? 'local') as StorageProviderType);
    const buffer = await streamToBuffer(provider.readStream(file.pathKey));
    if (file.mimeType === 'application/pdf' || file.pathKey.toLowerCase().endsWith('.pdf')) {
        return extractPdfText(buffer);
    }
    return buffer.toString('utf-8');
}
