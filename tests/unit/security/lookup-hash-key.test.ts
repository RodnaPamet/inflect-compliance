/**
 * Email lookup hashes survive a master-key rotation once LOOKUP_HASH_KEY is
 * set (#5071).
 *
 * `hashForLookup` keyed its HMAC on DATA_ENCRYPTION_KEY with no fallback, so
 * rotating the master key changed every `emailHash` and every sign-in by email
 * missed its account. With the dedicated key set, the hash depends on it alone.
 * Without it, behaviour is unchanged: the master-derived key.
 */
import {
    _resetKeyCache,
    hashForLookup,
    lookupHashKeyIsDedicated,
} from '@/lib/security/encryption';

const MASTER_A = 'a'.repeat(48);
const MASTER_B = 'b'.repeat(48);
const LOOKUP = 'l'.repeat(48);
const EMAIL = 'Person@Example.com';

const saved = {
    master: process.env.DATA_ENCRYPTION_KEY,
    lookup: process.env.LOOKUP_HASH_KEY,
};

function withKeys(master: string, lookup: string | undefined): string {
    process.env.DATA_ENCRYPTION_KEY = master;
    if (lookup === undefined) delete process.env.LOOKUP_HASH_KEY;
    else process.env.LOOKUP_HASH_KEY = lookup;
    _resetKeyCache();
    return hashForLookup(EMAIL);
}

afterEach(() => {
    if (saved.master === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = saved.master;
    if (saved.lookup === undefined) delete process.env.LOOKUP_HASH_KEY;
    else process.env.LOOKUP_HASH_KEY = saved.lookup;
    _resetKeyCache();
});

describe('lookup hashes and the master key (#5071)', () => {
    it('with LOOKUP_HASH_KEY set, rotating DATA_ENCRYPTION_KEY leaves the hash unchanged', () => {
        expect(withKeys(MASTER_A, LOOKUP)).toBe(withKeys(MASTER_B, LOOKUP));
        expect(lookupHashKeyIsDedicated()).toBe(true);
    });

    it('without it, the hash still follows the master key, exactly as before', () => {
        // The documented reason to set the variable before any rotation.
        expect(withKeys(MASTER_A, undefined)).not.toBe(withKeys(MASTER_B, undefined));
        expect(lookupHashKeyIsDedicated()).toBe(false);
    });

    it('the dedicated key gives different hashes from the master-derived one, so a recompute is needed', () => {
        expect(withKeys(MASTER_A, LOOKUP)).not.toBe(withKeys(MASTER_A, undefined));
    });

    it('a key shorter than 32 characters is ignored, never half-used', () => {
        expect(withKeys(MASTER_A, 'short')).toBe(withKeys(MASTER_A, undefined));
    });

    it('still normalises case and whitespace under the dedicated key', () => {
        process.env.DATA_ENCRYPTION_KEY = MASTER_A;
        process.env.LOOKUP_HASH_KEY = LOOKUP;
        _resetKeyCache();
        expect(hashForLookup('  person@example.com ')).toBe(hashForLookup(EMAIL));
    });
});
