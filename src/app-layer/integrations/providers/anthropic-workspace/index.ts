/**
 * `anthropic-workspace` — the customer's own Anthropic workspace, connected so
 * that Inflect can later run Managed Agents in it (Step 5a of
 * docs/claude-managed-agents-design.md, shape MA-C2).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHOSE WORKSPACE THIS IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The CUSTOMER'S. Anthropic acts as the customer's own processor, used at the
 * customer's direction (owner decision 5, 2026-10-30), and the row in
 * docs/sub-processors.md says so. This step stores the key and tests it, and
 * nothing more: no agent, environment or session is created here. Steps 5b–5d
 * build and switch on what does.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOST IS FIXED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every request goes to `https://api.anthropic.com`, resolved through
 * `resolveVendorOrigin` over `ANTHROPIC_API_HOSTS`, which names that one host.
 * The configuration's `apiHost` is a `vendorOrigin` field that no surface
 * offers for typing; a value naming any other host is refused at save
 * (`validateProviderConfig`) AND here, before any request, because a Test of
 * an unsaved configuration never passes the save-time validator. The one
 * exception is `e2e-faux.ts`, which only a Playwright run can reach.
 *
 * Every request goes through `safeFetch`, the egress guard every outbound sink
 * on a tenant-held credential uses (`tests/guards/ssrf-egress-coverage.test.ts`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT TEST DOES: ONE READ, NOTHING WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET /v1/agents?limit=1` — list at most one agent. It creates nothing in the
 * workspace, and this module imports no database client, so it writes no row in
 * Inflect either. It never calls `markAuthFailure`: an operator pressing Test
 * with a half-pasted key must not flag the connection's credential as broken,
 * which only a background job nobody is watching is entitled to conclude (the
 * `legacy-mcp` provider gives the same reasoning). The agent it may read is not
 * kept, returned or logged: only the SHAPE of the answer is checked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WORKSPACE HEADER, AND WHY A KEY FOR ANOTHER WORKSPACE FAILS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every request carries `anthropic-workspace-id: <the configured id>`
 * (`anthropicWorkspaceHeaders`). An organisation-level key is refused by
 * Anthropic without it ("This API key is not scoped to a workspace, so this
 * request must include the anthropic-workspace-id header…", seen for real on
 * 2026-11-14), and with it the key acts in the workspace the card names. A
 * workspace-scoped key acts in its own workspace.
 *
 * Either way the RESPONSE names the workspace the work ran in, in its own
 * `anthropic-workspace-id` header, and a Test passes only when that names the
 * configured workspace. A key for a different workspace is therefore refused
 * however Anthropic treats the request header, and an answer that names no
 * workspace at all is refused too (`WORKSPACE_UNCONFIRMED`): a Test that
 * cannot say which workspace it reached has not shown the one on the card.
 *
 * Nothing Anthropic writes is shown to the operator. Each outcome is a fixed
 * sentence of ours, chosen from the status and the error type alone.
 *
 * @module app-layer/integrations/providers/anthropic-workspace
 */

import { env } from '@/env';
import { safeFetch } from '@/app-layer/automation/webhook-safety';
import { ANTHROPIC_API_HOSTS, resolveVendorOrigin } from '../../allowed-host';
import { ANTHROPIC_WORKSPACE_ID_SHAPE } from '../../config-schema';
import { anthropicWorkspaceHeaders, answeredWorkspace } from '@/lib/ai/anthropic-workspace';
import { recordAnthropicWorkspaceValidation } from '@/lib/observability/integration-metrics';
import type {
    ConnectionConfigSchema,
    ConnectionValidationResult,
    IntegrationProvider,
} from '../../types';
import { anthropicWorkspaceE2eOrigin, nextTestModeFlag } from './e2e-faux';

export const ANTHROPIC_WORKSPACE_PROVIDER_ID = 'anthropic-workspace';

/** The one host. `apiHost` absent means this. */
export const ANTHROPIC_API_HOST = 'api.anthropic.com';

/** Both as the Managed Agents reference documents them (`curl/managed-agents.md`). */
export const ANTHROPIC_API_VERSION = '2026-10-21';
export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

/** The read Test makes: list at most one agent. */
export const LIST_ONE_AGENT_PATH = '/v1/agents?limit=1';

/** A one-agent page is small; anything this large is not one. */
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * How a Test ended. Closed, and each maps to one sentence an operator can act
 * on (`OPERATOR_MESSAGE`) and to one metric label.
 */
export type AnthropicWorkspaceProbeOutcome =
    | 'VALID'
    | 'CONFIG_INCOMPLETE'
    | 'CONFIG_REFUSED'
    | 'KEY_INVALID'
    | 'KEY_NOT_WORKSPACE_SCOPED'
    | 'KEY_REFUSED_FOR_WORKSPACE'
    | 'WRONG_WORKSPACE'
    | 'WORKSPACE_UNCONFIRMED'
    | 'RATE_LIMITED'
    | 'UNREACHABLE'
    | 'UNEXPECTED_RESPONSE';

const OPERATOR_MESSAGE: Record<Exclude<AnthropicWorkspaceProbeOutcome, 'VALID'>, string> = {
    CONFIG_INCOMPLETE: 'Enter the workspace ID and the API key.',
    CONFIG_REFUSED:
        'This configuration is not accepted: the workspace ID must look like wrkspc_…, and '
        + 'the connection only ever talks to api.anthropic.com.',
    KEY_INVALID: 'Anthropic did not accept this API key. Check the key and enter it again.',
    KEY_NOT_WORKSPACE_SCOPED:
        'This API key is not tied to a workspace, and Anthropic did not place it in the '
        + 'workspace on this card. Check the workspace ID, or create the key inside the '
        + 'workspace in the Anthropic Console.',
    KEY_REFUSED_FOR_WORKSPACE:
        'Anthropic refused this key for the workspace on this card. The key may belong to '
        + 'another workspace, or may not be allowed to use agents.',
    WRONG_WORKSPACE:
        'This API key belongs to a different workspace than the one on this card. Use a key '
        + 'created in that workspace, or correct the workspace ID.',
    WORKSPACE_UNCONFIRMED:
        'Anthropic answered, but did not say which workspace the key belongs to, so the '
        + 'workspace on this card is not confirmed. Try again later.',
    RATE_LIMITED: 'Anthropic is limiting requests from your organisation. Try again in a minute.',
    UNREACHABLE: 'Could not reach Anthropic. Try again later.',
    UNEXPECTED_RESPONSE: 'Anthropic answered in a way this connection does not recognise. Try again later.',
};

/** The words Anthropic uses for an organisation-level key with no workspace header. */
const NOT_SCOPED_PHRASE = 'not scoped to a workspace';

export class AnthropicWorkspaceProvider implements IntegrationProvider {
    readonly id = ANTHROPIC_WORKSPACE_PROVIDER_ID;
    readonly displayName = 'Anthropic workspace';
    readonly description =
        'Your own Anthropic workspace, where Inflect will run agents that need a sandbox. '
        + 'Anthropic acts as your processor, at your direction. Connecting it stores a key and '
        + 'creates nothing in the workspace.';

    /** EMPTY: this connection runs no compliance check. It holds a key for an engine. */
    readonly supportedChecks: string[] = [];

    /** A real authenticated read happens below. */
    readonly liveValidation = true;
    // Nothing in this repo records a Test against a live workspace yet.
    readonly mappingVerifiedBy = null;

    readonly setupGuide =
        'Create an API key inside the Anthropic workspace you want Inflect to use, and copy the '
        + 'workspace ID (wrkspc_…) from the Anthropic Console. Testing the connection lists at most '
        + 'one agent in that workspace and changes nothing. The key is encrypted at rest and is '
        + 'never shown again.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            {
                key: 'workspaceId',
                label: 'Workspace ID',
                type: 'string',
                required: true,
                description: 'The ID of your Anthropic workspace, from the Anthropic Console.',
                placeholder: 'wrkspc_…',
            },
            {
                key: 'keepSessions',
                label: 'Keep sessions in my workspace',
                type: 'boolean',
                required: false,
                description:
                    'Off by default: each session is deleted when its run ends. A kept session is '
                    + 'still deleted when the workspace is purged, when this connection is removed, '
                    + 'and on a data-subject erasure request.',
            },
            {
                key: 'apiHost',
                label: 'API host',
                type: 'string',
                required: false,
                description: 'Fixed to api.anthropic.com. No other host is accepted.',
            },
        ],
        secretFields: [
            {
                key: 'apiKey',
                label: 'API key',
                type: 'string',
                required: true,
                description:
                    'An API key created inside the workspace. It is encrypted at rest and is never '
                    + 'returned by the API, shown in a message or written to a log line.',
            },
        ],
    };

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const outcome = await probeAnthropicWorkspace(config, secrets);
        recordAnthropicWorkspaceValidation({ outcome: outcome.toLowerCase() });
        return outcome === 'VALID' ? { valid: true } : { valid: false, error: OPERATOR_MESSAGE[outcome] };
    }
}

/**
 * The Test itself, as an outcome. Exported for the unit tests, which drive it
 * over a faux transport (a mocked `safeFetch`) rather than a mock of this code.
 */
export async function probeAnthropicWorkspace(
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
): Promise<AnthropicWorkspaceProbeOutcome> {
    const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId.trim() : '';
    const apiKey = typeof secrets.apiKey === 'string' ? secrets.apiKey.trim() : '';
    if (!workspaceId || !apiKey) return 'CONFIG_INCOMPLETE';

    // Shape and host BEFORE any request: a Test of an unsaved configuration
    // never passed `validateProviderConfig`, so this is where an unsaved
    // `apiHost: 'evil.example'` is refused.
    if (!ANTHROPIC_WORKSPACE_ID_SHAPE.test(workspaceId)) return 'CONFIG_REFUSED';
    if (/[\r\n]/.test(apiKey)) return 'CONFIG_REFUSED';
    let origin: string;
    try {
        const host = typeof config.apiHost === 'string' && config.apiHost.trim() ? config.apiHost : ANTHROPIC_API_HOST;
        origin = resolveVendorOrigin(host, ANTHROPIC_API_HOSTS);
    } catch {
        return 'CONFIG_REFUSED';
    }

    let res: Response;
    try {
        res = await send(`${origin}${LIST_ONE_AGENT_PATH}`, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
                'anthropic-beta': MANAGED_AGENTS_BETA,
                ...anthropicWorkspaceHeaders(workspaceId),
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        // A refused destination, a DNS failure, a timeout, a reset: none of them
        // says anything about the key, so none is reported as if it did.
        return 'UNREACHABLE';
    }

    const body = await readCappedJson(res);

    if (res.ok) {
        if (!isAgentPage(body)) return 'UNEXPECTED_RESPONSE';
        // The one comparison, which the engine's client also asks of every
        // response (#5854 finding 4).
        const answered = answeredWorkspace(res.headers, workspaceId);
        if (answered === 'MISSING') return 'WORKSPACE_UNCONFIRMED';
        return answered === 'MATCH' ? 'VALID' : 'WRONG_WORKSPACE';
    }

    if (res.status === 401) return 'KEY_INVALID';
    if (res.status === 403) return 'KEY_REFUSED_FOR_WORKSPACE';
    if (res.status === 429) return 'RATE_LIMITED';
    if (res.status >= 500) return 'UNREACHABLE';
    if (res.status === 400 && errorMessageOf(body).toLowerCase().includes(NOT_SCOPED_PHRASE)) {
        return 'KEY_NOT_WORKSPACE_SCOPED';
    }
    return 'UNEXPECTED_RESPONSE';
}

/**
 * Where the request goes: `safeFetch` to the vendor origin, or — in a
 * Playwright run only — the loopback faux (`e2e-faux.ts`). An explicit branch,
 * so `safeFetch(` stays in this file for the egress guard to see and the one
 * unguarded path is visibly the test seam.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
    const faux = anthropicWorkspaceE2eOrigin({
        nextTestMode: nextTestModeFlag(),
        authTestMode: env.AUTH_TEST_MODE,
    });
    if (faux) {
        const { pathname, search } = new URL(url);
        return fetch(`${faux}${pathname}${search}`, { ...init, redirect: 'manual' });
    }
    return safeFetch(url, init);
}

/**
 * The body as JSON, or null — read through a byte cap that STOPS at the cap,
 * never `res.json()`, which has buffered the whole body before anything could
 * measure it.
 */
async function readCappedJson(res: Response): Promise<unknown> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return null;
    }
    const stream = res.body;
    if (!stream) return null;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

/** A page of the agents list: an object whose `data` is an array. Its contents are not read. */
function isAgentPage(body: unknown): boolean {
    return typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data);
}

/** Anthropic's error message, for CLASSIFICATION only — it is never shown or logged. */
function errorMessageOf(body: unknown): string {
    if (typeof body !== 'object' || body === null) return '';
    const error = (body as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return '';
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
}
