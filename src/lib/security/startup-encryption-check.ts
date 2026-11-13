/**
 * GAP-03 — Production startup checks for DATA_ENCRYPTION_KEY.
 *
 * Two helpers used by `src/instrumentation.ts` to enforce that no
 * production process serves traffic with encryption-at-rest broken
 * or absent. Defense-in-depth alongside the schema-level check in
 * `src/env.ts`:
 *
 *   1. `checkProductionEncryptionKey(env)` — synchronous config
 *      validation. Asserts presence + length + not-equal-to the
 *      documented dev fallback. Catches the case where the schema
 *      check is bypassed via `SKIP_ENV_VALIDATION=1` leaking into
 *      the runtime container.
 *
 *   2. `runEncryptionSentinel()` — async functional pre-flight.
 *      Encrypts and decrypts a fixed plaintext, asserts the round-
 *      trip matches. Catches a key that's structurally valid (32+
 *      chars, not the fallback) but breaks under HKDF/AES-GCM (e.g.
 *      a binary blob written to env). Surfaces as a clear startup
 *      error instead of a 500 on the first user write.
 *
 * Both return a discriminated union so the instrumentation hook can
 * uniformly map failure → console.error + process.exit(1), and tests
 * can assert behaviour without spawning child processes that
 * literally exit.
 */

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from './encryption-constants';

export type StartupCheckOutcome =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Synchronous config check. Returns ok=true for any non-production
 * environment so dev/test ergonomics are preserved.
 *
 * @param env Caller passes `process.env` (or a synthetic record in
 *            tests) so the function is pure and trivially mockable.
 */
export function checkProductionEncryptionKey(
    env: NodeJS.ProcessEnv,
): StartupCheckOutcome {
    if (env.NODE_ENV !== 'production') return { ok: true };

    const key = env.DATA_ENCRYPTION_KEY;
    if (!key || key.length < 32) {
        return {
            ok: false,
            reason:
                'DATA_ENCRYPTION_KEY is required in production and must be ' +
                'at least 32 characters. Generate with: openssl rand -base64 48',
        };
    }
    if (key === DEV_FALLBACK_DATA_ENCRYPTION_KEY) {
        return {
            ok: false,
            reason:
                'DATA_ENCRYPTION_KEY equals the documented dev fallback. ' +
                'Refusing to boot — generate a real key with: ' +
                'openssl rand -base64 48',
        };
    }

    // ═══ A ROTATION WITH THE LOOKUP HASHES STILL FOLLOWING THE KEK (#5071) ═══
    //
    // The one state in which this deployment is about to break every
    // email-based sign-in, and it is exactly detectable: a rotation is in
    // progress (the runbook sets DATA_ENCRYPTION_KEY_PREVIOUS) while the
    // lookup-hash key still falls back to DATA_ENCRYPTION_KEY, which has just
    // changed. Every stored `*Hash` was computed under the PREVIOUS key, and a
    // hash has no previous-key fallback the way a ciphertext does — a miss
    // reads as "no such user", so credentials, OAuth/SSO matching and invite
    // redemption all fail silently and uniformly.
    //
    // Refusing to boot is the right direction: the alternative is a running
    // deployment nobody can log in to, discovered by its users. The remedy is
    // one variable and no backfill, so the refusal names it.
    //
    // This sits INSIDE the existing check rather than beside it so that every
    // surface already calling this — the web tier, the worker, the scheduler —
    // gets it without new wiring to forget.
    const lookupKey = env.LOOKUP_HASH_KEY;
    if (env.DATA_ENCRYPTION_KEY_PREVIOUS && !(lookupKey && lookupKey.length >= 32)) {
        return {
            ok: false,
            reason:
                'DATA_ENCRYPTION_KEY_PREVIOUS is set (a master-KEK rotation is in ' +
                'progress) but LOOKUP_HASH_KEY is not. The deterministic lookup ' +
                'hashes (User.emailHash and friends) derive from DATA_ENCRYPTION_KEY ' +
                'when LOOKUP_HASH_KEY is unset, so every email-based sign-in, SSO/OAuth ' +
                'account match and invite redemption would miss. Set LOOKUP_HASH_KEY to ' +
                'the value now in DATA_ENCRYPTION_KEY_PREVIOUS — the key those hashes ' +
                'were computed under — and restart. No backfill is needed.',
        };
    }

    return { ok: true };
}

/**
 * Functional pre-flight. Imports the encryption module and rounds a
 * fixed plaintext through encrypt → decrypt. Any failure path
 * (HKDF derive throw, AES-GCM auth failure, mismatch) returns
 * ok=false with the underlying error captured in `reason`.
 *
 * Never logs the plaintext or any portion of the key. The reason
 * string is operator-facing — it carries the failure class, never
 * secret material.
 */
export async function runEncryptionSentinel(): Promise<StartupCheckOutcome> {
    const sentinel = 'inflect-startup-sentinel';
    try {
        const { encryptField, decryptField } = await import('./encryption');
        const round = decryptField(encryptField(sentinel));
        if (round !== sentinel) {
            return {
                ok: false,
                reason: 'encryption sentinel: round-trip mismatch',
            };
        }
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            reason:
                'encryption sentinel: ' +
                (err instanceof Error ? err.message : String(err)),
        };
    }
}
