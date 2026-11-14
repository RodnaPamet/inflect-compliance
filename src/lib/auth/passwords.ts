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

/**
 * What bcrypt actually hashes: base64(sha256(plaintext)) — #5592.
 *
 * ═══ THE DEFECT THIS REMOVES ═══
 *
 * bcrypt reads at most 72 BYTES of input and silently ignores the rest, so any
 * two passwords sharing their first 72 bytes were interchangeable.
 * `MAX_PASSWORD_LENGTH` was documented as the guard against that and could not
 * be: it caps 128 CHARACTERS, nearly double the truncation point, and every
 * check measured `String.length` — UTF-16 code units — against a limit in
 * bytes.
 *
 * Where that bites is not where an English reader would guess. UTF-8 spends two
 * bytes on Cyrillic, so the cut falls at the 37th character, and this product
 * ships a Bulgarian UI: a 40-character Bulgarian passphrase lost its last four
 * characters, and passphrase advice makes long ones MORE likely among exactly
 * the users who reach the limit soonest. Four bytes per emoji puts it at 19.
 *
 * ═══ WHY PRE-HASHING RATHER THAN A BYTE CAP ═══
 *
 * A 72-byte cap would stop new truncation, and at `verifyPassword` it would
 * lock out every existing user whose password is longer than that — their
 * stored hash was made from the truncated input, so the full input would be
 * refused before the compare. Applied only at set time it is safe and leaves a
 * Bulgarian user unable to choose a passphrase over 36 characters, which taxes
 * the people the defect already hurt. Pre-hashing removes the limit for
 * everyone (owner decision, 2026-11-14).
 *
 * ═══ THIS FUNCTION IS PART OF THE CREDENTIAL SCHEME ═══
 *
 * sha256 is 32 bytes and base64 is 44 ASCII characters of it, so every input —
 * any length, any script — reaches bcrypt as exactly 44 bytes and nothing is
 * truncated. base64 also carries no NUL byte, which some bcrypt
 * implementations treat as a terminator.
 *
 * CHANGING THE ALGORITHM, THE ENCODING OR THE INPUT ENCODING INVALIDATES EVERY
 * HASH MADE UNDER IT. There is no field recording which scheme a stored hash
 * used — `verifyPassword` probes — so a third scheme means a third probe. If
 * one is ever needed, record the scheme instead.
 */
export function prehashForBcrypt(plaintext: string): string {
    return createHash('sha256').update(plaintext, 'utf8').digest('base64');
}

// The length limits live in a client-safe module so a form can check them
// before it sends (#4688); they are re-exported here for the server.
import { createHash } from 'node:crypto';
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
    // STILL THE RAW PLAINTEXT, and that is deliberate — this is deploy 1 of
    // two (#5592, owner decision 2026-11-14).
    //
    // `verifyPasswordWithScheme` can already READ a pre-hashed hash, but
    // nothing writes one yet. Writing one here in the same deploy would make a
    // rollback strand every user who set a password while it was live: the
    // previous image compares the raw plaintext, and no raw comparison can
    // open a pre-hashed hash. `password-verify-bcrypt-interop` names that
    // guarantee — "a hash the new hasher writes is one bcryptjs reads, so a
    // rollback strands nobody" — and it is what caught this.
    //
    // Deploy 2 flips this one call to `prehashForBcrypt(plaintext)` and wires
    // the re-hash in `credentials.ts`. Reverting THAT lands on an image which
    // can still read what it wrote, because of the probe shipped here.
    return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a password against a stored hash. Returns `false` for every
 * failure mode — empty input, malformed hash, null hash, wrong password —
 * so the caller can't distinguish "user has no password" from "user
 * supplied the wrong password" by boolean alone. That shape is what
 * {@link credentials.ts} relies on for account-enumeration safety.
 *
 * Every failure costs one bcrypt compare. An empty or over-long input, a
 * missing or malformed hash all run `dummyVerify`, so a sign-in that names
 * a registered account takes as long as one that names an unknown account
 * (which the caller answers with `dummyVerify`), whatever the input.
 */
export async function verifyPassword(
    plaintext: string,
    hash: string | null | undefined,
): Promise<boolean> {
    return (await verifyPasswordWithScheme(plaintext, hash)).ok;
}

/** What {@link verifyPasswordWithScheme} answers. */
export interface PasswordVerification {
    readonly ok: boolean;
    /**
     * True when the password matched a hash made BEFORE pre-hashing (#5592),
     * so the caller should re-hash it. There is no field recording the scheme,
     * and both schemes produce an identical `$2b$12$…` shape, so `needsRehash`
     * cannot see this — it must be carried out of the verify.
     */
    readonly legacyScheme: boolean;
}

/**
 * Verify, and say which scheme matched.
 *
 * ═══ BOTH COMPARES RUN, ALWAYS, CONCURRENTLY ═══
 *
 * Not an optimisation — the timing property this file is built around.
 * `verifyPassword`'s contract is that "a sign-in that names a registered
 * account takes as long as one that names an unknown account", which
 * `credentials.ts` relies on for account-enumeration safety. Short-circuiting
 * on the pre-hashed compare would make a new-scheme account answer in ONE
 * bcrypt and everything else in two, so the fast answer would mark a
 * registered, already-migrated account.
 *
 * So the work is constant: two compares for every call, including
 * `dummyVerify`'s. `bcrypt` here is the NATIVE module, which runs on libuv's
 * threadpool, so `Promise.all` overlaps them and the wall clock stays at about
 * one compare. On a pure-JS bcrypt they would serialise and logins would cost
 * twice the latency — worth knowing before swapping the dependency.
 *
 * Returning `false` for every failure mode is unchanged: empty input, over-long
 * input, missing hash, malformed hash and wrong password are one answer, so a
 * caller cannot tell "user has no password" from "wrong password".
 */
export async function verifyPasswordWithScheme(
    plaintext: string,
    hash: string | null | undefined,
): Promise<PasswordVerification> {
    if (!plaintext || !hash || plaintext.length > MAX_PASSWORD_LENGTH) {
        await dummyVerify((plaintext ?? '').slice(0, MAX_PASSWORD_LENGTH));
        return { ok: false, legacyScheme: false };
    }
    try {
        const bcrypt = await bcryptModule;
        const stored = comparableHash(hash);
        const [current, legacy] = await Promise.all([
            bcrypt.compare(prehashForBcrypt(plaintext), stored),
            // The raw plaintext, which is what every hash made before #5592
            // was built from. bcrypt itself truncated it at 72 bytes then, and
            // still does here — that is precisely why this compare matches
            // those hashes and why the password must be re-hashed after it.
            bcrypt.compare(plaintext, stored),
        ]);
        if (current) return { ok: true, legacyScheme: false };
        if (legacy) return { ok: true, legacyScheme: true };
        return { ok: false, legacyScheme: false };
    } catch {
        // Malformed hash in the DB — treat as verification failure, don't
        // leak to callers that the record is corrupted.
        await dummyVerify(plaintext);
        return { ok: false, legacyScheme: false };
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
        // TWO compares, matching what a real verification now costs (#5592).
        // One would make an unknown account answer faster than a registered
        // one, which is the enumeration signal this function exists to remove.
        await Promise.all([
            bcrypt.compare(prehashForBcrypt(plaintext ?? ''), hash),
            bcrypt.compare(plaintext ?? '', hash),
        ]);
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
