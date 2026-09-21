/**
 * Per-stage shutdown budgets. Each stage is Promise.race'd against
 * its budget so a slow exporter never blocks the process past the
 * container's grace period (k8s terminationGracePeriodSeconds
 * defaults to 30s).
 *
 * Budget invariant: SHUTDOWN_TOTAL_CEILING_MS should leave room for
 * Next.js's own HTTP-drain handler, which runs in parallel.
 */

export const SHUTDOWN_AUDIT_FLUSH_MS = 3_000;
/**
 * Pausing this process's in-flight agentic runs so they stay resumable.
 *
 * Sits between audit and OTel because a stranded run outranks a lost span: if
 * this stage is skipped the run is abandoned RUNNING and `agent-run-reaper`
 * settles it to FAILED a wall-clock budget plus ten minutes later. It ranks
 * BELOW audit because that loss is irreversible and this one is not — a run
 * that fails to pause is still reaped, which is exactly today's behaviour.
 *
 * Two seconds for one `updateMany` over a handful of ids. The stage
 * short-circuits with no query at all when the process is executing nothing,
 * which is the common case.
 */
export const SHUTDOWN_PAUSE_RUNS_MS  = 2_000;
export const SHUTDOWN_OTEL_MS        = 2_000;
export const SHUTDOWN_SENTRY_MS      = 2_000;

/** Ceiling our observability stages must fit under. Rest of the
 * k8s grace period (default 30s) belongs to Next's HTTP drain. */
export const SHUTDOWN_TOTAL_CEILING_MS = 20_000;

/**
 * The stages, summed — 3 + 2 + 2 + 2 = 9s against a 20s ceiling.
 *
 * Declared rather than left implicit so a fifth stage cannot be added without
 * meeting the invariant; `tests/unit/security/startup-encryption-check.test.ts`
 * and the shutdown tests assert it stays under the ceiling.
 */
export const SHUTDOWN_STAGES_TOTAL_MS =
    SHUTDOWN_AUDIT_FLUSH_MS + SHUTDOWN_PAUSE_RUNS_MS + SHUTDOWN_OTEL_MS + SHUTDOWN_SENTRY_MS;
