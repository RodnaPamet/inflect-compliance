/**
 * Unit Test: Epic B.3 dual-KEK rotation support in encryption.ts.
 *
 * Pins:
 *   - Writes always use the primary (new) KEK.
 *   - Reads try primary first; on GCM failure, fall back to
 *     `DATA_ENCRYPTION_KEY_PREVIOUS` if configured.
 *   - No previous key configured → behaves exactly like B.1
 *     (primary-only decrypt, failure surfaces the primary error).
 *   - Both keys fail → the primary error is re-thrown (caller's
 *     mental model is "my current key doesn't fit").
 *   - Rotating `DATA_ENCRYPTION_KEY` without rotating `PREVIOUS` (or
 *     vice versa) still produces readable data as long as ONE of the
 *     two decrypts it.
 *   - `_resetKeyCache` picks up env changes (rotation in tests).
 */

import {
    encryptField,
    decryptField,
    hashForLookup,
    _resetKeyCache,
} from '@/lib/security/encryption';

const OLD_KEY = 'a'.repeat(48);
const NEW_KEY = 'b'.repeat(48);

function setKeys(primary?: string, previous?: string): void {
    if (primary === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = primary;

    if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    else process.env.DATA_ENCRYPTION_KEY_PREVIOUS = previous;

    _resetKeyCache();
}

function setLookupKey(key?: string): void {
    if (key === undefined) delete process.env.LOOKUP_HASH_KEY;
    else process.env.LOOKUP_HASH_KEY = key;
    _resetKeyCache();
}

const savedEnv = {
    primary: process.env.DATA_ENCRYPTION_KEY,
    previous: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
    lookup: process.env.LOOKUP_HASH_KEY,
};

afterAll(() => {
    setLookupKey(savedEnv.lookup);
    setKeys(savedEnv.primary, savedEnv.previous);
});

/**
 * A LOOKUP HASH IS AN INDEX, SO A ROTATION MUST NOT MOVE IT (#5071).
 *
 * `decryptField` falls back to DATA_ENCRYPTION_KEY_PREVIOUS, so a rotation
 * leaves ciphertext readable. A hash has no such fallback: `User.emailHash`
 * IS the lookup key, and a miss reads as "no such row". While the HMAC key
 * derived from DATA_ENCRYPTION_KEY, the documented rotation therefore broke
 * every email-based sign-in, SSO/OAuth account match and invite redemption
 * from the first request.
 */
describe('lookup hashes across a master-KEK rotation (#5071)', () => {
    const EMAIL = 'person@example.com';

    test('with LOOKUP_HASH_KEY pinned, rotating the KEK moves no hash', () => {
        // The property the fix exists for, and the whole migration path: pin
        // the lookup key to the key the hashes were computed under, then the
        // KEK is free to move.
        setLookupKey(OLD_KEY);
        setKeys(OLD_KEY);
        const before = hashForLookup(EMAIL);

        setKeys(NEW_KEY, OLD_KEY);
        const after = hashForLookup(EMAIL);

        expect(after).toBe(before);
    });

    test('ciphertext still rotates while the hash stays put', () => {
        // The two must not be coupled in EITHER direction: pinning the lookup
        // key must not pin the data key, or the rotation would do nothing.
        setLookupKey(OLD_KEY);
        setKeys(OLD_KEY);
        const ct = encryptField('secret');
        const hash = hashForLookup(EMAIL);

        setKeys(NEW_KEY, OLD_KEY);
        expect(decryptField(ct)).toBe('secret');     // read via the previous key
        expect(hashForLookup(EMAIL)).toBe(hash);     // index unmoved
        expect(decryptField(encryptField('fresh'))).toBe('fresh'); // new key writes
    });

    test('UNPINNED, a KEK change does move every hash — which is why boot refuses', () => {
        // Not a wish, a fact: the fallback keeps today's derivation, so an
        // operator who rotates without setting LOOKUP_HASH_KEY gets exactly
        // the #5071 breakage. `checkProductionEncryptionKey` refuses to boot in
        // that state; this records what it is protecting against, so the
        // fallback cannot be mistaken for safety.
        setLookupKey(undefined);
        setKeys(OLD_KEY);
        const before = hashForLookup(EMAIL);

        setKeys(NEW_KEY, OLD_KEY);
        expect(hashForLookup(EMAIL)).not.toBe(before);
    });

    test('an untouched deployment hashes exactly as it did before', () => {
        // The compatibility guarantee: unset LOOKUP_HASH_KEY must reproduce the
        // KEK-derived hash byte for byte, or upgrading would itself break
        // every sign-in.
        setKeys(OLD_KEY);
        setLookupKey(undefined);
        const fallback = hashForLookup(EMAIL);

        setLookupKey(OLD_KEY);
        expect(hashForLookup(EMAIL)).toBe(fallback);
    });

    test('a DIFFERENT lookup key yields a different hash', () => {
        // The control that proves the pin is read at all, rather than the
        // tests above passing because nothing varies.
        setKeys(OLD_KEY);
        setLookupKey(OLD_KEY);
        const a = hashForLookup(EMAIL);
        setLookupKey(NEW_KEY);
        expect(hashForLookup(EMAIL)).not.toBe(a);
    });

    test('a too-short LOOKUP_HASH_KEY is ignored, not accepted', () => {
        setKeys(OLD_KEY);
        setLookupKey(undefined);
        const fallback = hashForLookup(EMAIL);
        setLookupKey('a'.repeat(31));
        expect(hashForLookup(EMAIL)).toBe(fallback);
    });
});

describe('Dual-KEK decrypt (Epic B.3)', () => {
    test('no previous key configured → primary-only behaviour (B.1 baseline)', () => {
        setKeys(OLD_KEY);
        const ct = encryptField('hello');
        expect(decryptField(ct)).toBe('hello');
    });

    test('before rotation — ciphertext written under OLD_KEY', () => {
        setKeys(OLD_KEY);
        const ct = encryptField('pre-rotation secret');

        // --- OPERATOR rotates: primary becomes NEW_KEY, previous = OLD_KEY
        setKeys(NEW_KEY, OLD_KEY);

        // The old ciphertext STILL decrypts via the fallback.
        expect(decryptField(ct)).toBe('pre-rotation secret');
    });

    test('during rotation — new writes go under NEW_KEY', () => {
        setKeys(NEW_KEY, OLD_KEY);
        const ct = encryptField('written during rotation');
        expect(decryptField(ct)).toBe('written during rotation');

        // After rotation completes (previous unset), the ciphertext
        // is still decryptable — it was written under the primary all
        // along.
        setKeys(NEW_KEY);
        expect(decryptField(ct)).toBe('written during rotation');
    });

    test('post-rotation — OLD_KEY ciphertext readable UNTIL previous is unset', () => {
        setKeys(OLD_KEY);
        const legacy = encryptField('legacy value');

        setKeys(NEW_KEY, OLD_KEY);
        expect(decryptField(legacy)).toBe('legacy value');

        // Rotation complete — operator drops the previous env var.
        // Now this ciphertext CANNOT decrypt (rotation job should have
        // re-encrypted it before this point).
        setKeys(NEW_KEY);
        expect(() => decryptField(legacy)).toThrow();
    });

    test('both keys fail → primary error is re-thrown', () => {
        setKeys(OLD_KEY);
        const ct = encryptField('x');

        // Switch to a completely different key pair so neither works.
        setKeys(NEW_KEY, 'c'.repeat(48));
        expect(() => decryptField(ct)).toThrow();
    });

    test('previous key configured but primary still works → no fallback', () => {
        setKeys(NEW_KEY, OLD_KEY);
        const ct = encryptField('primary happy path');
        // Decrypt succeeds on primary; previous never consulted.
        expect(decryptField(ct)).toBe('primary happy path');
    });

    test('cache invalidation — swapping DATA_ENCRYPTION_KEY_PREVIOUS takes effect on next call', () => {
        setKeys(OLD_KEY);
        const ct = encryptField('test value');

        // Start rotation with wrong previous — should fail.
        setKeys(NEW_KEY, 'd'.repeat(48));
        expect(() => decryptField(ct)).toThrow();

        // Operator corrects the previous env var — next call reads the
        // corrected key (the _resetKeyCache inside setKeys drops the
        // stale cache).
        setKeys(NEW_KEY, OLD_KEY);
        expect(decryptField(ct)).toBe('test value');
    });

    test('tampered ciphertext fails both keys cleanly (auth tag mismatch)', () => {
        setKeys(NEW_KEY, OLD_KEY);
        const ct = encryptField('honest payload');
        const tampered = ct.slice(0, -4) + 'AAAA';
        expect(() => decryptField(tampered)).toThrow();
    });

    test('round-trip across three rotation generations', () => {
        setKeys('g1'.repeat(24));
        const a = encryptField('gen-1 data');

        // Rotate g1 → g2
        setKeys('g2'.repeat(24), 'g1'.repeat(24));
        expect(decryptField(a)).toBe('gen-1 data');
        const b = encryptField('gen-2 data');

        // Rotate g2 → g3. At this point the rotation job would have
        // re-encrypted `a` under g2. We simulate that by re-encrypting.
        setKeys('g3'.repeat(24), 'g2'.repeat(24));
        expect(decryptField(b)).toBe('gen-2 data');

        // `a` (encrypted under g1, then presumably re-encrypted under
        // g2 by the rotation job) is still readable only if it was
        // re-encrypted — the test bed doesn't simulate that, so a
        // direct decrypt of the g1 ciphertext fails.
        expect(() => decryptField(a)).toThrow();
    });
});
