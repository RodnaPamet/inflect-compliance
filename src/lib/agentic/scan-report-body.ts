/**
 * Reading a scanner's signed report under the contract's byte cap, shared by
 * both ingest routes: the agent report (`…/admin/agents/harness-scans`) and the
 * third-party application report (`…/admin/agents/integration-scans`).
 *
 * The body is read through a byte-capped stream that ABORTS at the cap, rather
 * than read whole and measured: a length check after `req.text()` has already
 * allocated what it was meant to refuse. A declared `content-length` over the
 * cap is a free early refusal, never the check, since a chunked request carries
 * none.
 *
 * The refusal names the caller's prefix (`harness_report_refused`,
 * `third_party_app_report_refused`) and the contract's own code, `TOO_LARGE`,
 * or `NOT_JSON` for a request with no body at all.
 */
import { badRequest } from '@/lib/errors/types';

export async function readSignedReportBody(
    req: Request,
    maxBytes: number,
    refusalPrefix: string,
): Promise<string> {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw badRequest(`${refusalPrefix}: TOO_LARGE`);
    const reader = req.body?.getReader();
    if (!reader) throw badRequest(`${refusalPrefix}: NOT_JSON: empty body`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw badRequest(`${refusalPrefix}: TOO_LARGE`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
