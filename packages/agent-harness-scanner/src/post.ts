/**
 * Posting a signed report to the tenant's ingest — the scanner's only write,
 * and it is to Inflect, never to the estate (DPIA condition 4).
 *
 * The body is the serialised report, UNCHANGED: the signature covers the
 * canonical form of what is sent, so re-serialising here could only break it.
 * The route is fixed (`INGEST_PATH_TEMPLATE`), the base must be https, and a
 * redirect is refused — the request carries the API key.
 *
 * What comes back is reduced to what an operator needs: the status, and on a
 * refusal its CODE (`harness_report_refused: <CODE>`), never the body.
 */
import type { FetchLike } from './http';
import { INGEST_PATH_TEMPLATE } from './scanner-surface';

export interface PostResult {
    readonly ok: boolean;
    readonly status: number;
    /** The refusal code the ingest named, when it refused. */
    readonly refusal: string | null;
    /** From a 201: whether the ingest derived the scan as complete, and how many agents it holds. */
    readonly complete: boolean | null;
    readonly agentCount: number | null;
}

export function ingestUrl(baseUrl: string, tenantSlug: string): string {
    return `${new URL(baseUrl).origin}${INGEST_PATH_TEMPLATE.replace('{tenantSlug}', encodeURIComponent(tenantSlug))}`;
}

export async function postReport(opts: {
    readonly baseUrl: string;
    readonly tenantSlug: string;
    readonly apiKey: string;
    readonly raw: string;
    readonly fetchImpl: FetchLike;
    readonly timeoutMs?: number;
}): Promise<PostResult> {
    const url = ingestUrl(opts.baseUrl, opts.tenantSlug);
    if (new URL(url).protocol !== 'https:') throw new Error('the ingest must be reached over https');
    const res = await opts.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: opts.raw,
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    let text = '';
    try {
        text = (await res.text()).slice(0, 64 * 1024);
    } catch {
        text = '';
    }
    if (res.status === 201) {
        let body: { complete?: unknown; agentCount?: unknown } = {};
        try {
            body = JSON.parse(text) as typeof body;
        } catch {
            body = {};
        }
        return {
            ok: true,
            status: res.status,
            refusal: null,
            complete: typeof body.complete === 'boolean' ? body.complete : null,
            agentCount: typeof body.agentCount === 'number' ? body.agentCount : null,
        };
    }
    const code = /harness_report_refused: ([A-Z_]+)/.exec(text)?.[1] ?? null;
    return { ok: false, status: res.status, refusal: code, complete: null, agentCount: null };
}
