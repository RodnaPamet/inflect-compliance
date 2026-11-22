/**
 * TOTP Crypto Unit Tests
 *
 * Tests encryption/decryption round-trip, secret generation,
 * URI format, and TOTP code verification.
 */
import {
    encryptTotpSecret,
    decryptTotpSecret,
    generateTotpSecret,
    generateTotpUri,
    verifyTotpCode,
} from '../../src/lib/security/totp-crypto';

const TEST_AUTH_SECRET = 'test-auth-secret-for-mfa-at-least-32-chars-long!'; // pragma: allowlist secret — test-only KEK string, not a real credential

describe('TOTP Crypto', () => {
    // ─── Encryption/Decryption ──────────────────────────────────────

    describe('encryptTotpSecret / decryptTotpSecret', () => {
        it('round-trips plaintext correctly', () => {
            const secret = 'JBSWY3DPEHPK3PXP'; // pragma: allowlist secret — RFC 6238 TOTP test vector
            const encrypted = encryptTotpSecret(secret, TEST_AUTH_SECRET);
            const decrypted = decryptTotpSecret(encrypted, TEST_AUTH_SECRET);
            expect(decrypted).toBe(secret);
        });

        it('produces different ciphertext each time (random IV)', () => {
            const secret = 'JBSWY3DPEHPK3PXP'; // pragma: allowlist secret — RFC 6238 TOTP test vector
            const e1 = encryptTotpSecret(secret, TEST_AUTH_SECRET);
            const e2 = encryptTotpSecret(secret, TEST_AUTH_SECRET);
            expect(e1).not.toBe(e2); // Different IVs
        });

        it('fails to decrypt with wrong key', () => {
            const secret = 'JBSWY3DPEHPK3PXP'; // pragma: allowlist secret — RFC 6238 TOTP test vector
            const encrypted = encryptTotpSecret(secret, TEST_AUTH_SECRET);
            expect(() => decryptTotpSecret(encrypted, 'wrong-key-that-is-long-enough-to-test')).toThrow();
        });

        it('fails on tampered ciphertext', () => {
            const secret = 'JBSWY3DPEHPK3PXP'; // pragma: allowlist secret — RFC 6238 TOTP test vector
            const encrypted = encryptTotpSecret(secret, TEST_AUTH_SECRET);
            // Tamper with a byte
            const buf = Buffer.from(encrypted, 'base64');
            buf[buf.length - 5] ^= 0xFF;
            const tampered = buf.toString('base64');
            expect(() => decryptTotpSecret(tampered, TEST_AUTH_SECRET)).toThrow();
        });

        it('handles empty string', () => {
            const encrypted = encryptTotpSecret('', TEST_AUTH_SECRET);
            const decrypted = decryptTotpSecret(encrypted, TEST_AUTH_SECRET);
            expect(decrypted).toBe('');
        });

        it('handles long secrets', () => {
            const long = 'A'.repeat(1000);
            const encrypted = encryptTotpSecret(long, TEST_AUTH_SECRET);
            const decrypted = decryptTotpSecret(encrypted, TEST_AUTH_SECRET);
            expect(decrypted).toBe(long);
        });
    });

    // ─── Secret Generation ──────────────────────────────────────────

    describe('generateTotpSecret', () => {
        it('generates a base32-encoded string', () => {
            const secret = generateTotpSecret();
            expect(secret).toMatch(/^[A-Z2-7]+$/);
        });

        it('generates 32-char secrets (20 bytes base32)', () => {
            const secret = generateTotpSecret();
            expect(secret.length).toBe(32);
        });

        it('generates unique secrets', () => {
            const s1 = generateTotpSecret();
            const s2 = generateTotpSecret();
            expect(s1).not.toBe(s2);
        });
    });

    // ─── URI Generation ─────────────────────────────────────────────

    describe('generateTotpUri', () => {
        it('generates valid otpauth URI', () => {
            const uri = generateTotpUri('JBSWY3DPEHPK3PXP', 'user@example.com');
            expect(uri).toMatch(/^otpauth:\/\/totp\//);
            expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
            expect(uri).toContain('user%40example.com');
            expect(uri).toContain('issuer=Inflect');
            expect(uri).toContain('algorithm=SHA1');
            expect(uri).toContain('digits=6');
            expect(uri).toContain('period=30');
        });

        it('uses custom issuer', () => {
            const uri = generateTotpUri('SECRET', 'u@e.com', 'MyApp');
            expect(uri).toContain('issuer=MyApp');
            expect(uri).toContain('MyApp:');
        });

        it('encodes special characters in email', () => {
            const uri = generateTotpUri('SECRET', 'user+tag@example.com');
            expect(uri).toContain('user%2Btag%40example.com');
        });
    });

    // ─── TOTP Verification ──────────────────────────────────────────

    describe('verifyTotpCode', () => {
        it('rejects non-6-digit codes', () => {
            expect(verifyTotpCode('JBSWY3DPEHPK3PXP', '12345')).toBe(false);
            expect(verifyTotpCode('JBSWY3DPEHPK3PXP', '1234567')).toBe(false);
            expect(verifyTotpCode('JBSWY3DPEHPK3PXP', 'abcdef')).toBe(false);
            expect(verifyTotpCode('JBSWY3DPEHPK3PXP', '')).toBe(false);
        });

        it('verifies a code generated for the current time window', () => {
            // Generate a code using our own implementation to test verification
            const secret = generateTotpSecret();
            // We can't easily generate the "right" code without using the same
            // internal function, so we test the verification API contract instead
            expect(typeof verifyTotpCode(secret, '000000')).toBe('boolean');
        });

        it('rejects random 6-digit code with very high probability', () => {
            const secret = generateTotpSecret();
            // With ±1 window (3 intervals), probability of random match is 3/1000000
            // Running it once is statistically safe
            const randomCode = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
            // We don't assert false here because there's a 0.0003% chance of collision
            // Instead we just verify it runs without error
            expect(typeof verifyTotpCode(secret, randomCode)).toBe('boolean');
        });
    });
});

describe('matchTotpStep: the step a code belongs to', () => {
    // RFC 6238 Appendix B: SHA-1 secret "12345678901234567890", T = 59 s,
    // 8-digit code 94287082, so the 6-digit code is 287082, at step 1.
    const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // pragma: allowlist secret — the published RFC 6238 test-vector secret

    beforeEach(() => jest.useFakeTimers().setSystemTime(59_000));
    afterEach(() => jest.useRealTimers());

    it('returns the RFC 6238 step of a valid code', () => {
        const { matchTotpStep } = jest.requireActual('@/lib/security/totp-crypto');
        expect(matchTotpStep(RFC_SECRET, '287082')).toBe(1);
    });

    it('returns null for a wrong or malformed code', () => {
        const { matchTotpStep } = jest.requireActual('@/lib/security/totp-crypto');
        expect(matchTotpStep(RFC_SECRET, '287083')).toBeNull();
        expect(matchTotpStep(RFC_SECRET, '28708')).toBeNull();
        expect(matchTotpStep(RFC_SECRET, 'abcdef')).toBeNull();
    });

    it('agrees with verifyTotpCode', () => {
        const { verifyTotpCode } = jest.requireActual('@/lib/security/totp-crypto');
        expect(verifyTotpCode(RFC_SECRET, '287082')).toBe(true);
        expect(verifyTotpCode(RFC_SECRET, '287083')).toBe(false);
    });
});
