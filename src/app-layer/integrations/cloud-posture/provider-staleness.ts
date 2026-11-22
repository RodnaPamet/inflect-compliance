/**
 * THE GATEWAY STILL HOLDS THE OLD CREDENTIAL — #5476, acceptance criterion 4.
 *
 * A posture connection's gateway provider is created by the operator, with that
 * connection's cloud credential, under the name `postureProviderName` derives.
 * The product attaches it and never writes it: that needs gateway-wide mTLS with
 * `OU=operator`, deliberately absent from both VMs.
 *
 * So when a tenant rotates the connection's credential IN THE PRODUCT, the
 * gateway's provider keeps the previous one — under the same name, because the
 * name is derived from row ids and not from the secret. Every scan then succeeds
 * against a credential the product no longer holds, which is the quietest
 * possible version of #5251: the account benchmarked is a real one, it is simply
 * not the one the tenant thinks they configured.
 *
 * ── Why this REPORTS and cannot resolve ────────────────────────────────
 *
 * Criterion 4 was originally "rotation and tenant purge remove the provider" and
 * was renegotiated to detect and report, because the product cannot remove what
 * it cannot write. It cannot CONFIRM the fix either: the readiness observation
 * #5739 added says `credentials_installed`, not WHICH credential is installed. So
 * there is no positive evidence available, and the owner's decision is that a
 * person closes the finding once they have re-provisioned.
 *
 * That is why nothing here closes anything. A finding that closed on the next
 * successful scan would close on the OLD credential working perfectly well.
 *
 * ── This module decides; it writes nothing ─────────────────────────────
 *
 * Pure, so the whole decision is testable without a database: the writer
 * (`usecases/posture-provider-staleness.ts`) only turns a `STALE` verdict into
 * one Finding.
 */

/** What a credential save means for the connection's gateway provider. */
export type ProviderStalenessVerdict =
    /** Not a posture connection, or no credential was supplied: nothing to say. */
    | 'NOT_APPLICABLE'
    /** The connection had no credential before, so the operator has not provisioned against one yet. */
    | 'FIRST_CREDENTIAL'
    /** The same credential was re-saved: the gateway's copy is still current. */
    | 'UNCHANGED'
    /** The credential moved, so the gateway's provider is behind. */
    | 'STALE'
    /** The previous credential could not be read, so currency cannot be shown. */
    | 'UNREADABLE_PREVIOUS';

/**
 * The stored credential, as the caller was able to read it.
 *
 * THREE STATES, named, because collapsing any two of them gets the verdict
 * wrong: "there was none" is a first provisioning and reports nothing, "we could
 * not read it" cannot show currency and reports, and a readable one is compared.
 * An earlier draft folded `unreadable` into a null canonical form and steered the
 * verdict through a second field, which worked and could not be read.
 */
export type StoredCredential =
    | { readonly kind: 'none' }
    | { readonly kind: 'readable'; readonly canonical: string }
    | { readonly kind: 'unreadable' };

/**
 * Should a credential save report the gateway provider as behind?
 *
 * The canonical forms are the DECRYPTED credential bags with their keys ordered.
 * Comparing ciphertexts instead would report every save as a rotation:
 * `encryptField` uses a fresh IV, so the same plaintext encrypts to a different
 * string every time.
 *
 * `UNREADABLE_PREVIOUS` is reportable, deliberately. If the stored credential
 * will not decrypt, the product cannot show that the gateway's copy matches it,
 * and "we cannot tell" is something an operator should be told rather than a
 * reason to stay quiet — the direction the credential hygiene pass takes when a
 * secret will not decrypt.
 */
export function providerStalenessVerdict(input: {
    /** True only for `aws-posture` / `azure-posture` / `gcp-posture`. */
    readonly isPostureConnection: boolean;
    /** The credential being stored, canonical — `undefined` when none was supplied. */
    readonly suppliedCanonical: string | undefined;
    readonly previous: StoredCredential;
}): ProviderStalenessVerdict {
    if (!input.isPostureConnection || input.suppliedCanonical === undefined) {
        return 'NOT_APPLICABLE';
    }
    switch (input.previous.kind) {
        // A connection that never held a credential cannot have an out-of-date
        // provider: the operator provisions against the credential it has now.
        case 'none':
            return 'FIRST_CREDENTIAL';
        case 'unreadable':
            return 'UNREADABLE_PREVIOUS';
        case 'readable':
            return input.previous.canonical === input.suppliedCanonical ? 'UNCHANGED' : 'STALE';
    }
}

/** The verdicts that mean an operator has something to do. */
export const REPORTABLE_STALENESS: readonly ProviderStalenessVerdict[] = [
    'STALE',
    'UNREADABLE_PREVIOUS',
];

/** Does this verdict want a finding? */
export function reportsStaleness(verdict: ProviderStalenessVerdict): boolean {
    return REPORTABLE_STALENESS.includes(verdict);
}
