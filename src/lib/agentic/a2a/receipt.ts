/**
 * A2A RECEIPTS — the signed statement each side attaches to every task and
 * every result it sends, and the check the other side runs on it (#3679, step
 * 4b; `docs/a2a-threat-model.md` I1 T, O5 S and "Receipts on both sides").
 *
 * ## The statement
 *
 * `inflect-a2a-receipt/1` names the two parties, the message's own id, what it
 * answers (a RESULT's TASK), the JSON-RPC method a TASK carried, when it was
 * issued, and the SHA-256 of the EXACT body bytes it travels with. It carries no
 * content: the digest binds the body without repeating it, so the statement can
 * be stored, logged by id and shown without carrying another organisation's
 * text or a tenant's data.
 *
 * ## One canonical form, shared with the mediator receipts
 *
 * The signature is Ed25519 over `receiptSignedMessage(statement)` —
 * SHA-256 of the canonical JSON — which is the function `receipt-verification.ts`
 * verifies pipelock receipts with. Reusing it rather than writing a second
 * canonicaliser is the point: two forms that merely look alike drift on the
 * first edit, and the drift would surface as a signature that stops verifying.
 *
 * ## What verification refuses
 *
 * Verification is against the key THIS SIDE registered for the signer — a
 * peer's `PeerAgent.signingPublicKey`, or Inflect's published key — never a key
 * the message names. A signature that verifies is then held to what the
 * receiver expected: the kind, the recipient (so a message signed for one
 * tenant's endpoint cannot be replayed at another's), the sender, the body
 * digest, what a RESULT answers, and the clock. Each refusal has a name, for the
 * audit row; none of them is returned to the other side (pinning rule 7).
 *
 * This module is PURE: no I/O, no Prisma.
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { ed25519PublicKeyFromMaterial, receiptSignedMessage } from '@/lib/mcp/receipt-verification';

export const A2A_RECEIPT_VERSION = 'inflect-a2a-receipt/1';

/** The HTTP header a receipt travels in, on the request and on the response. */
export const A2A_RECEIPT_HEADER = 'x-inflect-a2a-receipt';

/** The encoded header is refused above this, before it is decoded. */
export const A2A_RECEIPT_HEADER_MAX_BYTES = 4096;

/**
 * How far a receipt's `issuedAt` may sit from the receiver's clock. Bounds how
 * long a captured message stays replayable at an endpoint that has not seen its
 * id, and tolerates ordinary skew between two organisations' hosts.
 */
export const A2A_RECEIPT_MAX_SKEW_MS = 5 * 60 * 1000;

export const A2A_METHODS = ['message/send', 'tasks/get'] as const;
export type A2aMethod = (typeof A2A_METHODS)[number];

export type A2aReceiptKind = 'TASK' | 'RESULT';

const StatementSchema = z
    .object({
        v: z.literal(A2A_RECEIPT_VERSION),
        kind: z.enum(['TASK', 'RESULT']),
        messageId: z.string().min(1).max(128),
        relatesTo: z.string().min(1).max(128).nullable(),
        method: z.enum(A2A_METHODS).nullable(),
        sender: z.string().min(1).max(2048),
        recipient: z.string().min(1).max(2048),
        issuedAt: z.string().datetime(),
        bodyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .refine(
        (s) =>
            s.kind === 'TASK'
                ? s.method !== null && s.relatesTo === null
                : s.method === null && s.relatesTo !== null,
        { message: 'a TASK names its method and answers nothing; a RESULT answers one TASK' },
    );

export type A2aReceiptStatement = z.infer<typeof StatementSchema>;

const EnvelopeSchema = z
    .object({
        statement: z.unknown(),
        signature: z.string().regex(/^[0-9a-f]{128}$/),
    })
    .strict();

export interface SignedA2aReceipt {
    readonly statement: A2aReceiptStatement;
    /** Ed25519, hex (64 bytes). */
    readonly signature: string;
}

/** SHA-256 (hex) of the exact body bytes. The body is never re-serialised first. */
export function a2aBodyDigest(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The canonical bytes of a statement, as stored on the receipt row. */
export function canonicalStatement(statement: A2aReceiptStatement): string {
    // The form the signature covers, so the row and the signature agree byte
    // for byte: `receiptSignedMessage` hashes exactly `canonicalJson(statement)`.
    return canonicalJson(statement);
}

export function signA2aReceipt(statement: A2aReceiptStatement, privateKey: KeyObject): SignedA2aReceipt {
    const parsed = StatementSchema.parse(statement);
    const signature = cryptoSign(null, receiptSignedMessage(parsed), privateKey).toString('hex');
    return { statement: parsed, signature };
}

/** base64url(JSON) — compact, header-safe, and decoded only after a size check. */
export function encodeA2aReceiptHeader(receipt: SignedA2aReceipt): string {
    return Buffer.from(JSON.stringify({ statement: receipt.statement, signature: receipt.signature }), 'utf8').toString(
        'base64url',
    );
}

export type A2aReceiptRefusal =
    | 'RECEIPT_MISSING'
    | 'RECEIPT_TOO_LARGE'
    | 'RECEIPT_MALFORMED'
    | 'SIGNER_KEY_INVALID'
    | 'SIGNATURE_INVALID'
    | 'KIND_MISMATCH'
    | 'SENDER_MISMATCH'
    | 'RECIPIENT_MISMATCH'
    | 'DIGEST_MISMATCH'
    | 'RELATES_MISMATCH'
    | 'RECEIPT_STALE';

export type A2aReceiptVerdict =
    | { readonly ok: true; readonly receipt: SignedA2aReceipt }
    | { readonly ok: false; readonly reason: A2aReceiptRefusal };

export interface A2aReceiptExpectation {
    readonly kind: A2aReceiptKind;
    /** The signer's identity as THIS side registered it, when it is known. */
    readonly sender?: string;
    readonly recipient: string;
    /** The digest of the body as it arrived, computed by the receiver. */
    readonly bodyDigest: string;
    /** A RESULT must answer exactly this TASK. */
    readonly relatesTo?: string;
    readonly now?: Date;
}

/**
 * Decode and verify a receipt header against the key this side trusts for its
 * signer. The order is cheapest-first and the signature comes before any field
 * it covers is believed: size, shape, key, signature, then the expectations.
 */
export function verifyA2aReceiptHeader(
    header: string | null | undefined,
    trustedPublicKey: string,
    expect: A2aReceiptExpectation,
): A2aReceiptVerdict {
    if (!header) return { ok: false, reason: 'RECEIPT_MISSING' };
    if (Buffer.byteLength(header, 'utf8') > A2A_RECEIPT_HEADER_MAX_BYTES) {
        return { ok: false, reason: 'RECEIPT_TOO_LARGE' };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'RECEIPT_MALFORMED' };
    }
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success) return { ok: false, reason: 'RECEIPT_MALFORMED' };
    const statement = StatementSchema.safeParse(envelope.data.statement);
    if (!statement.success) return { ok: false, reason: 'RECEIPT_MALFORMED' };

    const key = ed25519PublicKeyFromMaterial(trustedPublicKey);
    if (!key) return { ok: false, reason: 'SIGNER_KEY_INVALID' };

    let valid = false;
    try {
        valid = cryptoVerify(
            null,
            receiptSignedMessage(statement.data),
            key,
            Buffer.from(envelope.data.signature, 'hex'),
        );
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: 'SIGNATURE_INVALID' };

    const s = statement.data;
    if (s.kind !== expect.kind) return { ok: false, reason: 'KIND_MISMATCH' };
    if (expect.sender !== undefined && s.sender !== expect.sender) return { ok: false, reason: 'SENDER_MISMATCH' };
    if (s.recipient !== expect.recipient) return { ok: false, reason: 'RECIPIENT_MISMATCH' };
    if (s.bodyDigest !== expect.bodyDigest) return { ok: false, reason: 'DIGEST_MISMATCH' };
    if (expect.relatesTo !== undefined && s.relatesTo !== expect.relatesTo) {
        return { ok: false, reason: 'RELATES_MISMATCH' };
    }
    const now = (expect.now ?? new Date()).getTime();
    if (Math.abs(now - new Date(s.issuedAt).getTime()) > A2A_RECEIPT_MAX_SKEW_MS) {
        return { ok: false, reason: 'RECEIPT_STALE' };
    }
    return { ok: true, receipt: { statement: s, signature: envelope.data.signature } };
}

/**
 * An Ed25519 public key in its one stored spelling: the raw 32 bytes, hex.
 * Peers may register a key hex or base64; a receipt row keeps it one way.
 */
export function rawEd25519PublicKeyHex(material: string): string | null {
    const key = ed25519PublicKeyFromMaterial(material);
    if (!key) return null;
    const spki = key.export({ type: 'spki', format: 'der' });
    return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}

/**
 * Re-verify a STORED receipt: the statement as kept, its signature, and the
 * body as kept against the statement's digest. What an auditor runs months
 * later; no clock, because the receipt is old by then.
 *
 * `expectedFingerprint`, when given, is the key id the row names: the key must
 * hash to it, so a row cannot vouch for itself with a key it chose. A receipt
 * signed before a rotation passes with the RETIRED key it names.
 */
export function verifyStoredA2aReceipt(
    stored: { receiptJson: string; signature: string; body: string },
    publicKey: string,
    expectedFingerprint?: string,
): boolean {
    if (expectedFingerprint !== undefined && harnessKeyFingerprint(publicKey) !== expectedFingerprint) {
        return false;
    }
    let statement: unknown;
    try {
        statement = JSON.parse(stored.receiptJson);
    } catch {
        return false;
    }
    const parsed = StatementSchema.safeParse(statement);
    if (!parsed.success) return false;
    const key = ed25519PublicKeyFromMaterial(publicKey);
    if (!key || !/^[0-9a-f]{128}$/.test(stored.signature)) return false;
    try {
        if (!cryptoVerify(null, receiptSignedMessage(parsed.data), key, Buffer.from(stored.signature, 'hex'))) {
            return false;
        }
    } catch {
        return false;
    }
    return parsed.data.bodyDigest === a2aBodyDigest(stored.body);
}
