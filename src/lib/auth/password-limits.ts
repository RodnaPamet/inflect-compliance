/**
 * The password length limits, client-safe (#4688).
 *
 * `passwords.ts` re-exports these, and the server enforces them through
 * `validatePasswordPolicy`. They live apart so a form can check them before
 * it sends: `passwords.ts` loads bcrypt and cannot reach the browser.
 */

/**
 * Minimum password length enforced at the point of setting (register,
 * change-password, reset-password). Login verification does not re-check —
 * old users whose passwords predate the policy can still authenticate.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Max length, in UTF-16 code units: bounds the work and memory a giant body
 * could cost the login route, and is the most `hashPassword` accepts. It does
 * NOT guard against bcrypt's 72-byte input truncation — 128 ASCII characters
 * are 128 bytes, and 128 Cyrillic ones are 256. {@link MAX_PASSWORD_BYTES} is
 * the ceiling a new password is held to.
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The most UTF-8 bytes a NEW password may have (owner decision, 2026-11-14,
 * #5306). bcrypt reads only the first 72 bytes of its input, so two longer
 * passwords sharing those bytes would verify alike. A password over the cap is
 * refused where it is set (register, change-password, reset-password) as
 * `too_long`; it is not pre-hashed, which the owner rejected.
 *
 * Bytes, not characters: a Latin letter or digit is one byte, a Cyrillic
 * letter two, most other scripts three and an emoji four, so 40 Cyrillic
 * letters are already 80 bytes.
 *
 * Set-time only. Sign-in and the rehash it may trigger take an existing
 * password of any length up to {@link MAX_PASSWORD_LENGTH} as before, so
 * nobody whose password predates the cap is locked out by it.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A password's length in UTF-8 bytes, which is what bcrypt reads. A lone
 * surrogate counts as the three bytes of the U+FFFD `TextEncoder` writes for it.
 */
export function passwordByteLength(plaintext: string): number {
    return new TextEncoder().encode(plaintext).length;
}
