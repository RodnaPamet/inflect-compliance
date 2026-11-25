#!/usr/bin/env node
/**
 * A faux Anthropic API for the end-to-end specs of the customer's own Anthropic
 * workspace: the `anthropic-workspace` connection's Test (Step 5a of
 * docs/claude-managed-agents-design.md) and a Managed Agents run (Step 5d).
 *
 * Started beside `next start` by the Playwright webServer list, on loopback
 * only, at the port `src/app-layer/integrations/providers/anthropic-workspace/
 * e2e-faux.ts` names. The provider and the engine's client dial it only in a
 * Playwright run (both NEXT_TEST_MODE and AUTH_TEST_MODE set); see that module
 * for why production cannot.
 *
 * ── THE TEST (Step 5a) ──────────────────────────────────────────────────────
 *
 * `GET /v1/agents`, as the Managed Agents reference documents it:
 *
 *   - a request missing the version, the Managed Agents beta or the workspace
 *     header is a 400, so a provider that dropped one fails the spec;
 *   - key `sk-ant-e2e-valid` → 200, a page of at most one of the workspace's
 *     agents, and the RESPONSE header `anthropic-workspace-id` naming the
 *     workspace the request named;
 *   - key `sk-ant-e2e-other-workspace` → 200 naming a DIFFERENT workspace;
 *   - any other key → 401 `authentication_error`.
 *
 * ── A MANAGED AGENTS RUN (Step 5d) ──────────────────────────────────────────
 *
 * The calls the engine makes, with key `sk-ant-e2e-valid` only (sent by the
 * SDK as a bearer token), each held in
 * the workspace the request's `anthropic-workspace-id` header names, so specs
 * running in parallel never see each other's objects:
 *
 *   POST /v1/environments, POST /v1/agents, POST|GET /v1/agents/{id}: stored
 *   as written, every version kept, so the run's drift check reads back what
 *   Inflect wrote; GET /v1/environments/{id}, the configuration as written with
 *   Anthropic's defaults filled in, which a run re-reads before its session
 *   (#5854);
 *   POST /v1/sessions, GET|DELETE /v1/sessions/{id}, GET /v1/sessions/{id}/events,
 *   POST /v1/sessions/{id}/events, GET /v1/sessions/{id}/events/stream (SSE);
 *   GET /v1/sessions?agent_id=…, the one page of an agent's live sessions that a
 *   run lists at its start for a session an earlier segment never recorded
 *   (#5854).
 *
 * A session plays a fixed two-turn script, one model call each: the first calls
 * the agent's first custom tool other than `activate_skill` with `{}` and idles
 * `requires_action`; once Inflect answers it, the second writes one sentence and
 * idles `end_turn`. A delete is refused while the session is running, as
 * Anthropic refuses it. The stream does not replay; the event list does.
 *
 * EVERY RESPONSE NAMES ITS WORKSPACE (#5854 finding 4): the `anthropic-workspace-id`
 * response header names the workspace the request named, as Anthropic's do, on
 * every `/v1/` answer (errors and the event stream's included). A spec can change
 * that for one workspace: `POST /__faux/workspace-answer?workspace=…&answer=none`
 * sends no header, `answer=other` names another workspace, `answer=echo` restores
 * the default. The Test's own key-specific answers above are unchanged.
 *
 * Any other method or path is a 405 / 404. Every request is COUNTED, by method,
 * path and workspace (never a header value): `GET /__faux/requests?workspace=…`
 * returns one workspace's, and `GET /__faux/sessions?workspace=…` the sessions it
 * holds now, so a spec can show what a Test or a run sent and what is left.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3008);
const VALID = 'sk-ant-e2e-valid';
const OTHER_WORKSPACE = 'sk-ant-e2e-other-workspace';
const BETA = 'managed-agents-2026-04-01';
/** How long a model request is in flight before its events are emitted. */
const IN_FLIGHT_MS = 15;

/** Every request, by method, path and workspace. */
const seen = [];
/** workspaceId → 'none' | 'other': what its responses name instead of itself (#5854 finding 4). */
const workspaceAnswers = new Map();
const SOMEONE_ELSE = 'wrkspc_e2eSomeoneElse';
/** workspaceId → { agents: Map<id, version[]>, environments: [], sessions: Map<id, session> } */
const workspaces = new Map();
let idSeq = 0;
const nextId = (prefix) => `${prefix}_e2e${String((idSeq += 1)).padStart(5, '0')}`;

function workspace(id) {
    if (!workspaces.has(id)) workspaces.set(id, { agents: new Map(), environments: [], sessions: new Map() });
    return workspaces.get(id);
}

function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_faux_${idSeq}`, ...headers });
    res.end(JSON.stringify(body));
}
const apiError = (res, status, type, message) =>
    reply(res, status, { type: 'error', error: { type, message }, request_id: 'req_faux' });

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve(null);
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(null);
            }
        });
    });
}

function agentObject(id, version, body) {
    return {
        id,
        type: 'agent',
        version,
        name: body.name,
        model: typeof body.model === 'string' ? { id: body.model } : body.model,
        system: body.system ?? null,
        description: body.description ?? null,
        tools: body.tools ?? [],
        mcp_servers: [],
        skills: [],
        multiagent: null,
        metadata: body.metadata ?? {},
        archived_at: null,
    };
}

/** The environment as Anthropic returns it: the configuration as written, the defaults Inflect left out filled in. */
function environmentObject(env) {
    const config = env.config ?? {};
    const networking = config.networking ?? null;
    return {
        id: env.id,
        type: 'environment',
        name: env.name,
        description: null,
        metadata: env.metadata ?? {},
        archived_at: null,
        created_at: '2026-11-23T00:00:00Z',
        updated_at: '2026-11-23T00:00:00Z',
        config: {
            ...config,
            ...(networking?.type === 'limited'
                ? { networking: { allowed_hosts: [], allow_mcp_servers: false, allow_package_managers: false, ...networking } }
                : {}),
            packages: { type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: [], ...(config.packages ?? {}) },
        },
    };
}

function sessionObject(s) {
    return {
        id: s.id,
        type: 'session',
        status: s.status,
        agent: { type: 'agent', id: s.agentId },
        metadata: s.metadata ?? {},
        archived_at: null,
        created_at: s.createdAt,
        environment_id: s.environmentId,
    };
}

function emit(s, partial) {
    const ev = { ...partial, id: nextId('sevt'), processed_at: new Date().toISOString() };
    s.history.push(ev);
    const frame = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const sub of [...s.subscribers]) {
        try {
            sub.write(frame);
        } catch {
            s.subscribers.delete(sub);
        }
    }
    return ev;
}

/** The custom tool the first turn calls: the agent's first one that is not `activate_skill`. */
function firstToolOf(ws, s) {
    const versions = ws.agents.get(s.agentId) ?? [];
    const agent = versions.find((a) => a.version === s.agentVersion) ?? versions[versions.length - 1];
    const tool = (agent?.tools ?? []).find((t) => t && t.type === 'custom' && t.name !== 'activate_skill');
    return tool ? tool.name : null;
}

async function runTurn(ws, s) {
    s.inFlight = true;
    s.status = 'running';
    const n = s.turns;
    s.turns += 1;
    emit(s, { type: 'session.status_running' });
    const start = emit(s, { type: 'span.model_request_start' });
    await new Promise((r) => setTimeout(r, IN_FLIGHT_MS));
    if (s.deleted) return;
    const calls = [];
    const tool = n === 0 ? firstToolOf(ws, s) : null;
    if (tool) {
        calls.push(emit(s, { type: 'agent.custom_tool_use', name: tool, input: {} }).id);
    } else {
        emit(s, { type: 'agent.message', content: [{ type: 'text', text: 'There is nothing further to report.' }] });
    }
    emit(s, {
        type: 'span.model_request_end',
        is_error: false,
        model_request_start_id: start.id,
        model_usage: { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    s.inFlight = false;
    s.status = 'idle';
    if (s.interruptRequested || calls.length === 0) {
        s.interruptRequested = false;
        s.pending.clear();
        emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
        return;
    }
    s.pending = new Set(calls);
    emit(s, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: calls }, stop_details: null });
}

function postEvents(ws, s, body) {
    const events = Array.isArray(body?.events) ? body.events : [];
    for (const e of events) {
        if (e.type === 'user.message') {
            emit(s, { type: 'user.message', content: e.content });
            if (!s.inFlight && s.pending.size === 0) void runTurn(ws, s);
        } else if (e.type === 'user.custom_tool_result') {
            const callId = String(e.custom_tool_use_id);
            s.pending.delete(callId);
            emit(s, { type: 'user.custom_tool_result', custom_tool_use_id: callId, is_error: e.is_error === true, content: e.content });
            if (s.pending.size === 0 && !s.inFlight && !s.interruptRequested) void runTurn(ws, s);
        } else if (e.type === 'user.interrupt') {
            emit(s, { type: 'user.interrupt' });
            if (s.inFlight) {
                s.interruptRequested = true;
            } else {
                s.pending.clear();
                s.status = 'idle';
                emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
            }
        }
    }
    return { data: events };
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__faux/health') return reply(res, 200, { ok: true });
    if (url.pathname === '/__faux/requests') {
        const only = url.searchParams.get('workspace');
        const requests = seen.filter((r) => only === null || r.workspace === only).map(({ method, path }) => ({ method, path }));
        return reply(res, 200, { requests });
    }
    if (url.pathname === '/__faux/workspace-answer' && req.method === 'POST') {
        const target = url.searchParams.get('workspace') ?? '';
        const answer = url.searchParams.get('answer');
        if (!target || !['none', 'other', 'echo'].includes(answer ?? '')) return apiError(res, 400, 'invalid_request_error', 'faux: workspace and answer=none|other|echo');
        if (answer === 'echo') workspaceAnswers.delete(target);
        else workspaceAnswers.set(target, answer);
        return reply(res, 200, { workspace: target, answer });
    }
    if (url.pathname === '/__faux/sessions') {
        const ws = workspaces.get(url.searchParams.get('workspace') ?? '');
        const all = ws ? [...ws.sessions.values()] : [];
        return reply(res, 200, {
            live: all.filter((s) => !s.deleted).map((s) => ({ id: s.id, status: s.status })),
            created: all.length,
            deleted: all.filter((s) => s.deleted).map((s) => s.id),
        });
    }

    const workspaceId = req.headers['anthropic-workspace-id'];
    seen.push({ method: req.method, path: url.pathname, workspace: typeof workspaceId === 'string' ? workspaceId : null });
    if (!url.pathname.startsWith('/v1/')) return apiError(res, 404, 'not_found_error', 'not found');
    // The response names the workspace the request named (#5854 finding 4),
    // merged by `writeHead` into every answer below, the stream's included.
    if (typeof workspaceId === 'string' && workspaceId) {
        const answer = workspaceAnswers.get(workspaceId);
        if (answer !== 'none') res.setHeader('anthropic-workspace-id', answer === 'other' ? SOMEONE_ELSE : workspaceId);
    }
    if (!req.headers['anthropic-version'] || !String(req.headers['anthropic-beta'] ?? '').includes(BETA) || !workspaceId) {
        return apiError(res, 400, 'invalid_request_error', 'missing header');
    }
    // The provider's Test sends `x-api-key`; the engine's SDK client sends the
    // same key as a bearer token.
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const key = req.headers['x-api-key'] ?? bearer;
    const ws = workspace(String(workspaceId));
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // The connection's Test (Step 5a).
    if (p === '/v1/agents' && method === 'GET') {
        if (key === VALID) {
            const data = [...ws.agents.values()].map((v) => v[v.length - 1]).slice(0, 1);
            return reply(res, 200, { data, next_page: null }, { 'anthropic-workspace-id': String(workspaceId) });
        }
        if (key === OTHER_WORKSPACE) {
            return reply(res, 200, { data: [], next_page: null }, { 'anthropic-workspace-id': SOMEONE_ELSE });
        }
        return apiError(res, 401, 'authentication_error', 'invalid x-api-key');
    }
    if (key !== VALID) return apiError(res, 401, 'authentication_error', 'invalid x-api-key');

    // A Managed Agents run (Step 5d).
    const body = method === 'POST' ? await readBody(req) : null;
    if (p === '/v1/environments' && method === 'POST') {
        const env = { id: nextId('env'), type: 'environment', ...(body ?? {}) };
        ws.environments.push(env);
        return reply(res, 200, environmentObject(env));
    }
    const envMatch = /^\/v1\/environments\/([^/]+)$/.exec(p);
    if (envMatch && method === 'GET') {
        const env = ws.environments.find((e) => e.id === envMatch[1]);
        return env ? reply(res, 200, environmentObject(env)) : apiError(res, 404, 'not_found_error', 'no such environment');
    }
    if (p === '/v1/agents' && method === 'POST') {
        const id = nextId('agent');
        const agent = agentObject(id, 1, body ?? {});
        ws.agents.set(id, [agent]);
        return reply(res, 200, agent);
    }
    let m = /^\/v1\/agents\/([^/]+)$/.exec(p);
    if (m) {
        const versions = ws.agents.get(m[1]);
        if (!versions) return apiError(res, 404, 'not_found_error', 'no such agent');
        const latest = versions[versions.length - 1];
        if (method === 'GET') {
            const wanted = url.searchParams.get('version');
            const agent = wanted === null ? latest : versions.find((a) => String(a.version) === wanted);
            return agent ? reply(res, 200, agent) : apiError(res, 404, 'not_found_error', 'no such version');
        }
        if (method === 'POST') {
            if (body?.version !== latest.version) return apiError(res, 409, 'conflict_error', 'stale version');
            const { version: _v, ...rest } = body;
            const agent = agentObject(m[1], latest.version + 1, { ...latest, ...rest });
            versions.push(agent);
            return reply(res, 200, agent);
        }
        return apiError(res, 405, 'invalid_request_error', 'method not allowed');
    }
    if (p === '/v1/sessions' && method === 'GET') {
        const agentId = url.searchParams.get('agent_id');
        if (!agentId) return apiError(res, 400, 'invalid_request_error', 'faux: a session list names an agent');
        const data = [...ws.sessions.values()].filter((s) => !s.deleted && s.agentId === agentId).map(sessionObject);
        return reply(res, 200, { data, next_page: null });
    }
    if (p === '/v1/sessions' && method === 'POST') {
        const agent = body?.agent ?? {};
        const s = {
            id: nextId('sesn'),
            agentId: agent.id,
            agentVersion: agent.version,
            environmentId: body?.environment_id,
            metadata: body?.metadata,
            status: 'idle',
            deleted: false,
            createdAt: new Date().toISOString(),
            history: [],
            subscribers: new Set(),
            pending: new Set(),
            inFlight: false,
            interruptRequested: false,
            turns: 0,
        };
        ws.sessions.set(s.id, s);
        return reply(res, 200, sessionObject(s));
    }
    m = /^\/v1\/sessions\/([^/]+)$/.exec(p);
    if (m) {
        const s = ws.sessions.get(m[1]);
        if (!s || s.deleted) return apiError(res, 404, 'not_found_error', 'no such session');
        if (method === 'GET') return reply(res, 200, sessionObject(s));
        if (method === 'DELETE') {
            if (s.status === 'running') return apiError(res, 400, 'invalid_request_error', 'cannot delete a running session');
            s.deleted = true;
            for (const sub of s.subscribers) sub.end();
            s.subscribers.clear();
            return reply(res, 200, { id: s.id, type: 'session_deleted' });
        }
        return apiError(res, 405, 'invalid_request_error', 'method not allowed');
    }
    m = /^\/v1\/sessions\/([^/]+)\/events$/.exec(p);
    if (m) {
        const s = ws.sessions.get(m[1]);
        if (!s || s.deleted) return apiError(res, 404, 'not_found_error', 'no such session');
        if (method === 'GET') return reply(res, 200, { data: [...s.history], next_page: null });
        if (method === 'POST') return reply(res, 200, postEvents(ws, s, body));
        return apiError(res, 405, 'invalid_request_error', 'method not allowed');
    }
    m = /^\/v1\/sessions\/([^/]+)\/events\/stream$/.exec(p);
    if (m && method === 'GET') {
        const s = ws.sessions.get(m[1]);
        if (!s || s.deleted) return apiError(res, 404, 'not_found_error', 'no such session');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.flushHeaders();
        s.subscribers.add(res);
        req.on('close', () => s.subscribers.delete(res));
        return undefined;
    }
    return apiError(res, 404, 'not_found_error', `faux: ${method} ${p}`);
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`[anthropic-workspace faux] listening on 127.0.0.1:${port}\n`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
