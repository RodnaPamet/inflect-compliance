/**
 * A FAUX MANAGED AGENTS WORKSPACE, served on `global.fetch` (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165).
 *
 * The engine under test builds its real SDK client (`managedAgentsClientFor`),
 * with its real middleware, and every request that client sends lands here.
 * This module answers the agent, environment and session endpoints the engine
 * calls, and plays the session's event stream as Server-Sent Events, the way
 * the SDK's `Stream` parses them (`event:` and `data:` lines; the SDK skips an
 * event without a name).
 *
 * ── THE SESSION MODEL ───────────────────────────────────────────────────────
 *
 * Each scripted turn is ONE model call. A turn starts when the opening message
 * arrives, or when the last pending custom call of the turn before is answered.
 * It emits `session.status_running` and `span.model_request_start`, is IN
 * FLIGHT for `IN_FLIGHT_MS`, then emits the turn's `agent.message` or its
 * `agent.custom_tool_use` events, `span.model_request_end`, and an idle:
 * `requires_action` naming the calls, or `end_turn`.
 *
 * `user.interrupt` is honoured AT A SAFE BOUNDARY, as the Managed Agents
 * reference documents it: an interrupt that arrives while a model request is in
 * flight lets that request finish, then the session idles `end_turn` and its
 * calls are cancelled; one that arrives while the session is idle idles it at
 * once. The events of one POST are processed in order, so a tool result that
 * completes a turn's calls starts the next model request BEFORE an interrupt
 * later in the same POST is read: that request is in flight when it arrives.
 * This is the weaker stop the kill-switch variance names.
 *
 * The stream does not replay. `events.list` returns the whole history.
 *
 * ── THE CLEAN-UP SURFACE (Step 5c, #4166) ───────────────────────────────────
 *
 * `sessions.list` filtered by `agent_id` (archived sessions only with
 * `include_archived=true`, `created_at[lte]` honoured), `sessions.retrieve`
 * with the session's metadata, and `agents.archive`. `seedSession` and
 * `seedAgent` put objects in the workspace that no run created: a FOREIGN
 * session or agent, or a session a crash left unrecorded. `unreachable` makes
 * every request fail at the network, and `authStatus` answers every request
 * with that status, so a test can take the provider away and give it back.
 */

export interface FauxScriptedTurn {
    readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>;
    readonly text?: string;
}

export const FAUX_ORIGIN = 'https://api.anthropic.com';

/** How long a model request is in flight: the window in which an interrupt is honoured after it. */
export const IN_FLIGHT_MS = 15;

interface FauxEvent {
    id: string;
    type: string;
    processed_at: string;
    [key: string]: unknown;
}

interface FauxSession {
    id: string;
    agent: Record<string, unknown>;
    system: string;
    environmentId: string;
    budget: unknown;
    metadata: unknown;
    status: 'idle' | 'running' | 'terminated';
    deleted: boolean;
    archived: boolean;
    createdAt: string;
    history: FauxEvent[];
    subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
    pending: Set<string>;
    inFlight: boolean;
    interruptRequested: boolean;
    conversation: unknown[];
}

export interface FauxRequest {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown> | null;
    readonly headers: Headers;
}

/** A dropped stream: when an event of this type is emitted, every open stream errors. */
export interface FauxDrop {
    readonly onType: string;
    /** Append the event to the history but do NOT deliver it before the drop. */
    readonly hide: boolean;
    /** How many drops to make. */
    times: number;
}

const encoder = new TextEncoder();

/**
 * Ids are unique across every faux in a test file, not per instance: a suite
 * that makes a new faux per test keeps the ledger rows of earlier tests, and a
 * pass over every tenant (the data-lifecycle reconciliation) would otherwise
 * read an earlier test's recorded id as naming this test's object.
 */
let fauxIdSeq = 0;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': `req_faux_${Math.random().toString(36).slice(2)}` },
    });
}

function apiError(status: number, type: string, message: string): Response {
    return json({ type: 'error', error: { type, message } }, status);
}

export class ManagedAgentsFaux {
    turns: FauxScriptedTurn[] = [];
    readonly requests: FauxRequest[] = [];
    /** Every version of every agent, as Anthropic would store it. */
    readonly agents = new Map<string, Array<Record<string, unknown>>>();
    readonly agentWrites: Array<{ op: 'create' | 'update'; body: Record<string, unknown> }> = [];
    readonly environments: Array<Record<string, unknown>> = [];
    readonly sessions = new Map<string, FauxSession>();
    readonly sessionCreates: Array<Record<string, unknown>> = [];
    /** What each model call received, serialised, in call order. */
    readonly modelInputs: string[] = [];
    /** Every custom tool result received, in order. */
    readonly toolResults: Array<{ id: string; isError: boolean; text: string }> = [];
    /** Results for a call that was not pending: a second answer, or an answer to nothing. */
    readonly unexpectedResults: string[] = [];
    readonly interrupts: string[] = [];
    readonly deletes: string[] = [];
    /** Agents archived, in order. */
    readonly archives: string[] = [];
    /** Every request fails at the network while this is true. */
    unreachable = false;
    /** Every request is answered with this status (401, 403, 503…) while set. */
    authStatus: number | null = null;
    /** Called as each model call starts. */
    onModelCall: (() => void) | null = null;
    /** A Console edit: change what `agents.retrieve` returns. */
    driftRetrieve: ((agent: Record<string, unknown>) => Record<string, unknown>) | null = null;
    /** Every POST of session events fails with this status from the Nth on (1-based). */
    failEventsFrom: { nth: number; status: number } | null = null;
    /** The delete answers with this status. */
    failDelete: number | null = null;
    drop: FauxDrop | null = null;
    /** Add a built-in tool use to the turn with this index (a reach beyond custom tools). */
    builtinToolUseOnTurn: number | null = null;
    private modelCallCount = 0;
    private eventPosts = 0;
    private readonly originalFetch = global.fetch;

    install(): void {
        global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.serve(input, init)) as typeof fetch;
    }

    uninstall(): void {
        global.fetch = this.originalFetch;
        for (const s of this.sessions.values()) for (const c of s.subscribers) safeClose(c);
    }

    /** The one session the run created. */
    onlySession(): FauxSession | undefined {
        return [...this.sessions.values()][0];
    }

    private nextId(prefix: string): string {
        fauxIdSeq += 1;
        return `${prefix}_${String(fauxIdSeq).padStart(4, '0')}`;
    }

    private async serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' && init.body.length > 0 ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        this.requests.push({ method, path: url.pathname, body, headers: new Headers(init?.headers) });
        if (url.origin !== FAUX_ORIGIN) return apiError(404, 'not_found_error', 'not served here');
        if (this.unreachable) throw new TypeError('faux: fetch failed (the workspace is unreachable)');
        if (this.authStatus !== null) {
            return apiError(this.authStatus, this.authStatus === 401 ? 'authentication_error' : this.authStatus === 403 ? 'permission_error' : 'api_error', 'refused');
        }
        const p = url.pathname;
        if (method === 'GET' && p === '/v1/sessions') return this.listSessions(url.searchParams);
        const archive = /^\/v1\/agents\/([^/]+)\/archive$/.exec(p);
        if (archive && method === 'POST') return this.archiveAgent(archive[1]);

        if (method === 'POST' && p === '/v1/agents') return this.createAgent(body ?? {});
        let m = /^\/v1\/agents\/([^/]+)$/.exec(p);
        if (m && method === 'POST') return this.updateAgent(m[1], body ?? {});
        if (m && method === 'GET') return this.retrieveAgent(m[1], url.searchParams.get('version'));
        if (method === 'POST' && p === '/v1/environments') {
            const env = { id: this.nextId('env'), type: 'environment', ...(body ?? {}) };
            this.environments.push(env);
            return json(env);
        }
        if (method === 'POST' && p === '/v1/sessions') return this.createSession(body ?? {});
        m = /^\/v1\/sessions\/([^/]+)$/.exec(p);
        if (m && method === 'GET') {
            const s = this.sessions.get(m[1]);
            if (!s || s.deleted) return apiError(404, 'not_found_error', 'no such session');
            return json(this.sessionObject(s));
        }
        if (m && method === 'DELETE') return this.deleteSession(m[1]);
        m = /^\/v1\/sessions\/([^/]+)\/events$/.exec(p);
        if (m && method === 'GET') {
            const s = this.sessions.get(m[1]);
            if (!s) return apiError(404, 'not_found_error', 'no such session');
            return json({ data: [...s.history], next_page: null });
        }
        if (m && method === 'POST') return this.postEvents(m[1], body ?? {});
        m = /^\/v1\/sessions\/([^/]+)\/events\/stream$/.exec(p);
        if (m && method === 'GET') return this.openStream(m[1], init?.signal ?? null);
        return apiError(404, 'not_found_error', `faux: ${method} ${p}`);
    }

    /** A session no run created: foreign, or one a crash left unrecorded. */
    seedSession(input: { agentId: string; metadata?: Record<string, string>; status?: 'idle' | 'running' | 'terminated'; archived?: boolean }): string {
        const id = this.nextId('sesn');
        this.sessions.set(id, {
            id,
            agent: { type: 'agent', id: input.agentId },
            system: '',
            environmentId: 'env_seeded',
            budget: null,
            metadata: input.metadata ?? {},
            status: input.status ?? 'idle',
            deleted: false,
            archived: input.archived ?? false,
            createdAt: new Date().toISOString(),
            history: [],
            subscribers: new Set(),
            pending: new Set(),
            inFlight: false,
            interruptRequested: false,
            conversation: [],
        });
        return id;
    }

    /** An agent no provision created. */
    seedAgent(name = 'foreign'): string {
        const id = this.nextId('agent');
        this.agents.set(id, [this.agentObject(id, 1, { name, model: 'claude-sonnet-5-5', system: 'not inflect' })]);
        return id;
    }

    /** Is this session still in the workspace? */
    holdsSession(id: string): boolean {
        const s = this.sessions.get(id);
        return Boolean(s && !s.deleted);
    }

    /** Is this agent archived? */
    isArchived(id: string): boolean {
        const versions = this.agents.get(id);
        return Boolean(versions && versions[versions.length - 1].archived_at);
    }

    private sessionObject(s: FauxSession): Record<string, unknown> {
        const agentId = typeof s.agent.id === 'string' ? s.agent.id : null;
        return {
            id: s.id,
            type: 'session',
            status: s.status,
            agent: { type: 'agent', id: agentId },
            metadata: (s.metadata ?? {}) as Record<string, string>,
            archived_at: s.archived ? s.createdAt : null,
            created_at: s.createdAt,
            environment_id: s.environmentId,
        };
    }

    private listSessions(params: URLSearchParams): Response {
        const agentId = params.get('agent_id');
        const includeArchived = params.get('include_archived') === 'true';
        const lte = params.get('created_at[lte]');
        const data = [...this.sessions.values()]
            .filter((s) => !s.deleted)
            .filter((s) => agentId === null || s.agent.id === agentId)
            .filter((s) => includeArchived || !s.archived)
            .filter((s) => lte === null || s.createdAt <= lte)
            .map((s) => this.sessionObject(s));
        return json({ data, next_page: null, prev_page: null });
    }

    private archiveAgent(id: string): Response {
        const versions = this.agents.get(id);
        if (!versions) return apiError(404, 'not_found_error', 'no such agent');
        const latest = versions[versions.length - 1];
        latest.archived_at = new Date().toISOString();
        this.archives.push(id);
        return json(latest);
    }

    private agentObject(id: string, version: number, body: Record<string, unknown>): Record<string, unknown> {
        return {
            id,
            type: 'agent',
            version,
            name: body.name,
            model: { id: body.model },
            system: body.system ?? null,
            tools: body.tools ?? [],
            mcp_servers: [],
            skills: [],
            multiagent: null,
            metadata: body.metadata ?? {},
            archived_at: null,
        };
    }

    private createAgent(body: Record<string, unknown>): Response {
        this.agentWrites.push({ op: 'create', body });
        const id = this.nextId('agent');
        const agent = this.agentObject(id, 1, body);
        this.agents.set(id, [agent]);
        return json(agent);
    }

    private updateAgent(id: string, body: Record<string, unknown>): Response {
        this.agentWrites.push({ op: 'update', body });
        const versions = this.agents.get(id);
        if (!versions) return apiError(404, 'not_found_error', 'no such agent');
        const latest = versions[versions.length - 1];
        if (body.version !== latest.version) return apiError(409, 'conflict_error', 'stale version');
        const { version: _ignored, ...rest } = body;
        const agent = this.agentObject(id, Number(latest.version) + 1, { ...latest, ...rest, model: (rest.model ?? (latest.model as { id: string }).id) });
        versions.push(agent);
        return json(agent);
    }

    private retrieveAgent(id: string, version: string | null): Response {
        const versions = this.agents.get(id);
        if (!versions) return apiError(404, 'not_found_error', 'no such agent');
        const agent = version === null ? versions[versions.length - 1] : versions.find((a) => String(a.version) === version);
        if (!agent) return apiError(404, 'not_found_error', 'no such version');
        return json(this.driftRetrieve ? this.driftRetrieve({ ...agent }) : agent);
    }

    private createSession(body: Record<string, unknown>): Response {
        this.sessionCreates.push(body);
        const agent = (body.agent ?? {}) as Record<string, unknown>;
        const s: FauxSession = {
            id: this.nextId('sesn'),
            agent,
            system: typeof agent.system === 'string' ? agent.system : '',
            environmentId: String(body.environment_id),
            budget: body.budget,
            metadata: body.metadata,
            status: 'idle',
            deleted: false,
            archived: false,
            createdAt: new Date().toISOString(),
            history: [],
            subscribers: new Set(),
            pending: new Set(),
            inFlight: false,
            interruptRequested: false,
            conversation: [],
        };
        this.sessions.set(s.id, s);
        return json({ id: s.id, type: 'session', status: s.status });
    }

    private deleteSession(id: string): Response {
        const s = this.sessions.get(id);
        if (!s || s.deleted) return apiError(404, 'not_found_error', 'no such session');
        if (this.failDelete !== null) return apiError(this.failDelete, 'api_error', 'delete failed');
        if (s.status === 'running') return apiError(400, 'invalid_request_error', 'cannot delete a running session');
        s.deleted = true;
        this.deletes.push(id);
        for (const c of s.subscribers) safeClose(c);
        s.subscribers.clear();
        return json({ id, type: 'session_deleted' });
    }

    private openStream(id: string, signal: AbortSignal | null): Response {
        const s = this.sessions.get(id);
        if (!s || s.deleted) return apiError(404, 'not_found_error', 'no such session');
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
                controller = c;
                s.subscribers.add(c);
            },
            cancel: () => {
                s.subscribers.delete(controller);
            },
        });
        signal?.addEventListener('abort', () => {
            s.subscribers.delete(controller);
            safeClose(controller);
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    private emit(s: FauxSession, partial: { type: string; [key: string]: unknown }): FauxEvent {
        const ev = { ...partial, id: this.nextId('sevt'), processed_at: new Date().toISOString() } as FauxEvent;
        s.history.push(ev);
        const drop = this.drop && this.drop.times > 0 && this.drop.onType === ev.type ? this.drop : null;
        if (drop && drop.hide) {
            drop.times -= 1;
            for (const c of [...s.subscribers]) safeError(c);
            s.subscribers.clear();
            return ev;
        }
        const frame = encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        for (const c of [...s.subscribers]) {
            try {
                c.enqueue(frame);
            } catch {
                s.subscribers.delete(c);
            }
        }
        if (drop) {
            drop.times -= 1;
            for (const c of [...s.subscribers]) safeError(c);
            s.subscribers.clear();
        }
        return ev;
    }

    private postEvents(id: string, body: Record<string, unknown>): Response {
        const s = this.sessions.get(id);
        if (!s || s.deleted) return apiError(404, 'not_found_error', 'no such session');
        this.eventPosts += 1;
        if (this.failEventsFrom && this.eventPosts >= this.failEventsFrom.nth) {
            return apiError(this.failEventsFrom.status, 'api_error', 'events refused');
        }
        const events = Array.isArray(body.events) ? (body.events as Array<Record<string, unknown>>) : [];
        for (const e of events) {
            if (e.type === 'user.message') {
                const text = ((e.content as Array<{ text?: string }>) ?? []).map((b) => b.text ?? '').join('\n');
                s.conversation.push({ role: 'user', text });
                this.emit(s, { type: 'user.message', content: e.content });
                if (!s.inFlight && s.pending.size === 0) void this.runTurn(s);
            } else if (e.type === 'user.custom_tool_result') {
                const callId = String(e.custom_tool_use_id);
                const text = ((e.content as Array<{ text?: string }>) ?? []).map((b) => b.text ?? '').join('\n');
                const isError = e.is_error === true;
                this.toolResults.push({ id: callId, isError, text });
                if (!s.pending.has(callId)) this.unexpectedResults.push(callId);
                s.pending.delete(callId);
                s.conversation.push({ role: 'tool_result', id: callId, isError, text });
                this.emit(s, { type: 'user.custom_tool_result', custom_tool_use_id: callId, is_error: isError, content: e.content });
                if (s.pending.size === 0 && !s.inFlight && !s.interruptRequested && s.status !== 'terminated') {
                    void this.runTurn(s);
                }
            } else if (e.type === 'user.interrupt') {
                this.interrupts.push(id);
                this.emit(s, { type: 'user.interrupt' });
                if (s.inFlight) {
                    s.interruptRequested = true;
                } else {
                    s.pending.clear();
                    s.status = 'idle';
                    this.emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
                }
            }
        }
        return json({ data: events });
    }

    private async runTurn(s: FauxSession): Promise<void> {
        // In flight from the first line, so a later event of the same POST sees it.
        s.inFlight = true;
        s.status = 'running';
        const n = this.modelCallCount;
        this.modelCallCount += 1;
        this.modelInputs.push(JSON.stringify({ system: s.system, conversation: s.conversation }));
        this.onModelCall?.();
        this.emit(s, { type: 'session.status_running' });
        const start = this.emit(s, { type: 'span.model_request_start' });
        await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_MS));
        if (s.deleted) return;
        const turn = this.turns[n] ?? { text: 'done' };
        if (turn.text !== undefined) this.emit(s, { type: 'agent.message', content: [{ type: 'text', text: turn.text }] });
        const calls: string[] = [];
        for (const c of turn.toolCalls ?? []) {
            calls.push(this.emit(s, { type: 'agent.custom_tool_use', name: c.name, input: c.args }).id);
        }
        if (this.builtinToolUseOnTurn === n) {
            this.emit(s, { type: 'agent.tool_use', name: 'bash', input: { command: 'ls' }, evaluated_permission: 'allow' });
        }
        this.emit(s, {
            type: 'span.model_request_end',
            is_error: false,
            model_request_start_id: start.id,
            model_usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        });
        s.inFlight = false;
        if (s.interruptRequested) {
            s.interruptRequested = false;
            s.pending.clear();
            s.status = 'idle';
            this.emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
            return;
        }
        s.status = 'idle';
        if (calls.length > 0) {
            s.pending = new Set(calls);
            this.emit(s, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: calls }, stop_details: null });
        } else {
            this.emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
        }
    }
}

function safeClose(c: ReadableStreamDefaultController<Uint8Array>): void {
    try {
        c.close();
    } catch {
        // already closed
    }
}

function safeError(c: ReadableStreamDefaultController<Uint8Array>): void {
    try {
        c.error(new TypeError('faux: the connection dropped'));
    } catch {
        // already closed
    }
}
