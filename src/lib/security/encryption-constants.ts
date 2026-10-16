/**
 * GAP-03 — Shared encryption constants.
 *
 * Tiny standalone module so the env-validation schema (`src/env.ts`),
 * the encryption runtime (`src/lib/security/encryption.ts`), and the
 * server-startup hook (`src/instrumentation.ts`) can reference the
 * same dev-fallback key without a circular import. Putting this
 * value in any of those three modules would force the others to
 * pull in their full dependency graph just to compare a string.
 */

/**
 * The hard-coded fallback key used by `getRawKeyMaterial()` in
 * development and test when `DATA_ENCRYPTION_KEY` is unset.
 *
 * NEVER acceptable in production. Three independent guards refuse
 * to start a production process whose live key equals this value:
 *
 *   1. Zod schema (`src/env.ts`) — validation error at module load.
 *   2. Startup hook (`src/instrumentation.ts`) — process.exit(1).
 *   3. Test guard (`tests/unit/security/startup-encryption-check.test.ts`)
 *      — CI fails if either of the above stops checking.
 *
 * The value is documented in source intentionally; its security
 * property is "well-known + refused in production", not "secret".
 */
export const DEV_FALLBACK_DATA_ENCRYPTION_KEY =
    'inflect-dev-encryption-key-not-for-production-use!!';
