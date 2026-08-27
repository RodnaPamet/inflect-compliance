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

/**
 * How recently a sync must have OBSERVED the on-premises state for that
 * observation to still be actable.
 *
 * ═══ WHY AN AGE AND NOT JUST A PRESENCE ═══
 *
 * `onPremStateObservedAt` is a DateTime because WHEN a directory answered is
 * the thing that matters, and the rail below reduced it to "answered at all".
 * The two are the same question only while the stamp and the link evidence are
 * refreshed by the same pass — and they are not. `identity-sync` writes the
 * stamp per CONNECTION, upserting only the accounts its own enumeration
 * returned. `reconcileIdentityAccountLinks` stamps `lastVerifiedAt` per
 * PROVIDER, over every account row this tenant holds for that provider.
 *
 * So one enabled connection syncing healthily keeps EVERY link for its provider
 * fresh, including links to rows a second, soft-disabled connection observed
 * and has not touched since. `removeIntegrationConnection` sets
 * `isEnabled: false` and deletes nothing; the deprovision reconcile is
 * connection-scoped, so those rows stay ACTIVE with a frozen stamp forever.
 * `resolveDirectoryWriter` refuses AMBIGUOUS_CONNECTION only when more than one
 * connection is ENABLED, so it does not fire on that shape. Link freshness
 * therefore bounds the PAIRING and says nothing about the age of the
 * observation the write-target rail acts on.
 *
 * ═══ WHY THIS EXACT NUMBER ═══
 *
 * The same instant the link bound uses — `LINK_FRESHNESS_MS` in
 * `identity-leaver-pass` is an alias of this constant, not a second copy of the
 * number. Two bounds mean the weaker one silently governs, and a rail whose
 * whole job is refusing stale evidence must not be the one holding the weaker
 * bound. Two days rather than one because the sync is daily, so a one-day bound
 * turns a single missed run into a pass that refuses everybody.
 *
 * ═══ WHY IT MATTERS MOST AT THE RUNG EVERYBODY IS ON ═══
 *
 * Above DRY_RUN the live Entra writer re-reads Graph and builds its own
 * capture, so a stale stored stamp is corrected before `disable` gates on it.
 * DRY_RUN is the rung every tenant is clamped at, and there the snapshot reader
 * performs no live read at all — the stored stamp is the ONLY evidence, and
 * a seven-day observation window reporting "would disable" for an account whose
 * on-prem state was last seen in January is the artefact an operator is being
 * asked to promote the tenant on.
 */
export const OBSERVATION_FRESHNESS_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Whether an observation stamp is recent enough to act on. FAILS CLOSED.
 *
 * Absent, unparseable, or older than `OBSERVATION_FRESHNESS_MS` all answer
 * `false`, which routes into the existing "not observed" refusal rather than
 * into a write. `undefined` is called out explicitly because that is what an
 * unselected column or a row shape predating the field produces, and the
 * original `!== null` form read it as OBSERVED — failing open on the rail whose
 * entire purpose is failing closed.
 *
 * A stamp in the FUTURE counts as fresh. Nothing writes one: `identity-sync`
 * stores its own `now`, so a forward stamp is ordinary clock skew between the
 * worker that synced and the pass that reads, and refusing on skew would make
 * the rail inert for a reason that has nothing to do with the directory.
 */
export function isObservationFresh(
    observedAt: Date | string | null | undefined,
    now: Date = new Date(),
): boolean {
    if (observedAt === null || observedAt === undefined) return false;
    const at = observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt);
    if (!Number.isFinite(at)) return false;
    return at >= now.getTime() - OBSERVATION_FRESHNESS_MS;
}

export interface WriteTargetInput {
    readonly provider: string;
    /** Observed during sync. `null` = not synced from on-prem, OR unanswered. */
    readonly onPremisesSyncEnabled: boolean | null;
    /**
     * Whether a sync got an ANSWER for the field above, RECENTLY ENOUGH to act on.
     *
     * This is what separates the two meanings of `null`. Absent/false keeps the
     * pre-existing conservative refusal, so a provider that says nothing — and
     * every row written before the column existed — behaves exactly as before.
     *
     * A BOOLEAN CARRYING AN AGE, and the caller owns the age. Every producer
     * derives it through `isObservationFresh` against the stored
     * `onPremStateObservedAt`, so "observed" here means observed inside
     * `OBSERVATION_FRESHNESS_MS` — not observed at some point in the row's
     * history. The column stays a DateTime because when a directory answered has
     * forensic value the rail does not need; this flag is the rail's reading of
     * it, not a replacement for it.
     */
    readonly onPremStateObserved?: boolean;
}

export type WriteTarget =
    /** The write may go to this provider's API. */
    | { readonly allowed: true }
    /** It may not, and this is why. */
    | { readonly allowed: false; readonly reason: string; readonly retargetTo?: string };

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
    if (account.provider === ON_PREM_DIRECTORY) return { allowed: true };

    if (!CLOUD_DIRECTORIES.has(account.provider)) {
        return {
            allowed: false,
            reason:
                `Refusing to write to "${account.provider}": not a directory this platform disables ` +
                `accounts in. Only ${[...CLOUD_DIRECTORIES, ON_PREM_DIRECTORY].sort().join(', ')} are supported.`,
        };
    }

    if (account.onPremisesSyncEnabled === true) {
        return {
            allowed: false,
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
        return {
            allowed: false,
            reason:
                'Refusing to disable an account whose on-premises sync state was never observed, or was ' +
                'last observed too long ago to act on. Unknown is not the same as cloud-only, and the two ' +
                'differ exactly where it matters; an observation older than the freshness bound is a ' +
                'statement about a directory that has had time to change since. Run a successful ' +
                'directory sync first so the flag is recorded, then retry.',
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
    return { allowed: true };
}
