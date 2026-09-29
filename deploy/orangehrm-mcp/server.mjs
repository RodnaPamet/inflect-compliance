/**
 * An MCP server in front of OrangeHRM — the write-capable far end #2861 needs.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * #2861 governs an agent CHANGING a configuration in an external system, and
 * the first production proving run established that Microsoft's Entra MCP
 * server exposes no write verb at all: three tools, every one declaring
 * `readOnlyHint: true`, none taking a method or a body. A ladder whose top rung
 * dispatches unattended writes cannot be proven against a far end that cannot
 * be written to.
 *
 * OrangeHRM can. `write-back-preflight.ts` already records the measured facts:
 * `PUT /pim/employee/{id}/contact-details` accepts `{"workEmail": …}` and the
 * read-back works — and then says the thing this service exists to respect:
 *
 *     "Knowing the verb exists is not permission to send it."
 *
 * That permission is exactly what the ladder issues. This is the far end it
 * issues it against.
 *
 * ── IT IS A LAB TARGET, AND SAYS SO IN ITS OWN TOOL TEXT ────────────────────
 *
 * Not a product surface. It fronts a fixture instance holding invented
 * employees, and the tool descriptions say so, because that description is
 * instruction text handed to a model and read by a human approving a manifest
 * pin. A tool that did not say it was a lab would be approved as though it
 * were not.
 *
 * ── WHY ONE FILE, NO DEPENDENCIES, NO BUILD ─────────────────────────────────
 *
 * MCP over HTTP is JSON-RPC in a POST body. Node's own `http` module serves
 * that in a few dozen lines, and `fetch` is global. A package.json, a lockfile
 * and a build step would each be a thing to keep current, a thing for CI to
 * scan and a supply-chain surface — for a lab fixture. It runs on the
 * `node:24-alpine` image with the file mounted.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not reach the internet. OrangeHRM is addressed on the Compose
 * network by service name, so the fixture is never internet-facing even though
 * this adapter is: the agent reaches the adapter over public HTTPS, and the
 * adapter reaches OrangeHRM over a private bridge. That is the whole reason
 * the two are separate processes rather than one.
 *
 * It holds no tenant data and makes no authorization decision. Every control
 * that decides whether a call may happen — the grant, the manifest pin, the
 * autonomy ceiling, the data-access rung, the write ladder — lives in IC and
 * has already run by the time a request arrives here.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);

/** The fixture, by Compose service name. Never a public address. */
const HRM_BASE = process.env.ORANGEHRM_BASE || 'http://orangehrm:80';
const WEB_ROOT = '/web/index.php';
const API = `${HRM_BASE}${WEB_ROOT}/api/v2`;

/**
 * A USER, not an OAuth client — because OrangeHRM 5.9 has no client-credentials
 * grant to use.
 *
 * `OAuthServer::getServer()` constructs exactly two grants, `AuthCodeGrant` and
 * `RefreshTokenGrant`, hardcoded rather than configured, and the string
 * `client_credentials` appears nowhere in its plugin tree. Measured against a
 * live 5.9 on 2026-09-29. The first version of this adapter POSTed
 * `grant_type=client_credentials` to `/oauth2/token`; that endpoint cannot
 * answer it, and no amount of client registration changes that.
 *
 * The remaining grants are both interactive — `authorization_code` needs a
 * browser redirect and a human, `refresh_token` needs one to have happened
 * first — so neither suits a service. What IS available is the session the web
 * UI itself uses, which is what this now does.
 */
const HRM_USER = process.env.ORANGEHRM_USER || '';
const HRM_PASSWORD = process.env.ORANGEHRM_PASSWORD || '';

/**
 * The bearer this adapter requires, matching the `authorization` SECRET field
 * on IC's mcp-server connection.
 *
 * A static header rather than OAuth, and that is a lab decision with a limit
 * written into it: `authorizationFor` prefers the refresh flow whenever a
 * connection carries one, so moving this fixture onto a real flow later needs
 * no change here. Refused outright when unset — an adapter that accepted
 * anonymous callers because a variable was missing would be reachable by
 * whoever found the hostname.
 */
const EXPECTED_BEARER = process.env.MCP_BEARER || '';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The session cookie, held for reuse. Null means "not logged in yet".
 *
 * Module-level rather than per-call: logging in costs two round trips and a
 * bcrypt verify, and doing that per tool call would make the adapter slower than
 * the thing it proxies. It is re-established on demand — see `hrm` below, which
 * retries once on a 401 rather than trusting this to still be valid.
 */
let sessionCookie = null;

/** Keep only `name=value` from a Set-Cookie line; attributes are not sent back. */
function cookiePairs(setCookieHeaders) {
    return setCookieHeaders
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
}

/**
 * Log in the way the web UI does: CSRF token, then credentials, then keep the
 * cookie.
 *
 * ── THE TOKEN IS DOUBLE-WRAPPED, AND THAT COST AN HOUR ─────────────────────
 *
 * The login page carries the CSRF token as a JSON string inside an HTML
 * attribute, so it arrives as `token="&quot;VALUE&quot;"`. Reading it by cutting
 * at the attribute quote captures the `&quot;` wrapper as part of the value, and
 * the server then rejects a CORRECT username and password with the same 302 back
 * to the login page that a wrong password produces. The status code cannot tell
 * those two apart; the redirect TARGET can, which is why this checks it.
 */
async function login() {
    if (!HRM_USER || !HRM_PASSWORD) {
        throw new Error('orangehrm user credentials are not configured');
    }
    const loginUrl = `${HRM_BASE}${WEB_ROOT}/auth/login`;
    const page = await fetch(loginUrl, { redirect: 'manual' });
    const jar = cookiePairs(page.headers.getSetCookie?.() ?? []);
    const html = await page.text();

    // Between the &quot; markers, never the attribute quotes.
    const m = html.match(/token="&quot;([^&]+)&quot;"/);
    if (!m) throw new Error('orangehrm login page carried no csrf token');

    const body = new URLSearchParams({ _token: m[1], username: HRM_USER, password: HRM_PASSWORD });
    const res = await fetch(`${HRM_BASE}${WEB_ROOT}/auth/validate`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
        body,
    });

    // The DESTINATION is the discriminator. Both outcomes are a 302.
    const location = res.headers.get('location') ?? '';
    if (location.includes('/auth/login')) {
        throw new Error('orangehrm rejected the adapter credentials');
    }
    const after = cookiePairs(res.headers.getSetCookie?.() ?? []);
    sessionCookie = after || jar;
    return sessionCookie;
}

/**
 * One OrangeHRM API call, re-authenticating once if the session has lapsed.
 *
 * The retry is bounded to ONE attempt and only on 401. An unbounded retry would
 * turn a permanently wrong password into a login storm against the fixture, and
 * retrying a 500 would re-send a write that may already have been applied — the
 * distinction `INDETERMINATE` exists for on IC's side.
 */
async function hrm(path, init = {}) {
    const send = async () => {
        if (!sessionCookie) await login();
        return fetch(`${API}${path}`, {
            ...init,
            headers: {
                Cookie: sessionCookie,
                Accept: 'application/json',
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {}),
            },
        });
    };

    let res = await send();
    if (res.status === 401) {
        // OrangeHRM answers an expired session with 401 and a JSON body reading
        // "Session expired" — indistinguishable from bad credentials at the
        // status line, so this re-logs in once and lets `login` raise the
        // credential error if that is what it is.
        sessionCookie = null;
        res = await send();
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`orangehrm answered ${res.status} to ${init.method || 'GET'} ${path}`);
    return text ? JSON.parse(text) : null;
}

/** An employee number, as a path segment. Digits only — it interpolates. */
function employeeNumber(v) {
    const s = String(v ?? '').trim();
    if (!/^[0-9]{1,9}$/.test(s)) throw new Error('employeeNumber must be a positive integer');
    return s;
}

/**
 * The catalogue.
 *
 * ── THE ANNOTATIONS ARE LOAD-BEARING, NOT DECORATION ────────────────────────
 *
 * `readOnlyHint` is how a server declares whether a tool reads or writes, and
 * #2941 made IC pin it on its own hash so a server cannot flip one silently.
 * This is the first far end IC can point at where the two tools differ on that
 * field, so it is also the first real exercise of that pin.
 *
 * The write tool declares `readOnlyHint: false` and `idempotentHint: true`:
 * setting a work email to a value is the same operation however many times it
 * is sent. `destructiveHint` is false because the previous value is readable
 * beforehand and restorable afterwards — which is what makes it a safe first
 * write, and what read-prior-state depends on.
 */
const TOOLS = [
    {
        name: 'orangehrm_get_employee_contact',
        description:
            'Read one employee\'s contact details from the OrangeHRM LAB FIXTURE — a '
            + 'self-hosted instance holding invented employees, not a customer system of '
            + 'record. Returns the work email and other contact fields for the given '
            + 'employee number. Read this before changing anything: the previous value is '
            + 'what makes a change reversible.',
        inputSchema: {
            type: 'object',
            properties: {
                employeeNumber: {
                    type: 'string',
                    description: 'OrangeHRM internal employee number (empNumber), e.g. "1".',
                },
            },
            required: ['employeeNumber'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'orangehrm_set_employee_work_email',
        description:
            'CHANGE one employee\'s work email in the OrangeHRM LAB FIXTURE. This WRITES to '
            + 'an external system: it sends PUT /pim/employee/{id}/contact-details. The '
            + 'instance holds invented employees and is not a customer system of record, but '
            + 'the write is real and the previous value is overwritten. Read the current '
            + 'contact details first, so the prior value is known and the change can be '
            + 'undone.',
        inputSchema: {
            type: 'object',
            properties: {
                employeeNumber: {
                    type: 'string',
                    description: 'OrangeHRM internal employee number (empNumber).',
                },
                workEmail: {
                    type: 'string',
                    description: 'The new work email address.',
                },
            },
            required: ['employeeNumber', 'workEmail'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
];

async function callTool(name, args) {
    if (name === 'orangehrm_get_employee_contact') {
        const emp = employeeNumber(args?.employeeNumber);
        const out = await hrm(`/pim/employee/${emp}/contact-details`);
        return JSON.stringify(out?.data ?? out, null, 2);
    }

    if (name === 'orangehrm_set_employee_work_email') {
        const emp = employeeNumber(args?.employeeNumber);
        const workEmail = String(args?.workEmail ?? '').trim();
        if (!workEmail) throw new Error('workEmail is required');

        // READ FIRST, and report what it was. The prior value is the whole of
        // the rollback story for this write, and a caller that never saw it
        // cannot undo the change it just made.
        const before = await hrm(`/pim/employee/${emp}/contact-details`);
        const previous = before?.data?.workEmail ?? null;

        // PUT takes the whole contact-details object; sending only the changed
        // field blanks the rest. Measured on a live 5.9 on 2026-09-29: a bare
        // `{"workEmail":...}` PUT returns 200 and nulls city, mobile and every
        // other field.
        //
        // ── BUT THE MERGE MUST DROP EMPTY KEYS, NOT SEND THEM ──────────────
        //
        // The GET returns `countryCode: ""` and the PUT REFUSES it: 422 with
        // `invalidParamKeys: ["countryCode"]`. So echoing back what was read is
        // rejected, which is what the first version of this did — every write
        // failed 422 while looking like a merge problem.
        //
        // Dropping null and empty values fixes it and loses nothing: a field
        // that held no value has none to preserve, and the PUT leaves absent
        // keys null — which is what they already were.
        //
        // Verified on a record where it could FAIL rather than on the empty one
        // the fixture ships with: with `city: "Sofia"` and a real mobile
        // seeded, a workEmail write kept both and changed only the address. On
        // an all-empty record every candidate rule passes, which is worth
        // noticing before believing one.
        const merged = Object.fromEntries(
            Object.entries({ ...(before?.data ?? {}), workEmail }).filter(
                ([, v]) => v !== null && v !== undefined && v !== '',
            ),
        );
        await hrm(`/pim/employee/${emp}/contact-details`, {
            method: 'PUT',
            body: JSON.stringify(merged),
        });

        const after = await hrm(`/pim/employee/${emp}/contact-details`);
        return JSON.stringify(
            {
                employeeNumber: emp,
                previousWorkEmail: previous,
                newWorkEmail: after?.data?.workEmail ?? null,
                applied: (after?.data?.workEmail ?? null) === workEmail,
            },
            null,
            2,
        );
    }

    throw new Error(`unknown tool: ${name}`);
}

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
    const { id, method, params } = msg ?? {};

    if (method === 'initialize') {
        return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'OrangeHRM.Lab.MCP', version: '1.0.0' },
        });
    }

    // A notification carries no id and expects no reply.
    if (method === 'notifications/initialized') return null;

    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

    if (method === 'tools/call') {
        const name = params?.name;
        try {
            const text = await callTool(name, params?.arguments ?? {});
            return rpcResult(id, { content: [{ type: 'text', text }] });
        } catch (err) {
            // isError, not a transport error: the far end answered, and the
            // answer is that the call failed. A JSON-RPC error would read as a
            // broken server rather than a refused call.
            return rpcResult(id, {
                isError: true,
                content: [{ type: 'text', text: String(err?.message ?? err) }],
            });
        }
    }

    return rpcError(id ?? null, -32601, `method not found: ${method}`);
}

const server = createServer((req, res) => {
    const send = (status, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload);
    };

    // Unauthenticated liveness, so the Compose healthcheck does not need the
    // bearer. It names the service and nothing else.
    if (req.method === 'GET' && req.url === '/healthz') {
        return send(200, { ok: true, service: 'orangehrm-mcp' });
    }

    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

    if (!EXPECTED_BEARER) {
        // Fail CLOSED. An unset bearer is a misconfiguration, and treating it
        // as "no auth required" would open the adapter to anyone who found it.
        return send(503, { error: 'adapter is not configured with MCP_BEARER' });
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${EXPECTED_BEARER}`) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            // Names the scheme and the error token, never a description —
            // the same rule IC's own client applies when reading this header.
            'WWW-Authenticate': 'Bearer error="invalid_token"',
        });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', async () => {
        let msg;
        try {
            msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            return send(400, rpcError(null, -32700, 'parse error'));
        }
        try {
            const out = await handleRpc(msg);
            if (out === null) {
                res.writeHead(202);
                return res.end();
            }
            return send(200, out);
        } catch (err) {
            return send(500, rpcError(msg?.id ?? null, -32603, String(err?.message ?? err)));
        }
    });
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`orangehrm-mcp listening on ${PORT}, fronting ${HRM_BASE}`);
});
