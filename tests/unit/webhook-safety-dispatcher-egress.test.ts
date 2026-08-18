/**
 * `safeFetch`'s dispatcher handoff must survive an undici major bump.
 *
 * ## The regression this exists to catch
 *
 * `safeFetch` builds an `Agent` from the npm `undici` package (to pin the
 * resolved IP and defeat DNS rebinding) and then has to hand that dispatcher to
 * a fetch implementation. If it hands it to the GLOBAL `fetch`, the dispatcher
 * crosses a version boundary: the global fetch is served by the undici bundled
 * inside Node, and the pairing works only while the two versions' internal
 * dispatcher-handler interfaces agree.
 *
 * They stopped agreeing in undici 8. Verified on Node 22.23.2:
 *
 *   undici 7.29.0 + global fetch  → 200 OK
 *   undici 8.10.0 + global fetch  → TypeError: fetch failed
 *                                   cause: invalid onRequestStart method
 *
 * That break is total and silent at the point of change. `safeFetch` is the
 * egress path for signed audit-stream batches AND every automation webhook
 * action, so a dependency bump alone would stop all SIEM delivery and fail
 * every webhook — with no code change to review and, before this file, no
 * failing test, because every other test in the suite mocks `node:dns` or
 * `fetch` and so never reaches the real dispatcher handoff.
 *
 * ## Why it is asserted this way
 *
 * A structural test ("does the module import fetch from undici?") would pass
 * against a module that imports it and then doesn't use it. What actually
 * matters is that a request carrying a pinned dispatcher completes, so these
 * tests exercise the real pairing against a real server.
 *
 * `safeFetch` itself is covered at the level above, in
 * tests/unit/webhook-safety.test.ts: those redirect tests stub the transport on
 * the `undici` module, so they pass ONLY while `safeFetch` actually calls
 * undici's fetch. A revert to the global one stops them intercepting and they
 * fail. No test here needs to make a real outbound connection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Agents created by `pinnedAgent`, closed in `afterAll`.
 *
 * An undici Agent holds a connection pool, so leaving them open makes Jest
 * report "a worker process has failed to exit gracefully" and keeps the worker
 * alive past the suite.
 */
const openAgents: Agent[] = [];

/** The pinned-lookup Agent exactly as `safeFetch` constructs it. */
function pinnedAgent(address: string, family: 4 | 6 = 4): Agent {
    const agent = new Agent({
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        connect: {
            lookup: (
                _hostname: string,
                _options: unknown,
                cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void,
            ) => cb(null, [{ address, family }]),
        },
    } as unknown as ConstructorParameters<typeof Agent>[0]);
    openAgents.push(agent);
    return agent;
}

describe('a pinned undici dispatcher can actually carry a request', () => {
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        server = createServer((req, res) => {
            if (req.url === '/redirect') {
                res.writeHead(302, { location: 'http://internal.example/' });
                res.end();
                return;
            }
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('delivered');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
        await Promise.all(openAgents.splice(0).map((a) => a.close()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('completes a real request — the pairing is functional, not merely non-throwing', async () => {
        // Under a mismatched undici this rejects with `invalid onRequestStart
        // method` instead of returning a response.
        const res = await undiciFetch(`http://localhost:${port}/`, {
            redirect: 'manual',
            dispatcher: pinnedAgent('127.0.0.1'),
        } as unknown as Parameters<typeof undiciFetch>[1]);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe('delivered');
    });

    it('still surfaces a 3xx rather than following it, so the redirect refusal keeps working', async () => {
        // `redirect: 'manual'` is load-bearing for the SSRF guard: the IP pin
        // does NOT survive a hop, so a followed redirect escapes validation.
        // Confirm the flag survives the change of fetch implementation.
        const res = await undiciFetch(`http://localhost:${port}/redirect`, {
            redirect: 'manual',
            dispatcher: pinnedAgent('127.0.0.1'),
        } as unknown as Parameters<typeof undiciFetch>[1]);

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://internal.example/');
    });

    it('honours the pin, sending a request for one host to the pinned address', async () => {
        // If the custom lookup were ignored, this unresolvable hostname would
        // fail DNS — reaching our server proves the pin is in force, which is
        // the whole reason a dispatcher is involved at all.
        const res = await undiciFetch(`http://this-host-does-not-resolve.invalid:${port}/`, {
            redirect: 'manual',
            dispatcher: pinnedAgent('127.0.0.1'),
        } as unknown as Parameters<typeof undiciFetch>[1]);

        expect(res.status).toBe(200);
    });
});

/**
 * The behavioural tests above are the real protection, but they only BITE once
 * undici 8 is the installed version: on undici 7 the global fetch and an
 * npm-undici Agent still interoperate, so a revert to `fetch(url, {dispatcher})`
 * would keep them green until the major bump lands — which is exactly the
 * silent interval this whole file exists to remove.
 *
 * So this one assertion is structural on purpose. It is not standing in for a
 * behavioural test; it covers the window a behavioural test provably cannot,
 * and it should be deleted once undici 8+ is the floor.
 */
describe('the egress call does not cross the undici version boundary', () => {
    it('calls undici fetch, never the global one', () => {
        const src = fs
            .readFileSync(path.join(process.cwd(), 'src/app-layer/automation/webhook-safety.ts'), 'utf8')
            // Comments MUST be stripped: this module's own prose discusses the
            // global `fetch(` at length, and would satisfy the check by itself.
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        expect(src).toMatch(/from 'undici'/);
        expect(src).toMatch(/undiciFetch\(/);
        // A bare `await fetch(` / `= fetch(` is the regression.
        expect(src).not.toMatch(/[^.\w]fetch\s*\(/);
    });
});
