/**
 * The A2A wire shapes this build speaks, and nothing else (#3679).
 *
 * A2A is JSON-RPC 2.0 over HTTPS. This module parses what a peer sends Inflect
 * and builds what Inflect sends a peer, against CLOSED method sets — the A2A
 * counterpart of the legacy-access client's `CLIENT_METHODS`
 * (`docs/a2a-threat-model.md` O4 E). The MCP clients cannot send an A2A method
 * and this cannot send `tools/*`.
 *
 * ## What is refused, and why each is a refusal rather than a skip
 *
 *  - A FILE part. It carries bytes or a URI, and a URI is an address the peer
 *    chose for Inflect to dial (R10). Nothing here dials one.
 *  - A push-notification configuration. It is a URL the peer chose for Inflect
 *    to call back (O6 I). Results are fetched over the one wire instead.
 *  - Streaming (`message/stream`) and every other method. A held-open stream is
 *    a way to keep a worker busy, and nothing here needs it.
 *  - Text over `A2A_MAX_TEXT_CHARS` and data that is not a flat map of short
 *    strings. A task is a request for work, not a payload (R20).
 *
 * Dropping any of these silently would hand a peer a request that means
 * something other than what it sent; refusing names the shape.
 *
 * This module is PURE: no I/O, no Prisma.
 */
import { z } from 'zod';

import type { A2aMethod } from './receipt';

/** The methods a peer may send Inflect. */
export const A2A_INBOUND_METHODS: ReadonlySet<A2aMethod> = new Set<A2aMethod>(['message/send', 'tasks/get']);

/**
 * The methods Inflect's client may send a peer. Results come back on the send,
 * and `tasks/get` asks after a task the peer accepted and had not finished
 * (#3743): a read, never a write.
 */
export const A2A_CLIENT_METHODS: ReadonlySet<A2aMethod> = new Set<A2aMethod>(['message/send', 'tasks/get']);

/** A request body over this is refused before it is parsed (R4, I1 D). */
export const A2A_MAX_BODY_BYTES = 64 * 1024;

/** A response body from a peer is read with this cap, which aborts. */
export const A2A_MAX_RESPONSE_BYTES = 256 * 1024;

/** All text parts of one message, together. */
export const A2A_MAX_TEXT_CHARS = 16_000;

/** A data part: at most this many keys, each value a string of at most this length. */
export const A2A_MAX_DATA_KEYS = 16;
export const A2A_MAX_DATA_VALUE_CHARS = 512;

const TextPart = z.object({ kind: z.literal('text'), text: z.string(), metadata: z.unknown().optional() }).strict();
const DataPart = z
    .object({ kind: z.literal('data'), data: z.record(z.string(), z.unknown()), metadata: z.unknown().optional() })
    .strict();
const AnyPart = z.object({ kind: z.string() }).passthrough();

const MessageSchema = z
    .object({
        kind: z.literal('message'),
        role: z.enum(['user', 'agent']),
        messageId: z.string().min(1).max(128),
        contextId: z.string().min(1).max(128).optional(),
        taskId: z.string().min(1).max(128).optional(),
        parts: z.array(AnyPart).min(1).max(32),
        metadata: z.record(z.string(), z.unknown()).optional(),
        referenceTaskIds: z.array(z.string().max(128)).max(8).optional(),
        extensions: z.array(z.string().max(256)).max(8).optional(),
    })
    .strict();

const SendParamsSchema = z
    .object({
        message: MessageSchema,
        configuration: z
            .object({
                blocking: z.boolean().optional(),
                acceptedOutputModes: z.array(z.string().max(128)).max(16).optional(),
                historyLength: z.number().int().min(0).max(100).optional(),
                pushNotificationConfig: z.unknown().optional(),
            })
            .strict()
            .optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

const GetParamsSchema = z
    .object({
        id: z.string().min(1).max(128),
        historyLength: z.number().int().min(0).max(100).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

const EnvelopeSchema = z
    .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string().max(128), z.number().int()]),
        method: z.string().max(64),
        params: z.unknown(),
    })
    .strict();

export type A2aInboundRefusal =
    | 'NOT_JSON'
    | 'NOT_JSONRPC'
    | 'METHOD_REFUSED'
    | 'PARAMS_INVALID'
    | 'FILE_PART_REFUSED'
    | 'PART_KIND_REFUSED'
    | 'PUSH_NOTIFICATION_REFUSED'
    | 'TEXT_TOO_LARGE'
    | 'DATA_REFUSED'
    | 'WORKFLOW_NOT_NAMED';

export type A2aInboundRequest =
    | {
          readonly method: 'message/send';
          readonly rpcId: string | number;
          readonly messageId: string;
          readonly contextId: string | null;
          readonly workflowKey: string;
          /** Every text part, joined with a blank line. Third-party content. */
          readonly text: string;
          /** Every data part, merged. Third-party content; values are short strings. */
          readonly data: Readonly<Record<string, string>>;
      }
    | {
          readonly method: 'tasks/get';
          readonly rpcId: string | number;
          readonly taskId: string;
      };

export type A2aInboundParse =
    | { readonly ok: true; readonly request: A2aInboundRequest }
    | {
          readonly ok: false;
          readonly reason: A2aInboundRefusal;
          readonly rpcId: string | number | null;
          /**
           * The method name as RECEIVED, on `METHOD_REFUSED` only (#3866).
           *
           * Echoed so a caller can name the spec's own error for a v1.0
           * operation this build does not serve — `UnsupportedOperationError`
           * rather than a generic refusal — without parsing the body twice.
           */
          readonly method?: string;
      };

/**
 * Parse a peer's request. Called only after the peer is authenticated, its
 * signature verified and its card admitted: this is the first read of content.
 */
export function parseA2aInboundRequest(
    body: string,
    /**
     * v1.0 method names to rewrite to their v0.3 equivalents before the method
     * set is checked (#3866). Passed only for a v1.0 caller.
     *
     * An ALIAS applied here rather than a rewrite of the body, because the body
     * is evidence: `HostConsumerMessage` keeps the exact bytes received, and a
     * request whose stored bytes differ from what arrived is not evidence of
     * what arrived.
     */
    methodAliases: Readonly<Record<string, string>> = {},
): A2aInboundParse {
    let raw: unknown;
    try {
        raw = JSON.parse(body);
    } catch {
        return { ok: false, reason: 'NOT_JSON', rpcId: null };
    }
    const env = EnvelopeSchema.safeParse(raw);
    if (!env.success) return { ok: false, reason: 'NOT_JSONRPC', rpcId: null };
    const rpcId = env.data.id;
    const method = methodAliases[env.data.method] ?? env.data.method;
    if (!A2A_INBOUND_METHODS.has(method as A2aMethod)) {
        return { ok: false, reason: 'METHOD_REFUSED', rpcId, method: env.data.method };
    }

    if (method === 'tasks/get') {
        const p = GetParamsSchema.safeParse(env.data.params);
        if (!p.success) return { ok: false, reason: 'PARAMS_INVALID', rpcId };
        return { ok: true, request: { method: 'tasks/get', rpcId, taskId: p.data.id } };
    }

    const p = SendParamsSchema.safeParse(env.data.params);
    if (!p.success) return { ok: false, reason: 'PARAMS_INVALID', rpcId };
    if (p.data.configuration?.pushNotificationConfig !== undefined) {
        return { ok: false, reason: 'PUSH_NOTIFICATION_REFUSED', rpcId };
    }

    const texts: string[] = [];
    const data: Record<string, string> = {};
    for (const part of p.data.message.parts) {
        if (part.kind === 'file') return { ok: false, reason: 'FILE_PART_REFUSED', rpcId };
        if (part.kind === 'text') {
            const t = TextPart.safeParse(part);
            if (!t.success) return { ok: false, reason: 'PARAMS_INVALID', rpcId };
            texts.push(t.data.text);
            continue;
        }
        if (part.kind === 'data') {
            const d = DataPart.safeParse(part);
            if (!d.success) return { ok: false, reason: 'PARAMS_INVALID', rpcId };
            for (const [k, v] of Object.entries(d.data.data)) {
                if (typeof v !== 'string' || v.length > A2A_MAX_DATA_VALUE_CHARS || k.length > 64) {
                    return { ok: false, reason: 'DATA_REFUSED', rpcId };
                }
                data[k] = v;
            }
            if (Object.keys(data).length > A2A_MAX_DATA_KEYS) return { ok: false, reason: 'DATA_REFUSED', rpcId };
            continue;
        }
        return { ok: false, reason: 'PART_KIND_REFUSED', rpcId };
    }
    const text = texts.join('\n\n');
    if (text.length > A2A_MAX_TEXT_CHARS) return { ok: false, reason: 'TEXT_TOO_LARGE', rpcId };

    const workflowKey = p.data.message.metadata?.workflowKey;
    if (typeof workflowKey !== 'string' || workflowKey.trim() === '' || workflowKey.length > 128) {
        return { ok: false, reason: 'WORKFLOW_NOT_NAMED', rpcId };
    }

    return {
        ok: true,
        request: {
            method: 'message/send',
            rpcId,
            messageId: p.data.message.messageId,
            contextId: p.data.message.contextId ?? null,
            workflowKey,
            text,
            data,
        },
    };
}

/** The A2A task states a run maps onto. */
export type A2aTaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected';

/**
 * A run's status as an A2A task state. A run waiting on a person in THIS
 * tenant is `working`, not `input-required`: the input it waits for is an
 * approval the peer cannot give.
 */
export function taskStateForRunStatus(status: string): A2aTaskState {
    switch (status) {
        case 'COMPLETED':
            return 'completed';
        case 'FAILED':
            return 'failed';
        case 'ABORTED':
            return 'canceled';
        case 'RUNNING':
        case 'AWAITING_APPROVAL':
        case 'PAUSED':
            return 'working';
        default:
            // An unknown status is not a success.
            return 'failed';
    }
}

/** A JSON-RPC success envelope. */
export function a2aResult(rpcId: string | number | null, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: rpcId, result });
}

/**
 * A JSON-RPC error. One generic message for every refusal (pinning rule 7,
 * I5 I): the reason goes to the audit row, never back to the peer.
 */
export function a2aRefusal(rpcId: string | number | null): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        error: {
            code: -32001,
            message:
                'Refused. If this peer or its agent card changed, it must be re-approved by the '
                + 'organisation that registered it.',
        },
    });
}

// ── Outbound ──────────────────────────────────────────────────────────────

export interface A2aOutboundSend {
    readonly rpcId: string;
    readonly messageId: string;
    readonly text: string;
    readonly contextId?: string | null;
    readonly taskId?: string | null;
    /** Which of the PEER's skills the task is for, when its card names several. */
    readonly skillId?: string | null;
}

/** The body of one `message/send` Inflect sends. Built here so the method set stays closed. */
export function buildA2aSendBody(send: A2aOutboundSend): string {
    const method: A2aMethod = 'message/send';
    if (!A2A_CLIENT_METHODS.has(method)) throw new Error('a2a client: message/send is not in the method set');
    const message: Record<string, unknown> = {
        kind: 'message',
        role: 'user',
        messageId: send.messageId,
        parts: [{ kind: 'text', text: send.text }],
    };
    if (send.contextId) message.contextId = send.contextId;
    if (send.taskId) message.taskId = send.taskId;
    if (send.skillId) message.metadata = { skillId: send.skillId };
    return JSON.stringify({
        jsonrpc: '2.0',
        id: send.rpcId,
        method,
        params: { message, configuration: { blocking: true } },
    });
}

/**
 * The body of one `tasks/get` Inflect sends (#3743): the peer's own task id and
 * nothing else. No history is asked for, because only the state is read.
 */
export function buildA2aTaskGetBody(get: { readonly rpcId: string; readonly taskId: string }): string {
    const method: A2aMethod = 'tasks/get';
    if (!A2A_CLIENT_METHODS.has(method)) throw new Error('a2a client: tasks/get is not in the method set');
    return JSON.stringify({ jsonrpc: '2.0', id: get.rpcId, method, params: { id: get.taskId } });
}

export type A2aPeerReply =
    | { readonly kind: 'task'; readonly taskId: string; readonly contextId: string | null; readonly state: string }
    | { readonly kind: 'message' }
    | { readonly kind: 'error'; readonly code: number }
    | { readonly kind: 'malformed' };

/**
 * Read a peer's answer to a send. Only the fields the journal settles on are
 * taken; the rest of the body is kept verbatim on the receipt row and never
 * interpreted here.
 */
export function parseA2aPeerReply(body: string, expectRpcId: string): A2aPeerReply {
    let raw: unknown;
    try {
        raw = JSON.parse(body);
    } catch {
        return { kind: 'malformed' };
    }
    if (!raw || typeof raw !== 'object') return { kind: 'malformed' };
    const r = raw as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
    if (r.jsonrpc !== '2.0' || r.id !== expectRpcId) return { kind: 'malformed' };
    if (r.error && typeof r.error === 'object') {
        const code = (r.error as { code?: unknown }).code;
        return { kind: 'error', code: typeof code === 'number' ? code : 0 };
    }
    const result = r.result as { kind?: unknown; id?: unknown; contextId?: unknown; status?: { state?: unknown } } | undefined;
    if (!result || typeof result !== 'object') return { kind: 'malformed' };
    if (result.kind === 'message') return { kind: 'message' };
    if (result.kind === 'task' && typeof result.id === 'string' && typeof result.status?.state === 'string') {
        return {
            kind: 'task',
            taskId: result.id.slice(0, 128),
            contextId: typeof result.contextId === 'string' ? result.contextId.slice(0, 128) : null,
            state: result.status.state.slice(0, 32),
        };
    }
    return { kind: 'malformed' };
}
