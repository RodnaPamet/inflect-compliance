/**
 * In-Memory Rate Limiter
 *
 * Simple sliding-window rate limiter for brute-force protection.
 * Uses a Map to track attempt timestamps per key (IP, userId, etc.).
 *
 * DESIGN: In-memory is appropriate for single-instance deployments.
 * For multi-instance, swap to Redis-backed limiter.
 *
 * This module is intentionally simple and dependency-free.
 */

interface RateLimitEntry {
    timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(windowMs: number) {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store) {
            entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
            if (entry.timestamps.length === 0) {
                store.delete(key);
            }
        }
    }, CLEANUP_INTERVAL);
    // Allow Node.js to exit even if timer is running
    if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
        cleanupTimer.unref();
    }
}

export interface RateLimitConfig {
    /** Maximum number of requests allowed in the window */
    maxAttempts: number;
    /** Window duration in milliseconds */
    windowMs: number;
    /** Optional: lockout duration in ms after max attempts exceeded */
    lockoutMs?: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

/**
 * Check if a request is within rate limits.
 *
 * `units` charges several attempts at once, ALL OR NOTHING: either every unit
 * fits in the window and all are recorded, or none is and the request is
 * refused with the budget untouched. One JSON-RPC batch is the caller — charging
 * it one unit at a time would spend the remaining budget on the messages that
 * fit and then refuse the rest, so a client retrying a refused batch would find
 * less budget than it was refused with. With the default of 1 the behaviour is
 * exactly the single-attempt check every other caller relies on.
 *
 * @param key - Unique identifier (e.g., `mfa:${userId}`, `login:${ip}`)
 * @param config - Rate limit configuration
 * @param units - Attempts this request costs (default 1)
 * @returns Whether the request is allowed and how many attempts remain
 */
export function checkRateLimit(
    key: string,
    config: RateLimitConfig,
    units = 1,
): RateLimitResult {
    startCleanup(config.windowMs);

    const now = Date.now();
    const entry = store.get(key) || { timestamps: [] };

    // Remove timestamps outside the window
    const windowStart = now - config.windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    // Check lockout: if last attempt was within lockout period and at max
    if (config.lockoutMs && entry.timestamps.length >= config.maxAttempts) {
        const lastAttempt = entry.timestamps[entry.timestamps.length - 1];
        const lockoutEnd = lastAttempt + config.lockoutMs;
        if (now < lockoutEnd) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: lockoutEnd - now,
            };
        }
        // Lockout expired, reset
        entry.timestamps = [];
    }

    if (entry.timestamps.length + units > config.maxAttempts) {
        store.set(key, entry);
        // The request fits once enough of the oldest attempts have left the
        // window to make room for all `units`. For one unit that is the oldest
        // attempt, as it always was. A charge larger than the whole budget can
        // never fit; callers bound that before asking (the MCP route refuses
        // such a batch with a 400), and the window is the honest answer here.
        const freeingIndex = entry.timestamps.length + units - config.maxAttempts - 1;
        const freeingAt = entry.timestamps[Math.max(0, freeingIndex)];
        return {
            allowed: false,
            remaining: Math.max(0, config.maxAttempts - entry.timestamps.length),
            retryAfterMs:
                units > config.maxAttempts || freeingAt === undefined
                    ? config.windowMs
                    : freeingAt + config.windowMs - now,
        };
    }

    // Record this attempt — every unit of it.
    for (let i = 0; i < units; i += 1) entry.timestamps.push(now);
    store.set(key, entry);

    return {
        allowed: true,
        remaining: config.maxAttempts - entry.timestamps.length,
        retryAfterMs: 0,
    };
}

/**
 * Reset rate limit for a key (e.g., after successful auth).
 */
export function resetRateLimit(key: string): void {
    store.delete(key);
}

/**
 * For testing: clear all rate limit state.
 */
export function clearAllRateLimits(): void {
    store.clear();
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

// ─── Preset Configurations ──────────────────────────────────────────
//
// Each preset encodes a policy choice. The numbers are not arbitrary —
// they balance user ergonomics against abuse resistance. Sizing rule
// of thumb:
//
//   sensitive auth flow   → small window, small budget, lockout
//   normal mutation       → per-minute window, moderate budget
//   highly privileged op  → hour window, tiny budget
//
// When you add a new preset, document the threat model in the JSDoc
// and prefer tighter-than-you-think limits — the middleware returns
// a clean 429 + Retry-After, not an opaque error.

/** MFA verify: 5 attempts per 15 minutes, 5 min lockout after exhaustion */
export const MFA_VERIFY_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,     // 15 minutes
    lockoutMs: 5 * 60 * 1000,     // 5 minute lockout
};

/** MFA enrollment verify: 10 attempts per 15 minutes */
export const MFA_ENROLL_VERIFY_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
};

/**
 * Login (credentials / SSO callback / password reset):
 *   10 attempts per 15 minutes, 15 min lockout after exhaustion.
 *
 * Threat model: online password brute-force. The lockout doubles as
 * a back-pressure signal — an attacker spraying credentials across
 * thousands of accounts gets degraded throughput per IP even when
 * they rotate usernames, because the middleware keys by IP+userId
 * when available but falls back to IP alone for pre-authentication.
 */
export const LOGIN_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
};

/**
 * General mutation API: 60 requests per minute per (IP, userId).
 *
 * Threat model: a compromised credential or a runaway client making
 * thousands of writes per second. The limit is intentionally
 * generous — normal interactive use doesn't come close (a user
 * filling a detail form might submit 2-3 writes per minute). Scripts
 * and tests that need higher throughput should use an API key with
 * a dedicated rate plan (future work), not share the interactive
 * budget.
 */
export const API_MUTATION_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * General read API: 120 requests per minute per (IP, userId, tenantSlug).
 *
 * GAP-17. Applied at the Edge middleware to GET requests on
 * `/api/t/<slug>/...`, excluding health probes (`/api/health`,
 * `/api/livez`, `/api/readyz`) and `/api/docs`.
 *
 * Threat model: scraping / accidental overload — a runaway frontend
 * that fans out many list calls per page load, an abusive script
 * iterating filter combinations, or a compromised credential
 * scraping data. The limit is roughly 2× the mutation budget because
 * reads are cheaper, idempotent, and a normal page load can fan
 * out to 5-10 list endpoints (controls + risks + evidence + counts
 * + traceability + …); 120/min comfortably covers that for a single
 * actor while still tripping a real scraper within seconds.
 *
 * Bucketing: per (IP, userId, tenantSlug) so a single user with a
 * runaway tab in tenant A doesn't burn the budget for the same user
 * in tenant B. The tenantSlug appears as a scope namespace in the
 * key, not as part of the identifier — meaning N users in one
 * tenant each get their own bucket, not a shared tenant pool.
 *
 * The actual enforcement lives in `src/lib/rate-limit/apiReadRateLimit.ts`
 * (Upstash + memory-fallback, mirrors `authRateLimit.ts`). This
 * preset is the single source of truth for the numbers; the
 * enforcement module re-uses them.
 */
export const API_READ_LIMIT: RateLimitConfig = {
    maxAttempts: 120,
    windowMs: 60 * 1000,
};

/**
 * `/api/mcp`, per API KEY: 60 JSON-RPC messages per minute per key.
 *
 * The MCP endpoint used to ride the default mutation tier, keyed
 * `api-mutation:ip:<ip>:anon` — one bucket per caller IP, shared with every
 * other default mutation route. That is the wrong unit for this surface. A
 * hosted MCP client (Anthropic's Managed Agents, the Messages API's MCP
 * connector) calls from its provider's egress addresses, so every customer
 * agent hosted there would share one 60/min budget, and one busy agent would
 * throttle every other customer's.
 *
 * So the budget belongs to the key. The bucket is the VERIFIED
 * `apiKeyId`, charged once `verifyMcpCredential` succeeds and before the
 * invocation is built (#4205) — never a digest
 * of the presented token, which is the thing an unauthenticated caller varies
 * (see `docs/rate-limiting.md` → *API-key callers*). An exchanged token
 * resolves to its issuing key, so exchange cannot multiply the budget. The
 * bucket carries no IP: a key calling from many addresses gets one budget, not
 * one per address.
 *
 * Charged per JSON-RPC MESSAGE, not per HTTP request, because one POST can
 * carry a batch; a per-request budget would let a single call carry any number
 * of tool calls. 60 keeps the per-caller figure the mutation tier always gave
 * this endpoint, and a batch larger than it is refused outright.
 */
export const MCP_PER_KEY_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * `/api/mcp`, per caller IP, BEFORE authentication: a ceiling, not a budget.
 *
 * Containment for the unauthenticated case, which the per-key budget above
 * cannot cover: a request with a made-up key never reaches it, and each one
 * still costs a key lookup before its 401. This is the same split the edge
 * makes for `iflk_` callers on `/api/t/**` — fairness keyed on the key,
 * containment keyed on the IP — with the fairness half moved to after
 * verification.
 *
 * Sized at ten keys' worth (600/min) so legitimate callers sharing an
 * address — every customer agent hosted at one provider — do not meet it in
 * ordinary use, while one address still cannot drive more than ten key lookups
 * a second. Its own scope (`mcp-ip`), so MCP traffic no longer shares a bucket
 * with every other mutation route called from the same address.
 */
export const MCP_IP_CEILING_LIMIT: RateLimitConfig = {
    maxAttempts: 600,
    windowMs: 60 * 1000,
};

/**
 * API key creation: 5 per hour per (tenant, creator user).
 *
 * Threat model: post-compromise lateral movement. A user with a
 * stolen session could mint persistent API keys; tight limits slow
 * that chain and leave a denser audit trail. Legitimate churn (a
 * user rotating a handful of keys) is comfortably under 5/hr.
 */
/**
 * Asking the workspace a question: 20 per hour, PER USER (#3869).
 *
 * The first preset in this file intended to bind a PERSON rather than an IP,
 * and it only works because the route supplies the `getUserId` resolver the
 * middleware has always accepted and no route has ever passed. Without it the
 * key is `<scope>:ip:<ip>:anon` and co-NAT'd colleagues share one budget —
 * which for a question endpoint means one busy user silently starves a floor.
 *
 * ── WHY A PER-USER LIMIT AT ALL, GIVEN THE MONTHLY BUDGET ───────────────────
 *
 * `assertWithinMonthlyBudget` already bounds what a TENANT spends, and it
 * pre-flights every run start. It does not bound who spends it: one person can
 * exhaust a whole workspace's month, and the others learn about it from a
 * refusal that names a budget they did not use. The two limits answer different
 * questions and neither replaces the other.
 *
 * ── WHAT 20/HOUR IS AND IS NOT ──────────────────────────────────────────────
 *
 * A person asking in earnest asks a handful of questions an hour; twenty is
 * comfortably above that and far below a script's rate. It is NOT a cost
 * control — a model call's cost varies by orders of magnitude with context, so
 * bounding request COUNT cannot bound spend. The monthly budget is the cost
 * control, and this is the one that keeps a single caller from monopolising it.
 *
 * No lockout beyond the window: a person who asks too fast should wait, not be
 * shut out for an hour. Compare `API_KEY_CREATE_LIMIT` below, where the lockout
 * is deliberate because minting credentials is not something to retry at speed.
 *
 * `lockoutMs` is OMITTED rather than set to 0. The check is
 * `if (config.lockoutMs && …)`, so the two behave identically — and an explicit
 * zero reads like a configured duration that happens to be short, where absence
 * says there is no lockout at all.
 *
 * Note the storage this rides on is an in-process Map, so with N app instances
 * the effective ceiling is N x 20. That is a property of the mutation tier
 * rather than of this preset, and it is recorded here because a reader checking
 * whether 20 is enforceable deserves to find it.
 */
export const AGENT_QUESTION_LIMIT: RateLimitConfig = {
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
};

export const API_KEY_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    lockoutMs: 60 * 60 * 1000,
};

/**
 * Passwordless / magic-link email dispatch: 5 per hour per IP.
 *
 * Threat model: email bomb abuse (attacker pointing the "send link"
 * endpoint at a victim email). This preset is explicitly IP-only
 * even when the endpoint receives a target email — the rate applies
 * to senders, not recipients.
 */
export const EMAIL_DISPATCH_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
};

/**
 * Platform-admin tenant creation: 5 per hour per calling IP.
 *
 * Threat model: a leaked PLATFORM_ADMIN_API_KEY being used to spin up
 * many tenants in rapid succession. 5/hour is comfortable for
 * orchestrator-driven batch provisioning while throttling an attacker
 * who obtained the key. Keyed by IP (the platform key itself is a
 * single shared secret, so per-key bucketing would add no isolation).
 */
export const TENANT_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    lockoutMs: 60 * 60 * 1000,
};

/**
 * Tenant invite creation: 20 per hour per tenant.
 *
 * Threat model: a compromised ADMIN account flooding the TenantInvite
 * table (storage abuse) or sending phishing invites at scale. 20/hr is
 * comfortable for legitimate batch onboarding while creating a tight
 * audit trail for abuse. Keyed by (tenant, IP) so a multi-browser
 * attacker with one session still burns the same budget.
 */
export const TENANT_INVITE_CREATE_LIMIT: RateLimitConfig = {
    maxAttempts: 20,
    windowMs: 60 * 60 * 1000,
};

/**
 * Invite preview / redemption: 10 per minute per IP.
 *
 * Threat model: token brute-force on the preview/redeem endpoints.
 * The 32-byte base64url token space is 2^256, so enumeration is
 * impossible in practice — this limit adds a defence-in-depth layer
 * and rate-stamps the audit trail so anomalous redemption patterns
 * are visible in logs. 10/min is comfortable for a user tabbing
 * between invite emails.
 */
export const INVITE_REDEEM_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════
// Progressive rate limit — Epic A.3 auth brute-force protection
// ═══════════════════════════════════════════════════════════════════
//
// The simple `RateLimitConfig` above is "N attempts per window,
// optional lockout" — a single threshold. Epic A.3 needs graduated
// *punishment*: each failed attempt past a threshold costs the
// attacker more wall-clock time, culminating in a hard lockout.
//
// The primitive is shared (not login-specific) so future flows
// (second-factor, recovery codes) can reuse it with their own policy.

export interface ProgressiveRateLimitTier {
    /** Apply this delay when cumulative failures >= this count. */
    atFailures: number;
    /** Milliseconds to delay the CURRENT attempt before verifying. */
    delayMs: number;
}

export interface ProgressiveRateLimitPolicy {
    /**
     * Tiers sorted ascending by `atFailures`. The highest-matching
     * tier's `delayMs` is applied; tiers do not sum. Failures below
     * the first tier's threshold incur no delay.
     */
    tiers: readonly ProgressiveRateLimitTier[];
    /** Failure count that flips the account into lockout. */
    lockoutAtFailures: number;
    /** Duration of the lockout once triggered. */
    lockoutMs: number;
    /**
     * Rolling window over which failures accumulate. A single entry
     * older than `windowMs` stops contributing to the count. Sized
     * generously — lockouts are meant to feel real, not rotate out.
     */
    windowMs: number;
}

/**
 * Epic A.3 login policy.
 *
 *   attempts 1-2  → no delay (typo allowance)
 *   attempts 3-4  → 5s delay (mild friction)
 *   attempts 5-9  → 30s delay (significant friction)
 *   attempt 10+   → 15 min lockout (attack territory)
 *
 * Window is 1 hour: a legitimate user who typed their password
 * wrong ten times in a day isn't locked out in perpetuity; an
 * attacker who managed to sustain 10 failures/hour stays locked
 * for the full window.
 */
export const LOGIN_PROGRESSIVE_POLICY: ProgressiveRateLimitPolicy = {
    tiers: [
        { atFailures: 3, delayMs: 5_000 },
        { atFailures: 5, delayMs: 30_000 },
    ],
    lockoutAtFailures: 10,
    lockoutMs: 15 * 60 * 1000,
    windowMs: 60 * 60 * 1000,
};

export interface ProgressiveRateLimitDecision {
    /**
     * `false` when the identifier is in lockout and no further
     * verify should be attempted. The caller returns 429/"too many
     * requests" to the client.
     */
    allowed: boolean;
    /**
     * Delay (ms) the caller SHOULD sleep before proceeding with the
     * expensive verify. `0` when under the first tier. The caller
     * is responsible for actually sleeping — this function returns
     * synchronously so it can be used inside timing-sensitive
     * branches (e.g. a dummyVerify needs to happen even on lockout).
     */
    delayMs: number;
    /**
     * Only populated when `allowed === false`. Seconds until the
     * lockout expires (always ≥ 1).
     */
    retryAfterSeconds: number;
    /** Failures currently counted against this identifier. */
    failureCount: number;
}

function pickDelayMs(
    count: number,
    tiers: readonly ProgressiveRateLimitTier[],
): number {
    let delay = 0;
    for (const tier of tiers) {
        if (count >= tier.atFailures) delay = tier.delayMs;
    }
    return delay;
}

/**
 * Evaluate the current state WITHOUT recording a new attempt. Call
 * this BEFORE verifying the password so the caller knows how long
 * to delay (and whether to short-circuit with a lockout response).
 *
 * Reuses the same sliding-window store the other rate-limit functions
 * in this file already use — one process-wide Map, cleanup timer
 * already running.
 */
export function evaluateProgressiveRateLimit(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
    startCleanup(policy.windowMs);

    const now = Date.now();
    const entry = store.get(key) || { timestamps: [] };

    // Expire stale failures out of the count but keep the entry
    // stored; caller may be about to write a new failure.
    const windowStart = now - policy.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    store.set(key, entry);

    const failureCount = entry.timestamps.length;

    if (failureCount >= policy.lockoutAtFailures) {
        const lastFailure = entry.timestamps[entry.timestamps.length - 1];
        const lockoutEnd = lastFailure + policy.lockoutMs;
        if (now < lockoutEnd) {
            return {
                allowed: false,
                delayMs: 0,
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((lockoutEnd - now) / 1000),
                ),
                failureCount,
            };
        }
        // Lockout expired — counter resets. The attempt proceeds
        // with zero delay; a legitimate user who came back after
        // the lockout should not immediately eat another 30s.
        entry.timestamps = [];
        store.set(key, entry);
        return {
            allowed: true,
            delayMs: 0,
            retryAfterSeconds: 0,
            failureCount: 0,
        };
    }

    return {
        allowed: true,
        delayMs: pickDelayMs(failureCount, policy.tiers),
        retryAfterSeconds: 0,
        failureCount,
    };
}

/**
 * Record a failure for this identifier. Call AFTER a verify has
 * returned `false`. Returns the post-increment decision so the
 * caller can surface the new lockout state to logging / audit.
 */
export function recordProgressiveFailure(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
    startCleanup(policy.windowMs);
    const now = Date.now();
    const entry = store.get(key) || { timestamps: [] };
    // Trim the window before writing so the count we return is
    // current.
    const windowStart = now - policy.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    entry.timestamps.push(now);
    store.set(key, entry);

    return evaluateProgressiveRateLimit(key, policy);
}

/**
 * Clear the failure list. Call after a SUCCESSFUL verify so a
 * legitimate user who typo'd a few times isn't still throttled on
 * the next login.
 */
export function resetProgressiveFailures(key: string): void {
    store.delete(key);
}
