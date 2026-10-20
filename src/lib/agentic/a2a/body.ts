/**
 * Reading an inbound A2A body under its cap (#3679, I1 D), shared by both inbound
 * routes (#3742): the per-tenant one and the per-peer one kept for peers already
 * given it.
 *
 * Refused on a declared `content-length` and again while streaming, so an
 * oversized task is never buffered whole.
 */
import { A2A_MAX_BODY_BYTES } from './protocol';

export type CappedBody = { readonly ok: true; readonly body: string } | { readonly ok: false };

export async function readA2aBody(req: Request, cap: number = A2A_MAX_BODY_BYTES): Promise<CappedBody> {
    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) return { ok: false };
    const stream = req.body;
    if (!stream) return { ok: true, body: '' };
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            return { ok: false };
        }
        out += decoder.decode(value, { stream: true });
    }
    return { ok: true, body: out + decoder.decode() };
}
