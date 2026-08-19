#!/usr/bin/env node
/**
 * HTTP/2 front door for the E2E harness.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Production terminates TLS at Caddy with `protocols h1 h2 h3`
 * (deploy/caddy/Caddyfile). The E2E harness ran `next start` directly over
 * plain HTTP — so the one tier we gate merges on was the only tier speaking
 * HTTP/1.1, and HTTP/1.1 caps browsers at SIX connections per origin.
 *
 * That gap is not academic. The sidebar deliberately forces a full-RSC
 * prefetch of 14 force-dynamic routes (nav-item.tsx), and opening the mobile
 * drawer puts all 14 links in the viewport at once. Through six sockets those
 * queue, `waitForLoadState('networkidle')` never settles, and every test that
 * visits the page burns its full 180s timeout. Upstream describes the same
 * mechanism: vercel/next.js#96109.
 *
 * The app was fine. The harness was testing a transport the product never
 * uses. HTTP/2 multiplexes over ONE connection, so the burst stops mattering
 * — which is what production has always done.
 *
 * ═══ WHY A NODE SCRIPT AND NOT CADDY ═══
 *
 * Caddy is not installed on GitHub runners and would need a download step
 * plus a version to pin. `node:http2` is built in, so this behaves identically
 * on a laptop and in CI with nothing to install. `openssl` (present on the
 * runner images and virtually every dev machine) generates the throwaway cert.
 *
 * ═══ THE CERT ═══
 *
 * Self-signed, generated on first run into a gitignored cache dir, valid for
 * localhost only. It is NOT committed: a private key in the tree would trip
 * scripts/detect-secrets.sh, and rightly so. Playwright sets
 * `ignoreHTTPSErrors: true`; nothing else should ever trust it.
 */
import { spawnSync } from 'node:child_process';
import { createSecureServer } from 'node:http2';
import { request as httpRequest } from 'node:http';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = resolve(ROOT, 'node_modules/.cache/e2e-tls');
const KEY = resolve(CERT_DIR, 'key.pem');
const CRT = resolve(CERT_DIR, 'cert.pem');

const LISTEN = Number(process.env.E2E_HTTPS_PORT || 3006);
const UPSTREAM = Number(process.env.E2E_UPSTREAM_PORT || 3007);

/** Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function ensureCert() {
    if (existsSync(KEY) && existsSync(CRT)) return;
    mkdirSync(CERT_DIR, { recursive: true });
    const r = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', KEY, '-out', CRT, '-days', '3650',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'pipe' });
    if (r.status !== 0) {
        throw new Error(`openssl failed to generate the E2E cert:\n${r.stderr?.toString() ?? ''}`);
    }
    console.log(`[e2e-http2] generated a throwaway localhost cert in ${CERT_DIR}`);
}

ensureCert();

const server = createSecureServer({
    key: readFileSync(KEY),
    cert: readFileSync(CRT),
    // Keep HTTP/1.1 working too. The point is to make h2 AVAILABLE, matching
    // production's `h1 h2 h3` — not to forbid h1.
    allowHTTP1: true,
});

server.on('request', (req, res) => {
    // Strip HTTP/2 pseudo-headers (:method, :path, :scheme, :authority) and
    // hop-by-hop headers; node's compat layer exposes pseudo-headers with a
    // leading colon, which an HTTP/1.1 upstream would reject.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith(':') || HOP_BY_HOP.has(k)) continue;
        headers[k] = v;
    }
    headers.host = `127.0.0.1:${UPSTREAM}`;
    // Tell the app it was reached over https, so absolute-URL and secure-cookie
    // logic sees what production sees.
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = `localhost:${LISTEN}`;

    const upstream = httpRequest(
        { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers },
        (up) => {
            const out = {};
            for (const [k, v] of Object.entries(up.headers)) {
                if (HOP_BY_HOP.has(k)) continue;
                out[k] = v;
            }
            res.writeHead(up.statusCode || 502, out);
            up.pipe(res);
        },
    );

    upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`e2e-http2 proxy: upstream error: ${err.message}`);
    });

    req.pipe(upstream);
});

server.on('sessionError', (err) => console.warn('[e2e-http2] session error:', err.message));

server.listen(LISTEN, () => {
    console.log(`[e2e-http2] https://localhost:${LISTEN} (h2 + h1) → http://127.0.0.1:${UPSTREAM}`);
});
