/**
 * Which connection providers are CLOUD-POSTURE collectors.
 *
 * The posture family is `aws-posture` (`aws-posture-provider.ts`) plus the
 * cloud-posture pair that shares `cloud-posture/powerpipe-core.ts` — Azure and
 * GCP. All three run a Powerpipe benchmark against a cloud account and record
 * ONE `IntegrationExecution` per run.
 *
 * The family was already named in two private places that could not be reused:
 * `POSTURE_JOB_BY_PROVIDER` in `jobs/cloud-posture-collect-dispatch.ts` (which
 * collect job services each provider) and the `'cloud'` rows of
 * `PROVIDER_CATEGORY` in `usecases/integrations.ts` (which hub group they
 * render in). This module is the one place a THIRD reader can ask the
 * question, so a fourth cloud is added here and inherits every consumer.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY FRESHNESS NEEDS THIS
 * ─────────────────────────────────────────────────────────────────────
 * A posture collection that runs perfectly and finds non-compliance persists
 * `status: 'FAILED'` — FAILED means "the collector reached the account, read
 * it, and the account is not compliant", which is a SUCCESSFUL collection with
 * an unwelcome answer. It is the same distinction the collectors already
 * encode when they `clearAuthFailure` on FAILED as well as PASSED.
 *
 * So for a posture connection, "when did this connector last collect?" is the
 * newest PASSED **or** FAILED execution. Reading PASSED alone makes every real
 * posture connection report "Never succeeded" forever and drives its freshness
 * gauge past the 48 h stale threshold on a completely healthy connector.
 *
 * This does NOT generalise. `github` and `servicenow` also emit FAILED for
 * "the check ran and found a gap", but they are cheap per-control checks whose
 * failures are far more often a genuinely broken connector — widening the
 * allowlist fleet-wide would let a dead one read fresh for up to 48 h longer
 * than it should. Hence a posture-only allowlist rather than a global one.
 *
 * @module integrations/posture-providers
 */

/**
 * Every provider id whose executions are Powerpipe benchmark collections.
 *
 * Keep in step with `POSTURE_JOB_BY_PROVIDER` — that map is typed against this
 * union, so adding a cloud here is a compile error until its collect job is
 * wired, and vice versa.
 */
export const POSTURE_PROVIDER_IDS = ['aws-posture', 'azure-posture', 'gcp-posture'] as const;

export type PostureProviderId = (typeof POSTURE_PROVIDER_IDS)[number];

const POSTURE_PROVIDER_SET: ReadonlySet<string> = new Set<string>(POSTURE_PROVIDER_IDS);

/**
 * True when this connection's provider is a cloud-posture collector.
 *
 * Takes the raw `IntegrationConnection.provider` string (the column is a plain
 * `String`, not an enum) so callers can pass a DB row straight in.
 */
export function isPostureProvider(provider: string): provider is PostureProviderId {
    return POSTURE_PROVIDER_SET.has(provider);
}
