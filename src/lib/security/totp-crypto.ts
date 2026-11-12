/**
 * TOTP Crypto Utilities
 *
 * Encryption: AES-256-GCM using AUTH_SECRET-derived key
 * TOTP: RFC 6238 compliant with ±1 step window
 *
 * SECURITY: TOTP secrets are encrypted at rest. Never log plaintext secrets.
 */
import crypto from 'crypto';

// ─── Key Derivation ─────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_INFO = 'mfa-totp-encryption';

/**
 * Derives a 256-bit encryption key from AUTH_SECRET using HKDF.
 * This ensures the actual key used for encryption is cryptographically
 * independent from the AUTH_SECRET used for JWT signing.
 */
function deriveKey(authSecret: string): Buffer {
    // Use HKDF to derive a proper encryption key from AUTH_SECRET
    const salt = Buffer.from('inflect-mfa-salt', 'utf8');
    const ikm = Buffer.from(authSecret, 'utf8');
    const info = Buffer.from(KEY_INFO, 'utf8');

    // HKDF-Extract
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    // HKDF-Expand (single block is enough for 32 bytes)
    const t1 = crypto.createHmac('sha256', prk)
        .update(Buffer.concat([info, Buffer.from([1])]))
        .digest();

    return t1; // 32 bytes = 256 bits
}

// ─── Encryption ─────────────────────────────────────────────────────

/**
 * Encrypts a TOTP secret using AES-256-GCM.
 * Output format: base64(iv || ciphertext || authTag)
 */
export function encryptTotpSecret(plaintext: string, authSecret: string): string {
    const key = deriveKey(authSecret);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // iv (12) + ciphertext (variable) + tag (16)
    const combined = Buffer.concat([iv, encrypted, tag]);
    return combined.toString('base64');
}

/**
 * Decrypts a TOTP secret from AES-256-GCM ciphertext.
 * Input format: base64(iv || ciphertext || authTag)
 */
export function decryptTotpSecret(ciphertext: string, authSecret: string): string {
    const key = deriveKey(authSecret);
    const combined = Buffer.from(ciphertext, 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

// ─── TOTP Secret Generation ────────────────────────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generates a cryptographically random 20-byte TOTP secret, base32-encoded.
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 */
export function generateTotpSecret(): string {
    const bytes = crypto.randomBytes(20);
    return base32Encode(bytes);
}

/**
 * Generates an otpauth:// URI for QR code rendering.
 * @param secret Base32-encoded TOTP secret
 * @param email User's email address (used as account label)
 * @param issuer Application name shown in authenticator app
 */
export function generateTotpUri(secret: string, email: string, issuer: string = 'Inflect'): string {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedEmail = encodeURIComponent(email);
    return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

// ─── TOTP Verification ─────────────────────────────────────────────

/**
 * Verifies a TOTP code against the secret with ±1 step window.
 * Supports 30-second period, 6-digit codes, SHA-1 HMAC (RFC 6238 defaults).
 */
export function verifyTotpCode(secret: string, code: string, windowSize: number = 1): boolean {
    return matchTotpStep(secret, code, windowSize) !== null;
}

/**
 * The time step (RFC 6238 counter) a valid code belongs to, or null.
 * A caller that must not accept the same code twice records the step and
 * accepts only a later one.
 */
export function matchTotpStep(secret: string, code: string, windowSize: number = 1): number | null {
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
        return null;
    }

    const secretBytes = base32Decode(secret);
    const now = Math.floor(Date.now() / 1000);
    const period = 30;

    for (let offset = -windowSize; offset <= windowSize; offset++) {
        const counter = Math.floor((now + offset * period) / period);
        const expected = generateHotp(secretBytes, counter);
        if (expected === code) {
            return counter;
        }
    }

    return null;
}

// ─── Internal HOTP Implementation ──────────────────────────────────

function generateHotp(secret: Buffer, counter: number): string {
    // Counter as 8-byte big-endian
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter & 0xFFFFFFFF, 4);

    const hmac = crypto.createHmac('sha1', secret).update(counterBuffer).digest();

    // Dynamic truncation
    const offset = hmac[hmac.length - 1] & 0x0F;
    const code = (
        ((hmac[offset] & 0x7F) << 24) |
        ((hmac[offset + 1] & 0xFF) << 16) |
        ((hmac[offset + 2] & 0xFF) << 8) |
        (hmac[offset + 3] & 0xFF)
    ) % 1000000;

    return code.toString().padStart(6, '0');
}

// ─── Base32 Encoding/Decoding ──────────────────────────────────────

function base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let result = '';

    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            result += BASE32_CHARS[(value >>> (bits - 5)) & 0x1F];
            bits -= 5;
        }
    }

    if (bits > 0) {
        result += BASE32_CHARS[(value << (5 - bits)) & 0x1F];
    }

    return result;
}

function base32Decode(input: string): Buffer {
    const cleanInput = input.toUpperCase().replace(/=+$/, '');
    const bytes: number[] = [];
    let bits = 0;
    let value = 0;

    for (const char of cleanInput) {
        const idx = BASE32_CHARS.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;

        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xFF);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}
