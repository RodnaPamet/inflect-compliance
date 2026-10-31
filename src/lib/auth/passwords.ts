/**
 * Password hashing — production-grade primitives. The ONE place the app
 * hashes or verifies a password; `src/lib/auth.ts` re-exports it.
 *
 * ## Algorithm
 * bcrypt via the native `bcrypt` package at work factor 12. Sits safely
 * inside the OWASP 2024 guidance (≥10 for bcrypt). The cost is
 * centralised in `BCRYPT_COST` so a future bump is a single edit + a
 * re-hash on next login via `needsRehash()`.
 *
 * ## Why native bcrypt, not bcryptjs
 * Until 2026-10-26 this used `bcryptjs`, which is pure JavaScript and so
 * hashes on Node's ONE main thread. A check at cost 12 is ~300 ms of CPU,
 * and concurrent logins took turns on that thread: 25 at once all finished
 * together after ~7.8 s, while every other request on the process waited
 * with them. That is the nightly k6 login p95 of 8.4 s.
 *
 * Native `bcrypt` runs each hash on libuv's thread pool, off the main
 * thread and across cores (measured: 25 concurrent checks, p95 ~3 s on
 * four cores, with the main thread free throughout). Its output is the
 * same `$2b$` format, and it verifies the `$2a$`/`$2b$` hashes bcryptjs
 * wrote, so no stored hash changes — `tests/unit/security/
 * password-verify-bcrypt-interop.test.ts` holds that. It ships prebuilt
 * binaries for glibc and musl (the node:24-alpine image); Next lists it
 * in its default `serverExternalPackages`. Nothing on the edge runtime
 * imports this file.
 *
 * Switching to argon2 later is an isolated change in this file;
 * `needsRehash()` + the login flow's "rehash on successful verify" path
 * (see `src/lib/auth/credentials.ts`) migrates users silently.
 *
 * ## What does NOT belong in this file
 * - User lookup, tenant resolution, lockout, rate limiting, audit
 *   logging — those live in `src/lib/auth/credentials.ts`. This file
 *   is *pure crypto*: plaintext + hash in, boolean out.
 */

// `bcrypt` is published as CommonJS. Node.js's ESM-importing-CJS interop
// in newer Node versions wraps the exports under `.default` on the
// dynamic-import namespace; older Node spreads them to the top level.
// Normalise here so callers can treat the result as the bcrypt module
// regardless of the host Node's ESM/CJS interop behaviour.
//
// Without this, `(await import(…)).compare` is undefined on Node ≥ 22 when
// tsx / next compile this file as ESM, and verifyPassword silently returns
// false for every login attempt — locking out every credentials user. That
// happened once with bcryptjs; the same normalisation applies here.
const bcryptModule = import('bcrypt').then((m) => {
    return (m as unknown as { default?: typeof m }).default ?? m;
});

/**
 * `$2y$` is PHP's name for the same algorithm as `$2b$`. bcryptjs accepted
 * it; native bcrypt returns false for it, which would lock out a user whose
 * stored hash was imported in that form. Compare it as `$2b$`, and
 * `needsRehash` rewrites it on the next login.
 */
function comparableHash(hash: string): string {
    return hash.startsWith('$2y$') ? `$2b$${hash.slice(4)}` : hash;
}

/** Current default bcrypt work factor. OWASP 2024 floor for bcrypt is 10. */
export const BCRYPT_COST = 12;

// The length limits live in a client-safe module so a form can check them
// before it sends (#4688); they are re-exported here for the server.
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-limits';
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH };

// ── Hashing ────────────────────────────────────────────────────────────

/**
 * Hash a password for storage. Uses bcrypt at {@link BCRYPT_COST}.
 *
 * Throws if `plaintext` is falsy or exceeds {@link MAX_PASSWORD_LENGTH}.
 * Does NOT enforce {@link MIN_PASSWORD_LENGTH} — callers should run the
 * plaintext through {@link validatePasswordPolicy} first and surface
 * the error to the user before we get here.
 */
export async function hashPassword(plaintext: string): Promise<string> {
    if (!plaintext) throw new Error('hashPassword: plaintext is empty');
    if (plaintext.length > MAX_PASSWORD_LENGTH) {
        throw new Error(`hashPassword: plaintext exceeds ${MAX_PASSWORD_LENGTH} chars`);
    }
    const bcrypt = await bcryptModule;
    return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a password against a stored hash. Returns `false` for every
 * failure mode — empty input, malformed hash, null hash, wrong password —
 * so the caller can't distinguish "user has no password" from "user
 * supplied the wrong password" by boolean alone. That shape is what
 * {@link credentials.ts} relies on for account-enumeration safety.
 *
 * bcrypt.compare itself is constant-time *relative to hashes of equal
 * length*, which is what we want — a different-length hash already
 * failed (malformed) and returns fast, but we don't care about timing
 * in that path because the account-not-found path equalises timing
 * upstream via `dummyVerify`.
 */
export async function verifyPassword(
    plaintext: string,
    hash: string | null | undefined,
): Promise<boolean> {
    if (!plaintext || !hash) return false;
    if (plaintext.length > MAX_PASSWORD_LENGTH) return false;
    try {
        const bcrypt = await bcryptModule;
        return await bcrypt.compare(plaintext, comparableHash(hash));
    } catch {
        // Malformed hash in the DB — treat as verification failure, don't
        // leak to callers that the record is corrupted.
        return false;
    }
}

/**
 * A precomputed bcrypt hash of an unguessable placeholder string.
 * {@link dummyVerify} runs `bcrypt.compare` against this so the code
 * path for "user not found" still pays the bcrypt CPU cost. Prevents
 * account enumeration via response-time analysis.
 *
 * Re-hashed at module load with the current BCRYPT_COST so timing
 * matches real comparisons. We could inline a pre-baked string but
 * the cost is one-time at boot and keeps the hash in lockstep with
 * whatever BCRYPT_COST becomes in the future.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
    if (!dummyHashPromise) {
        dummyHashPromise = hashPassword(
            'dummy-placeholder-for-timing-equalisation-do-not-use',
        );
    }
    return dummyHashPromise;
}

/**
 * Runs a bcrypt.compare against a dummy hash so the user-not-found path
 * matches the timing of a real failed verify. Always returns `false`.
 * Call this in the "no user" / "no password hash" branch of your auth
 * flow so an attacker can't enumerate emails via response time.
 */
export async function dummyVerify(plaintext: string): Promise<false> {
    const [bcrypt, hash] = await Promise.all([bcryptModule, getDummyHash()]);
    try {
        await bcrypt.compare(plaintext ?? '', hash);
    } catch {
        // Best-effort timing burn; any error path still returns false.
    }
    return false;
}

// ── Rehash-on-verify migration hook ────────────────────────────────────

/**
 * Returns true when a stored hash should be re-hashed on next successful
 * verification — typically because the work factor has moved up.
 *
 * Silent migration pattern:
 *   1. User logs in with plaintext X
 *   2. verifyPassword(X, oldHash) → true
 *   3. needsRehash(oldHash) → true
 *   4. hashPassword(X) → newHash; persist; done
 *
 * This lets us bump BCRYPT_COST (or swap to argon2id later) without
 * forcing a password-reset email campaign.
 */
export function needsRehash(hash: string | null | undefined): boolean {
    if (!hash) return false; // No hash to rehash; login will fail upstream
    // bcrypt hashes begin `$2a$<cost>$` / `$2b$<cost>$` / `$2y$<cost>$`.
    // Anything else is from a different algorithm and definitely needs
    // re-hashing if we keep bcrypt as canonical. `$2y$` verifies only
    // through `comparableHash`, so it is rewritten as `$2b$` too.
    const match = /^\$2([aby])\$(\d{2})\$/.exec(hash);
    if (!match) return true;
    if (match[1] === 'y') return true;
    const cost = Number(match[2]);
    return cost < BCRYPT_COST;
}

// ── Password policy (for new passwords only) ───────────────────────────

export type PasswordPolicyResult =
    | { ok: true }
    | { ok: false; reason: 'too_short' | 'too_long' | 'empty' };

/**
 * Validate a plaintext against the minimum password policy. Only runs
 * at the point of *setting* a password (register, change, reset) — NOT
 * at login. Pre-existing users whose passwords predate a policy bump
 * are not locked out by a new rule.
 *
 * Keeps the policy narrow on purpose: length floor + length ceiling.
 * We don't mandate special characters / mixed case / etc. — NIST 800-63B
 * explicitly deprecates those requirements in favour of length and
 * breach-list screening. Breach-list screening lives in a later prompt.
 */
export function validatePasswordPolicy(plaintext: string): PasswordPolicyResult {
    if (!plaintext) return { ok: false, reason: 'empty' };
    if (plaintext.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
    if (plaintext.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'too_long' };
    return { ok: true };
}

/**
 * Human-readable, user-facing message for a failed
 * {@link validatePasswordPolicy}. Kept here next to the policy so the
 * wording and the numeric bounds can never drift apart — every
 * password-setting route (register, change, reset) renders the same
 * sentence for the same failure.
 */
export function describePasswordPolicyFailure(
    reason: Exclude<PasswordPolicyResult, { ok: true }>['reason'],
): string {
    switch (reason) {
        case 'too_short':
            return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        case 'too_long':
            return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
        case 'empty':
            return 'Password is required.';
    }
}
