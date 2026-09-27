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

const HRM_CLIENT_ID = process.env.ORANGEHRM_CLIENT_ID || '';
const HRM_CLIENT_SECRET = process.env.ORANGEHRM_CLIENT_SECRET || '';

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

/** OAuth2 client-credentials, minted per call. Nothing is persisted. */
async function accessToken() {
    if (!HRM_CLIENT_ID || !HRM_CLIENT_SECRET) {
        throw new Error('orangehrm client credentials are not configured');
    }
    const res = await fetch(`${HRM_BASE}${WEB_ROOT}/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            // Basic, not the form body — the same reasoning `token.ts` gives:
            // it keeps the secret out of any request-body logging in between.
            Authorization:
                'Basic ' + Buffer.from(`${HRM_CLIENT_ID}:${HRM_CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`orangehrm token endpoint answered ${res.status}`);
    const payload = await res.json();
    if (!payload?.access_token) throw new Error('orangehrm token endpoint returned no access_token');
    return payload.access_token;
}

async function hrm(path, init = {}) {
    const token = await accessToken();
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
        },
    });
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
        // field would blank the rest. Merge over what was read.
        const merged = { ...(before?.data ?? {}), workEmail };
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
