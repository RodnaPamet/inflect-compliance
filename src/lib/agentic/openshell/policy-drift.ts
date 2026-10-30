/**
 * Policy drift, and the fallback that looks like an outage — 5.2 (#3972).
 *
 * ═══ WHY THE TWO CASES MUST NOT COLLAPSE ═══
 *
 * `openshell policy set` replaces the WHOLE policy, so a partial edit silently
 * removes rules. That is drift: someone changed what is in force. Separately, an
 * invalid policy loaded from disk falls back to a restrictive default — and the
 * symptom of THAT is things failing, so the instinct is to restore service while
 * the actual event (the policy meant to be in force is not) goes unrecorded.
 *
 * Both present as "the live hash is not the committed hash". If the detector
 * reports one verdict for both, the fallback case gets triaged as an outage,
 * which is precisely the failure #3972 exists to prevent. So they are separate
 * outcomes with separate reasons, and a test asserts they DIFFER rather than
 * asserting each label — a label can be renamed into agreement, a difference
 * cannot.
 *
 * ═══ WHY FALLBACK IS DETECTED BY HASH AND NOT BY A FLAG ═══
 *
 * Because the gateway has no flag for it. Read out of `openshell-gateway`
 * v0.1.6 rather than from documentation, `policy_source` carries exactly three
 * members:
 *
 *     POLICY_SOURCE_UNSPECIFIED   <- proto3 zero
 *     POLICY_SOURCE_SANDBOX
 *     POLICY_SOURCE_GLOBAL
 *
 * There is no `POLICY_SOURCE_FALLBACK`. (`fallback` does appear in the binary,
 * 16 times — every one of them a TLS alert name.) So a fallback cannot be read
 * off the source field, and `UNSPECIFIED` must not be treated as evidence of
 * one: being the zero value, an unset field, a field a proxy dropped, and a
 * field explicitly set to zero are the same bytes.
 *
 * What a fallback CAN be recognised by is its hash: the restrictive default is
 * a known artefact, so a live policy whose hash is the default's is a fallback
 * rather than an arbitrary edit. That requires the default's hash to be
 * recorded, which is the one input this module cannot derive and must be given.
 *
 * ═══ THE CONFIG AXIS: WHY IT IS STILL NARROWER THAN #4000 PROMISED ═══
 *
 * #4000 recorded a committed config digest and framed it as unlocking a second
 * anchor here: "a digest that changes without a deploy is drift by definition".
 * That half is real and it is the half this module cannot use, because the
 * comparison needs the OTHER side — what the running gateway was actually
 * started with — and the gateway will not say.
 *
 * Measured in phase 0.1a, over HTTP: `config`, `configz`, `version` and
 * `/api/v1/config` all answer 404. So the digest has nothing to be compared
 * against and a one-sided comparison is not a check.
 *
 * REFINED while investigating #4561, and the refinement matters: the 404s were
 * measured over HTTP, and the gRPC service `openshell.v1.OpenShell` carries
 * `GetGatewayConfig` among its 95 methods. So the obstacle is not "the gateway
 * cannot be asked" but "this product has no gRPC client to ask with" — a
 * smaller and differently-shaped blocker, tracked on #4561. Nothing here should
 * be written as though the capability were missing upstream.
 *
 * What IS implementable today is narrower and lives in
 * `./pinned-release`: `/readyz` carries the release, so the version a gateway
 * reports can be compared with the release every recorded fact was verified
 * against (#4567). That is a weaker signal than a config digest — a gateway can
 * run the pinned release against an edited config — but it is a real one, it
 * needs no client, and it is not satisfied vacuously.
 */
import { createHash } from 'node:crypto';

/** Where the gateway says the live policy came from. Three members, zero included. */
export const POLICY_SOURCES = [
    'POLICY_SOURCE_UNSPECIFIED',
    'POLICY_SOURCE_SANDBOX',
    'POLICY_SOURCE_GLOBAL',
] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

/** What `GetSandboxPolicyStatus` reports, in the fields this check reads. */
export interface LivePolicyStatus {
    readonly sandboxId: string;
    /** `effective_policy_hash` — what is actually in force. */
    readonly effectivePolicyHash: string;
    readonly policySource: PolicySource;
}

export type DriftOutcome =
    /** The live hash is the committed hash. Nothing to report. */
    | 'in-force'
    /** The live policy differs and is NOT the restrictive default: someone changed it. */
    | 'drifted'
    /**
     * The live policy IS the restrictive default. The committed policy is not in
     * force and the symptom will be refusals, so this must not be filed as
     * drift and must never be filed as an outage.
     */
    | 'fell-back-to-default'
    /**
     * The status could not be believed. Reported rather than guessed, because a
     * check that cannot read the live policy has not found it unchanged.
     */
    | 'unverifiable';

export interface DriftFinding {
    readonly outcome: DriftOutcome;
    readonly sandboxId: string;
    /** Present for every outcome, so a finding can be audited without re-reading. */
    readonly committedHash: string;
    readonly liveHash: string;
    readonly reason: string;
}

/**
 * Hash a committed policy. Stable across key order, because a policy is a set of
 * facts and not a byte sequence: re-serialising the same policy with keys in a
 * different order must not read as drift.
 */
export function hashCommittedPolicy(policy: unknown): string {
    return createHash('sha256').update(stableStringify(policy)).digest('hex');
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Classify one sandbox's live policy against what was committed.
 *
 * `restrictiveDefaultHash` is required rather than optional. Made optional, a
 * caller that omitted it would get every fallback reported as `drifted` — the
 * exact collapse this module exists to prevent — and would get it silently,
 * which is worse than a type error.
 */
export function classifyPolicyDrift(input: {
    readonly committedHash: string;
    readonly status: LivePolicyStatus | null;
    readonly restrictiveDefaultHash: string;
}): DriftFinding {
    const { committedHash, status, restrictiveDefaultHash } = input;

    if (status === null) {
        return {
            outcome: 'unverifiable',
            sandboxId: '',
            committedHash,
            liveHash: '',
            reason:
                'the live policy status could not be read; the committed policy is not known to be in force',
        };
    }

    const base = { sandboxId: status.sandboxId, committedHash, liveHash: status.effectivePolicyHash };

    if (status.effectivePolicyHash.length === 0) {
        return {
            ...base,
            outcome: 'unverifiable',
            reason: 'the status carried no effective policy hash, so nothing can be compared',
        };
    }

    if (status.effectivePolicyHash === committedHash) {
        return { ...base, outcome: 'in-force', reason: 'the live policy hash matches the committed policy' };
    }

    if (status.effectivePolicyHash === restrictiveDefaultHash) {
        return {
            ...base,
            outcome: 'fell-back-to-default',
            reason:
                'the live policy is the restrictive default: the committed policy was not loaded. ' +
                'The symptom is refusals, so this will present as an outage — it is not one.',
        };
    }

    return {
        ...base,
        outcome: 'drifted',
        reason:
            'the live policy is neither the committed policy nor the restrictive default: ' +
            'it was replaced. `policy set` replaces the whole policy, so rules may be missing.',
    };
}

/** Outcomes that are findings. `in-force` is not one; the other three are. */
export const DRIFT_OUTCOMES_REPORTABLE: readonly DriftOutcome[] = [
    'drifted',
    'fell-back-to-default',
    'unverifiable',
];
