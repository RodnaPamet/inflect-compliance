/**
 * Drain a PDFKit document into a Buffer.
 *
 * ─── WHY THIS IS A MODULE AND NOT A LOCAL FUNCTION ──────────────────────
 *
 * The listeners MUST be attached before `doc.end()` is called. PDFKit begins
 * emitting as soon as the document ends, so a copy that ends the document
 * first silently resolves to a short or empty Buffer — and an empty Buffer
 * still writes a FileRecord, still hashes, and still reads as a successful
 * close. The failure is invisible at every layer above it.
 *
 * Four private copies of this function already existed when Step 5a needed a
 * fifth. The two access-review usecases now share this one, which is the
 * domain the step touches; the three route-level copies in
 * `policies/[id]/export`, `processes/[id]/export-pdf` and
 * `reports/pdf/generate` are untouched, because migrating them is unrelated
 * to this step and would widen an authorisation diff into a refactor.
 */
export function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        // Attached above, ended here — in this order, always.
        doc.end();
    });
}
