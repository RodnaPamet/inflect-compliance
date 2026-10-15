/**
 * A real socket in front of the reference `inflect-legacy-access/1` server.
 *
 * ─── WHY THIS EXISTS (#3578) ───────────────────────────────────────────────
 *
 * Phases 1–6 of the recertification pipeline have never spoken to anything over
 * a network. The contract has exactly one implementation —
 * `tests/helpers/legacy-mcp-fake-server.ts` — and it says of itself:
 *
 *   > IN-PROCESS, Web `Request` to `Response`. No port is opened and nothing is
 *   > listening: the handler is passed to the Step 1b client as its injected
 *   > `fetch`, which is the only seam that client has. Production code never
 *   > passes one.
 *
 * So the client has been exercised only through a seam production does not use.
 * This opens a port in front of that same handler, so the production path —
 * `safeFetch`, address resolution, TLS, the handshake, the manifest read,
 * paging — runs for the first time against something real.
 *
 * ─── WHAT IT PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 *
 * PROVES: the wire. Whether our client can hold a session, page a snapshot and
 * persist it when the bytes cross a socket, through the real egress rules.
 *
 * DOES NOT PROVE: the contract against a real application. The rows are the
 * reference fixture's seven synthetic accounts. Implementing the contract over
 * a real HR database is a separate and larger piece of work, and the appendix in
 * `docs/legacy-access-recertification-phases.md` must keep saying so.
 *
 * ─── IT IS NOT PRODUCTION CODE ─────────────────────────────────────────────
 *
 * Deliberately absent from `scripts/build-worker.mjs`, so no production build
 * bundles it. It is bundled ad hoc for a run and removed afterwards — the same
 * handling as the #3577 backfill.
 *
 * A BEARER TOKEN IS ENFORCED HERE, not by the reference server, which ignores
 * `Authorization` entirely. That is correct of the reference — the contract
 * leaves authentication to the operator — but this one listens on a public
 * hostname, so an endpoint that answered anybody would be wrong even for
 * synthetic rows. It also exercises the client's credential path, which an
 * open endpoint would not.
 *
 * Usage (on the VM, inside a container that has node):
 *   PROVING_TOKEN=<token> PROVING_PORT=8099 node proving-legacy-mcp.mjs
 */

import { createServer } from 'node:http';

import { createLegacyMcpFakeServer } from '../tests/helpers/legacy-mcp-fake-server';

const PORT = Number(process.env.PROVING_PORT ?? 8099);
const TOKEN = process.env.PROVING_TOKEN ?? '';
if (!TOKEN) {
    console.error('PROVING_TOKEN is required — this listens on a public hostname');
    process.exit(1);
}

// Seven accounts over pages of three, the reference defaults: enough to force
// real paging (3 + 3 + 1) and small enough that a human can read the result.
const fake = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });

const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const ok = auth === `Bearer ${TOKEN}`;

    // The request log, so the run can be inspected afterwards — specifically
    // that no `tools/*` call was ever sent, which is a contract property the
    // in-process tests assert and which nobody has checked over a socket.
    if (req.method === 'GET' && req.url === '/__requests') {
        if (!ok) {
            res.writeHead(401).end('unauthorised');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify(
                { requests: fake.requests, snapshotId: fake.snapshotId(), columns: fake.columns() },
                null,
                2,
            ),
        );
        return;
    }

    if (!ok) {
        // 401 before the body is read: a wrong token must not reach the handler.
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorised');
        return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }

    const request = new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
    });

    try {
        const response = await fake.fetch(request);
        const out = Buffer.from(await response.arrayBuffer());
        const h: Record<string, string> = {};
        response.headers.forEach((v, k) => {
            h[k] = v;
        });
        res.writeHead(response.status, h).end(out);
    } catch (e) {
        console.error('handler threw:', e instanceof Error ? e.message : String(e));
        res.writeHead(500, { 'content-type': 'text/plain' }).end('handler error');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`proving-run legacy-mcp reference server listening on :${PORT}`);
    console.log(`  accounts: 7   rowsPerPage: 3   snapshotId: ${fake.snapshotId()}`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
        console.log(`\nrequests received: ${fake.requests.length}`);
        for (const r of fake.requests) {
            console.log(`  ${r.method} ${r.uri ?? ''} session=${r.sessionId ?? '-'} proto=${r.protocolVersion ?? '-'}`);
        }
        server.close(() => process.exit(0));
    });
}
