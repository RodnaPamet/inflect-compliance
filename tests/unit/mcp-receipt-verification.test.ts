import {
    createHash,
    generateKeyPairSync,
    sign as cryptoSign,
} from 'node:crypto';

import {
    ed25519PublicKeyFromMaterial,
    verifyReceiptSignature,
    boundAndScrubSummary,
    extractReceiptFields,
    receiptSignedMessage,
    SCANNED_SUMMARY_MAX_BYTES,
    type PipelockReceipt,
} from '@/lib/mcp/receipt-verification';

/**
 * A RECEIPT FROM AN EXTERNAL SIGNER IS DECODED DEFENSIVELY (#3617).
 *
 * `receipt-verification.ts` had twelve uncovered branches, and every one of them
 * was a degradation rule for material this process did not produce: a key that
 * is not 32 bytes, a signature that is not 64, a summary that will not
 * serialise, a timestamp that is not a date. The receipt arrives from a
 * pipelock signer and the configured key from a tenant's settings, so both are
 * inputs rather than invariants.
 *
 * ── ONE CONTRAST WORTH NAMING ──────────────────────────────────────────────
 *
 * `verifyExchangedToken` refuses with ONE coarse message on purpose, because
 * naming the failing check would be a format oracle for whoever is probing it.
 * This verifier does the opposite: it returns a DISTINCT reason for each
 * outcome, and reports `signingKeyId` on every one of them including the
 * failures.
 *
 * Both are right. A bearer token is checked against an attacker; a receipt is
 * verified against a signer the tenant configured, and the operator reading the
 * result is the one who has to fix it — "no_configured_key" and
 * "signer_key_mismatch" are different jobs. The reasons are asserted
 * individually for that reason.
 */

/** A real Ed25519 pair, so signatures are genuine rather than shaped. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const PUB_HEX = rawPublic.toString('hex');
const PUB_B64 = rawPublic.toString('base64');

const ACTION_RECORD = { tool: 'list_risks', verdict: 'allow', policy: 'p-1' };

/** Sign the canonical digest the verifier will recompute. */
const signFor = (record: unknown): string =>
    cryptoSign(null, receiptSignedMessage(record), privateKey).toString('hex');

const receipt = (over: Partial<PipelockReceipt> = {}): PipelockReceipt => ({
    action_record: ACTION_RECORD,
    signature: signFor(ACTION_RECORD),
    signer_key: PUB_HEX,
    ...over,
});

describe('ed25519PublicKeyFromMaterial — what counts as a key', () => {
    it('accepts the raw 32 bytes as hex, and as base64', () => {
        // Both encodings appear in the wild: receipts use hex, configuration has
        // been seen carrying base64. Hex is tried first, and the base64 path is
        // the fallback — so both need a case or one of them is theoretical.
        expect(ed25519PublicKeyFromMaterial(PUB_HEX)).not.toBeNull();
        expect(ed25519PublicKeyFromMaterial(PUB_B64)).not.toBeNull();
    });

    it('tolerates surrounding whitespace', () => {
        // Configuration arrives from a text field.
        expect(ed25519PublicKeyFromMaterial(`  ${PUB_HEX}\n`)).not.toBeNull();
    });

    it.each([
        ['31 bytes', Buffer.alloc(31).toString('hex')],
        ['33 bytes', Buffer.alloc(33).toString('hex')],
        ['an empty string', ''],
        ['whitespace only', '   '],
        ['odd-length hex', 'abc'],
        ['not hex and not base64', '!!! not key material !!!'],
    ])('returns null for %s', (_label, material) => {
        // NULL rather than a throw: the caller turns it into
        // `invalid_configured_key`, which is an operator-actionable reason. A
        // throw here would surface as a 500 on a settings page.
        expect(ed25519PublicKeyFromMaterial(material)).toBeNull();
    });
});

describe('verifyReceiptSignature — a distinct reason for each outcome', () => {
    it('accepts a genuine signature', () => {
        // The control. Without it every refusal below is satisfied by a verifier
        // that rejects everything.
        expect(verifyReceiptSignature(receipt(), PUB_HEX)).toEqual({
            valid: true,
            signingKeyId: PUB_HEX,
        });
    });

    it('accepts a signature carrying the `ed25519:` prefix', () => {
        // The prefix is stripped before decoding. A verifier that did not strip
        // it would reject every receipt from a signer that writes the canonical
        // form.
        const r = receipt({ signature: `ed25519:${signFor(ACTION_RECORD)}` });
        expect(verifyReceiptSignature(r, PUB_HEX).valid).toBe(true);
    });

    it.each([
        ['no_configured_key', undefined],
        ['no_configured_key', null],
        ['no_configured_key', ''],
        ['no_configured_key', '   '],
    ])('reports %s when the tenant configured nothing', (reason, key) => {
        expect(verifyReceiptSignature(receipt(), key as string | null | undefined)).toEqual({
            valid: false,
            reason,
            signingKeyId: PUB_HEX,
        });
    });

    it('reports invalid_configured_key when the configured key is not key material', () => {
        // Distinct from `no_configured_key`: somebody set a value and it is
        // wrong, which is a different fix from somebody having set nothing.
        expect(verifyReceiptSignature(receipt(), 'not-a-key').reason).toBe(
            'invalid_configured_key',
        );
    });

    it('reports signer_key_mismatch when the receipt names a DIFFERENT key', () => {
        // The cross-check. Without it a receipt signed by anybody whose key the
        // tenant happens to trust would verify — the receipt must claim to come
        // from the key we trust, not merely verify against it.
        const other = generateKeyPairSync('ed25519').publicKey
            .export({ format: 'der', type: 'spki' })
            .subarray(-32)
            .toString('hex');
        const r = receipt({ signer_key: other });
        expect(verifyReceiptSignature(r, PUB_HEX)).toEqual({
            valid: false,
            reason: 'signer_key_mismatch',
            signingKeyId: other,
        });
    });

    it('reports malformed_signature for a signature that is not 64 bytes', () => {
        expect(verifyReceiptSignature(receipt({ signature: 'abcd' }), PUB_HEX).reason).toBe(
            'malformed_signature',
        );
    });

    it('reports signature_invalid for a well-formed signature that does not verify', () => {
        // 64 bytes of the right shape and the wrong content — the case
        // `malformed_signature` must NOT absorb, because the two mean different
        // things about the signer.
        const r = receipt({ signature: Buffer.alloc(64, 7).toString('hex') });
        expect(verifyReceiptSignature(r, PUB_HEX).reason).toBe('signature_invalid');
    });

    it('reports signature_invalid when the action record was edited after signing', () => {
        // The property the signature exists for: the digest is recomputed over
        // the record as received.
        const r = receipt({ action_record: { ...ACTION_RECORD, verdict: 'deny' } });
        expect(verifyReceiptSignature(r, PUB_HEX).reason).toBe('signature_invalid');
    });

    it('names the signing key on EVERY outcome, including the failures', () => {
        // An operator reading a failed verification has to know which key it was
        // about. A result that omitted it on failure would leave them guessing
        // between the configured key and the one the receipt claimed.
        const outcomes = [
            verifyReceiptSignature(receipt(), PUB_HEX),
            verifyReceiptSignature(receipt(), undefined),
            verifyReceiptSignature(receipt(), 'not-a-key'),
            verifyReceiptSignature(receipt({ signature: 'abcd' }), PUB_HEX),
        ];
        expect(outcomes.every((o) => typeof o.signingKeyId === 'string' && o.signingKeyId)).toBe(
            true,
        );
    });
});

describe('boundAndScrubSummary — bounded, scrubbed, never raw', () => {
    it('wraps a non-object under `value` rather than spreading it', () => {
        // A string has no fields to redact and `{...'abc'}` would become
        // `{0:'a',1:'b',2:'c'}`. Wrapping keeps the shape honest.
        expect(boundAndScrubSummary('a string')).toEqual({ value: 'a string' });
        expect(boundAndScrubSummary(42)).toEqual({ value: 42 });
        expect(boundAndScrubSummary(null)).toEqual({ value: null });
    });

    it('wraps an ARRAY too, and the redactor summarises it rather than storing it', () => {
        // An array is `typeof 'object'`, so without the explicit check it would
        // be treated as a field bag and come back as `{0: …, 1: …}`. Measured:
        // the wrapped value is then summarised to a descriptor by the shared
        // redactor, which is the behaviour wanted — a receipt summary should
        // record that there WAS an array, not its contents.
        expect(boundAndScrubSummary([1, 2])).toEqual({ value: '[Array len=2]' });
    });

    /**
     * ── THE TWO BOUNDS ARE COMPLEMENTARY, NOT REDUNDANT ────────────────────
     *
     * `redactSensitiveFields` runs first and bounds DEPTH and VALUE LENGTH: a
     * cyclic object comes back `_truncated` at depth, and a single enormous
     * string is summarised. So neither a deep object nor a long value can reach
     * the size cap below — measured, a 8KB+ single blob is already shrunk by the
     * time `JSON.stringify` sees it.
     *
     * What the redactor does NOT bound is WIDTH. Three thousand short fields
     * survive it untouched and serialise to sixty kilobytes, which is what the
     * 8KB cap is actually for. And a value JSON cannot serialise at all — a
     * BigInt — survives redaction and throws at `stringify`, which is what the
     * drop is for.
     *
     * Both tripwires therefore fire, but only on the inputs the FIRST guard
     * does not already handle. My first attempt at these two used a long string
     * and a cyclic object and reached neither.
     */
    it('CAPS a summary that is WIDE rather than deep, with the size and a digest', () => {
        // Many small fields: nothing for the redactor to truncate, and far past
        // the byte budget once serialised. Better a marker than an oversized and
        // possibly leaky blob in the database; the digest is what lets an
        // investigator match it against something they hold.
        const wide: Record<string, string> = {};
        for (let i = 0; i < 3000; i += 1) wide[`field_${i}`] = `v${i}`;

        const out = boundAndScrubSummary(wide);
        expect(out._capped).toBe(true);
        expect(out.reason).toBe('oversize');
        expect(out.bytes as number).toBeGreaterThan(SCANNED_SUMMARY_MAX_BYTES);
        expect(out.sha256).toBe(
            createHash('sha256').update(JSON.stringify(wide)).digest('hex'),
        );
    });

    it('DROPS a summary JSON cannot serialise, rather than throwing', () => {
        // A BigInt. `JSON.stringify` throws on it and the redactor passes it
        // through, so this is the one shape that reaches the catch. A throw here
        // would fail the whole receipt ingest over a summary incidental to it.
        expect(boundAndScrubSummary({ n: BigInt(7) } as unknown)).toEqual({
            _dropped: true,
            reason: 'unserializable',
        });
    });

    it('a CYCLIC summary is de-cycled by the redactor, not dropped', () => {
        // The negative half of the pair above: the drop is not where a circular
        // object lands, because the redactor truncates it at depth first.
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const out = boundAndScrubSummary(circular);
        expect(out._dropped).toBeUndefined();
        expect(JSON.stringify(out)).toContain('_truncated');
    });

    it('passes a small, clean object through', () => {
        // The control for the two refusals above.
        expect(boundAndScrubSummary({ tool: 'list_risks' })).toMatchObject({
            tool: 'list_risks',
        });
    });
});

describe('extractReceiptFields — plausible names, and a safe fallback', () => {
    it('falls back to `unknown` rather than null for the two required strings', () => {
        // `toolName` and `decisionVerdict` are stored columns; a null would be a
        // different kind of row from "the signer did not name it".
        const out = extractReceiptFields(receipt({ action_record: {} }));
        expect(out.toolName).toBe('unknown');
        expect(out.decisionVerdict).toBe('unknown');
        expect(out.activePolicy).toBeNull();
    });

    it('falls back to the run nonce for the agent id', () => {
        const out = extractReceiptFields(
            receipt({ action_record: {}, run_nonce: 'nonce-7' }),
        );
        expect(out.agentId).toBe('nonce-7');
    });

    it('substitutes NOW for a timestamp that is not a date', () => {
        // `new Date('nonsense')` is an Invalid Date, and persisting one is a
        // column that cannot be queried. The fallback is what keeps the row
        // usable.
        const out = extractReceiptFields(
            receipt({ action_record: { timestamp: 'not a date at all' } }),
        );
        expect(Number.isNaN(out.occurredAt.getTime())).toBe(false);
    });

    it('reads the FIRST plausible name, in order', () => {
        // The order matters: a record carrying both `tool` and `action` must
        // report the more specific one.
        const out = extractReceiptFields(
            receipt({ action_record: { action: 'generic', tool: 'specific' } }),
        );
        expect(out.toolName).toBe('specific');
    });
});
