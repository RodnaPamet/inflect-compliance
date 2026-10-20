/**
 * AN IN-PROCESS A2A PEER, for the tests of #3679. Never a real network.
 *
 * It is another organisation's agent as Inflect sees it: an agent card served
 * at a card URL, a service endpoint that takes `message/send`, and an Ed25519
 * key it signs with. It is reached ONLY through the `fetchImpl` seams of the
 * card fetch and of `wirePost`, so everything this product does to a request
 * before the socket — https only, the closed method set, the secret scan, the
 * byte cap, the deadline — runs for real, and the far end is this object.
 *
 * It is a strict peer. A task from Inflect is acted on only when Inflect's
 * receipt verifies against Inflect's registered public key and names this peer
 * as recipient; otherwise it answers 401 and records nothing. What it received
 * is kept in `received`, so a test can assert that a refused send never left.
 *
 * Misbehaviour on demand (`reply`): an unsigned answer, an answer signed by the
 * wrong key, a body tampered after signing, or a given task state — the cases
 * the outbound verifier must refuse or settle honestly.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { a2aSigningKeyFromSeed, type A2aSigningKey } from '@/lib/agentic/a2a/signing-key';
import {
    A2A_RECEIPT_HEADER,
    a2aBodyDigest,
    encodeA2aReceiptHeader,
    signA2aReceipt,
    verifyA2aReceiptHeader,
    type A2aMethod,
} from '@/lib/agentic/a2a/receipt';

export type FakePeerReply =
    | { kind: 'task'; state: string }
    | { kind: 'unsigned' }
    | { kind: 'wrong-key' }
    | { kind: 'tampered' }
    | { kind: 'http'; status: number };

export interface ReceivedTask {
    readonly body: string;
    readonly messageId: string;
    readonly text: string | null;
    readonly authorization: string | null;
}

export function newSigningKey(): { seed: string; key: A2aSigningKey } {
    const seed = randomBytes(32).toString('hex');
    const key = a2aSigningKeyFromSeed(seed);
    if (!key) throw new Error('fake peer: could not build a signing key');
    return { seed, key };
}

export class FakeA2aPeer {
    readonly key: A2aSigningKey;
    readonly cardUrl: string;
    readonly endpoint: string;
    card: Record<string, unknown>;
    reply: FakePeerReply = { kind: 'task', state: 'completed' };
    readonly received: ReceivedTask[] = [];
    /** Inflect's public key and its identity (the tenant's card URL, #3742), as the peer pinned them. */
    inflectPublicKey = '';
    inflectIdentity = '';

    constructor(host = 'peer.partner.example') {
        this.key = newSigningKey().key;
        this.cardUrl = `https://${host}/.well-known/agent-card.json`;
        this.endpoint = `https://${host}/a2a`;
        this.card = this.baseCard();
    }

    baseCard(): Record<string, unknown> {
        return {
            protocolVersion: '0.3.0',
            name: 'Partner Reconciler',
            description: 'Reconciles supplier invoices against purchase orders.',
            url: this.endpoint,
            preferredTransport: 'JSONRPC',
            skills: [{ id: 'reconcile', name: 'Reconcile', description: 'Matches one invoice.', examples: ['INV-1'] }],
        };
    }

    /** The `fetchImpl` both seams take. */
    readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
        if (url === this.cardUrl && (init.method ?? 'GET') === 'GET') {
            return new Response(JSON.stringify(this.card), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url !== this.endpoint || init.method !== 'POST') return new Response('not found', { status: 404 });
        const headers = new Headers(init.headers);
        const body = String(init.body ?? '');
        const verdict = verifyA2aReceiptHeader(headers.get(A2A_RECEIPT_HEADER), this.inflectPublicKey, {
            kind: 'TASK',
            sender: this.inflectIdentity,
            recipient: this.cardUrl,
            bodyDigest: a2aBodyDigest(body),
        });
        if (!verdict.ok) return new Response(JSON.stringify({ error: verdict.reason }), { status: 401 });
        const rpc = JSON.parse(body) as {
            id: string;
            params: { message: { parts: { kind: string; text?: string }[]; contextId?: string } };
        };
        this.received.push({
            body,
            messageId: verdict.receipt.statement.messageId,
            text: rpc.params.message.parts.find((p) => p.kind === 'text')?.text ?? null,
            authorization: headers.get('authorization'),
        });
        if (this.reply.kind === 'http') return new Response('{}', { status: this.reply.status });

        const state = this.reply.kind === 'task' ? this.reply.state : 'completed';
        const answer = JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
                kind: 'task',
                id: `peer-task-${this.received.length}`,
                contextId: rpc.params.message.contextId ?? `ctx-${this.received.length}`,
                status: { state },
            },
        });
        const signer = this.reply.kind === 'wrong-key' ? newSigningKey().key : this.key;
        const receipt = signA2aReceipt(
            {
                v: 'inflect-a2a-receipt/1',
                kind: 'RESULT',
                messageId: randomUUID(),
                relatesTo: verdict.receipt.statement.messageId,
                method: null,
                sender: this.cardUrl,
                recipient: this.inflectIdentity,
                issuedAt: new Date().toISOString(),
                bodyDigest: a2aBodyDigest(answer),
            },
            signer.privateKey,
        );
        const out = this.reply.kind === 'tampered' ? answer.replace('"completed"', '"completed" ') : answer;
        const respHeaders: Record<string, string> = { 'content-type': 'application/json' };
        if (this.reply.kind !== 'unsigned') respHeaders[A2A_RECEIPT_HEADER] = encodeA2aReceiptHeader(receipt);
        return new Response(out, { status: 200, headers: respHeaders });
    };

    /** A request from this peer TO Inflect, signed as the peer signs: body plus its receipt header. */
    signedRequest(
        body: Record<string, unknown>,
        opts: { method?: A2aMethod; messageId?: string; recipient?: string; issuedAt?: Date; signer?: A2aSigningKey } = {},
    ): { body: string; receiptHeader: string; messageId: string } {
        const raw = JSON.stringify(body);
        const messageId = opts.messageId ?? randomUUID();
        const receipt = signA2aReceipt(
            {
                v: 'inflect-a2a-receipt/1',
                kind: 'TASK',
                messageId,
                relatesTo: null,
                method: opts.method ?? ((body as { method?: A2aMethod }).method ?? 'message/send'),
                sender: this.cardUrl,
                recipient: opts.recipient ?? this.inflectIdentity,
                issuedAt: (opts.issuedAt ?? new Date()).toISOString(),
                bodyDigest: a2aBodyDigest(raw),
            },
            (opts.signer ?? this.key).privateKey,
        );
        return { body: raw, receiptHeader: encodeA2aReceiptHeader(receipt), messageId };
    }

    /** A `message/send` body asking for one workflow. */
    static sendBody(workflowKey: string, text: string, extra: { data?: Record<string, string>; parts?: unknown[] } = {}) {
        const parts: unknown[] = extra.parts ?? [{ kind: 'text', text }];
        if (extra.data) parts.push({ kind: 'data', data: extra.data });
        return {
            jsonrpc: '2.0',
            id: `rpc-${randomUUID()}`,
            method: 'message/send',
            params: {
                message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, metadata: { workflowKey } },
            },
        };
    }
}
