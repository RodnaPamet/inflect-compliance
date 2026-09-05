/**
 * Observability Metrics — OpenTelemetry counters, histograms, and gauges.
 *
 * ── REQUEST METRICS ──
 *   api.request.count      — Counter   (method, route, status)
 *   api.request.duration   — Histogram (method, route, status) [ms]
 *   api.request.errors     — Counter   (method, route, errorCode)
 *
 * ── REPOSITORY METRICS (Epic OI-3) ──
 *   repo.method.duration     — Histogram (repo.method, outcome) [ms]
 *   repo.method.calls        — Counter   (repo.method, outcome)
 *   repo.method.errors       — Counter   (repo.method, error.type)
 *   repo.method.result_count — Histogram (repo.method)
 *
 *   tenant_id is intentionally NOT a metric label (would explode
 *   cardinality on multi-tenant deployments). It IS recorded as a
 *   span attribute (`repo.tenant_id`) so trace search can still
 *   pivot per-tenant.
 *
 * ── JOB METRICS ──
 *   job.execution.count    — Counter   (job_name, status: success|failure)
 *   job.execution.duration — Histogram (job_name, status) [ms]
 *   job.queue.depth        — Observable Gauge (queue_name, state)
 *
 * ── AUDIT-STREAM METRICS ──
 *   audit_stream.delivery.success  — Counter   (http.status_code)
 *   audit_stream.delivery.failures — Counter   (http.status_code)
 *   audit_stream.delivery.attempts — Histogram (outcome)
 *   audit_stream.delivery.duration — Histogram (outcome) [ms]
 *   audit_stream.buffer.overflow_dropped — Counter
 *   audit_stream.buffer.depth      — Observable Gauge
 *     One delivery-outcome record per batch (after the retry loop).
 *     success + failures give the delivery success ratio; attempts
 *     shows retry pressure; buffer.depth + overflow_dropped show
 *     downstream backpressure. Status 0 == network throw / timeout.
 *     Audit-stream failures deliberately do NOT gate /api/readyz —
 *     the path is out-of-band + fail-safe (the audit row is already
 *     committed); escalation is alert-based on these metrics.
 *
 * ── AUTH VERIFICATION-EMAIL METRICS ──
 *   auth.verification_email.sent   — Counter (outcome)
 *   auth.verification_email.failed — Counter (outcome)
 *     `issueEmailVerification` swallows SMTP errors so the register
 *     API stays 200 (enumeration safety: same response shape
 *     regardless of whether the address is registered). That
 *     swallow is invisible to the user — the operator only sees
 *     pino warns. These metrics surface the failure rate before a
 *     user-facing outage: if `AUTH_REQUIRE_EMAIL_VERIFICATION=1`
 *     is flipped on in a prod where the mailer is unreliable, a
 *     non-zero `.failed` rate gates verification end-to-end.
 *     `outcome` label is `register | resend` so the dashboard can
 *     pivot per-flow.
 *
 * ── ENTRA ID GROUP-RESOLUTION METRICS (EI-4) ──
 *   auth.entra.group_resolution    — Counter   (source, outcome)
 *   auth.entra.group_count         — Histogram (source)
 *   auth.entra.graph_fetch.duration— Histogram (outcome) [ms]
 *     One record per `microsoft-entra-id` sign-in (from
 *     `resolveEntraGroupClaims`). `source=token` vs `graph_overage`
 *     splits the in-token claim from the > ~200-group Graph fallback;
 *     `source=graph_overage, outcome=empty` is the Graph-outage alert
 *     signal (the Graph helper fails open to `[]`). graph_fetch.duration
 *     is recorded only on the overage path.
 *
 * ── SCIM AUTH METRICS (EI-4) ──
 *   scim.auth.count                — Counter   (outcome, reason)
 *     One record per `authenticateScimRequest` call. `reason` is a
 *     bounded 5-value enum (ok / missing_header / empty_token /
 *     not_found / revoked). A `not_found` spike is the brute-force /
 *     stale-connector signal; `revoked` rising means an IdP is still
 *     pushing with a rotated token.
 *
 * ── ENTRA ROLE-SYNC METRICS (EI-3) ──
 *   auth.entra.role_sync           — Counter   (outcome)
 *     One record per entra-id sign-in that reaches `syncEntraMembershipRole`.
 *     `outcome` ∈ synced / unchanged / gate_denied / no_membership /
 *     owner_immune / no_match / no_mappings. A `gate_denied` spike means a
 *     tenant's `enforceGroupGate` is locking users out (often a misconfigured
 *     mapping).
 *
 * CARDINALITY SAFETY:
 *   Route labels are normalized via `normalizeRoute()` to collapse dynamic
 *   segments (UUIDs, slugs) into placeholder tokens. This prevents
 *   unbounded label growth from entity-specific URLs.
 *
 * LAZY INITIALIZATION:
 *   All instruments are created on first access to give the global
 *   MeterProvider time to register. When OTel is not initialized,
 *   the noop meter produces zero-overhead noop instruments.
 *
 * These are recorded from:
 *   - `withApiErrorHandling` (request metrics)
 *   - `runJob` / `executorRegistry.execute` (job metrics)
 *   - `startQueueDepthReporting` (queue depth gauge)
 */

import { metrics } from '@opentelemetry/api';

const METER_NAME = 'inflect-compliance';

function getMeter() {
    return metrics.getMeter(METER_NAME);
}

// ════════════════════════════════════════════════════════════════════════
// ROUTE NORMALIZATION — Cardinality Safety
// ════════════════════════════════════════════════════════════════════════

/**
 * UUID v4 pattern — matches standard 36-char UUIDs.
 * Used to collapse entity IDs in URL paths.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * CUID / nanoid / opaque-id pattern — matches 20+ char alphanumeric segments.
 * Guards against non-UUID ID formats that would still cause cardinality explosion.
 */
const OPAQUE_ID_RE = /\/[a-z0-9]{20,}\b/gi;

/**
 * Normalize a raw request pathname to a route template safe for metric labels.
 *
 * Collapses:
 *   - UUIDs → :id
 *   - Tenant slugs in /t/[slug]/ → :tenantSlug
 *   - Long opaque IDs → :id
 *
 * Examples:
 *   /api/t/acme-corp/controls/550e8400-e29b-41d4-a716-446655440000
 *     → /api/t/:tenantSlug/controls/:id
 *
 *   /api/t/my-tenant/evidence/abc123def456
 *     → /api/t/:tenantSlug/evidence/abc123def456  (short IDs kept — low cardinality)
 *
 * @param pathname — raw URL pathname from req.nextUrl.pathname
 * @returns normalized route string, safe for OTel labels
 */
export function normalizeRoute(pathname: string): string {
    let route = pathname;

    // 1. Replace UUIDs with :id
    route = route.replace(UUID_RE, ':id');

    // 2. Replace tenant slug in /t/<slug>/ or /api/t/<slug>/
    //    Next.js dynamic segment: /t/[tenantSlug]/...
    route = route.replace(/\/t\/([^/]+)\//, '/t/:tenantSlug/');

    // 3. Replace remaining long opaque IDs
    route = route.replace(OPAQUE_ID_RE, '/:id');

    return route;
}

// ════════════════════════════════════════════════════════════════════════
// REQUEST METRICS — Instrument Singletons
// ════════════════════════════════════════════════════════════════════════

let _requestCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _requestDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _requestErrors: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

// Repository instruments — Epic OI-3.
// Cardinality safety: labels are { 'repo.method', 'outcome' } only.
// tenant_id, user_id are SPAN attributes (queryable in trace search)
// but NOT metric labels (where they'd explode cardinality).
let _repoDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _repoCalls: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _repoErrors: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _repoResultCount: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getRequestCount() {
    if (!_requestCount) {
        _requestCount = getMeter().createCounter('api.request.count', {
            description: 'Total number of API requests',
            unit: '1',
        });
    }
    return _requestCount;
}

function getRequestDuration() {
    if (!_requestDuration) {
        _requestDuration = getMeter().createHistogram('api.request.duration', {
            description: 'API request duration in milliseconds',
            unit: 'ms',
        });
    }
    return _requestDuration;
}

function getRequestErrors() {
    if (!_requestErrors) {
        _requestErrors = getMeter().createCounter('api.request.errors', {
            description: 'Total number of API request errors',
            unit: '1',
        });
    }
    return _requestErrors;
}

/**
 * Record a completed API request.
 *
 * Route is auto-normalized to prevent label cardinality explosion.
 * Called from `withApiErrorHandling` on every request completion.
 */
export function recordRequestMetrics(attrs: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
}): void {
    const normalizedRoute = normalizeRoute(attrs.route);

    const labels = {
        'http.method': attrs.method,
        'http.route': normalizedRoute,
        'http.status_code': attrs.status,
    };

    getRequestCount().add(1, labels);
    getRequestDuration().record(attrs.durationMs, labels);
}

/**
 * Record an API request error.
 *
 * Route is auto-normalized.
 */
export function recordRequestError(attrs: {
    method: string;
    route: string;
    errorCode: string;
}): void {
    getRequestErrors().add(1, {
        'http.method': attrs.method,
        'http.route': normalizeRoute(attrs.route),
        'error.code': attrs.errorCode,
    });
}

// ════════════════════════════════════════════════════════════════════════
// AGGREGATION CACHE METRICS
//
// Emitted by src/lib/cache/aggregation-cache.ts::cachedAggregationRead.
// The only label is `aggregation` (the registry key) — bounded
// cardinality (one value per AGGREGATIONS entry). Watch the hit ratio
// per aggregation in Grafana: a sustained low hit rate means the
// invalidation graph is over-eager or the TTL is too short.
// ════════════════════════════════════════════════════════════════════════

let _aggCacheHit: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aggCacheMiss: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aggCacheComputeDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getAggCacheHit() {
    if (!_aggCacheHit) {
        _aggCacheHit = getMeter().createCounter('cache.aggregation.hit', {
            description: 'Aggregation cache hits',
            unit: '1',
        });
    }
    return _aggCacheHit;
}

function getAggCacheMiss() {
    if (!_aggCacheMiss) {
        _aggCacheMiss = getMeter().createCounter('cache.aggregation.miss', {
            description: 'Aggregation cache misses',
            unit: '1',
        });
    }
    return _aggCacheMiss;
}

function getAggCacheComputeDuration() {
    if (!_aggCacheComputeDuration) {
        _aggCacheComputeDuration = getMeter().createHistogram('cache.aggregation.compute_duration_ms', {
            description: 'Time to compute an aggregation on a cache miss',
            unit: 'ms',
        });
    }
    return _aggCacheComputeDuration;
}

/** Record an aggregation cache hit. */
export function recordAggregationCacheHit(aggregation: string): void {
    getAggCacheHit().add(1, { aggregation });
}

/** Record an aggregation cache miss + the time the underlying compute took. */
export function recordAggregationCacheMiss(aggregation: string, computeMs: number): void {
    getAggCacheMiss().add(1, { aggregation });
    getAggCacheComputeDuration().record(computeMs, { aggregation });
}

// ════════════════════════════════════════════════════════════════════════
// REPOSITORY METRICS — Epic OI-3
//
// Emitted by src/lib/observability/repository-tracing.ts::traceRepository.
// Labels are restricted to { 'repo.method', 'outcome' } to keep
// cardinality bounded. Use trace span attributes (tenant.id, user.id)
// for tenant-aware debugging — those don't explode metric storage.
// ════════════════════════════════════════════════════════════════════════

export function getRepositoryDurationHistogram() {
    if (!_repoDuration) {
        _repoDuration = getMeter().createHistogram('repo.method.duration', {
            description: 'Repository method execution duration in milliseconds',
            unit: 'ms',
        });
    }
    return _repoDuration;
}

export function getRepositoryCallCounter() {
    if (!_repoCalls) {
        _repoCalls = getMeter().createCounter('repo.method.calls', {
            description: 'Total number of repository method invocations',
            unit: '1',
        });
    }
    return _repoCalls;
}

export function getRepositoryErrorCounter() {
    if (!_repoErrors) {
        _repoErrors = getMeter().createCounter('repo.method.errors', {
            description: 'Total number of repository method errors',
            unit: '1',
        });
    }
    return _repoErrors;
}

export function getRepositoryResultCountHistogram() {
    if (!_repoResultCount) {
        _repoResultCount = getMeter().createHistogram('repo.method.result_count', {
            description: 'Distribution of result counts returned by repository methods',
            unit: '1',
        });
    }
    return _repoResultCount;
}

// ════════════════════════════════════════════════════════════════════════
// JOB METRICS — Instrument Singletons
// ════════════════════════════════════════════════════════════════════════

let _jobCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _jobDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getJobCount() {
    if (!_jobCount) {
        _jobCount = getMeter().createCounter('job.execution.count', {
            description: 'Total number of job executions',
            unit: '1',
        });
    }
    return _jobCount;
}

function getJobDuration() {
    if (!_jobDuration) {
        _jobDuration = getMeter().createHistogram('job.execution.duration', {
            description: 'Job execution duration in milliseconds',
            unit: 'ms',
        });
    }
    return _jobDuration;
}

/**
 * Record a completed job execution.
 *
 * @param attrs.jobName — the job name (bounded set from JobPayloadMap)
 * @param attrs.success — whether the job completed without error
 * @param attrs.durationMs — execution time in milliseconds
 */
export function recordJobMetrics(attrs: {
    jobName: string;
    success: boolean;
    durationMs: number;
}): void {
    const labels = {
        'job.name': attrs.jobName,
        'job.status': attrs.success ? 'success' : 'failure',
    };

    getJobCount().add(1, labels);
    getJobDuration().record(attrs.durationMs, labels);
}

// ════════════════════════════════════════════════════════════════════════
// AUDIT-STREAM METRICS — Instrument Singletons
//
// Delivery outcomes are recorded once per batch, after the retry loop in
// `deliverBatch` (src/app-layer/events/audit-stream.ts) settles. The set
// answers the operator questions:
//   - are batches landing?            success / failures counters
//   - what is the success ratio?      success / (success + failures)
//   - is the downstream flaky?        attempts histogram (1..3)
//   - how slow is delivery?           duration histogram [ms]
//   - is the buffer under pressure?   buffer.depth gauge + overflow counter
//
// Cardinality: only `http.status_code` (finite) and `outcome`
// (success|failure). tenantId is NEVER a label — tenant-level
// debugging uses the structured `logger.warn` in the same code path.
// ════════════════════════════════════════════════════════════════════════

let _auditStreamSuccess: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _auditStreamFailures: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _auditStreamAttempts: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _auditStreamDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _auditStreamOverflow: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getAuditStreamSuccess() {
    if (!_auditStreamSuccess) {
        _auditStreamSuccess = getMeter().createCounter('audit_stream.delivery.success', {
            description: 'Audit-stream batches delivered successfully (2xx on the final attempt)',
            unit: '1',
        });
    }
    return _auditStreamSuccess;
}

function getAuditStreamFailures() {
    if (!_auditStreamFailures) {
        _auditStreamFailures = getMeter().createCounter('audit_stream.delivery.failures', {
            description: 'Audit-stream batches whose final delivery attempt was not-ok (after retry)',
            unit: '1',
        });
    }
    return _auditStreamFailures;
}

function getAuditStreamAttempts() {
    if (!_auditStreamAttempts) {
        _auditStreamAttempts = getMeter().createHistogram('audit_stream.delivery.attempts', {
            description: 'Delivery attempts made per audit-stream batch (1 = no retry, up to 3)',
            unit: '1',
        });
    }
    return _auditStreamAttempts;
}

function getAuditStreamDuration() {
    if (!_auditStreamDuration) {
        _auditStreamDuration = getMeter().createHistogram('audit_stream.delivery.duration', {
            description: 'Wall-clock time to deliver an audit-stream batch, including retry backoff',
            unit: 'ms',
        });
    }
    return _auditStreamDuration;
}

function getAuditStreamOverflow() {
    if (!_auditStreamOverflow) {
        _auditStreamOverflow = getMeter().createCounter('audit_stream.buffer.overflow_dropped', {
            description: 'Audit-stream events dropped because a per-tenant buffer hit its hard cap',
            unit: '1',
        });
    }
    return _auditStreamOverflow;
}

/**
 * Record the outcome of an audit-stream batch delivery — called once
 * per batch by `deliverBatch` after the retry loop settles (NOT per
 * retry attempt).
 *
 * Emits, in one call:
 *   - `audit_stream.delivery.success` OR `.failures` (by outcome);
 *   - `audit_stream.delivery.attempts` (retry-pressure histogram);
 *   - `audit_stream.delivery.duration` (delivery latency).
 *
 * `status` is the final HTTP status (0 == network throw / timeout).
 * TenantId is deliberately NOT a label — tenant-level debugging
 * uses the structured `logger.warn` in the same code path.
 */
export function recordAuditStreamDelivery(attrs: {
    outcome: 'success' | 'failure';
    status: number;
    attempts: number;
    durationMs: number;
}): void {
    const statusLabel = { 'http.status_code': attrs.status };
    if (attrs.outcome === 'success') {
        getAuditStreamSuccess().add(1, statusLabel);
    } else {
        getAuditStreamFailures().add(1, statusLabel);
    }
    const outcomeLabel = { outcome: attrs.outcome };
    getAuditStreamAttempts().record(attrs.attempts, outcomeLabel);
    getAuditStreamDuration().record(attrs.durationMs, outcomeLabel);
}

/**
 * Record an audit-stream buffer overflow — one event dropped because
 * a per-tenant in-memory buffer hit `BUFFER_HARD_CAP`. A non-zero
 * rate here means the downstream SIEM is too slow to keep up with
 * audit volume and events are being shed.
 */
export function recordAuditStreamBufferOverflow(): void {
    getAuditStreamOverflow().add(1);
}

// ── Field decryption (Epic B) ─────────────────────────────────────────

let _fieldDecryptFailures: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getFieldDecryptFailures() {
    if (!_fieldDecryptFailures) {
        _fieldDecryptFailures = getMeter().createCounter('encryption.field.decrypt_failed', {
            description:
                'Encrypted field values the middleware could not decrypt. Each one was handed to the caller as RAW CIPHERTEXT — see recordFieldDecryptFailure.',
            unit: '1',
        });
    }
    return _fieldDecryptFailures;
}

/**
 * Record a field the encryption middleware failed to decrypt.
 *
 * WHY THIS DESERVES A METRIC RATHER THAN JUST THE EXISTING WARN LINE: the
 * middleware fails OPEN. On a decrypt failure it logs and leaves the field
 * as the raw ciphertext, and the caller receives a string it cannot tell
 * from plaintext. So the blast radius is every downstream consumer of that
 * row — the UI renders a base64 blob, a PDF export embeds it, an audit-pack
 * share link publishes it, an SDK consumer reads it verbatim.
 *
 * A log line nobody is alerted on is not a control. This makes the failure
 * countable so it can be alerted on, and gives whoever decides the
 * fail-open/fail-closed question the evidence to decide it with.
 *
 * Labels are deliberately low-cardinality — model, field and envelope
 * version, never tenantId (that would blow up the series count and put a
 * tenant identifier in metrics).
 */
/**
 * A write whose row `tenantId` disagrees with the ambient tenant context.
 *
 * WHY THIS EXISTS AS ITS OWN SIGNAL
 * ---------------------------------
 * Field encryption keys off the AMBIENT tenant context, not off the row being
 * written. So a write that sets `tenantId: B` while the context says A
 * encrypts B's row under A's DEK — and nothing notices, because the write
 * succeeds. The damage surfaces much later, on an unrelated READ, as
 * `DecryptIntegrityError ... wrong key, corrupt row, or a write made under a
 * mismatched tenant context`. By then the offending write is long gone: the
 * read tells you which row is unreadable and nothing about who wrote it.
 *
 * That is what happened. E2E runs carry a steady 6-9 of those 500s, on green
 * runs as well as red, and the read-side error cannot name the writer. This
 * counter names it at the moment of the write, with the model, the operation
 * and BOTH tenant ids — which is the only place the information still exists.
 *
 * Two distinct outcomes, because they need opposite fixes:
 *
 *   `mismatch` — ambient tenant A, row tenant B. The row will be encrypted
 *     under the wrong DEK and become undecryptable. This is the corruption.
 *
 *   `unscoped` — no ambient tenant at all, but the row names one. The value
 *     is encrypted under the GLOBAL KEK (`v1:`) instead of the tenant's DEK.
 *     It stays readable, so it is not an outage — but it silently opts that
 *     row out of per-tenant key isolation, and a tenant-DEK rotation will not
 *     re-key it. Cross-tenant sweeps that write with the raw client land here
 *     (`automation-runner`'s all-tenants pass creates Findings this way).
 *
 * Deliberately observation-only for now, mirroring the posture this codebase
 * already took for `decrypt_failed`: make it countable, find the real call
 * sites, then decide whether to throw. Labels stay low-cardinality — no
 * tenant ids in metrics; those go to the log line instead.
 */
let _tenantContextMismatches: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function getTenantContextMismatches(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
    if (!_tenantContextMismatches) {
        _tenantContextMismatches = getMeter().createCounter('encryption.write.tenant_context_mismatch', {
            description:
                'Writes whose row tenantId disagrees with the ambient tenant context. `mismatch` corrupts (wrong DEK); `unscoped` silently downgrades the row to the global KEK.',
            unit: '1',
        });
    }
    return _tenantContextMismatches;
}

export function recordTenantContextMismatch(attrs: {
    model: string;
    operation: string;
    outcome: 'mismatch' | 'unscoped';
}): void {
    getTenantContextMismatches().add(1, {
        model: attrs.model,
        operation: attrs.operation,
        outcome: attrs.outcome,
    });
}

export function recordFieldDecryptFailure(attrs: {
    model: string;
    field: string;
    version: string;
    /**
     * WHICH of the three failure classes this was. They have opposite
     * correct responses, and before this label they were one undifferentiated
     * number — so a genuine key mismatch was invisible inside routine
     * no-DEK-by-design noise.
     *
     *   `no_dek_by_design` — the operation legitimately has no tenant DEK
     *     (the Tenant model itself, no ambient tenantId, or a BYPASS_SOURCES
     *     caller). Expected. The field is now handed back as NULL: the caller
     *     has no business reading plaintext, and a null surfaces a mistaken
     *     read immediately where a ciphertext blob hides it forever.
     *
     *   `dek_resolve_failed` — a tenantId WAS present but the DEK lookup
     *     threw. Not expected. Still fails open to ciphertext, because
     *     nulling a whole list page on a transient DB blip is its own
     *     outage. Watch this one.
     *
     *   `decrypt_failed` — a DEK resolved and AES-GCM still rejected the
     *     value: wrong key, corrupt row, or a write made under a mismatched
     *     tenant context. Also still fails open, pending the posture
     *     decision on whether it should throw.
     */
    outcome: 'no_dek_by_design' | 'dek_resolve_failed' | 'decrypt_failed';
}): void {
    getFieldDecryptFailures().add(1, {
        model: attrs.model,
        field: attrs.field,
        'ciphertext.version': attrs.version,
        outcome: attrs.outcome,
    });
}

// ── Session-policy resolution (Epic C.3) ──────────────────────────────

let _sessionPolicyResolution: ReturnType<ReturnType<typeof getMeter>['createCounter']> | undefined;

function getSessionPolicyResolution() {
    if (!_sessionPolicyResolution) {
        _sessionPolicyResolution = getMeter().createCounter('session.policy.resolution', {
            description:
                'Outcome of reading a tenant session policy at sign-in. `failed` means the ' +
                'concurrent-session cap and lifetime cap did NOT apply for that sign-in',
            unit: '1',
        });
    }
    return _sessionPolicyResolution;
}

/**
 * Record whether the tenant session policy could be resolved at sign-in.
 *
 * `outcome: 'failed'` is a SECURITY signal, not a availability one: the sign-in
 * still succeeds (the tracker is deliberately non-blocking), but it proceeds
 * with NO concurrent-session cap and NO lifetime cap. Any sustained non-zero
 * rate means a security control is silently not applying, which is exactly the
 * condition this counter exists to make alertable.
 */
export function recordSessionPolicyResolution(attrs: {
    outcome: 'ok' | 'failed';
}): void {
    getSessionPolicyResolution().add(1, { outcome: attrs.outcome });
}

// ── Auth verification-email delivery counters ─────────────────────────

let _verificationEmailSent: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _verificationEmailFailed: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getVerificationEmailSent() {
    if (!_verificationEmailSent) {
        _verificationEmailSent = getMeter().createCounter('auth.verification_email.sent', {
            description: 'Verification emails successfully handed off to the mailer',
            unit: '1',
        });
    }
    return _verificationEmailSent;
}

function getVerificationEmailFailed() {
    if (!_verificationEmailFailed) {
        _verificationEmailFailed = getMeter().createCounter('auth.verification_email.failed', {
            description: 'Verification emails that the mailer rejected (operator-only signal — the register API still returns 200)',
            unit: '1',
        });
    }
    return _verificationEmailFailed;
}

/**
 * Record the outcome of a single verification-email send attempt.
 * Called from `issueEmailVerification` after the `sendEmail` try/catch
 * settles.
 *
 * `flow` labels the call-site:
 *   - `register` — first email at signup
 *   - `resend`   — `/api/auth/verify-email/resend` re-issue
 *
 * No email or userId on the label (PII + cardinality). Per-tenant
 * debugging uses the structured pino warn line in the same code path.
 *
 * Failures here are best-effort signal — the token is already stored
 * and the API returns 200 regardless. Operators alert on
 * `auth.verification_email.failed` (rate or absolute) to catch a
 * mailer outage BEFORE `AUTH_REQUIRE_EMAIL_VERIFICATION=1` locks
 * legitimate signups out of verification.
 */
export function recordVerificationEmailDelivery(attrs: {
    outcome: 'sent' | 'failed';
    flow: 'register' | 'resend';
}): void {
    const labels = { flow: attrs.flow };
    if (attrs.outcome === 'sent') {
        getVerificationEmailSent().add(1, labels);
    } else {
        getVerificationEmailFailed().add(1, labels);
    }
}

// ── Entra ID group-resolution metrics (EI-4) ──────────────────────────

let _entraGroupResolution: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _entraGroupCount: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _entraGraphFetchDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getEntraGroupResolution() {
    if (!_entraGroupResolution) {
        _entraGroupResolution = getMeter().createCounter('auth.entra.group_resolution', {
            description: 'Entra ID sign-ins by how the AAD group list was resolved',
            unit: '1',
        });
    }
    return _entraGroupResolution;
}

function getEntraGroupCount() {
    if (!_entraGroupCount) {
        _entraGroupCount = getMeter().createHistogram('auth.entra.group_count', {
            description: 'Number of AAD security groups resolved for a user at sign-in',
            unit: '1',
        });
    }
    return _entraGroupCount;
}

function getEntraGraphFetchDuration() {
    if (!_entraGraphFetchDuration) {
        _entraGraphFetchDuration = getMeter().createHistogram('auth.entra.graph_fetch.duration', {
            description: 'Latency of the Graph /me/memberOf overage fetch in milliseconds',
            unit: 'ms',
        });
    }
    return _entraGraphFetchDuration;
}

/**
 * Record one Entra ID group-claim resolution at sign-in — called once per
 * `microsoft-entra-id` sign-in by `resolveEntraGroupClaims`.
 *
 * `source`:
 *   - `token`         — the `groups` claim was present in the ID token (the
 *                       common case, ≤ ~200 groups).
 *   - `graph_overage` — the user is in > ~200 groups, so Entra omitted the
 *                       claim and we fetched the full list from Graph.
 * `outcome`:
 *   - `resolved`      — at least one group came back.
 *   - `empty`         — zero groups. On `token` that's a user genuinely in no
 *                       groups; on `graph_overage` it almost always means the
 *                       Graph call failed (the helper fails open to `[]`), so
 *                       `source=graph_overage, outcome=empty` is the operator's
 *                       alert signal for a Graph outage degrading group-driven
 *                       role assignment.
 *
 * No tenantId / userId label — group resolution is per-user but the metric is
 * a fleet-health signal; per-user debugging uses the structured log line in
 * the same code path.
 */
export function recordEntraGroupResolution(attrs: {
    source: 'token' | 'graph_overage';
    outcome: 'resolved' | 'empty';
    groupCount: number;
    graphFetchDurationMs?: number;
}): void {
    getEntraGroupResolution().add(1, { source: attrs.source, outcome: attrs.outcome });
    getEntraGroupCount().record(attrs.groupCount, { source: attrs.source });
    if (attrs.source === 'graph_overage' && attrs.graphFetchDurationMs !== undefined) {
        getEntraGraphFetchDuration().record(attrs.graphFetchDurationMs, {
            outcome: attrs.outcome,
        });
    }
}

// ── SCIM token-auth metrics (EI-4) ────────────────────────────────────

let _scimAuth: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getScimAuth() {
    if (!_scimAuth) {
        _scimAuth = getMeter().createCounter('scim.auth.count', {
            description: 'SCIM bearer-token authentication attempts by outcome',
            unit: '1',
        });
    }
    return _scimAuth;
}

/**
 * Record one SCIM bearer-token authentication attempt — called from
 * `authenticateScimRequest` at every terminal branch.
 *
 * `reason` is a bounded enum (5 values) so cardinality stays flat:
 *   - `ok`             — authenticated.
 *   - `missing_header` — no / malformed `Authorization: Bearer` header.
 *   - `empty_token`    — `Bearer` with an empty value.
 *   - `not_found`      — token hash matched no row.
 *   - `revoked`        — token row exists but is revoked.
 *
 * A spike in `not_found` is the brute-force / stale-connector signal;
 * `revoked` rising means an IdP is still pushing with a rotated token.
 * No tenantId label (the failing cases have no resolved tenant anyway).
 */
export function recordScimAuth(attrs: {
    outcome: 'success' | 'failure';
    reason: 'ok' | 'missing_header' | 'empty_token' | 'not_found' | 'revoked';
}): void {
    getScimAuth().add(1, { outcome: attrs.outcome, reason: attrs.reason });
}

// ── Entra group → role sync metrics (EI-3) ────────────────────────────

let _entraRoleSync: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getEntraRoleSync() {
    if (!_entraRoleSync) {
        _entraRoleSync = getMeter().createCounter('auth.entra.role_sync', {
            description: 'Entra group → IC-role sync decisions at sign-in, by outcome',
            unit: '1',
        });
    }
    return _entraRoleSync;
}

/**
 * Record one Entra group → role sync decision — called once per
 * `microsoft-entra-id` sign-in that reaches `syncEntraMembershipRole`.
 *
 * `outcome`:
 *   - `synced`        — the member's role was changed to the mapped role.
 *   - `unchanged`     — a mapping matched but the role already matched.
 *   - `gate_denied`   — `enforceGroupGate` on + no mapped group → access denied.
 *   - `no_membership` — a role mapped but the user has no ACTIVE membership to
 *                       sync (membership creation stays on the Epic 1 paths).
 *   - `owner_immune`  — the member is an OWNER; sync + gate are skipped so a
 *                       misconfigured mapping can never demote / lock out an owner.
 *   - `role_protected` — a ceiling-bound caller (SCIM Groups push) hit a
 *                       membership whose current role it could not itself have
 *                       assigned (ADMIN today); nothing was written.
 *   - `no_match`      — mappings exist but none matched the user's groups (gate off).
 *   - `no_mappings`   — the tenant has no group mappings configured.
 *
 * A `gate_denied` spike means a tenant's gate is denying logins (often a
 * misconfigured mapping). No tenantId/userId label — fleet-health signal;
 * per-tenant detail lives in the audit row written on `synced`.
 */
export function recordEntraRoleSync(attrs: {
    outcome:
        | 'synced'
        | 'unchanged'
        | 'gate_denied'
        | 'no_membership'
        | 'owner_immune'
        | 'role_protected'
        | 'no_match'
        | 'no_mappings';
}): void {
    getEntraRoleSync().add(1, { outcome: attrs.outcome });
}

let _auditStreamBufferGaugeStarted = false;

/**
 * Register the observable gauge `audit_stream.buffer.depth` — the
 * total number of audit events buffered across all per-tenant
 * buffers, read at metric-scrape time. A sustained high depth means
 * delivery is not keeping up with ingestion.
 *
 * Idempotent. Called once from `audit-stream.ts` on module init.
 *
 * @param getDepthFn — returns the current total buffered event count.
 */
export function startAuditStreamBufferReporting(getDepthFn: () => number): void {
    if (_auditStreamBufferGaugeStarted) return;
    _auditStreamBufferGaugeStarted = true;

    const gauge = getMeter().createObservableGauge('audit_stream.buffer.depth', {
        description: 'Total audit events buffered across all per-tenant audit-stream buffers',
        unit: '1',
    });
    gauge.addCallback((result) => {
        try {
            result.observe(getDepthFn());
        } catch {
            // Buffer not available — noop; the gauge simply won't report.
        }
    });
}

/** Reset the buffer-gauge flag (testing only). @internal */
export function _resetAuditStreamBufferGaugeForTesting(): void {
    _auditStreamBufferGaugeStarted = false;
}

// ════════════════════════════════════════════════════════════════════════
// QUEUE DEPTH GAUGE — Observable (push-based)
// ════════════════════════════════════════════════════════════════════════

let _queueDepthStarted = false;

/**
 * Start periodic queue depth reporting.
 *
 * Uses OTel's ObservableGauge which is read by the metric reader
 * at export time. This avoids polling overhead — the gauge callback
 * is only invoked when the collector scrapes.
 *
 * Reports counts for: waiting, active, delayed, failed states.
 *
 * Call this once from the worker/scheduler entrypoint (not from
 * every request). Safe to call multiple times — only initializes once.
 *
 * @param getQueueFn — function that returns the BullMQ Queue instance
 */
export function startQueueDepthReporting(
    getQueueFn: () => { getJobCounts: () => Promise<Record<string, number>> },
): void {
    if (_queueDepthStarted) return;
    _queueDepthStarted = true;

    const gauge = getMeter().createObservableGauge('job.queue.depth', {
        description: 'Number of jobs in the queue by state',
        unit: '1',
    });

    gauge.addCallback(async (result) => {
        try {
            const counts = await getQueueFn().getJobCounts();

            // Only report meaningful states — avoid high-cardinality from
            // BullMQ's internal states like 'unknown' or 'paused'.
            const reportableStates = ['waiting', 'active', 'delayed', 'failed'];

            for (const state of reportableStates) {
                if (counts[state] !== undefined) {
                    result.observe(counts[state], {
                        'queue.name': 'inflect-jobs',
                        'queue.state': state,
                    });
                }
            }
        } catch {
            // Queue may not be available — noop. Gauge simply won't report.
        }
    });
}

/**
 * Reset queue depth reporting flag (for testing only).
 * @internal
 */
export function _resetQueueDepthForTesting(): void {
    _queueDepthStarted = false;
}

// ════════════════════════════════════════════════════════════════════════
// SLOW-QUERY COUNTER
//
// Emitted by src/lib/prisma.ts's query-event listener when a query
// exceeds the slow threshold (50ms). Label is { model } only — the raw
// SQL + bound params go to the internal log, NEVER to a metric label.
// ════════════════════════════════════════════════════════════════════════

let _slowQueryCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getSlowQueryCount() {
    if (!_slowQueryCount) {
        _slowQueryCount = getMeter().createCounter('db.slow_query.count', {
            description: 'Queries exceeding the slow-query threshold',
            unit: '1',
        });
    }
    return _slowQueryCount;
}

/** Record a slow query, labelled by the parsed model name. */
export function recordSlowQuery(model: string): void {
    getSlowQueryCount().add(1, { model });
}

// ════════════════════════════════════════════════════════════════════════
// SSR PAYLOAD CACHE METRICS
//
// Emitted by src/lib/cache/ssr-cache.ts::cachedSsrPayload. Label is
// `route` (the canonical route name — bounded: dashboard, risks, …) plus
// `outcome` on the duration histogram. Watch the per-route hit ratio in
// Grafana; a low ratio means the tenant-wide invalidation is too eager or
// the TTL is too short.
// ════════════════════════════════════════════════════════════════════════

let _ssrHit: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _ssrMiss: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _ssrDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getSsrHit() {
    if (!_ssrHit) _ssrHit = getMeter().createCounter('cache.ssr.hit', { description: 'SSR payload cache hits', unit: '1' });
    return _ssrHit;
}
function getSsrMiss() {
    if (!_ssrMiss) _ssrMiss = getMeter().createCounter('cache.ssr.miss', { description: 'SSR payload cache misses', unit: '1' });
    return _ssrMiss;
}
function getSsrDuration() {
    if (!_ssrDuration) _ssrDuration = getMeter().createHistogram('cache.ssr.duration', { description: 'SSR payload fetch duration (hit = cache read, miss = compute)', unit: 'ms' });
    return _ssrDuration;
}

/** Record an SSR payload cache hit. */
export function recordSsrCacheHit(route: string, durationMs: number): void {
    getSsrHit().add(1, { route });
    getSsrDuration().record(durationMs, { route, outcome: 'hit' });
}

/** Record an SSR payload cache miss + the time the underlying compute took. */
export function recordSsrCacheMiss(route: string, durationMs: number): void {
    getSsrMiss().add(1, { route });
    getSsrDuration().record(durationMs, { route, outcome: 'miss' });
}

// ─── AI risk-assessment metrics (AISVS C12 — monitoring of the AI subsystem) ──
//
// Operational observability for IC's AI-enabled risk-assessment feature: how
// often it runs, how long the provider call takes, and how often it falls back
// to the deterministic stub (a degraded-but-safe outcome). `tenant.id` is NOT a
// label (cardinality discipline); `provider` + `outcome` are bounded enums.
let _aiRiskCalls: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aiRiskDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _aiRiskFallbacks: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aiRiskSuggestions: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _aiRiskTokens: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getAiRiskCalls() {
    if (!_aiRiskCalls) {
        _aiRiskCalls = getMeter().createCounter('ai.risk_assessment.calls', {
            description: 'AI risk-assessment generations, labelled by provider + outcome (success/failure)',
            unit: '1',
        });
    }
    return _aiRiskCalls;
}
function getAiRiskDuration() {
    if (!_aiRiskDuration) {
        _aiRiskDuration = getMeter().createHistogram('ai.risk_assessment.duration', {
            description: 'Wall-clock time for an AI risk-assessment generation (provider call + validation)',
            unit: 'ms',
        });
    }
    return _aiRiskDuration;
}
function getAiRiskFallbacks() {
    if (!_aiRiskFallbacks) {
        _aiRiskFallbacks = getMeter().createCounter('ai.risk_assessment.fallbacks', {
            description: 'AI risk-assessments served from the deterministic stub fallback (provider unavailable or output rejected)',
            unit: '1',
        });
    }
    return _aiRiskFallbacks;
}
function getAiRiskSuggestions() {
    if (!_aiRiskSuggestions) {
        _aiRiskSuggestions = getMeter().createHistogram('ai.risk_assessment.suggestions', {
            description: 'Number of risk suggestions returned per AI generation',
            unit: '1',
        });
    }
    return _aiRiskSuggestions;
}
function getAiRiskTokens() {
    if (!_aiRiskTokens) {
        _aiRiskTokens = getMeter().createCounter('ai.risk_assessment.tokens', {
            description:
                'Tokens consumed by AI risk-assessment inferences, labelled by provider + kind (prompt/completion). Per-tenant attribution lives in the audit trail; this metric stays low-cardinality for capacity planning.',
            unit: '1',
        });
    }
    return _aiRiskTokens;
}

/**
 * Record one AI risk-assessment generation — called once at the usecase
 * boundary after the provider call settles (success OR failure).
 *
 *   - `ai.risk_assessment.calls`       counter  (provider, outcome)
 *   - `ai.risk_assessment.duration`    histogram(provider, outcome)
 *   - `ai.risk_assessment.fallbacks`   counter  (provider) — when fallback=true
 *   - `ai.risk_assessment.suggestions` histogram(provider) — on success
 *   - `ai.risk_assessment.tokens`      counter  (provider, kind) — when reported
 */
export function recordAiRiskAssessment(attrs: {
    provider: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    fallback: boolean;
    suggestionCount?: number;
    /** Token usage when the provider reported it (AISVS C12.2.5). */
    promptTokens?: number;
    completionTokens?: number;
}): void {
    const labels = { provider: attrs.provider, outcome: attrs.outcome };
    getAiRiskCalls().add(1, labels);
    getAiRiskDuration().record(attrs.durationMs, labels);
    if (attrs.fallback) getAiRiskFallbacks().add(1, { provider: attrs.provider });
    if (attrs.outcome === 'success' && typeof attrs.suggestionCount === 'number') {
        getAiRiskSuggestions().record(attrs.suggestionCount, { provider: attrs.provider });
    }
    // AISVS C12.2.5 — token volume by provider + kind (low cardinality; the
    // per-tenant attribution lives in the audit inference-log).
    if (typeof attrs.promptTokens === 'number') {
        getAiRiskTokens().add(attrs.promptTokens, { provider: attrs.provider, kind: 'prompt' });
    }
    if (typeof attrs.completionTokens === 'number') {
        getAiRiskTokens().add(attrs.completionTokens, { provider: attrs.provider, kind: 'completion' });
    }
}

// ─── AI decision log (Art 12/14) — invocation + human-outcome metrics ───

let _aiDecisionLogged: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aiDecisionGuardBlocks: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _aiDecisionOutcomes: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getAiDecisionLogged() {
    if (!_aiDecisionLogged) {
        _aiDecisionLogged = getMeter().createCounter('ai.decision.logged', {
            description: 'AI decisions logged, labelled by provider + feature. One per AI-feature invocation.',
            unit: '1',
        });
    }
    return _aiDecisionLogged;
}
function getAiDecisionGuardBlocks() {
    if (!_aiDecisionGuardBlocks) {
        _aiDecisionGuardBlocks = getMeter().createCounter('ai.decision.guard_blocks', {
            description: 'AI decisions whose output guard redacted/dropped content, labelled by provider + feature.',
            unit: '1',
        });
    }
    return _aiDecisionGuardBlocks;
}
function getAiDecisionOutcomes() {
    if (!_aiDecisionOutcomes) {
        _aiDecisionOutcomes = getMeter().createCounter('ai.decision.outcome', {
            description: 'Human-oversight outcomes on AI suggestions (accepted/edited/rejected), labelled by outcome. Acceptance rate is derivable.',
            unit: '1',
        });
    }
    return _aiDecisionOutcomes;
}

/** Record one AI decision-log write — called once per AI-feature invocation. */
export function recordAiDecisionLogged(attrs: {
    provider: string;
    feature: string;
    guardBlocked?: boolean;
}): void {
    const labels = { provider: attrs.provider, feature: attrs.feature };
    getAiDecisionLogged().add(1, labels);
    if (attrs.guardBlocked) getAiDecisionGuardBlocks().add(1, labels);
}

/** Record a human-oversight outcome on an AI suggestion (Art 14). */
export function recordAiDecisionOutcome(attrs: {
    outcome: 'ACCEPTED' | 'EDITED' | 'REJECTED';
}): void {
    getAiDecisionOutcomes().add(1, { outcome: attrs.outcome });
}

// ════════════════════════════════════════════════════════════════════════
// AGENTIC WORKFLOW CONTEXT INTEGRITY — OWASP ASI06
// ════════════════════════════════════════════════════════════════════════
//
// Two instruments, and they answer different questions. The counter answers
// "did a run stop because its memory could not be trusted?", which is an
// incident. The histogram answers "how close are healthy runs to the cap?",
// which is the question you want answered BEFORE the counter moves — a cap
// that only shows up as halts is a cap nobody can plan around.
//
// Cardinality: the counter's only label is the integrity code, a closed set of
// five (see `ContextIntegrityCode`). No run id, no tenant id.

let _workflowContextHalts: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _workflowContextBytes: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getWorkflowContextHalts() {
    if (!_workflowContextHalts) {
        _workflowContextHalts = getMeter().createCounter('agentic.workflow.context_integrity.halt', {
            description:
                'Workflow runs halted because the accumulated context failed validation, the hash chain, or the size cap. Labelled by integrity code.',
            unit: '1',
        });
    }
    return _workflowContextHalts;
}

function getWorkflowContextBytes() {
    if (!_workflowContextBytes) {
        _workflowContextBytes = getMeter().createHistogram('agentic.workflow.context.bytes', {
            description: 'Size of a sealed workflow context at each step, in bytes. Watch the upper percentiles against MAX_CONTEXT_BYTES.',
            unit: 'By',
        });
    }
    return _workflowContextBytes;
}

/** One workflow run halted on a context-integrity failure. */
export function recordWorkflowContextIntegrityHalt(attrs: { code: string }): void {
    getWorkflowContextHalts().add(1, { code: attrs.code });
}

/** The size of one sealed context, recorded at every commit. */
export function recordWorkflowContextBytes(bytes: number): void {
    getWorkflowContextBytes().record(bytes);
}
