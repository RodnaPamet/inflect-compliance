/**
 * THE STUB, BOUND TO A SOCKET (#3867 step 1).
 *
 * Wraps `createStubHandler` in an https listener so it can be registered as a
 * real `mcp-server` connection in a dev tenant and reached through the
 * product's own egress path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT REFUSES TO BIND LOOPBACK, AND WHY IT IS https-ONLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Inflect's egress guard refuses `http://localhost:PORT` for TWO independent
 * reasons, and the owner's decision (2026-10-22) was to satisfy both rather
 * than punch a hole through either:
 *
 *   * `webhook-safety.ts:73` — the scheme must be `https:`. So this serves TLS
 *     even on a LAN, and a self-signed certificate needs `NODE_EXTRA_CA_CERTS`
 *     on the Inflect process. There is no http mode to fall back to, because a
 *     fallback is the thing that ends up used.
 *   * `egress-allowlist.ts` — `NEVER_ALLOWLISTABLE` lists `127.0.0.0/8` and
 *     `::1/128` and is checked BEFORE the operator's allowlist, so `0.0.0.0/0`
 *     still cannot reach loopback. Its reason: loopback is the Inflect
 *     process's own admin surfaces. A non-loopback RFC1918 address is not on
 *     that list and IS admissible in SELFHOSTED mode with no code change.
 *
 * So binding loopback would produce a stub that the product can never reach,
 * and the failure would surface as a connection refusal with no hint as to
 * which of the two checks said no. Refusing at startup, by name, is cheaper
 * than that — `--host` has no default for the same reason.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

import { definitionsHash, DEFINITIONS_VERSION, TOOL_DEFINITIONS } from './definitions';
import { createStubHandler } from './handler';

const LOOPBACK = /^(127\.|0\.0\.0\.0$|::1$|localhost$)/i;

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

export function main(): void {
    const host = arg('host');
    const port = Number(arg('port') ?? 8443);
    const cert = arg('cert');
    const key = arg('key');

    if (host === undefined || cert === undefined || key === undefined) {
        process.stderr.write(
            'usage: sap-mcp-stub --host <lan-ip> --cert <pem> --key <pem> ' +
                '[--port 8443] [--fail-mode] [--empty-catalogue]\n',
        );
        process.exit(2);
    }
    if (LOOPBACK.test(host)) {
        // Named, rather than left to fail later as a refused connection.
        process.stderr.write(
            `sap-mcp-stub: refusing to bind ${host}. Inflect's egress guard can never ` +
                'reach loopback: NEVER_ALLOWLISTABLE in src/lib/security/egress-allowlist.ts ' +
                'lists 127.0.0.0/8 and ::1/128 and is checked before the operator allowlist. ' +
                'Bind a non-loopback RFC1918 address instead.\n',
        );
        process.exit(2);
    }

    const handler = createStubHandler({
        failMode: flag('fail-mode'),
        emptyCatalogue: flag('empty-catalogue'),
    });

    const server = createServer(
        { cert: readFileSync(cert), key: readFileSync(key) },
        (req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                void handler(req.url ?? '/', { body: Buffer.concat(chunks).toString('utf8') }).then(
                    async (response) => {
                        res.writeHead(response.status, {
                            'content-type':
                                response.headers.get('content-type') ?? 'application/json',
                        });
                        res.end(await response.text());
                    },
                );
            });
        },
    );

    server.listen(port, host, () => {
        // The hash on boot, so a run can state which contract it ran against.
        process.stdout.write(
            [
                `sap-mcp-stub listening on https://${host}:${port}`,
                `definitions ${DEFINITIONS_VERSION} sha256=${definitionsHash()}`,
                `tools ${TOOL_DEFINITIONS.length === 0 ? '(empty catalogue)' : TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
                flag('fail-mode') ? 'FAIL MODE: every tool call errors' : '',
            ]
                .filter(Boolean)
                .join('\n') + '\n',
        );
    });
}

// Only when run directly, so importing this module in a test binds nothing.
if (process.argv[1] !== undefined && process.argv[1].endsWith('server.ts')) main();
