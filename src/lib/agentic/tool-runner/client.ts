/**
 * THE ONE PLACE AN ANTHROPIC CLIENT IS BUILT FOR AN AGENT RUN (Step 2a of
 * `docs/claude-tool-runner-design.md`, #4148).
 *
 * The Tool Runner engine talks to the Messages API through
 * `@anthropic-ai/sdk`. Every client it uses comes from `clientForRun`, which
 * chooses from the run's residency and builds a NEW client per call. Nothing is
 * cached, so no two runs, and no two tenants, ever share an instance. The SDK
 * holds no process-wide provider registry (unlike pi-ai's, see
 * `flue/model-selection.ts`), so a client per run is all the isolation there
 * is to get, and it is enough.
 *
 * `eslint.config.mjs` refuses a value import of any `@anthropic-ai/*` package
 * anywhere under `src/` except this file. With the class importable in one file
 * only, a second construction site cannot exist. Type imports stay allowed, so
 * an engine can describe its tools in the SDK's types.
 *
 * ── RESIDENCY ───────────────────────────────────────────────────────────────
 *
 *   EXTERNAL (or no posture row)  a client for Anthropic's API, keyed with
 *                                 `ANTHROPIC_API_KEY` and carrying the
 *                                 workspace header when one is configured
 *   LOCAL_ONLY                    refused, `TOOL_RUNNER_LOCAL_ONLY_UNSERVED`:
 *                                 the local gateway speaks the OpenAI protocol,
 *                                 not Anthropic's, so this engine has nothing
 *                                 local to call
 *
 * LOCAL_ONLY is checked FIRST, before anything external is read, for the reason
 * `resolveFlueModel` gives: a residency invariant enforced after an external
 * branch has been evaluated depends on the order of a switch.
 *
 * ── WHAT THE SDK WOULD OTHERWISE TAKE FROM THE ENVIRONMENT ─────────────────
 *
 * The SDK's constructor reads several `ANTHROPIC_*` variables on its own. Each
 * one that would change where a run's content goes, or who sees it, is pinned
 * here rather than left to whatever the process environment holds:
 *
 *   ANTHROPIC_BASE_URL       → `baseURL` is pinned to Anthropic's API, so the
 *                              host a run reaches is decided in code
 *   ANTHROPIC_LOG            → `logLevel` is pinned to 'warn'; at 'debug' the
 *                              SDK logs requests, which carry tenant content.
 *                              Its logger is ours, and drops the arguments
 *   ANTHROPIC_OPEN_TELEMETRY_* → tracing is pinned to `metadata_only`, so no
 *                              span carries message content; no trace context
 *                              is sent to Anthropic
 *   ANTHROPIC_WEBHOOK_SIGNING_KEY → `webhookKey` is null; a run verifies no
 *                              webhooks
 *   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and the credential chain → never
 *                              read: passing `apiKey` is the client's only
 *                              credential, and the SDK then reads no other
 *
 * One cannot be pinned: `ANTHROPIC_CUSTOM_HEADERS` is merged into every request
 * the client makes, and no option turns that off. A header set there, a beta
 * flag that stores conversations included, would apply to every run without a
 * line of code saying so. So while it is set, `clientForRun` refuses
 * (`SDK_AMBIENT_HEADERS_SET`) instead of building a client that would send it.
 *
 * ── WHAT A RUN'S CLIENT MAY SEND ────────────────────────────────────────────
 *
 * The SDK reaches every Anthropic API: files, skills, batches, server-held
 * threads, Managed Agents. An agent run needs one of them. Every client built
 * here carries `messagesOnlyFor`'s middleware, which runs before each request
 * leaves the process and refuses (`requestRefusal`) anything that is not:
 *
 *   • a POST to `/v1/messages` on the pinned origin; and
 *   • a body that asks Anthropic to hold nothing and call nothing on the run's
 *     behalf: no `thread` (server-held conversation state), no `container`, no
 *     `mcp_servers`, and no tool with a `type` other than `custom`, because a
 *     server tool runs at Anthropic, outside the funnel.
 *
 * The engine still sets `thread: false` on its runner; this makes forgetting it
 * a refused request rather than a stored conversation. Storing anything new at
 * Anthropic is a sub-processor step (global rule 3 of the roadmap in
 * `docs/claude-agent-sdk-design.md`), so a widening here is that step's diff.
 */
import Anthropic, { type Middleware } from '@anthropic-ai/sdk';

import { env } from '@/env';
import { anthropicWorkspaceHeaders } from '@/lib/ai/anthropic-workspace';
import {
    anthropicWorkspaceE2eOrigin,
    nextTestModeFlag,
} from '@/app-layer/integrations/providers/anthropic-workspace/e2e-faux';
import { MANAGED_AGENTS_PREAMBLE } from '@/lib/agentic/managed-agents/preamble';
import {
    bindWorkspaceHeaderLatch,
    checkResponseWorkspace,
    newWorkspaceHeaderLatch,
    workspaceHeaderKindOf,
    type WorkspaceHeaderLatch,
} from '@/lib/agentic/managed-agents/workspace-header';
import type { ManagedAgentsWorkspaceKind } from '@/lib/agentic/managed-agents/workspace';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability';
import type { ProfileModelTier } from '@/lib/agentic/agent-profile';
import type { FlueModelSelection } from '@/lib/agentic/flue/model-selection';

/** The Messages API's origin. Pinned, so the environment cannot move a run's traffic. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/**
 * The route a Tool Runner run's model calls take, as the external-AI transfer
 * gate (`external-residency-gate.ts`) reads it (#5364).
 *
 * Its own id, not Flue's `inflect-external`: that names a provider registered
 * in pi-ai's registry, which this engine never touches. The gate treats every
 * id but the local gateway's as outside the deployment, and this one is
 * outside by construction: `clientForRun` builds a client for Anthropic's API
 * or none at all.
 */
export const TOOL_RUNNER_PROVIDER_ID = 'anthropic-messages-api';

/**
 * The per-tenant residency terms: the same three columns, through the same
 * mapper (`residencyTermsFrom`), that the Flue engine reads.
 */
export type ToolRunnerResidencyTerms = FlueModelSelection;

/** Why a run cannot have a client. Each is an operator-actionable gap. */
export type ToolRunnerClientRefusal =
    /** LOCAL_ONLY: this engine speaks only Anthropic's protocol, and no local gateway serves it. */
    | 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED'
    /** EXTERNAL, but `ANTHROPIC_API_KEY` is not configured. */
    | 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED'
    /** `ANTHROPIC_CUSTOM_HEADERS` is set, and the SDK would add it to every request. */
    | 'SDK_AMBIENT_HEADERS_SET';

export type ToolRunnerClientChoice =
    | { ok: true; residency: 'EXTERNAL'; providerId: typeof TOOL_RUNNER_PROVIDER_ID; client: Anthropic }
    | { ok: false; reason: ToolRunnerClientRefusal };

/** The SDK's warnings and errors, in our log, without the arguments it attaches (requests, responses). */
const sdkLogger = {
    error: (message: string) => logger.error(message, { component: 'anthropic-sdk' }),
    warn: (message: string) => logger.warn(message, { component: 'anthropic-sdk' }),
    info: (message: string) => logger.info(message, { component: 'anthropic-sdk' }),
    debug: (message: string) => logger.debug(message, { component: 'anthropic-sdk' }),
};

/** The one API path a run's client may call. */
export const MESSAGES_PATH = '/v1/messages';

/** Body members that ask Anthropic to hold state or call out on the run's behalf. */
const REFUSED_BODY_MEMBERS = ['thread', 'container', 'mcp_servers'] as const;

/** Why `messagesOnlyFor`'s middleware refused a request. */
export type ToolRunnerRequestRefusal =
    | 'NOT_THE_PINNED_ORIGIN'
    | 'NOT_A_MESSAGES_CALL'
    | 'BODY_UNREADABLE'
    | 'SERVER_HELD_STATE'
    | 'SERVER_TOOL';

/**
 * What one outbound request carried, as the run's log records it (Step 2H): the
 * method, the path and the body's top-level member NAMES. Never a value, so no
 * prompt text, tool output or key reaches the log. `threadMember` is the
 * production evidence that no request asked Anthropic to hold the conversation.
 */
export interface RequestShape {
    readonly method: string;
    readonly path: string;
    /** The JSON body's top-level member names, sorted. Empty when the body is not a JSON object. */
    readonly bodyKeys: readonly string[];
    readonly threadMember: 'absent' | 'present';
}

/**
 * The refusal and the shape of one request, from ONE parse of its body. Pure,
 * so every branch is unit-tested without a network.
 */
export function inspectRequest(request: { method?: string; url: string; body?: unknown }): {
    refusal: ToolRunnerRequestRefusal | null;
    shape: RequestShape;
} {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();
    let body: unknown;
    let parsed = false;
    if (typeof request.body === 'string') {
        try {
            body = JSON.parse(request.body);
            parsed = true;
        } catch {
            parsed = false;
        }
    }
    const isObject = parsed && body !== null && typeof body === 'object' && !Array.isArray(body);
    const members = isObject ? (body as Record<string, unknown>) : null;
    const bodyKeys = members ? Object.keys(members).sort() : [];
    const shape: RequestShape = {
        method,
        path: url.pathname,
        bodyKeys,
        threadMember: bodyKeys.includes('thread') ? 'present' : 'absent',
    };
    return { refusal: refusalOf(url, method, members), shape };
}

/** The reason a request may not leave, given its parsed parts. */
function refusalOf(url: URL, method: string, members: Record<string, unknown> | null): ToolRunnerRequestRefusal | null {
    if (url.origin !== ANTHROPIC_API_BASE_URL) return 'NOT_THE_PINNED_ORIGIN';
    if (method !== 'POST' || url.pathname !== MESSAGES_PATH) return 'NOT_A_MESSAGES_CALL';
    if (!members) return 'BODY_UNREADABLE';
    // `null` is the explicit "none", the same as leaving the member out.
    if (REFUSED_BODY_MEMBERS.some((name) => members[name] != null)) return 'SERVER_HELD_STATE';
    const tools = members.tools;
    if (tools !== undefined) {
        if (!Array.isArray(tools)) return 'BODY_UNREADABLE';
        const serverTool = tools.some((tool: unknown) => {
            if (tool === null || typeof tool !== 'object') return true;
            const type = (tool as { type?: unknown }).type;
            return type !== undefined && type !== null && type !== 'custom';
        });
        if (serverTool) return 'SERVER_TOOL';
    }
    return null;
}

/** The reason a request may not leave a run's client, or null when it may. */
export function requestRefusal(request: { method?: string; url: string; body?: unknown }): ToolRunnerRequestRefusal | null {
    return inspectRequest(request).refusal;
}

/**
 * Runs before every request a run's client sends, retries included: logs the
 * request's shape (names only) and refuses what `requestRefusal` refuses.
 */
/**
 * The last request each run client sent, by shape: the run's MODEL_CALL step
 * records it, so the run's page shows what went over the wire (method, path,
 * body key names, whether a `thread` member was there) without anyone reading
 * the worker's log. Keyed by the client, which is the run's alone, and held
 * weakly, so it goes when the client does.
 */
const LAST_REQUEST = new WeakMap<Anthropic, { shape: RequestShape | null }>();

/** The shape of the last request `client` sent, or null before its first. */
export function lastRequestShape(client: Anthropic): RequestShape | null {
    return LAST_REQUEST.get(client)?.shape ?? null;
}

function messagesOnlyFor(run: { readonly runId?: string }, sent: { shape: RequestShape | null }): Middleware {
    return async (request, next) => {
        // Read off named objects, so every logged value is judged by what its
        // property says it is (`local/no-raw-prompt-logging`).
        const inspected = inspectRequest(request);
        sent.shape = inspected.shape;
        logger.info('tool-runner: request', {
            component: 'agentic',
            runId: run.runId,
            method: inspected.shape.method,
            path: inspected.shape.path,
            bodyKeys: inspected.shape.bodyKeys,
            threadMember: inspected.shape.threadMember,
            refused: inspected.refusal,
        });
        if (inspected.refusal) {
            throw forbidden('An agent run\'s Anthropic client sends Messages API calls only.', { reason: inspected.refusal });
        }
        return next(request);
    };
}

/**
 * A new client for one run, chosen from its residency, or the named reason
 * there is none. Never cached: call it once per run and hold the result for
 * that run only.
 */
export function clientForRun(
    selection?: ToolRunnerResidencyTerms,
    opts: { readonly runId?: string } = {},
): ToolRunnerClientChoice {
    // ── HARD residency invariant, checked before anything external ──────────
    if (selection?.residency === 'LOCAL_ONLY') {
        return { ok: false, reason: 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED' };
    }

    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED' };
    if (env.ANTHROPIC_CUSTOM_HEADERS?.trim()) return { ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' };

    const sent: { shape: RequestShape | null } = { shape: null };
    const client = new Anthropic({
        apiKey,
        baseURL: ANTHROPIC_API_BASE_URL,
        // A fresh object per client: no two clients share a headers map.
        defaultHeaders: { ...anthropicWorkspaceHeaders(env.ANTHROPIC_WORKSPACE_ID) },
        webhookKey: null,
        logLevel: 'warn',
        logger: sdkLogger,
        openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
        middleware: [messagesOnlyFor(opts, sent)],
    });
    LAST_REQUEST.set(client, sent);
    return { ok: true, residency: 'EXTERNAL', providerId: TOOL_RUNNER_PROVIDER_ID, client };
}

/** The model each profile tier runs on when the deployment names none. */
export const TOOL_RUNNER_DEFAULT_MODELS: Readonly<Record<ProfileModelTier, string>> = {
    balanced: 'claude-sonnet-5-5',
    deep: 'claude-opus-5-5',
};

/**
 * The model id a profile's tier runs on: the deployment's
 * `AGENT_TOOL_RUNNER_MODEL_BALANCED` / `_DEEP`, else the default. A tier is a
 * deployment choice and never a model id a tenant writes, so a profile cannot
 * name a model this deployment does not offer.
 */
export function toolRunnerModelFor(tier: ProfileModelTier): string {
    const configured: Record<ProfileModelTier, string | undefined> = {
        balanced: env.AGENT_TOOL_RUNNER_MODEL_BALANCED,
        deep: env.AGENT_TOOL_RUNNER_MODEL_DEEP,
    };
    return configured[tier]?.trim() || TOOL_RUNNER_DEFAULT_MODELS[tier];
}

// ─── The Managed Agents engine's client (Step 5b, #4165) ───────────────────
//
// THE ONE CONSTRUCTOR for that engine, in this file because this is the one
// file under `src/` that may load the SDK (`local/anthropic-client-single-seam`).
// It differs from `clientForRun` in the two ways the engine needs and in no
// other:
//
//   • the CREDENTIAL is the customer's, not the deployment's: the run's
//     `anthropic-workspace` connection's decrypted key, with that connection's
//     workspace id in the `anthropic-workspace-id` header
//     (`anthropicWorkspaceHeaders`), as the connection's Test sends it;
//   • the API is Managed Agents, not Messages: `managedAgentsRequestRefusal`
//     admits the agent, environment and session calls the engine makes and
//     nothing else, and Step 5c's clean-up calls: a session list by recorded
//     agent and an agent archive.
//   • every RESPONSE must name the workspace the client was built for
//     (`checkResponseWorkspace`, #5854 finding 4): one naming another fails
//     the call; one naming none passes, counted, until the owner's switch
//     (`REFUSE_MISSING_WORKSPACE_HEADER`) is flipped.
//
// Everything `clientForRun` pins is pinned here the same way: the origin, the
// log level and logger, metadata-only tracing with no propagation, no webhook
// key, and the refusal while `ANTHROPIC_CUSTOM_HEADERS` is set. Residency is
// the driver's, which refuses a LOCAL_ONLY tenant before it reads the
// connection. `tests/unit/agentic/managed-agents-client.test.ts` holds that
// this function is the only construction of a client for the engine.

/** Why the Managed Agents engine cannot have a client. */
export type ManagedAgentsClientRefusal =
    /** The connection holds no usable key. */
    | 'WORKSPACE_KEY_MISSING'
    /** `ANTHROPIC_CUSTOM_HEADERS` is set, and the SDK would add it to every request. */
    | 'SDK_AMBIENT_HEADERS_SET';

export type ManagedAgentsClientChoice =
    | { ok: true; client: Anthropic }
    | { ok: false; reason: ManagedAgentsClientRefusal };

/** Why `managedAgentsRequestRefusal` refused a request. */
export type ManagedAgentsRequestRefusal =
    | 'NOT_THE_PINNED_ORIGIN'
    | 'NOT_A_MANAGED_AGENTS_CALL'
    | 'BODY_UNREADABLE'
    /** An agent body asking for anything but custom tools: a toolset, MCP, skills, sub-agents. */
    | 'AGENT_NOT_CUSTOM_TOOLS_ONLY'
    /** A session asking for vaults, resources, or overriding anything but `system`. */
    | 'SESSION_REACHES_BEYOND_SYSTEM'
    /** An environment that is not `cloud` with `limited` networking and no hosts. */
    | 'ENVIRONMENT_NOT_SEALED'
    /** A session list with no `agent_id`: a list of the customer's whole workspace (Step 5c). */
    | 'SESSION_LIST_NOT_BY_AGENT'
    /**
     * A body carrying a member the engine never sends (Step 5H, #5854): an
     * agent's `description` or `execution_identity`, a tool member beyond the
     * four a custom tool has, a session's `title`, an environment's
     * `description`. Checked against an ALLOWLIST, so a member Anthropic adds
     * later is refused until somebody lists it.
     */
    | 'MEMBER_NOT_ALLOWED'
    /** An agent body whose `system` is not Inflect's preamble, byte for byte (#5854). */
    | 'AGENT_SYSTEM_NOT_PREAMBLE'
    /**
     * A session events POST carrying an event the engine does not send
     * (#5854): anything but `user.message`, `user.custom_tool_result` and
     * `user.interrupt`, such as a `user.tool_confirmation`.
     */
    | 'EVENT_NOT_ENGINE_SENT';

/** Archiving an agent: the one POST the engine sends without a body (Step 5c). */
const ARCHIVE_AGENT = /^\/v1\/agents\/[A-Za-z0-9_-]+\/archive$/;

/**
 * The routes the engine calls, by method, each with the name its responses are
 * counted under (`agentic.managed_agents.workspace_header`, #5854). Anything
 * else is refused.
 */
const MANAGED_AGENTS_ROUTES: ReadonlyArray<{ readonly name: string; readonly method: string; readonly path: RegExp }> = [
    { name: 'agents.create', method: 'POST', path: /^\/v1\/agents$/ },
    { name: 'agents.retrieve', method: 'GET', path: /^\/v1\/agents\/[A-Za-z0-9_-]+$/ },
    { name: 'agents.update', method: 'POST', path: /^\/v1\/agents\/[A-Za-z0-9_-]+$/ },
    { name: 'environments.create', method: 'POST', path: /^\/v1\/environments$/ },
    // A run re-reads its environment before each session (#5854).
    { name: 'environments.retrieve', method: 'GET', path: /^\/v1\/environments\/[A-Za-z0-9_-]+$/ },
    { name: 'sessions.create', method: 'POST', path: /^\/v1\/sessions$/ },
    // Step 5c's crash window: a session list, which the clean-up sends only
    // with an `agent_id` Inflect recorded (`listCrashWindow` in
    // `managed-agents/cleanup.ts`). A list with no `agent_id` is refused below.
    { name: 'sessions.list', method: 'GET', path: /^\/v1\/sessions$/ },
    { name: 'sessions.retrieve', method: 'GET', path: /^\/v1\/sessions\/[A-Za-z0-9_-]+$/ },
    { name: 'sessions.delete', method: 'DELETE', path: /^\/v1\/sessions\/[A-Za-z0-9_-]+$/ },
    { name: 'sessions.events.list', method: 'GET', path: /^\/v1\/sessions\/[A-Za-z0-9_-]+\/events$/ },
    { name: 'sessions.events.send', method: 'POST', path: /^\/v1\/sessions\/[A-Za-z0-9_-]+\/events$/ },
    { name: 'sessions.events.stream', method: 'GET', path: /^\/v1\/sessions\/[A-Za-z0-9_-]+\/events\/stream$/ },
    // Step 5c: archive a recorded agent. It carries no body, so it is answered
    // before the body checks below (`ARCHIVE_AGENT`).
    { name: 'agents.archive', method: 'POST', path: ARCHIVE_AGENT },
];

/**
 * Every name a response is counted under, in route order: the endpoints the
 * workspace-header tally line carries and the `VM check` action
 * `managed-agents-workspace-header` reads (#5962), which a guard holds equal to
 * this list.
 */
export const MANAGED_AGENTS_ENDPOINT_NAMES: readonly string[] = MANAGED_AGENTS_ROUTES.map((r) => r.name);

/** The name of the engine route a request takes, or null for one the engine never calls. */
export function managedAgentsEndpointOf(method: string, pathname: string): string | null {
    const m = method.toUpperCase();
    return MANAGED_AGENTS_ROUTES.find((r) => r.method === m && r.path.test(pathname))?.name ?? null;
}

/**
 * THE MEMBERS EACH BODY MAY CARRY (Step 5H, #5854): exactly what the engine
 * writes (`agentBodyFor`, `environmentBodyFor`, the session create and the
 * events it sends in `execute.ts`), and nothing else. An allowlist, not a
 * denylist: a member nobody listed is refused, so a new one is a reviewed diff
 * here rather than a request that leaves.
 */
const AGENT_CREATE_MEMBERS: ReadonlySet<string> = new Set(['name', 'model', 'system', 'tools', 'metadata']);
/** An update names the version it replaces, for Anthropic's optimistic concurrency. */
const AGENT_UPDATE_MEMBERS: ReadonlySet<string> = new Set([...AGENT_CREATE_MEMBERS, 'version']);
/** A custom tool's four fields (`ManagedAgentCustomTool`). */
const CUSTOM_TOOL_MEMBERS: ReadonlySet<string> = new Set(['type', 'name', 'description', 'input_schema']);
const ENVIRONMENT_MEMBERS: ReadonlySet<string> = new Set(['name', 'config', 'metadata']);
const SESSION_MEMBERS: ReadonlySet<string> = new Set(['agent', 'environment_id', 'budget', 'metadata']);
const EVENTS_POST_MEMBERS: ReadonlySet<string> = new Set(['events']);
/** The events the engine sends a session, and each one's members. */
const ENGINE_SENT_EVENTS: Readonly<Record<string, ReadonlySet<string>>> = {
    'user.message': new Set(['type', 'content']),
    'user.custom_tool_result': new Set(['type', 'custom_tool_use_id', 'is_error', 'content']),
    'user.interrupt': new Set(['type']),
};

/** Every key of `value` is in `allowed`. */
function onlyMembers(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every((k) => allowed.has(k));
}

/** A plain JSON object, not an array or `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Present and not an empty list or `null`: what "asks for it" means for an optional body member. */
function asksFor(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

/**
 * The reason a request may not leave a Managed Agents client, or null when it
 * may. Pure, so every branch is unit-tested without a network.
 */
export function managedAgentsRequestRefusal(
    request: { method?: string; url: string; body?: unknown },
    /** The origin the client was built for: `managedAgentsOrigin()`, Anthropic's everywhere but a Playwright run. */
    origin: string = ANTHROPIC_API_BASE_URL,
): ManagedAgentsRequestRefusal | null {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();
    if (url.origin !== origin) return 'NOT_THE_PINNED_ORIGIN';
    if (managedAgentsEndpointOf(method, url.pathname) === null) return 'NOT_A_MANAGED_AGENTS_CALL';
    // A session list must name a recorded agent: the clean-up never lists a
    // customer's whole workspace (Step 5c).
    if (method === 'GET' && url.pathname === '/v1/sessions') {
        return url.searchParams.get('agent_id') ? null : 'SESSION_LIST_NOT_BY_AGENT';
    }
    if (method !== 'POST') return null;
    // Archive takes no body: exempt from the body checks, and only this path.
    if (ARCHIVE_AGENT.test(url.pathname)) return null;
    let members: Record<string, unknown>;
    try {
        const parsed: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : null;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'BODY_UNREADABLE';
        members = parsed as Record<string, unknown>;
    } catch {
        return 'BODY_UNREADABLE';
    }
    if (url.pathname.startsWith('/v1/agents')) {
        if (asksFor(members.mcp_servers) || asksFor(members.multiagent) || asksFor(members.skills)) {
            return 'AGENT_NOT_CUSTOM_TOOLS_ONLY';
        }
        const tools = members.tools;
        if (tools !== undefined && tools !== null) {
            if (!Array.isArray(tools)) return 'BODY_UNREADABLE';
            const notCustom = tools.some(
                (t: unknown) => t === null || typeof t !== 'object' || (t as { type?: unknown }).type !== 'custom',
            );
            if (notCustom) return 'AGENT_NOT_CUSTOM_TOOLS_ONLY';
            if (tools.some((t: Record<string, unknown>) => !onlyMembers(t, CUSTOM_TOOL_MEMBERS))) return 'MEMBER_NOT_ALLOWED';
        }
        const allowed = url.pathname === '/v1/agents' ? AGENT_CREATE_MEMBERS : AGENT_UPDATE_MEMBERS;
        if (!onlyMembers(members, allowed)) return 'MEMBER_NOT_ALLOWED';
        // The agent holds Inflect's text and nothing else: absent is refused
        // too, so an update can never leave a Console-written `system` in place.
        if (members.system !== MANAGED_AGENTS_PREAMBLE) return 'AGENT_SYSTEM_NOT_PREAMBLE';
        return null;
    }
    if (url.pathname === '/v1/environments') {
        if (!onlyMembers(members, ENVIRONMENT_MEMBERS)) return 'MEMBER_NOT_ALLOWED';
        const config = members.config as { type?: unknown; networking?: Record<string, unknown> | null; packages?: unknown } | undefined;
        const net = config?.networking;
        const sealed =
            config?.type === 'cloud' &&
            net != null &&
            net.type === 'limited' &&
            !asksFor(net.allowed_hosts) &&
            net.allow_mcp_servers !== true &&
            net.allow_package_managers !== true &&
            !asksFor(config.packages);
        return sealed ? null : 'ENVIRONMENT_NOT_SEALED';
    }
    if (url.pathname === '/v1/sessions') {
        if (asksFor(members.vault_ids) || asksFor(members.resources)) return 'SESSION_REACHES_BEYOND_SYSTEM';
        if (!onlyMembers(members, SESSION_MEMBERS)) return 'MEMBER_NOT_ALLOWED';
        const agent = members.agent;
        if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) return 'SESSION_REACHES_BEYOND_SYSTEM';
        const allowed = new Set(['type', 'id', 'version', 'system']);
        const keys = Object.keys(agent as Record<string, unknown>);
        if ((agent as { type?: unknown }).type !== 'agent_with_overrides' || keys.some((k) => !allowed.has(k))) {
            return 'SESSION_REACHES_BEYOND_SYSTEM';
        }
        return null;
    }
    // A session's events: a user message, a tool result, an interrupt, and
    // nothing else (#5854). A `user.tool_confirmation`, for one, would approve a
    // built-in tool call the agent cannot hold.
    if (!onlyMembers(members, EVENTS_POST_MEMBERS)) return 'MEMBER_NOT_ALLOWED';
    const events = members.events;
    if (!Array.isArray(events)) return 'BODY_UNREADABLE';
    for (const event of events) {
        if (!isRecord(event)) return 'BODY_UNREADABLE';
        const type = event.type;
        const eventMembers =
            typeof type === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_SENT_EVENTS, type)
                ? ENGINE_SENT_EVENTS[type]
                : undefined;
        if (!eventMembers) return 'EVENT_NOT_ENGINE_SENT';
        if (!onlyMembers(event, eventMembers)) return 'MEMBER_NOT_ALLOWED';
    }
    return null;
}

function managedAgentsOnlyFor(run: {
    readonly runId?: string;
    readonly origin: string;
    /** The workspace the client was built for: every response must name it (#5854). */
    readonly workspaceId: string;
    readonly latch: WorkspaceHeaderLatch;
}): Middleware {
    return async (request, next) => {
        const url = new URL(request.url);
        // Log fields are read off this object, so each value's name is its own.
        const verdict = {
            method: (request.method ?? 'GET').toUpperCase(),
            refusal: managedAgentsRequestRefusal(request, run.origin),
        };
        logger.info('managed-agents: request', {
            component: 'agentic',
            runId: run.runId,
            method: verdict.method,
            path: url.pathname,
            refused: verdict.refusal,
        });
        if (verdict.refusal) {
            throw forbidden('A Managed Agents run\'s client sends the engine\'s own calls only.', { reason: verdict.refusal });
        }
        const response = await next(request);
        // THE RESPONSE NAMES ITS WORKSPACE (#5854 finding 4, owner decision
        // 2026-11-25), checked here, the one place every Managed Agents
        // response passes, before the SDK reads a byte of it: the event
        // stream's headers too. Another workspace fails the call; none passes,
        // counted (`workspace-header.ts`).
        checkResponseWorkspace(response, {
            configuredWorkspaceId: run.workspaceId,
            // Never null here: the refusal above admits only the engine's routes.
            endpoint: managedAgentsEndpointOf(verdict.method, url.pathname) ?? 'unknown',
            method: verdict.method,
            runId: run.runId,
            latch: run.latch,
        });
        return response;
    };
}

/**
 * WHERE A MANAGED AGENTS CLIENT SENDS: `https://api.anthropic.com`, and in a
 * Playwright run only, the loopback faux (Step 5d, #4167).
 *
 * The provider's Test (Step 5a) already dials the faux through the same seam,
 * `anthropicWorkspaceE2eOrigin`, and this extends it to the engine's own calls
 * so an end-to-end run can provision, run and delete against it. Nothing a
 * tenant writes is read: the answer needs BOTH `NEXT_TEST_MODE=1` and
 * `AUTH_TEST_MODE=1` on the process, and the faux address is a constant on
 * loopback. No configuration names the host, as for every tenant-writable path
 * of the provider.
 */
export function managedAgentsOrigin(): string {
    return (
        anthropicWorkspaceE2eOrigin({ nextTestMode: nextTestModeFlag(), authTestMode: env.AUTH_TEST_MODE }) ??
        ANTHROPIC_API_BASE_URL
    );
}

/**
 * A new client for one Managed Agents run, keyed with the customer's
 * workspace key, or the named reason there is none. Never cached.
 */
export function managedAgentsClientFor(input: {
    readonly apiKey: string;
    readonly workspaceId: string;
    /** Whose workspace it is: the tally line names it (#5962). */
    readonly workspaceKind: ManagedAgentsWorkspaceKind;
    readonly runId?: string;
}): ManagedAgentsClientChoice {
    const apiKey = input.apiKey.trim();
    if (!apiKey) return { ok: false, reason: 'WORKSPACE_KEY_MISSING' };
    if (env.ANTHROPIC_CUSTOM_HEADERS?.trim()) return { ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' };
    const origin = managedAgentsOrigin();
    const latch = newWorkspaceHeaderLatch(workspaceHeaderKindOf(input.workspaceKind));
    const client = new Anthropic({
        apiKey,
        baseURL: origin,
        defaultHeaders: { ...anthropicWorkspaceHeaders(input.workspaceId) },
        webhookKey: null,
        logLevel: 'warn',
        logger: sdkLogger,
        openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
        middleware: [managedAgentsOnlyFor({ runId: input.runId, origin, workspaceId: input.workspaceId, latch })],
    });
    bindWorkspaceHeaderLatch(client, latch);
    return { ok: true, client };
}
