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
 *
 * THAT QUESTION, left open by #5593, is answered in #5592: the password is
 * PRE-HASHED before bcrypt sees it (`prehashForBcrypt`), so no input is
 * truncated and this limit keeps only the job it could ever do. It lands in two
 * deploys — the read side first, the write side after — because a pre-hashed
 * hash cannot be opened by a build that compares the raw plaintext, so shipping
 * both at once would let a rollback strand everyone who set a password in the
 * window.
 */
export const MAX_PASSWORD_LENGTH = 128;
