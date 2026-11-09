/**
 * THE SCANNER'S EGRESS PROXY — the only way out of its network (#5004 part C;
 * owner decision 4 of 2026-11-08).
 *
 * In the VM overlay the scanner sits on an INTERNAL Docker network with no
 * route out. This proxy is the one container on both that network and one that
 * reaches the internet, and it forwards exactly one thing: a CONNECT tunnel to
 * a host on its allowlist, on port 443. Everything else is refused:
 *
 *   • a CONNECT to any other host, any other port, or an IP literal — 403;
 *   • any plain HTTP request, absolute-form or not — 405: the scanner speaks
 *     only https, so a proxy that relayed cleartext would be a second, wider
 *     door beside the first;
 *   • a malformed target — 400.
 *
 * The allowlist is EXACT hostnames, lower-cased, from `EGRESS_ALLOW`
 * (comma-separated). No wildcard and no suffix match: `*.example.com` would
 * admit any host somebody can create under it. An empty or missing allowlist
 * refuses everything, so a proxy started without its configuration fails
 * CLOSED.
 *
 * It decides on the CONNECT line, before any byte of the tunnel, and never sees
 * inside it: TLS runs end to end between the scanner and the host. So it logs
 * what it decided — host, port, allowed or refused — and can log nothing else,
 * because it holds nothing else.
 *
 * It ships in the scanner's own image and runs from the same pinned digest
 * (`deploy/docker-compose.harness-scanner.yml`), so the proxy is the reviewed
 * code beside the scanner, not a third-party image with its own supply chain.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { jsonLineLog, type ScannerLog } from './log';

/** The one port a tunnel may name: the scanner speaks https and nothing else. */
export const EGRESS_PORT = 443;
/** Where the proxy listens inside its container. */
export const EGRESS_PROXY_LISTEN_PORT = 3128;

/** A hostname as DNS allows it, lower-case: labels of letters, digits and hyphens. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** `EGRESS_ALLOW` to the set of exact hostnames it names. Anything not a plain hostname is refused. */
export function parseEgressAllowlist(value: string | undefined): ReadonlySet<string> {
    const hosts = new Set<string>();
    for (const raw of (value ?? '').split(',')) {
        const host = raw.trim().toLowerCase();
        if (host === '') continue;
        if (!HOSTNAME.test(host) || isIP(host) !== 0) {
            throw new Error(`EGRESS_ALLOW names something that is not a hostname: ${JSON.stringify(raw.trim())}`);
        }
        hosts.add(host);
    }
    return hosts;
}

export type EgressDecision =
    | { readonly allowed: true; readonly host: string; readonly port: number }
    | { readonly allowed: false; readonly status: 400 | 403; readonly reason: string; readonly host: string | null };

/** The decision for one CONNECT target (`host:port`), against the allowlist. Pure. */
export function decideConnect(target: string | undefined, allow: ReadonlySet<string>): EgressDecision {
    const m = /^([^:\s/@]+):(\d{1,5})$/.exec(target ?? '');
    if (m === null) return { allowed: false, status: 400, reason: 'MALFORMED_TARGET', host: null };
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    if (isIP(host) !== 0) return { allowed: false, status: 403, reason: 'IP_LITERAL', host };
    if (port !== EGRESS_PORT) return { allowed: false, status: 403, reason: 'PORT_NOT_ALLOWED', host };
    if (!allow.has(host)) return { allowed: false, status: 403, reason: 'HOST_NOT_ALLOWED', host };
    return { allowed: true, host, port };
}

export interface EgressProxyOptions {
    readonly allow: ReadonlySet<string>;
    readonly log?: ScannerLog;
    /** Opens the upstream connection. A TEST SEAM: production dials the host. */
    readonly dial?: (host: string, port: number) => Socket;
}

function refuse(socket: Duplex, status: 400 | 403 | 405 | 502, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createEgressProxy(opts: EgressProxyOptions): Server {
    const log = opts.log ?? jsonLineLog();
    const dial = opts.dial ?? ((host: string, port: number) => connect({ host, port }));
    const server = createServer((req, res) => {
        // Cleartext forwarding is never offered.
        log.warn('egress refused', { reason: 'NOT_CONNECT', method: String(req.method ?? '') });
        res.writeHead(405, { Connection: 'close', 'Content-Length': '0' }).end();
    });
    server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
        const decision = decideConnect(req.url, opts.allow);
        if (!decision.allowed) {
            log.warn('egress refused', { reason: decision.reason, host: decision.host });
            refuse(client, decision.status, decision.status === 400 ? 'Bad Request' : 'Forbidden');
            return;
        }
        const upstream = dial(decision.host, decision.port);
        let established = false;
        upstream.once('connect', () => {
            established = true;
            log.info('egress allowed', { host: decision.host, port: decision.port });
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.once('error', () => {
            log.warn('egress upstream failed', { host: decision.host });
            // Before the tunnel opened, the client is owed an answer; after,
            // the bytes are TLS and a status line would corrupt them.
            if (!established && client.writable) refuse(client, 502, 'Bad Gateway');
            else client.destroy();
        });
        client.once('error', () => upstream.destroy());
        client.once('close', () => upstream.destroy());
    });
    return server;
}

if (require.main === module) {
    const log = jsonLineLog();
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
        process.once(signal, () => process.exit(code));
    }
    const allow = parseEgressAllowlist(process.env.EGRESS_ALLOW);
    // An empty allowlist is not an error the proxy can recover from: it would
    // refuse every tunnel. Say so at start rather than at the scanner's first
    // read, and keep running — refusing everything is the safe state.
    if (allow.size === 0) log.warn('egress allowlist is empty: every tunnel will be refused');
    createEgressProxy({ allow, log }).listen(EGRESS_PROXY_LISTEN_PORT, () => {
        log.info('egress proxy listening', { port: EGRESS_PROXY_LISTEN_PORT, hosts: [...allow].sort().join(',') });
    });
}
