/**
 * THE REGISTRATION INTAKE'S PURE HALF (#3669, step 2a of the agentic IAM
 * roadmap): what the attribution skill's suggestion may contribute to a
 * registration, and the refusals the intake names.
 *
 * `usecases/agent-registration-intake.ts` turns a SHADOW_AGENT harness finding
 * into a DRAFT register row through a provisional AI-system entry. The owner of
 * that row is a PERSON'S choice: the request names `ownerUserId` and confirms
 * it. The `nhi-ownership-attribution` skill may have suggested somebody, and
 * its answer may ride along — parsed through 1d's contract
 * (`parseOwnershipAttribution`) and kept as PROVENANCE only:
 *
 *   • which signals the suggestion rested on, by kind and evidence pointer;
 *   • whether the person confirmed as owner is the person it suggested.
 *
 * It never decides the owner. There is no code path from a suggestion to an
 * `ownerUserId`: the confirmed owner is read from the request alone, and a
 * request that confirms nobody is refused whatever the suggestion says.
 *
 * WHAT IS KEPT OUT of the provenance: the suggested person's reference and each
 * signal's `personRef`. Both are identifiers in the SOURCE's namespace — an
 * e-mail address, a directory object id — and the provenance lands in an audit
 * row, whose structured payload streams to the tenant's SIEM. "Was the confirmed
 * owner the suggested one" is answered with a boolean, so the reference itself
 * is not needed to say it. A signal's evidence pointer is kept: it is what the
 * suggestion rested on, and the contract refuses one that looks like a secret.
 *
 * PURE: the e-mail comparison takes the lookup hash as a function, so nothing
 * here reads a key or a clock.
 */
import type { OwnerSignalKind, OwnershipAttribution } from './iam-skill-outputs';

/** Every refusal the intake names, carried as `details.reason`. */
export const REGISTRATION_INTAKE_REFUSALS = [
    /** No live finding with that id in this tenant. */
    'FINDING_NOT_FOUND',
    /** The finding exists and is not a harness SHADOW_AGENT finding. */
    'NOT_A_SHADOW_AGENT_FINDING',
    /** The discovered agent the finding names is not in this tenant. */
    'DISCOVERED_AGENT_NOT_FOUND',
    /** A scan has already linked the discovered agent to a live register row. */
    'ALREADY_REGISTERED',
    /** The intake has already registered this discovered agent, whatever a scan says since. */
    'ALREADY_REGISTERED_BY_INTAKE',
    /** No owner named, or the owner was named and not confirmed. */
    'OWNER_NOT_CONFIRMED',
    /** The confirmed owner is not an ACTIVE member of this tenant. */
    'OWNER_NOT_ACTIVE_MEMBER',
    /** The attribution skill's answer does not parse through its contract. */
    'SUGGESTION_INVALID',
    /** The attribution is about a different discovered agent. */
    'SUGGESTION_FOR_ANOTHER_AGENT',
] as const;
export type RegistrationIntakeRefusal = (typeof REGISTRATION_INTAKE_REFUSALS)[number];

/** One signal the suggestion rested on, without the person it names. */
export interface IntakeSignalProvenance {
    readonly kind: OwnerSignalKind;
    readonly evidence: string;
    /** Whether the signal named a person at all — the reference is not kept. */
    readonly namesPerson: boolean;
}

export interface IntakeSuggestionProvenance {
    readonly status: OwnershipAttribution['status'];
    /** The grade of a SUGGESTED proposal; null for the other two statuses. */
    readonly grade: 'STRONG' | 'WEAK' | null;
    /** Why an UNMATCHED answer proposed nobody; null otherwise. */
    readonly unmatchedReason: 'NO_OWNER_SIGNAL' | 'OWNER_DEPARTED' | null;
    readonly signals: readonly IntakeSignalProvenance[];
    /**
     * TRUE when a SUGGESTED proposal names the confirmed owner — by user id, or
     * by an e-mail address that hashes to theirs. FALSE when it suggested
     * somebody this could not show to be them (another person, or a reference
     * in a namespace that cannot be compared). NULL when nobody was suggested
     * (AMBIGUOUS, UNMATCHED). FALSE is "not shown to agree", never proof of a
     * different person.
     */
    readonly confirmedOwnerIsSuggested: boolean | null;
}

/** The confirmed owner, as the membership read found them. */
export interface ConfirmedOwner {
    readonly userId: string;
    readonly emailHash: string | null;
}

/**
 * Does a suggested reference name the confirmed owner? By exact user id, or by
 * the e-mail lookup hash (`hashForLookup` normalises case and whitespace, so
 * `Jane@Example.com` matches a user stored as `jane@example.com`).
 */
export function suggestionNamesOwner(
    proposedOwnerRef: string,
    owner: ConfirmedOwner,
    hashForLookup: (value: string) => string,
): boolean {
    if (proposedOwnerRef === owner.userId) return true;
    if (owner.emailHash === null || !proposedOwnerRef.includes('@')) return false;
    return hashForLookup(proposedOwnerRef) === owner.emailHash;
}

/** The provenance an intake records for a parsed attribution. */
export function suggestionProvenance(
    attribution: OwnershipAttribution,
    owner: ConfirmedOwner,
    hashForLookup: (value: string) => string,
): IntakeSuggestionProvenance {
    const signals = attribution.signals.map((s) => ({
        kind: s.kind,
        evidence: s.evidence,
        namesPerson: s.personRef !== null,
    }));
    if (attribution.status === 'SUGGESTED') {
        return {
            status: 'SUGGESTED',
            grade: attribution.grade,
            unmatchedReason: null,
            signals,
            confirmedOwnerIsSuggested: suggestionNamesOwner(attribution.proposedOwnerRef, owner, hashForLookup),
        };
    }
    return {
        status: attribution.status,
        grade: null,
        unmatchedReason: attribution.status === 'UNMATCHED' ? attribution.reason : null,
        signals,
        confirmedOwnerIsSuggested: null,
    };
}
