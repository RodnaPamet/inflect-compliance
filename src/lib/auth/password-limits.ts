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

/** Max length guards against bcrypt's documented 72-byte input truncation
 *  surprise and against memory-abuse via a giant body on the login route. */
export const MAX_PASSWORD_LENGTH = 128;
