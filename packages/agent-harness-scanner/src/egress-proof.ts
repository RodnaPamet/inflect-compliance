/**
 * EACH SCAN PROVES ITS OWN EGRESS (#5004 part C; owner decision 4 of
 * 2026-11-08).
 *
 * `H3.egress_enforced` asks whether the agent's outbound network is enforced
 * against an allowlist, with evidence. For the scanner the evidence is taken
 * fresh, by the scan itself, before any source reads, from inside the
 * container that does the reading:
 *
 *   1. the scanner's own requests go through the proxy — `HTTPS_PROXY` names
 *      the configured proxy and `NODE_USE_ENV_PROXY=1` makes Node's fetch
 *      honour it;
 *   2. the proxy ADMITS an allowlisted host: a CONNECT to the Inflect host the
 *      report is posted to answers 200;
 *   3. the proxy REFUSES a host off the list: a CONNECT to the configured
 *      canary answers 403;
 *   4. there is no way AROUND the proxy: a direct TCP connection to that same
 *      allowlisted host fails.
 *
 * Met only when all four hold, in one expression. The fourth is the one a
 * proxy alone cannot show: a proxy that refuses the canary proves nothing if
 * the scanner could simply not use it. Each check is a connection opened and
 * closed — no request is sent through a tunnel, and nothing is read from one.
 *
 * The verdict is about THIS program's container, so it is reported on the
 * scanner's own agent only (`inflect-register`'s self-verdicts).
 */
import { request } from 'node:http';
import { connect } from 'node:net';

import { EGRESS_PORT } from './egress-proxy';

export type Env = Readonly<Record<string, string | undefined>>;

/** How a proof reaches the network. Production dials; the tests substitute both. */
export interface EgressProbe {
    /** A CONNECT to `target` (`host:port`) through the proxy: the status it answered, or 0 if none. */
    connectThrough(proxy: URL, target: string, timeoutMs: number): Promise<number>;
    /** Whether a direct TCP connection to `host:port` opened. */
    dialDirect(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

export interface EgressProofOptions {
    /** The proxy the scanner is configured to go through, `http://<host>:<port>`. */
    readonly proxyUrl: string;
    /** A host the allowlist must admit: the Inflect host the report goes to. */
    readonly allowedHost: string;
    /** A host the allowlist must refuse. */
    readonly canaryHost: string;
    readonly env: Env;
    readonly probe?: EgressProbe;
    readonly timeoutMs?: number;
}

export type EgressProofFailure = 'ENV_PROXY_NOT_SET' | 'ALLOWED_HOST_REFUSED' | 'CANARY_NOT_REFUSED' | 'DIRECT_EGRESS_OPEN';

export interface EgressProof {
    readonly met: boolean;
    /** What was observed, for the verdict's evidence pointer. Hosts and outcomes only. */
    readonly evidence: string;
    readonly failed: EgressProofFailure | null;
}

export const nodeEgressProbe: EgressProbe = {
    connectThrough(proxy, target, timeoutMs) {
        return new Promise((resolve) => {
            const req = request({
                host: proxy.hostname,
                port: Number(proxy.port || 80),
                method: 'CONNECT',
                path: target,
                timeout: timeoutMs,
            });
            const done = (status: number) => {
                req.destroy();
                resolve(status);
            };
            // Node raises `connect` for the CONNECT answer whatever its status.
            req.once('connect', (res, socket) => {
                socket.destroy();
                done(res.statusCode ?? 0);
            });
            req.once('response', (res) => done(res.statusCode ?? 0));
            req.once('timeout', () => done(0));
            req.once('error', () => done(0));
            req.end();
        });
    },
    dialDirect(host, port, timeoutMs) {
        return new Promise((resolve) => {
            const socket = connect({ host, port });
            const done = (opened: boolean) => {
                socket.destroy();
                resolve(opened);
            };
            socket.setTimeout(timeoutMs, () => done(false));
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
        });
    },
};

export async function proveEgress(opts: EgressProofOptions): Promise<EgressProof> {
    const probe = opts.probe ?? nodeEgressProbe;
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const proxy = new URL(opts.proxyUrl);
    const base = `egress:proxy=${proxy.host};allowed=${opts.allowedHost};canary=${opts.canaryHost}`;
    const fail = (failed: EgressProofFailure): EgressProof => ({ met: false, evidence: `${base};failed=${failed}`, failed });

    const envProxy = opts.env.HTTPS_PROXY ?? opts.env.https_proxy;
    if (envProxy !== opts.proxyUrl || opts.env.NODE_USE_ENV_PROXY !== '1') return fail('ENV_PROXY_NOT_SET');
    if ((await probe.connectThrough(proxy, `${opts.allowedHost}:${EGRESS_PORT}`, timeoutMs)) !== 200) {
        return fail('ALLOWED_HOST_REFUSED');
    }
    if ((await probe.connectThrough(proxy, `${opts.canaryHost}:${EGRESS_PORT}`, timeoutMs)) !== 403) {
        return fail('CANARY_NOT_REFUSED');
    }
    if (await probe.dialDirect(opts.allowedHost, EGRESS_PORT, timeoutMs)) return fail('DIRECT_EGRESS_OPEN');
    return { met: true, evidence: `${base}:refused;direct=blocked`, failed: null };
}
