/**
 * The joiner's directory seam — deliberately NOT `DirectoryWriter` (#2674).
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY A SECOND INTERFACE RATHER THAN FIVE MORE MEMBERS
 * ═══════════════════════════════════════════════════════════════════
 *
 * `DirectoryWriter`'s docblock calls itself "deliberately tiny", and that
 * charter argument is the WEAKER reason to leave it alone. The decisive
 * one is that **the snapshot arm cannot be shared, even in DRY_RUN.**
 *
 * `createSnapshotWriter.readState` throws `DirectoryWriteError` with
 * `definitivelyNotApplied: true` when the account is absent from the last
 * enumeration — "the last complete sync did not see this account, so there
 * is nothing to report on". For a LEAVER that is right: absence is an
 * anomaly, and the live writer resolves the same case as an account that
 * cannot be disabled because it is not there.
 *
 * **For a JOINER, absence is the SUCCESS case.** It is precisely what
 * "this identifier is free" looks like. A joiner reaching through
 * `DirectoryWriter.readState` would raise a provider error for every
 * legitimate candidate, and the seven-day artefact would be a page of
 * throws where it should be a page of plans.
 *
 * So the collision read needs its own shape — which is the same conclusion
 * the charter argument reaches, by a route that does not depend on taste.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE GAP THIS EXISTS TO CLOSE, QUOTED FROM THE PLANNER
 * ═══════════════════════════════════════════════════════════════════
 *
 * `identity-joiner-pass.ts`'s `predictionLimits` says of every plan it
 * emits today:
 *
 *   > The collision read covers the stored `email` column only (for Entra
 *   > that is `mail || userPrincipalName`). Create-time uniqueness is
 *   > enforced on `userPrincipalName`, `mailNickname` and
 *   > `proxyAddresses`, and on Active Directory most often on
 *   > `sAMAccountName`, which this product persists nowhere. A plan that
 *   > found no conflict is NOT a statement that the address is available.
 *
 * That is the limit this seam is built to retire. The roster's stored
 * `email` is not the namespace a create collides in, so asking the roster
 * answers a different question from the one a joiner needs answered.
 *
 * ═══════════════════════════════════════════════════════════════════
 * "CANNOT TELL" IS A FIRST-CLASS ANSWER, AND IT IS NOT "FREE"
 * ═══════════════════════════════════════════════════════════════════
 *
 * The probe returns three outcomes, not two. `unknown` exists because the
 * snapshot arm CANNOT answer a create-time uniqueness question — it holds
 * stored rows from a past enumeration, and no amount of reading them tells
 * you whether a `userPrincipalName` is claimable right now.
 *
 * Collapsing `unknown` into `free` is the defect this shape refuses to
 * permit: it would turn "we did not look" into "we looked and it is
 * available", and the create that followed would be the one decision 1
 * forbids — an account whose address diverges from the one the leaver
 * path could later disable.
 *
 * A failed probe therefore means UNKNOWN, never FREE. There is no arm of
 * this type that a caller can reach by accident and read as permission.
 */
import type { WriterRefusal } from './identity-writer-factory';

/**
 * What a directory said about one candidate identifier.
 *
 * Never throws for a free identifier — see the module header. `free` is the
 * joiner's success case and must be expressible without an exception.
 */
export type IdentifierProbe =
    | {
          readonly kind: 'free';
          /**
           * The namespaces actually consulted. A literal list rather than a
           * boolean, for the same reason `JoinerDecision.namespacesChecked`
           * is one: widening coverage later is then a visible diff, and an
           * old artefact cannot be re-read as having promised more than it
           * checked.
           */
          readonly namespacesChecked: readonly string[];
      }
    | {
          readonly kind: 'taken';
          /** Which namespace held it — `userPrincipalName`, `sAMAccountName`, … */
          readonly namespace: string;
          /** The account holding it, when the directory names one. */
          readonly externalUserId: string | null;
          readonly detail: string;
      }
    | {
          readonly kind: 'unknown';
          /**
           * Namespaces that could NOT be consulted. Non-empty by
           * construction: an `unknown` that named nothing would be
           * indistinguishable from a `free` nobody checked.
           */
          readonly namespacesUnavailable: readonly string[];
          readonly detail: string;
      };

/**
 * Ask a directory whether an identifier is claimable.
 *
 * Deliberately ONE member. The mutating verbs — create, assign group, issue
 * credential — are NOT declared here yet, and their absence is the point:
 * a loud-throwing stub is a surface whose only job is to fail correctly,
 * and the design already names that as the cost of widening the wrong
 * interface. They arrive with the create verb, which is gated on #2608
 * having a real directory to exercise it against.
 *
 * When they do arrive, the order is settled by OWNER DECISION 3
 * (2026-09-19): on Entra the security-group add comes FIRST, then the
 * Temporary Access Pass, then SSO. `docs/jml-joiner-design.md` sketches
 * create → TAP → group → enable, which puts the group AFTER; the owner's
 * wording governs and the design predates it.
 */
/**
 * The result of ONE of a create's writes.
 *
 * Three arms, not two, and the third is the point. `refused` positively
 * asserts the directory did NOT change; `indeterminate` says we do not know.
 * Collapsing them would make a timeout look like a rejection, and the
 * rollback decision is different for each: a refusal has nothing to undo, an
 * indeterminate result may.
 */
export type ProvisionStep =
    | { readonly kind: 'applied'; readonly detail?: string }
    | { readonly kind: 'refused'; readonly detail: string }
    | { readonly kind: 'indeterminate'; readonly detail: string };

/** What a create needs to know about the person it is provisioning. */
export interface CreateAccountInput {
    /** The identifier the plan derived and probed. */
    readonly identifier: string;
    readonly displayName: string;
    /** The employee this account answers to, for the journal's anchor. */
    readonly employeeId: string;
}

/** `applied` carries the directory's own id — everything after needs it. */
export type CreateAccountStep =
    | {
          readonly kind: 'applied';
          readonly externalUserId: string;
          readonly detail?: string;
      }
    | { readonly kind: 'refused'; readonly detail: string }
    | { readonly kind: 'indeterminate'; readonly detail: string };

export interface DirectoryProvisioner {
    readonly provider: string;
    /**
     * The namespaces a create in THIS directory collides in.
     *
     * Declared by the provisioner because only the provider knows them, and
     * read by the caller because only the caller reports them. Entra
     * enforces uniqueness on `userPrincipalName`, `mailNickname` and
     * `proxyAddresses`; Active Directory most often on `sAMAccountName`.
     */
    readonly collisionNamespaces: readonly string[];
    /** Never throws for a free identifier. See {@link IdentifierProbe}. */
    probeIdentifier(candidate: string): Promise<IdentifierProbe>;

    /**
     * Create the account SIGN-IN BLOCKED. #2714.
     *
     * Blocked, not enabled, and that is the whole safety argument: the
     * sequence exists so the recoverable half is last. An account nobody can
     * sign into is recoverable by a human; one anyone can sign into with no
     * entitlements is not observable.
     */
    createBlockedAccount(input: CreateAccountInput): Promise<CreateAccountStep>;

    /**
     * Add the account to its entitlement group. #2713 decides WHICH group.
     *
     * SECOND, before the credential — owner decision 3 (2026-09-19): "the pass
     * is issued through Entra — after adding the user to the security group.
     * after that it's SSO login." The design doc sketched the opposite order
     * and was corrected in the same PR that added this method.
     */
    assignGroup(externalUserId: string, groupId: string): Promise<ProvisionStep>;

    /**
     * Mint the joining credential. THIRD, after the group.
     *
     * Entra: a Temporary Access Pass, then SSO. Never a password, and never a
     * password FALLBACK — if TAP policy is disabled this refuses, because a
     * silent downgrade to a password is a different security posture than the
     * one the tenant configured. AD keeps its own password arm, which is a
     * different provisioner, not a fallback inside this one.
     */
    issueCredential(externalUserId: string): Promise<ProvisionStep>;

    /**
     * Unblock sign-in. LAST.
     *
     * By this point the account exists, is entitled, and has a credential. It
     * is the last step precisely because everything before it is the half that
     * is not observable if left half-done.
     */
    enableAccount(externalUserId: string): Promise<ProvisionStep>;
}

/** Why no provisioner could be resolved. Shares the writer's vocabulary. */
export type ProvisionerRefusal = WriterRefusal;

export type ProvisionerResolution =
    | { readonly kind: 'provisioner'; readonly provisioner: DirectoryProvisioner }
    | {
          readonly kind: 'none';
          readonly refusal: ProvisionerRefusal;
          readonly detail: string;
      };

/**
 * The provisioner that answers "I cannot tell" to everything.
 *
 * NOT a stub and not a placeholder — it is the correct implementation for
 * every mode below AUTOMATIC, because the stored enumeration genuinely
 * cannot answer a create-time uniqueness question. Returning `unknown` is
 * this arm being RIGHT, not being unfinished.
 *
 * It is also the arm that makes the seam testable before #2608 exists: a
 * DRY_RUN plan can be driven end to end, and every candidate comes back
 * with its namespaces named as unavailable rather than silently assumed
 * free.
 */
export function createSnapshotProvisioner(
    provider: string,
    collisionNamespaces: readonly string[],
): DirectoryProvisioner {
    return {
        provider,
        collisionNamespaces,
        probeIdentifier: async (candidate: string): Promise<IdentifierProbe> => ({
            kind: 'unknown',
            namespacesUnavailable: collisionNamespaces,
            detail:
                `The stored enumeration cannot say whether ${JSON.stringify(candidate)} is ` +
                `claimable: create-time uniqueness is enforced on ` +
                `${collisionNamespaces.join(', ')}, and this product persists the roster's ` +
                `stored address rather than those namespaces. Reported as UNKNOWN rather ` +
                `than free — "we did not look" must not read as "it is available".`,
        }),

        // THE FOUR MUTATING VERBS REFUSE, and that is this arm being correct
        // rather than unfinished. The snapshot provisioner is what every mode
        // below AUTOMATIC resolves to; a DRY_RUN plan must be drivable end to
        // end WITHOUT the directory changing. A no-op that returned `applied`
        // would make a dry run indistinguishable from a real one in the
        // journal, which is the one outcome this seam exists to prevent.
        //
        // `refused`, not `indeterminate`: nothing was attempted, so we can
        // positively assert the directory did not change. There is nothing to
        // roll back, and the caller can say so.
        createBlockedAccount: async (input: CreateAccountInput): Promise<CreateAccountStep> => ({
            kind: 'refused',
            detail:
                `The snapshot provisioner cannot create ${JSON.stringify(input.identifier)}: it ` +
                `reads a stored enumeration and holds no write path to ${provider}. This is the ` +
                `arm every mode below AUTOMATIC resolves to, so a plan reaching here is a DRY_RUN ` +
                `behaving correctly, not a create that failed.`,
        }),
        assignGroup: async (externalUserId: string, groupId: string): Promise<ProvisionStep> => ({
            kind: 'refused',
            detail:
                `The snapshot provisioner cannot add ${externalUserId} to group ${groupId}: no ` +
                `write path to ${provider}.`,
        }),
        issueCredential: async (externalUserId: string): Promise<ProvisionStep> => ({
            kind: 'refused',
            detail:
                `The snapshot provisioner cannot mint a credential for ${externalUserId}: no ` +
                `write path to ${provider}. Never a password fallback — see the interface.`,
        }),
        enableAccount: async (externalUserId: string): Promise<ProvisionStep> => ({
            kind: 'refused',
            detail:
                `The snapshot provisioner cannot enable ${externalUserId}: no write path to ` +
                `${provider}.`,
        }),
    };
}
