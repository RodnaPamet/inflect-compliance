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
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability';
import type { ProfileModelTier } from '@/lib/agentic/agent-profile';
import type { FlueModelSelection } from '@/lib/agentic/flue/model-selection';

/** The Messages API's origin. Pinned, so the environment cannot move a run's traffic. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

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
    | { ok: true; residency: 'EXTERNAL'; client: Anthropic }
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
    return { ok: true, residency: 'EXTERNAL', client };
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
