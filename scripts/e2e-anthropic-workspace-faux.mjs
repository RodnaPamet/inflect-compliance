#!/usr/bin/env node
/**
 * A faux Anthropic API for the `anthropic-workspace` end-to-end spec (Step 5a of
 * docs/claude-managed-agents-design.md).
 *
 * Started beside `next start` by the Playwright webServer list, on loopback
 * only, at the port `src/app-layer/integrations/providers/anthropic-workspace/
 * e2e-faux.ts` names. The provider dials it only in a Playwright run (both
 * NEXT_TEST_MODE and AUTH_TEST_MODE set); see that module for why production
 * cannot.
 *
 * It answers the ONE request the provider's Test makes, `GET /v1/agents`, as the
 * Managed Agents reference documents it, and nothing else:
 *
 *   - a request missing the version, the Managed Agents beta or the workspace
 *     header is a 400, so a provider that dropped one fails the spec;
 *   - key `sk-ant-e2e-valid` → 200, a page with no agents, and the RESPONSE
 *     header `anthropic-workspace-id` naming the workspace the request named;
 *   - key `sk-ant-e2e-other-workspace` → 200 naming a DIFFERENT workspace;
 *   - any other key → 401 `authentication_error`.
 *
 * Any other method or path is a 405 / 404 and is COUNTED. `GET /__faux/requests`
 * returns what it received (method and path only, never a header value), so the
 * spec can show that a Test sent one GET and wrote nothing.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3008);
const VALID = 'sk-ant-e2e-valid';
const OTHER_WORKSPACE = 'sk-ant-e2e-other-workspace';
/** Every request, by method and path, so the spec can assert nothing was written. */
const seen = [];

function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}
const apiError = (res, status, type, message) =>
    reply(res, status, { type: 'error', error: { type, message }, request_id: 'req_faux' });

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__faux/health') return reply(res, 200, { ok: true });
    if (url.pathname === '/__faux/requests') return reply(res, 200, { requests: seen });

    seen.push({ method: req.method, path: url.pathname });
    if (url.pathname !== '/v1/agents') return apiError(res, 404, 'not_found_error', 'not found');
    if (req.method !== 'GET') return apiError(res, 405, 'invalid_request_error', 'method not allowed');

    const workspace = req.headers['anthropic-workspace-id'];
    if (!req.headers['anthropic-version'] || req.headers['anthropic-beta'] !== 'managed-agents-2026-04-01' || !workspace) {
        return apiError(res, 400, 'invalid_request_error', 'missing header');
    }
    const key = req.headers['x-api-key'];
    if (key === VALID) {
        return reply(res, 200, { data: [], next_page: null }, { 'anthropic-workspace-id': String(workspace) });
    }
    if (key === OTHER_WORKSPACE) {
        return reply(res, 200, { data: [], next_page: null }, { 'anthropic-workspace-id': 'wrkspc_e2eSomeoneElse' });
    }
    return apiError(res, 401, 'authentication_error', 'invalid x-api-key');
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`[anthropic-workspace faux] listening on 127.0.0.1:${port}\n`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
