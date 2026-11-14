/**
 * Per-identifier (email) rate limiting for the credentials auth path.
 *
 * Sits alongside the per-IP NextAuth middleware
 * (`src/lib/rate-limit/authRateLimit.ts`, 10/min per IP). That middleware
 * catches volumetric abuse from a single source; this module catches
 * credential-stuffing where the attacker rotates IPs but hammers a
 * single account. Both run on the same login request.
 *
 * Policy:
 *   - 5 failed attempts per 15-minute sliding window per email address
 *   - Successful auth resets the counter (via {@link resetCredentialsBackoff})
 *   - Key is SHA-256(lowercased-trimmed email) — never the raw address,
 *     so the rate-limit cache can't be scraped to enumerate accounts
 *   - When `AUTH_TEST_MODE=1` the check is a no-op (keeps E2E test runs
 *     from tripping themselves), matching the convention in
 *     `authRateLimit.ts`
 *   - Fails OPEN on Redis error, matching the existing module — better
 *     to let a legit user through than to brick logins across the fleet
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';
import { edgeLogger } from '@/lib/observability/edge-logger';

// ── Policy ─────────────────────────────────────────────────────────────

export const CREDENTIALS_RATE_LIMIT = {
    maxAttempts: 5,
    windowSeconds: 15 * 60, // 15 minutes
} as const;

// ── Upstash / memory fallback (same pattern as authRateLimit.ts) ──────

let _limiter: Ratelimit | null = null;
let _initialized = false;

function initLimiter() {
    if (_initialized) return;
    _initialized = true;
    if (env.RATE_LIMIT_MODE !== 'upstash') return;
    try {
        _limiter = new Ratelimit({
            redis: Redis.fromEnv(),
            limiter: Ratelimit.slidingWindow(
                CREDENTIALS_RATE_LIMIT.maxAttempts,
                `${CREDENTIALS_RATE_LIMIT.windowSeconds} s`,
            ),
            analytics: false,
        });
    } catch (err) {
        edgeLogger.error('Failed to init credential rate-limit Upstash', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

// Memory fallback — shared across the process. Sliding window is approximated
// as a fixed-window bucket; good enough for dev and CI.
const _memoryAttempts = new Map<string, { count: number; expiresAt: number }>();

// ── Identifier key ─────────────────────────────────────────────────────

/** Hex SHA-256 of the normalised email. Never store plaintext email as a cache key. */
async function hashIdentifier(email: string): Promise<string> {
    const normalised = (email ?? '').trim().toLowerCase();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalised);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── Public contract ────────────────────────────────────────────────────

export type CredentialsRateLimitDecision =
    | { ok: true }
    | { ok: false; retryAfterSeconds: number };

/**
 * Check whether the caller is allowed to attempt a login for this email.
 * Call BEFORE hitting bcrypt — the point of this check is to short-
 * circuit the expensive verify work for hammered accounts.
 *
 * A call counts toward the limit. Successful auth should call
 * {@link resetCredentialsBackoff} to clear the bucket so a legitimate
 * user isn't permanently blocked after 5 typos.
 */
export async function checkCredentialsAttempt(
    email: string,
): Promise<CredentialsRateLimitDecision> {
    // E2E tests + explicit kill-switch short-circuit the check. Keep this
    // in lockstep with `authRateLimit.ts` so operators have one flag to
    // pull if the limiter misbehaves in prod.
    if (env.AUTH_TEST_MODE === '1' || env.RATE_LIMIT_ENABLED === '0') {
        return { ok: true };
    }

    const ident = await hashIdentifier(email).catch(() => '');
    if (!ident) {
        // crypto.subtle unavailable (shouldn't happen on modern Node/edge).
        // Fail open — same policy as the upstream IP limiter.
        return { ok: true };
    }

    const key = `rl:cred:id:${ident}`;

    initLimiter();
    try {
        if (_limiter) {
            const result = await _limiter.limit(key);
            if (result.success) return { ok: true };
            return {
                ok: false,
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((result.reset - Date.now()) / 1000),
                ),
            };
        }

        // Memory fallback
        const now = Date.now();
        const windowMs = CREDENTIALS_RATE_LIMIT.windowSeconds * 1000;
        let bucket = _memoryAttempts.get(key);
        if (!bucket || bucket.expiresAt <= now) {
            bucket = { count: 0, expiresAt: now + windowMs };
        }
        bucket.count += 1;
        _memoryAttempts.set(key, bucket);
        if (bucket.count <= CREDENTIALS_RATE_LIMIT.maxAttempts) {
            return { ok: true };
        }
        return {
            ok: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
        };
    } catch (err) {
        // Fail open on infrastructure error.
        edgeLogger.warn('Credential rate-limit check failed; failing open', {
            component: 'rate-limit',
            err: String(err),
        });
        return { ok: true };
    }
}

/**
 * Clear the per-email counter after a successful login. Without this a
 * legitimate user who typo'd their password 5 times gets locked out for
 * 15 minutes even after getting it right — unnecessary friction, and
 * counterproductive against credential stuffing (an attacker who just
 * GOT the correct creds doesn't need more attempts).
 *
 * Both stores get cleared:
 *   • the in-process memory fallback (one `Map.delete`)
 *   • Upstash, if initialised — through the limiter's own
 *     `resetUsedTokens`, which deletes every per-window key it wrote
 *
 * Fails open on a Redis error: the worst case is the user has to wait
 * for the bucket to age out of the 15-minute window naturally, which
 * is the previous behaviour. Better than 500ing a successful login.
 */
export async function resetCredentialsBackoff(email: string): Promise<void> {
    const ident = await hashIdentifier(email).catch(() => '');
    if (!ident) return;
    const key = `rl:cred:id:${ident}`;
    _memoryAttempts.delete(key);

    // Clear Upstash too when we're in upstash mode. The sliding window
    // does NOT store its state under `key`: it writes
    // `<prefix>:<key>:<window>` for the current and previous window, so a
    // `DEL` on the bare key deleted nothing (#5306). `resetUsedTokens`
    // builds the prefixed pattern itself and also drops the limiter's
    // in-process block cache for the identifier.
    initLimiter();
    if (_limiter) {
        try {
            await _limiter.resetUsedTokens(key);
        } catch (err) {
            edgeLogger.warn(
                'Credential rate-limit reset: Upstash reset failed; bucket will age out naturally',
                { component: 'rate-limit', err: String(err) },
            );
        }
    }
}

/**
 * Test-only helper: wipes the in-memory counters AND the Upstash
 * initialisation flag so the next call re-reads `env.RATE_LIMIT_MODE`.
 * Exported instead of reaching into private state from tests so jest
 * setups that flip env between test files get a predictable reset
 * point.
 */
export function __resetCredentialsRateLimitForTests(): void {
    _memoryAttempts.clear();
    _limiter = null;
    _initialized = false;
}
