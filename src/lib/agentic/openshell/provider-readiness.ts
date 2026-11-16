/**
 * IS THE ATTACHED CREDENTIAL ACTUALLY THERE? — the gateway's readiness states,
 * and the one rule that reads them.
 *
 * `AttachSandboxProvider` does not install a credential. Its response says so in
 * the proto itself:
 *
 *     message AttachSandboxProviderResponse {
 *       Sandbox sandbox = 1;
 *       bool attached = 2;
 *       // Persisted intent; readiness requires current supervisor observations.
 *       ProviderMutationReceipt receipt = 3;
 *     }
 *
 * So a returned attach is an INTENT, and the credential's presence is a separate
 * observation read back through `GetSandboxProviderStatus` on the receipt's id.
 * `ProviderReadinessStatus.observed_time` is documented "absent until the current
 * supervisor session supplies accepted evidence" — readiness is evidence the
 * gateway may not have yet, not a flag that defaults true.
 *
 * This matters because the collector runs a third-party benchmark binary that
 * reads its credential from the attached provider and from nothing else. Exec on
 * an un-applied attachment and powerpipe runs against a credential that is not
 * there, which is indistinguishable in the stored `IntegrationExecution` and
 * `Evidence` from a scan of an account that is simply clean.
 *
 * ── Why this is a table and not a comparison ────────────────────────────
 *
 * `state === 'PROVIDER_READINESS_STATE_READY'` would be correct today and silently
 * wrong the day the gateway adds a state. `READINESS_VERDICT` is a `Record` over
 * the closed union, so a re-vendored proto carrying a ninth state fails `tsc`
 * until somebody decides which of the three answers it is — the same shape
 * `SIGNAL_STRENGTH` uses in the reconcile engine, and for the same reason.
 */

/** The gateway's eight readiness states, as it spells them. */
export const PROVIDER_READINESS_STATES = [
    'PROVIDER_READINESS_STATE_UNSPECIFIED',
    'PROVIDER_READINESS_STATE_PERSISTED',
    'PROVIDER_READINESS_STATE_PENDING',
    'PROVIDER_READINESS_STATE_READY',
    'PROVIDER_READINESS_STATE_WITHHELD',
    'PROVIDER_READINESS_STATE_REVOKED',
    'PROVIDER_READINESS_STATE_FAILED',
    'PROVIDER_READINESS_STATE_SUPERSEDED',
] as const;
export type ProviderReadinessState = (typeof PROVIDER_READINESS_STATES)[number];

/**
 * What a caller does about a state.
 *
 * `WAIT` is not a third kind of success — it is "ask again", and every caller
 * bounds it. Only `READY` admits an exec.
 */
export type ReadinessVerdict = 'READY' | 'WAIT' | 'REFUSED';

/**
 * Exhaustive over the union, by type.
 *
 * `UNSPECIFIED` is `WAIT` rather than `REFUSED` because it is the proto's zero
 * value — the answer a field carries while the gateway has not filled it in — and
 * a propagating attachment legitimately reads that way for a moment. It is
 * emphatically not `READY`: a zero value is not an assurance, which is the same
 * reading `DELETION_IS_SETTLED` gives `DELETION_OUTCOME_UNSPECIFIED`.
 *
 * `SUPERSEDED` is `REFUSED`, not `WAIT`. A newer desired state has replaced the
 * receipt this caller holds, so no amount of further polling makes THIS receipt
 * ready, and the attachment that did win was configured by somebody else — which
 * is precisely the shared-credential confusion #5251 is about.
 */
export const READINESS_VERDICT: Readonly<Record<ProviderReadinessState, ReadinessVerdict>> =
    Object.freeze({
        PROVIDER_READINESS_STATE_UNSPECIFIED: 'WAIT',
        PROVIDER_READINESS_STATE_PERSISTED: 'WAIT',
        PROVIDER_READINESS_STATE_PENDING: 'WAIT',
        PROVIDER_READINESS_STATE_READY: 'READY',
        PROVIDER_READINESS_STATE_WITHHELD: 'REFUSED',
        PROVIDER_READINESS_STATE_REVOKED: 'REFUSED',
        PROVIDER_READINESS_STATE_FAILED: 'REFUSED',
        PROVIDER_READINESS_STATE_SUPERSEDED: 'REFUSED',
    });

/**
 * The verdict for whatever the gateway said, including things it should not say.
 *
 * An unrecognised, absent or empty state is `REFUSED`, and that direction is the
 * decision. It can never be `READY` — that much is forced. Between the other two,
 * `WAIT` would spend the caller's whole setup budget on a state that may never
 * become ready and then refuse anyway, reporting a timeout where the real fact is
 * that this build does not understand the gateway it is talking to. Refusing
 * names the surprise at the moment it arrives.
 */
export function readinessVerdict(state: string | null | undefined): ReadinessVerdict {
    if (!state) return 'REFUSED';
    return READINESS_VERDICT[state as ProviderReadinessState] ?? 'REFUSED';
}

/**
 * Whether the gateway's observation says the credential is installed.
 *
 * Reported BESIDE the verdict and never instead of it. `credentials_installed` is
 * one field of `ProviderReadinessObservation`, and a provider can have its
 * credential installed while its policy is not yet active — so the state is the
 * gate and this is for the refusal's own text, where it is the single most useful
 * thing an operator can be told.
 */
export function describeReadiness(input: {
    readonly state: string | null | undefined;
    readonly reason?: string | null;
    readonly credentialsInstalled?: boolean | null;
}): string {
    const parts = [`state=${input.state || 'ABSENT'}`];
    if (input.reason) parts.push(`reason=${input.reason}`);
    if (input.credentialsInstalled !== null && input.credentialsInstalled !== undefined) {
        parts.push(`credentialsInstalled=${input.credentialsInstalled}`);
    }
    return parts.join(' ');
}
