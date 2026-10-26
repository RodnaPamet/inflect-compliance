/**
 * Unit tests for src/lib/auth/passwords.ts — the pure password-crypto
 * primitives that underpin the production-grade credentials auth path.
 *
 * Covers:
 *   - hashPassword produces bcrypt output at BCRYPT_COST
 *   - verifyPassword round-trips correctly and fails safely for every
 *     non-matching / malformed input
 *   - dummyVerify pays the bcrypt CPU cost so enumeration timing is
 *     equalised with real verify (we test that it returns false and
 *     takes a plausible amount of time, not an exact number)
 *   - needsRehash correctly flags weaker hashes for silent migration
 *   - validatePasswordPolicy enforces length floor + ceiling with the
 *     documented reason codes
 *
 * Per-test timeout bump: bcrypt is CPU-heavy; under the full-suite
 * parallel run a single hash can push past Jest's 5s default.
 * 60s gives headroom without masking real regressions.
 */
jest.setTimeout(60_000);

import {
    BCRYPT_COST,
    MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH,
    dummyVerify,
    hashPassword,
    needsRehash,
    validatePasswordPolicy,
    verifyPassword,
} from '@/lib/auth/passwords';

describe('hashPassword', () => {
    it('produces a bcrypt hash at the configured work factor', async () => {
        const hash = await hashPassword('correct-horse-battery-staple');
        // bcrypt hashes begin `$2a|b|y$<cost>$`. Check the cost is
        // exactly BCRYPT_COST so a future bump to this constant fails
        // loudly here before it lands.
        expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
    });

    it('produces a different hash on every call (salt is non-deterministic)', async () => {
        const a = await hashPassword('same-input');
        const b = await hashPassword('same-input');
        expect(a).not.toBe(b);
    });

    it('throws on empty plaintext', async () => {
        await expect(hashPassword('')).rejects.toThrow();
    });

    it(`throws when plaintext exceeds ${MAX_PASSWORD_LENGTH} chars`, async () => {
        const tooLong = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
        await expect(hashPassword(tooLong)).rejects.toThrow();
    });
});

describe('verifyPassword', () => {
    it('returns true for the correct plaintext + hash', async () => {
        const hash = await hashPassword('Tr0ub4dor&3');
        await expect(verifyPassword('Tr0ub4dor&3', hash)).resolves.toBe(true);
    });

    it('returns false for a wrong plaintext', async () => {
        const hash = await hashPassword('Tr0ub4dor&3');
        await expect(verifyPassword('wrong-guess', hash)).resolves.toBe(false);
    });

    it('returns false when hash is null / undefined / empty', async () => {
        await expect(verifyPassword('anything', null)).resolves.toBe(false);
        await expect(verifyPassword('anything', undefined)).resolves.toBe(false);
        await expect(verifyPassword('anything', '')).resolves.toBe(false);
    });

    it('returns false (does not throw) when hash is malformed', async () => {
        await expect(verifyPassword('anything', 'not-a-bcrypt-hash')).resolves.toBe(false);
    });

    it('returns false when plaintext is empty', async () => {
        const hash = await hashPassword('real-password');
        await expect(verifyPassword('', hash)).resolves.toBe(false);
    });

    it(`returns false when plaintext exceeds ${MAX_PASSWORD_LENGTH} chars`, async () => {
        const hash = await hashPassword('real-password');
        const huge = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
        await expect(verifyPassword(huge, hash)).resolves.toBe(false);
    });
});

describe('dummyVerify', () => {
    it('always returns false', async () => {
        await expect(dummyVerify('')).resolves.toBe(false);
        await expect(dummyVerify('anything')).resolves.toBe(false);
    });

    it('pays non-trivial wall-clock cost (bcrypt-like)', async () => {
        // We don't assert an exact number — bcrypt at cost 12 is typically
        // 50–400ms depending on hardware. Anything above ~10ms signals
        // the bcrypt compare actually ran rather than being short-circuited.
        const start = performance.now();
        await dummyVerify('anything');
        const elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThan(10);
    });
});

describe('needsRehash', () => {
    it('returns true for a weaker bcrypt cost than the current one', () => {
        // Any cost < BCRYPT_COST triggers rehash. cost 08 is a safe example;
        // if BCRYPT_COST drops to ≤8 in the future update this fixture.
        const weakHash =
            '$2a$08$abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop';
        expect(needsRehash(weakHash)).toBe(true);
    });

    it('returns false for a hash already at BCRYPT_COST', async () => {
        const freshHash = await hashPassword('anything');
        expect(needsRehash(freshHash)).toBe(false);
    });

    it('returns true for a $2y$ hash at full cost, so it is rewritten as $2b$', () => {
        // Native bcrypt verifies $2y$ only through passwords.ts's mapping.
        const cost = String(BCRYPT_COST).padStart(2, '0');
        expect(needsRehash(`$2y$${cost}$${'a'.repeat(53)}`)).toBe(true);
        expect(needsRehash(`$2b$${cost}$${'a'.repeat(53)}`)).toBe(false);
    });

    it('returns true for a non-bcrypt format (forces algo migration)', () => {
        expect(needsRehash('argon2id$v=19$...')).toBe(true);
        expect(needsRehash('plaintext-leftover')).toBe(true);
    });

    it('returns false for null / undefined (nothing to rehash)', () => {
        expect(needsRehash(null)).toBe(false);
        expect(needsRehash(undefined)).toBe(false);
    });
});

describe('validatePasswordPolicy', () => {
    it('accepts a password at the floor length', () => {
        const pw = 'a'.repeat(MIN_PASSWORD_LENGTH);
        expect(validatePasswordPolicy(pw)).toEqual({ ok: true });
    });

    it('accepts a reasonable long password', () => {
        expect(validatePasswordPolicy('correct-horse-battery-staple')).toEqual({ ok: true });
    });

    it('rejects empty with reason=empty', () => {
        expect(validatePasswordPolicy('')).toEqual({ ok: false, reason: 'empty' });
    });

    it(`rejects below ${MIN_PASSWORD_LENGTH} chars with reason=too_short`, () => {
        const pw = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
        expect(validatePasswordPolicy(pw)).toEqual({ ok: false, reason: 'too_short' });
    });

    it(`rejects above ${MAX_PASSWORD_LENGTH} chars with reason=too_long`, () => {
        const pw = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
        expect(validatePasswordPolicy(pw)).toEqual({ ok: false, reason: 'too_long' });
    });
});
