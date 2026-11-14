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
 * Max length. A bound on the BODY of a login or set-password request, and
 * nothing more.
 *
 * It used to claim it also guarded "bcrypt's documented 72-byte input
 * truncation surprise", which it could not: 128 characters is nearly double
 * that, and every check compares `String.length` — UTF-16 code units — against
 * it. The cut fell at the 37th Cyrillic character, on a product that ships a
 * Bulgarian UI. Truncation is handled where it can be, by pre-hashing the
 * password before bcrypt sees it (`prehashForBcrypt`, #5592).
 */
export const MAX_PASSWORD_LENGTH = 128;
