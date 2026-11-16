#!/usr/bin/env node
/**
 * The metering proxy: the ONLY way an evaluation job's own model calls reach
 * Anthropic (Ragas Phase 1, docs/ai-architecture/ragas.md; the cost meter is
 * sub-phase 0.6, shared with garak).
 *
 * A job's judge (Ragas's Python client) is pointed at this proxy on
 * 127.0.0.1 and never holds the key: the proxy holds it, and it checks every
 * call against the job's SHARE of the USD 5 nightly cap (D-EV-1, D-EV-2,
 * D-EV-11) BEFORE it is sent, with `meter.mjs` — the same reservation garak's
 * between-role breaker is priced by. So "hard-capped" is a property of the
 * only socket the judge has, not of the judge's own good behaviour.
 *
 * ‾‾‾ WHAT IT CHECKS, PER CALL ‾‾‾
 *
 *   • the request is POST /v1/messages, JSON, not streamed (a streamed answer's
 *     usage arrives last, after the money is spent);
 *   • the model is the share's model (`shares.json`): a call to an unpriced or
 *     other model is refused, never metered as something cheaper;
 *   • `max_tokens` is present and at most the proxy's cap (2048 by default):
 *     the reservation needs a worst case, and an absent one has none;
 *   • the reservation fits: input is bounded by the request body's UTF-8 BYTE
 *     length (a token covers at least one byte, and the body carries every
 *     prompt byte plus its JSON syntax, tool schemas included), output by
 *     `max_tokens`. A call that could pass the share is answered 402
 *     `budget_exhausted` and never sent; from then on the run is
 *     BUDGET_EXHAUSTED and every later call is refused too.
 *
 * After the upstream answers, the reservation settles to the usage the vendor
 * reported (cache tokens counted at the input price — over, never under), or
 * keeps the worst case when there is none: a network failure, an unreadable
 * body, a 5xx. An unknown cost is never read as a small one.
 *
 * 402 is chosen because the Anthropic SDK does not retry it (it retries 408,
 * 409, 429 and 5xx): a refusal that the client re-sent would be refused again,
 * but the job would read three refusals as three calls.
 *
 * ‾‾‾ SPEND THE JOB MAKES ELSEWHERE ‾‾‾
 *
 * A model call the job causes but does not send itself (the product answering
 * a question, Ragas Phase 1.2) is metered through the same share with
 * `POST /meter/reserve` before it and `POST /meter/settle` after it, so the
 * judge and the answers can never together pass the job's share.
 *
 * `GET /meter/state` is what the record's `spendUsd` and `status` are read
 * from, with the price table's hash.
 *
 * Run:  COST_METER_JOB=ragas ANTHROPIC_API_KEY=… node evals/cost-meter/anthropic-proxy.mjs
 * Env:  COST_METER_PORT (default 8787), COST_METER_MAX_OUTPUT_TOKENS (2048),
 *       ANTHROPIC_WORKSPACE_ID (sent as anthropic-workspace-id when set: the
 *       repository's organisation-level key needs it; see
 *       docs/implementation-notes/2026-10-17-anthropic-workspace-header.md).
 * It listens on 127.0.0.1 only and logs counts and reasons, never a prompt.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createMeter, jobBudget, loadPriceTable, loadShares } from './meter.mjs';

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';
/** Headers a client may pass through; everything else (any credential) is dropped. */
const PASSED_HEADERS = ['anthropic-version', 'anthropic-beta'];

function send(res, status, body, extra = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
}

function refuse(res, status, type, message) {
    send(res, status, { type: 'error', error: { type, message } }, { 'x-cost-meter': type });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('body too large'), { tooLarge: true }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** The vendor's reported usage as the meter reads it, or null when there is none to read. */
export function usageOf(body) {
    const u = body?.usage;
    if (!u || typeof u !== 'object') return null;
    const n = (v) => (v === undefined || v === null ? 0 : v);
    const input = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    return { inputTokens: input, outputTokens: u.output_tokens };
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * Build the proxy for one job's share. `fetchImpl` and `upstream` are the test
 * seams; production passes neither.
 */
export function createProxy({
    job,
    apiKey,
    workspaceId = '',
    upstream = ANTHROPIC_UPSTREAM,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    fetchImpl = fetch,
    shares = loadShares(),
    priceTable = loadPriceTable(),
    log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
    if (!apiKey) throw new Error('anthropic-proxy: no API key');
    const { shareUsd, model, price } = jobBudget(shares, priceTable.table, job);
    const meter = createMeter({ shareUsd, price });
    const counts = { calls: 0, refused: 0, upstreamErrors: 0, overran: 0, external: 0 };

    function state() {
        return {
            job,
            model,
            shareUsd,
            priceTableHash: priceTable.hash,
            spentUsd: meter.spentUsd(),
            reservedUsd: meter.reservedUsd(),
            openReservations: meter.openReservations(),
            status: meter.status(),
            ...counts,
        };
    }

    async function messages(req, res) {
        let raw;
        try {
            raw = await readBody(req);
        } catch (err) {
            return refuse(res, 413, 'request_too_large', err.tooLarge ? 'body over the proxy cap' : 'unreadable body');
        }
        let body;
        try {
            body = JSON.parse(raw.toString('utf-8'));
        } catch {
            return refuse(res, 400, 'invalid_request_error', 'body is not JSON');
        }
        if (body.stream === true) return refuse(res, 400, 'invalid_request_error', 'streamed calls are not metered; send stream:false');
        if (body.model !== model) return refuse(res, 400, 'model_not_in_share', `this job's share prices ${model} only`);
        if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxOutputTokens) {
            return refuse(res, 400, 'invalid_request_error', `max_tokens must be an integer in 1..${maxOutputTokens}`);
        }
        const reservation = meter.reserve({ inputTokens: raw.length, maxOutputTokens: body.max_tokens });
        if (!reservation.ok) {
            counts.refused += 1;
            log(`anthropic-proxy: refused a call worth up to USD ${reservation.worstCaseUsd}; USD ${reservation.remainingUsd} of ${shareUsd} left`);
            return refuse(res, 402, 'budget_exhausted', `the ${job} share of USD ${shareUsd} cannot fit this call`);
        }
        counts.calls += 1;
        const headers = {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': req.headers['anthropic-version'] ?? ANTHROPIC_VERSION,
        };
        for (const h of PASSED_HEADERS) if (h !== 'anthropic-version' && req.headers[h]) headers[h] = req.headers[h];
        if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;

        let status = 502;
        let text = '';
        let usage = null;
        try {
            const upstreamRes = await fetchImpl(`${upstream}/v1/messages`, { method: 'POST', headers, body: raw });
            status = upstreamRes.status;
            text = await upstreamRes.text();
            if (status >= 200 && status < 300) {
                try {
                    usage = usageOf(JSON.parse(text));
                } catch {
                    usage = null;
                }
            } else if (status < 500) {
                // A 4xx is an answer the vendor did not bill as a completion;
                // its usage, when present, is what it billed.
                try {
                    usage = usageOf(JSON.parse(text));
                } catch {
                    usage = null;
                }
                if (usage === null) usage = { inputTokens: 0, outputTokens: 0 };
            }
        } catch {
            counts.upstreamErrors += 1;
            text = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: 'the model endpoint did not answer' } });
        }
        // A missing or unreadable usage keeps the worst case (meter.settle).
        const settled = meter.settle(reservation.id, usage !== null && isCount(usage.inputTokens) && isCount(usage.outputTokens) ? usage : null);
        if (settled.overran) counts.overran += 1;
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
    }

    async function external(req, res, kind) {
        let body;
        try {
            body = JSON.parse((await readBody(req)).toString('utf-8'));
        } catch {
            return send(res, 400, { ok: false, reason: 'INVALID' });
        }
        if (kind === 'reserve') {
            if (!isCount(body?.inputTokens) || !isCount(body?.maxOutputTokens)) return send(res, 400, { ok: false, reason: 'INVALID' });
            const r = meter.reserve({ inputTokens: body.inputTokens, maxOutputTokens: body.maxOutputTokens });
            if (!r.ok) {
                counts.refused += 1;
                return send(res, 402, r);
            }
            counts.external += 1;
            return send(res, 200, r);
        }
        try {
            const usage = body?.usage && isCount(body.usage.inputTokens) && isCount(body.usage.outputTokens) ? body.usage : null;
            return send(res, 200, meter.settle(body?.id, usage));
        } catch (err) {
            return send(res, 400, { ok: false, reason: 'NO_SUCH_RESERVATION', message: err.message });
        }
    }

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'POST' && url.pathname === '/v1/messages') return void messages(req, res);
        if (req.method === 'POST' && url.pathname === '/meter/reserve') return void external(req, res, 'reserve');
        if (req.method === 'POST' && url.pathname === '/meter/settle') return void external(req, res, 'settle');
        if (req.method === 'GET' && url.pathname === '/meter/state') return send(res, 200, state());
        return refuse(res, 404, 'not_found', 'the proxy serves POST /v1/messages and the meter routes only');
    });
    return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const job = process.env.COST_METER_JOB;
    const port = Number(process.env.COST_METER_PORT ?? 8787);
    const { server, state } = createProxy({
        job,
        apiKey: process.env.ANTHROPIC_API_KEY,
        workspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? '',
        maxOutputTokens: Number(process.env.COST_METER_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS),
    });
    server.listen(port, '127.0.0.1', () => {
        const s = state();
        process.stderr.write(`anthropic-proxy: ${job} on 127.0.0.1:${port}, model ${s.model}, share USD ${s.shareUsd}, prices ${s.priceTableHash}\n`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
