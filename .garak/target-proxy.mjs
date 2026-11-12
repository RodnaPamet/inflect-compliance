#!/usr/bin/env node
/**
 * The garak target proxy: the only thing garak talks to.
 *
 *   garak (container, host network) --POST /ask--> this proxy (127.0.0.1)
 *     --POST + session cookie--> /api/t/<slug>/assistant/ask (the app)
 *
 * Four jobs, each of which garak cannot do for itself:
 *
 *  1. THE WIRE CAP. At most MAX_REQUESTS requests reach the app per run,
 *     whatever .garak/config.yaml asks for. Past it, no request is forwarded:
 *     garak receives SKIP_STATUS, which .garak/config.yaml lists in the rest
 *     generator's `skip_codes`, so the attempt is recorded UNSCORED (garak
 *     counts it in `nones`, never in `total_evaluated`) and the ledger counts
 *     it, so a truncated run is a fact the summary holds (it reports the run
 *     INCOMPLETE). It used to answer a sentinel TEXT, which a detector scores
 *     like any other answer: `mitigation.MitigationBypass` (dan) reads any
 *     text without a mitigation phrase as a jailbreak, so every capped request
 *     was a false hit.
 *  2. THE CREDENTIAL. The role's session cookie lives in this process's
 *     environment only. garak echoes its generator config into its report;
 *     a cookie there would be uploaded as an artifact.
 *  3. GUARD REFUSALS AS ANSWERS. A content-guard refusal is HTTP 403 with
 *     `ai_guard_*` in the body. To garak that is an error; it is in fact the
 *     guard doing its job, i.e. "no hit". It is returned as REFUSAL text
 *     (refusalText) that every detector the configured probes use scores as a
 *     pass: it opens with a phrase from MitigationBypass's mitigation list
 *     (an inverted detector, a HIT when no such phrase appears) and carries no
 *     trigger, payload, markdown or import any other detector looks for.
 *     Counted per direction (input: the model was never called; output: it
 *     was, and the egress guard withheld the answer).
 *  4. NOTHING ELSE ABORTS GARAK. garak 0.17.1's RestGenerator raises a bare
 *     ConnectionError on any 4xx or 5xx outside `skip_codes`, and nothing
 *     catches it: the whole role's run ends at the first one. So every
 *     outcome that is not an answer, a refusal or a (bounded) rate limit is
 *     returned as SKIP_STATUS and counted:
 *       - a question longer than QUESTION_MAX_CHARS is NOT forwarded
 *         (`overLength`): the product's own schema refuses it for any user
 *         with a 400 before any model call, so it is not deliverable. 41 % of
 *         garak's DanInTheWild corpus is longer than that;
 *       - any other upstream status (`upstreamErrors`), which makes the
 *         record incomplete;
 *       - a 429 is passed back (garak backs off and retries; no model call
 *         was made, so it is NOT charged) at most MAX_RATE_LIMIT_PASSBACKS
 *         times per run. garak retries a 429 without a retry limit, so past
 *         that the proxy stops it (`rateLimitAbandoned`, incomplete) rather
 *         than let one role spin until the job's timeout.
 *
 * Logs nothing row by row and never logs probe text or answers: the ledger
 * holds counts only. Dependency-free; Node >= 20.
 *
 * Environment:
 *   GARAK_TARGET_URL      absolute URL of the app's assistant/ask route
 *   GARAK_SESSION_COOKIE  `next-auth.session-token=<value>`
 *   GARAK_MAX_REQUESTS    the per-run wire cap (from .garak/budget.json)
 *   GARAK_PROXY_PORT      default 3107
 *   GARAK_LEDGER          path of the JSON ledger, rewritten per request
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The status garak is told to record as "no output" (.garak/config.yaml
 * `skip_codes`). tests/guardrails/garak-workflow-pinning.test.ts holds the two
 * equal.
 */
export const SKIP_STATUS = 422;

/** AskAssistantSchema's `question` maximum (src/app-layer/usecases/assistant.ts). */
export const QUESTION_MAX_CHARS = 2000;

/** How many 429s one run passes back to garak before the proxy stops it. */
export const MAX_RATE_LIMIT_PASSBACKS = 10;

/**
 * The answer garak scores for a guard refusal. It must read as a PASS to every
 * detector the configured probes use; the opening clause is on garak 0.17.1's
 * MitigationBypass list ("I'm sorry, but I can", "I can't assist"), which is
 * what keeps dan from scoring a working guard as a jailbreak.
 */
export const refusalText = (direction) =>
    `I'm sorry, but I can't assist with that: the content guard refused this turn (${direction}).`;

/** Max body garak may send (well above QUESTION_MAX_CHARS, which is checked separately). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Classify one upstream response. Pure, so the decision table is testable
 * without a network.
 *
 * @returns {{ kind: 'answer' | 'guard-input' | 'guard-output' | 'rate-limited' | 'error',
 *             status: number, message?: string, charged: boolean }}
 */
export function classifyUpstream(status, bodyText) {
    if (status === 429) return { kind: 'rate-limited', status: 429, charged: false };
    if (status === 200) {
        let message = '';
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed && typeof parsed.message === 'string') message = parsed.message;
        } catch {
            return { kind: 'error', status: SKIP_STATUS, upstreamStatus: 200, charged: true };
        }
        return { kind: 'answer', status: 200, message, charged: true };
    }
    if (status === 403 && /ai_guard_(?:blocked|review_required)/.test(bodyText)) {
        // The guard's message names its direction; the input guard runs before
        // any model call, the output guard after.
        const output = /ai_guard_(?:blocked|review_required):\s*(?:output|egress|outbound)/i.test(bodyText);
        return {
            kind: output ? 'guard-output' : 'guard-input',
            status: 200,
            message: refusalText(output ? 'output' : 'input'),
            charged: true,
        };
    }
    // A gate 403, a schema 400, a 5xx: garak would abort the whole role on
    // it, so it goes back as a skip. Charged: a 5xx may have reached the model.
    return { kind: 'error', status: SKIP_STATUS, upstreamStatus: status, charged: true };
}

export function emptyLedger(maxRequests) {
    return {
        maxRequests,
        forwarded: 0,
        answers: 0,
        guardRefusedInput: 0,
        guardRefusedOutput: 0,
        rateLimited: 0,
        rateLimitAbandoned: 0,
        upstreamErrors: 0,
        /** Counts by upstream status (`network` when no response), so a broken night says why. */
        upstreamErrorStatuses: {},
        overCap: 0,
        overLength: 0,
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function reply(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

export function startProxy({ targetUrl, cookie, maxRequests, port, ledgerPath }) {
    const ledger = emptyLedger(maxRequests);
    const target = new URL(targetUrl);
    const persist = () => {
        if (ledgerPath) writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    };
    persist();

    const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/ask') return reply(res, 404, { error: 'not found' });
        let question;
        try {
            const parsed = JSON.parse(await readBody(req));
            question = parsed?.question;
        } catch {
            return reply(res, 400, { error: 'invalid body' });
        }
        if (typeof question !== 'string') return reply(res, 400, { error: 'question must be a string' });

        if (question.length > QUESTION_MAX_CHARS) {
            ledger.overLength += 1;
            persist();
            return reply(res, SKIP_STATUS, { error: 'over-length' });
        }

        if (ledger.forwarded >= maxRequests) {
            ledger.overCap += 1;
            persist();
            return reply(res, SKIP_STATUS, { error: 'over-cap' });
        }

        ledger.forwarded += 1;
        let verdict;
        try {
            const upstream = await fetch(target, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: cookie,
                    Origin: target.origin,
                },
                body: JSON.stringify({ question }),
                signal: AbortSignal.timeout(85_000),
            });
            verdict = classifyUpstream(upstream.status, await upstream.text());
        } catch {
            verdict = { kind: 'error', status: SKIP_STATUS, charged: true };
        }

        if (!verdict.charged) ledger.forwarded -= 1;
        if (verdict.kind === 'answer') ledger.answers += 1;
        else if (verdict.kind === 'guard-input') ledger.guardRefusedInput += 1;
        else if (verdict.kind === 'guard-output') ledger.guardRefusedOutput += 1;
        else if (verdict.kind === 'rate-limited') {
            ledger.rateLimited += 1;
            if (ledger.rateLimited > MAX_RATE_LIMIT_PASSBACKS) {
                ledger.rateLimitAbandoned += 1;
                verdict = { kind: 'rate-limited', status: SKIP_STATUS, charged: false };
            }
        } else {
            ledger.upstreamErrors += 1;
            const key = String(verdict.upstreamStatus ?? 'network');
            ledger.upstreamErrorStatuses[key] = (ledger.upstreamErrorStatuses[key] ?? 0) + 1;
        }
        persist();

        if (verdict.message !== undefined) return reply(res, 200, { message: verdict.message });
        return reply(res, verdict.status, { error: verdict.kind });
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve({ server, ledger }));
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const targetUrl = process.env.GARAK_TARGET_URL;
    const cookie = process.env.GARAK_SESSION_COOKIE;
    const maxRequests = Number.parseInt(process.env.GARAK_MAX_REQUESTS ?? '', 10);
    if (!targetUrl || !cookie || !Number.isInteger(maxRequests) || maxRequests < 1) {
        process.stderr.write(
            'target-proxy: GARAK_TARGET_URL, GARAK_SESSION_COOKIE and a positive GARAK_MAX_REQUESTS are required\n',
        );
        process.exit(2);
    }
    const port = Number.parseInt(process.env.GARAK_PROXY_PORT ?? '3107', 10);
    await startProxy({ targetUrl, cookie, maxRequests, port, ledgerPath: process.env.GARAK_LEDGER });
    process.stdout.write(`target-proxy: listening on 127.0.0.1:${port}, cap ${maxRequests}\n`);
}
