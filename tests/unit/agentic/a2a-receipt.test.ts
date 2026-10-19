/**
 * A2A receipts (#3679): every task and result is signed, and a receipt that was
 * tampered with, signed by another key, addressed elsewhere or replayed late
 * does not verify. Pure — no database, no network.
 */
import { randomUUID } from 'node:crypto';

import {
    A2A_RECEIPT_MAX_SKEW_MS,
    a2aBodyDigest,
    canonicalStatement,
    encodeA2aReceiptHeader,
    signA2aReceipt,
    verifyA2aReceiptHeader,
    verifyStoredA2aReceipt,
    type A2aReceiptStatement,
} from '@/lib/agentic/a2a/receipt';
import { a2aSigningKeyFromSeed } from '@/lib/agentic/a2a/signing-key';

const SEED = 'a'.repeat(64);
const OTHER_SEED = 'b'.repeat(64);
const key = a2aSigningKeyFromSeed(SEED)!;
const other = a2aSigningKeyFromSeed(OTHER_SEED)!;

const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { text: 'hi' } } });

function task(over: Partial<A2aReceiptStatement> = {}): A2aReceiptStatement {
    return {
        v: 'inflect-a2a-receipt/1',
        kind: 'TASK',
        messageId: randomUUID(),
        relatesTo: null,
        method: 'message/send',
        sender: 'https://peer.example/card.json',
        recipient: 'inflect:a2a/t1/p1',
        issuedAt: new Date().toISOString(),
        bodyDigest: a2aBodyDigest(BODY),
        ...over,
    };
}

const expectTask = { kind: 'TASK' as const, sender: 'https://peer.example/card.json', recipient: 'inflect:a2a/t1/p1', bodyDigest: a2aBodyDigest(BODY) };

describe('signing and verifying a receipt', () => {
    it('a receipt signed by the trusted key, over this body, to this recipient, verifies', () => {
        const header = encodeA2aReceiptHeader(signA2aReceipt(task(), key.privateKey));
        const v = verifyA2aReceiptHeader(header, key.publicKeyHex, expectTask);
        expect(v.ok).toBe(true);
    });

    it('a body changed after signing fails on the digest', () => {
        const header = encodeA2aReceiptHeader(signA2aReceipt(task(), key.privateKey));
        const v = verifyA2aReceiptHeader(header, key.publicKeyHex, { ...expectTask, bodyDigest: a2aBodyDigest(`${BODY} `) });
        expect(v).toEqual({ ok: false, reason: 'DIGEST_MISMATCH' });
    });

    it('a statement edited after signing fails on the signature', () => {
        const signed = signA2aReceipt(task(), key.privateKey);
        const forged = { ...signed, statement: { ...signed.statement, recipient: 'inflect:a2a/t2/p1' } };
        const v = verifyA2aReceiptHeader(encodeA2aReceiptHeader(forged), key.publicKeyHex, {
            ...expectTask,
            recipient: 'inflect:a2a/t2/p1',
        });
        expect(v).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    });

    it('a receipt signed by any other key fails, whatever it claims', () => {
        const header = encodeA2aReceiptHeader(signA2aReceipt(task(), other.privateKey));
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    });

    it('a receipt for another recipient does not verify here — no replay across tenants or peers', () => {
        const header = encodeA2aReceiptHeader(signA2aReceipt(task({ recipient: 'inflect:a2a/t2/p1' }), key.privateKey));
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'RECIPIENT_MISMATCH' });
    });

    it('a stale receipt is refused, and so is one from the future', () => {
        const old = new Date(Date.now() - A2A_RECEIPT_MAX_SKEW_MS - 60_000).toISOString();
        const header = encodeA2aReceiptHeader(signA2aReceipt(task({ issuedAt: old }), key.privateKey));
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'RECEIPT_STALE' });
        const late = new Date(Date.now() + A2A_RECEIPT_MAX_SKEW_MS + 60_000).toISOString();
        const header2 = encodeA2aReceiptHeader(signA2aReceipt(task({ issuedAt: late }), key.privateKey));
        expect(verifyA2aReceiptHeader(header2, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'RECEIPT_STALE' });
    });

    it('a RESULT must answer the TASK it is expected to answer', () => {
        const result = signA2aReceipt(
            task({ kind: 'RESULT', method: null, relatesTo: 'msg-1' }),
            key.privateKey,
        );
        const header = encodeA2aReceiptHeader(result);
        const base = { ...expectTask, kind: 'RESULT' as const };
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, { ...base, relatesTo: 'msg-1' }).ok).toBe(true);
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, { ...base, relatesTo: 'msg-2' })).toEqual({
            ok: false,
            reason: 'RELATES_MISMATCH',
        });
        // …and a RESULT presented where a TASK is expected is refused by kind.
        expect(verifyA2aReceiptHeader(header, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'KIND_MISMATCH' });
    });

    it('a missing, oversized or malformed header refuses by name', () => {
        expect(verifyA2aReceiptHeader(null, key.publicKeyHex, expectTask)).toEqual({ ok: false, reason: 'RECEIPT_MISSING' });
        expect(verifyA2aReceiptHeader('x'.repeat(5000), key.publicKeyHex, expectTask)).toEqual({
            ok: false,
            reason: 'RECEIPT_TOO_LARGE',
        });
        expect(verifyA2aReceiptHeader('not-base64-json', key.publicKeyHex, expectTask)).toEqual({
            ok: false,
            reason: 'RECEIPT_MALFORMED',
        });
    });

    it('a TASK must name its method and a RESULT must answer one: the statement shape is enforced at signing', () => {
        expect(() => signA2aReceipt(task({ method: null }), key.privateKey)).toThrow();
        expect(() => signA2aReceipt(task({ kind: 'RESULT', method: null, relatesTo: null }), key.privateKey)).toThrow();
    });
});

describe('a stored receipt re-verifies from the row alone', () => {
    it('verifies against the signer key, and fails when the kept body or statement was altered', () => {
        const signed = signA2aReceipt(task(), key.privateKey);
        const row = { receiptJson: canonicalStatement(signed.statement), signature: signed.signature, body: BODY };
        expect(verifyStoredA2aReceipt(row, key.publicKeyHex)).toBe(true);
        expect(verifyStoredA2aReceipt({ ...row, body: `${BODY} ` }, key.publicKeyHex)).toBe(false);
        expect(verifyStoredA2aReceipt({ ...row, receiptJson: row.receiptJson.replace('t1', 't9') }, key.publicKeyHex)).toBe(false);
        expect(verifyStoredA2aReceipt(row, other.publicKeyHex)).toBe(false);
    });
});

describe('the signing key', () => {
    it('is built from a 32-byte seed in hex or base64, and nothing else', () => {
        expect(a2aSigningKeyFromSeed(SEED)?.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(a2aSigningKeyFromSeed(Buffer.from(SEED, 'hex').toString('base64'))?.publicKeyHex).toBe(key.publicKeyHex);
        expect(a2aSigningKeyFromSeed('too-short')).toBeNull();
        expect(a2aSigningKeyFromSeed('')).toBeNull();
    });
});
