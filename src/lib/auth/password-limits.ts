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
 * could cost the login route. It does NOT guard against bcrypt's 72-byte input
 * truncation — 128 ASCII characters are 128 bytes, and 128 Cyrillic ones are
 * 256 — so two passwords sharing their first 72 UTF-8 bytes verify alike.
 * Whether to cap by bytes or pre-hash is open (#5306).
 */
export const MAX_PASSWORD_LENGTH = 128;
