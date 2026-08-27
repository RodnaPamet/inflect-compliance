/**
 * Where a directory write is allowed to land, decided per ACCOUNT.
 *
 * ═══ WHY THIS IS NOT A TENANT SETTING ═══
 *
 * The obvious design is an operator-supplied "directory topology" — Entra, or
 * on-prem AD, or hybrid — configured per tenant, or per organization to save
 * the operator repeating themselves.
 *
 * Both are the wrong axis, and per-tenant is already too coarse. A hybrid
 * estate holds BOTH cloud-only and directory-synced accounts inside ONE Entra
 * tenant: `onPremisesSyncEnabled` is a per-USER flag. "What is this tenant's
 * topology?" therefore has no single correct answer, and a per-organization
 * value has none for a whole group of tenants.
 *
 * It would also be a claim the config layer cannot verify. `IntegrationConnection`
 * is keyed `(tenantId, provider, name)` and knows nothing about organizations,
 * so an org-level "Entra" says nothing about a tenant that has since wired an
 * `active-directory` connection.
 *
 * So nothing here is configured. The signal is OBSERVED during a healthy sync
 * and READ at write time — the same shape as the worker↔account link, and for
 * the same reason: the moment you need the answer is the worst moment to go
 * asking for it.
 *
 * Config loses to observation, always, because the observation is what Azure AD
 * Connect will actually honour.
 *
 * @module usecases/identity-write-target
 */

/** The subset of a stored account this decision needs. */
/**
 * Providers whose documented contract makes a NULL mean "not synced from
 * on-premises" rather than "no answer".
 *
 * Deliberately a set of one, and deliberately not inferred from the observation
 * flag alone. A provider author adding `onPremStateObserved: true` to their
 * normalizer — reasonably, since their API *was* asked — would otherwise
 * silently convert "this directory cannot answer the question" into "this
 * account is writable". The flag says we asked; this says the answer means what
 * we think it means, and only Microsoft's is quoted in the branch below.
 *
 * Okta and Google Workspace hardcode null for the opposite reason: there is no
 * on-premises concept to report. They must stay refused.
 */
const NULL_MEANS_NOT_SYNCED = new Set(['entra-id']);

export interface WriteTargetInput {
    readonly provider: string;
    /** Observed during sync. `null` = not synced from on-prem, OR unanswered. */
    readonly onPremisesSyncEnabled: boolean | null;
    /**
     * Whether a sync actually got an ANSWER for the field above.
     *
     * This is what separates the two meanings of `null`. Absent/false keeps the
     * pre-existing conservative refusal, so a provider that says nothing — and
     * every row written before the column existed — behaves exactly as before.
     */
    readonly onPremStateObserved?: boolean;
}

/**
 * WHICH RULE DECIDED — the fact a dry-run report has to carry.
 *
 * The verdict alone is not enough for the seven-day observation window. Its
 * reader is being asked whether to grant this thing unattended authority over a
 * customer's directory, and "would disable" is not an answer they can weigh;
 * "would disable, because the directory answered that this account is
 * cloud-only" is. Widening the rail (#2144 moved a whole population from
 * REFUSED_TARGET to would-disable) is invisible in a report that only says what
 * the verdict was.
 *
 * The two REFUSED bases are the pair that matter most, and they were one string
 * until now. `NEVER_OBSERVED` means the provider CAN answer and has not yet for
 * this row — the response is to wait for the nightly sync, and it clears
 * itself. `PROVIDER_CANNOT_OBSERVE` means the provider has no such flag to
 * report, so no sync will ever record one and waiting is not a plan. An
 * operator's next action differs completely, and the un-backfilled migration
 * put both on the same page at the same time.
 */
export type WriteTargetBasis =
    /** The on-prem directory itself: the write lands at the source of authority. */
    | 'ON_PREM_DIRECTORY'
    /** Observed `false` — the directory says this account is not synced from on-prem. */
    | 'NOT_ON_PREM_SYNCED'
    /** Observed `null` from a provider whose null MEANS not-synced. The widened rule. */
    | 'CLOUD_ONLY_OBSERVED'
    /** Observed `true` — mastered on-premises, so a cloud write would be reverted. */
    | 'ON_PREM_MASTERED'
    /** The provider can answer; nothing has asked for this account yet. WAIT. */
    | 'NEVER_OBSERVED'
    /** The provider has no on-premises concept to report. Waiting will not help. */
    | 'PROVIDER_CANNOT_OBSERVE'
    /** Not a directory this platform disables accounts in. */
    | 'UNSUPPORTED_DIRECTORY';

export type WriteTarget =
    /** The write may go to this provider's API. */
    | { readonly allowed: true; readonly basis: WriteTargetBasis }
    /** It may not, and this is why. */
    | {
          readonly allowed: false;
          readonly basis: WriteTargetBasis;
          readonly reason: string;
          readonly retargetTo?: string;
      };

/**
 * Cloud directories whose accounts we may write to directly, PROVIDED the
 * account is not mastered somewhere else.
 */
const CLOUD_DIRECTORIES = new Set(['entra-id', 'okta', 'google-workspace']);

/** The on-prem directory. A write here lands where authority already lives. */
const ON_PREM_DIRECTORY = 'active-directory';

/**
 * Decide whether a disable may be written against this account's own provider.
 *
 * Refuses rather than guessing in every ambiguous case, because the failure
 * this exists to prevent is not a failed write — it is a SUCCESSFUL-LOOKING
 * one. Disabling a directory-synced account through Graph is accepted by the
 * API and then reverted by the next Azure AD Connect cycle, so the leaver
 * reports done and re-enables itself, with an audit trail saying the
 * offboarding succeeded.
 */
export function resolveWriteTarget(account: WriteTargetInput): WriteTarget {
    // The on-prem directory masters its own accounts. This is the one provider
    // where a write is unambiguously landing at the source of authority.
    if (account.provider === ON_PREM_DIRECTORY)
        return { allowed: true, basis: 'ON_PREM_DIRECTORY' };

    if (!CLOUD_DIRECTORIES.has(account.provider)) {
        return {
            allowed: false,
            basis: 'UNSUPPORTED_DIRECTORY',
            reason:
                `Refusing to write to "${account.provider}": not a directory this platform disables ` +
                `accounts in. Only ${[...CLOUD_DIRECTORIES, ON_PREM_DIRECTORY].sort().join(', ')} are supported.`,
        };
    }

    if (account.onPremisesSyncEnabled === true) {
        return {
            allowed: false,
            basis: 'ON_PREM_MASTERED',
            reason:
                'Refusing to disable a directory-synced account through the cloud directory: it is mastered ' +
                'on-premises, so the write is reverted at the next Azure AD Connect cycle. The account would ' +
                'report disabled and then re-enable itself, which is worse than failing because the audit ' +
                'trail would say the offboarding succeeded. Disable it in Active Directory instead.',
            retargetTo: ON_PREM_DIRECTORY,
        };
    }

    const nullMeansCloudOnly =
        NULL_MEANS_NOT_SYNCED.has(account.provider) && account.onPremStateObserved === true;

    if (account.onPremisesSyncEnabled === null && !nullMeansCloudOnly) {
        // TWO REFUSALS, NOT ONE — and they were the same sentence until now.
        //
        // Whether the provider CAN answer is decided by the same set the allow
        // above consults, so the split costs nothing and cannot drift from it.
        //
        // The distinction is the operator's whole next action. A provider that
        // answers has simply not answered for THIS row yet — the un-backfilled
        // migration guarantees a population of those for one sync cycle — and
        // the refusal clears itself overnight. A provider that has no such flag
        // will never record one, so "run a sync first, then retry" was advice
        // that could not be taken, aimed at the operator least able to tell.
        const providerCanObserve = NULL_MEANS_NOT_SYNCED.has(account.provider);
        return providerCanObserve
            ? {
                  allowed: false,
                  basis: 'NEVER_OBSERVED',
                  reason:
                      'Refusing to disable an account whose on-premises sync state was never observed. Unknown ' +
                      'is not the same as cloud-only, and the two differ exactly where it matters. Run a ' +
                      'successful directory sync first so the flag is recorded, then retry.',
              }
            : {
                  allowed: false,
                  basis: 'PROVIDER_CANNOT_OBSERVE',
                  reason:
                      `Refusing to disable an account in "${account.provider}", which does not report whether ` +
                      'an account is mastered on-premises. Unlike an account nothing has looked at yet, there ' +
                      'is no sync to wait for here — this directory has no such flag to record — so the ' +
                      'refusal stands until the platform can tell one of its accounts from a synced one.',
              };
    }

    // Reached by an observed `false` AND by an observed `null`, and the second
    // one is the point.
    //
    // Graph's contract for `onPremisesSyncEnabled` is `true` when the object is
    // synced from an on-premises AD and, verbatim, "otherwise the user isn't
    // being synced and can be managed in Microsoft Entra ID". So `null` from a
    // directory that was ASKED is that "otherwise" — it is the ordinary and
    // permanent state of every user in a cloud-only tenant, not a gap.
    //
    // Treating it as a gap made this rail refuse every candidate in every
    // cloud-only directory, forever, while advising the operator to run a sync
    // they had already run successfully. The refusal survives untouched for a
    // genuine unknown: Okta and Google Workspace hardcode null precisely
    // because they cannot answer, and they set no observation.
    return {
        allowed: true,
        basis: account.onPremisesSyncEnabled === null ? 'CLOUD_ONLY_OBSERVED' : 'NOT_ON_PREM_SYNCED',
    };
}
