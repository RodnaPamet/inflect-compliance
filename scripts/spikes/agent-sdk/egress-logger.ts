/**
 * A refusing forward proxy that only RECORDS where the subprocess tried to go.
 *
 * In `--faux` mode the subprocess is handed `HTTPS_PROXY` / `HTTP_PROXY`
 * pointing here, so any request it makes to a host other than the faux
 * Messages API (telemetry, feature flags, update checks, error reporting) is
 * logged by host and refused with 403. Nothing is forwarded anywhere. The
 * faux API itself is reached on 127.0.0.1, which `NO_PROXY` exempts.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EgressLogger {
    url: string;
    attempts: Array<{ at: number; method: string; target: string }>;
    close(): Promise<void>;
}

export async function startEgressLogger(): Promise<EgressLogger> {
    const attempts: EgressLogger['attempts'] = [];
    const server = createServer((req, res) => {
        attempts.push({ at: Date.now(), method: req.method ?? '', target: req.url ?? '' });
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('spike egress logger: refused');
    });
    server.on('connect', (req, socket) => {
        socket.on('error', () => undefined);
        attempts.push({ at: Date.now(), method: 'CONNECT', target: req.url ?? '' });
        socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        attempts,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** host:port → host, for a stable report. */
export const egressHosts = (attempts: EgressLogger['attempts']) =>
    [...new Set(attempts.map((a) => a.target.replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '')))].sort();
