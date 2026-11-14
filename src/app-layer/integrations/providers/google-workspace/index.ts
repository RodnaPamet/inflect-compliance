/**
 * Google Workspace identity provider (PR-2).
 *
 * A `ScheduledCheckProvider` + `IdentitySyncProvider` over the Admin SDK
 * Directory API. Syncs the Workspace directory into
 * `ConnectedIdentityAccount` and runs the shared identity checks
 * (`google-workspace.mfa_enforced`, `.no_dormant_admins`, …).
 *
 * The `listAccounts` HTTP fetch is injectable so unit tests exercise the
 * check + sync logic without live Google credentials. The live path reads
 * a domain-wide-delegated service-account JSON (impersonating an admin) —
 * see docs; the token exchange is the one part that needs live creds to
 * validate.
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../../types';
import {
    runIdentityCheck,
    IDENTITY_CHECKS,
    type IdentitySyncProvider,
    type ListAccountsResult,
    type NormalizedIdentityAccount,
} from '../identity/types';
import { IntegrationAuthError, resilientFetch } from '../../http-resilience';
import { logger } from '@/lib/observability/logger';
import { fetchOAuthToken } from '../../oauth-token-fetch';

const MAX_USERS = 5000;
const PAGE_SIZE = 200;
const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1';

/** GAP-4 — domain-level inbound SAML SSO coverage, derived from assignments. */
interface SsoCoverage {
    /** A SAML_SSO assignment applies to the whole customer (all users). */
    customerWide: boolean;
    /** At least one SAML_SSO assignment exists (possibly OU/group-scoped only). */
    hasSaml: boolean;
    /**
     * Org-unit ids a SAML assignment targets, WITHOUT the `orgUnits/` prefix.
     *
     * Optional so every existing `listSsoAssignments` double stays valid, and
     * an omitted value reads as "no OU targets", which is the pre-#5571
     * behaviour. The real reader always populates it.
     */
    samlOrgUnitIds?: readonly string[];
    /**
     * A SAML assignment targets a GROUP.
     *
     * Load-bearing for the fail-closed reading: this sync does not read group
     * memberships, so an account not covered by any OU may still be covered by
     * a group, and must therefore be UNKNOWN rather than NOT ENROLLED.
     */
    hasGroupTargetedSaml?: boolean;
}

/** One org unit, as the Directory API reports it. */
interface GoogleOrgUnit {
    orgUnitId?: string;
    orgUnitPath?: string;
    parentOrgUnitId?: string;
    parentOrgUnitPath?: string;
}

/**
 * Org-unit paths by id, plus the ROOT's id — which the API does not hand over.
 *
 * `orgunits.list` returns the org units UNDER the root and never the root
 * itself, so the root's id is derived: it is the `parentOrgUnitId` shared by
 * every unit whose `parentOrgUnitPath` is `/`. Exactly one such id must exist,
 * or the derivation is refused rather than guessed.
 *
 * AN EMPTY LIST RESOLVES NOTHING, deliberately. A customer with no sub-units
 * has exactly one org unit — the root — so arguing that any targeted OU "must
 * therefore be the root" is tempting and is NOT done here. The inference is
 * sound only while the emptiness is real, and it fails in the one direction
 * that matters: a response that lost its `organizationUnits` key for any other
 * reason would mark every account SSO-enrolled, turning a security control into
 * a guaranteed pass. Unresolved stays unresolved, and the verdict is unknown.
 */
export function buildOrgUnitPaths(units: readonly GoogleOrgUnit[]): {
    pathById: Map<string, string>;
    rootId: string | null;
} {
    const pathById = new Map<string, string>();
    for (const u of units) {
        if (u.orgUnitId && u.orgUnitPath) pathById.set(u.orgUnitId, u.orgUnitPath);
    }
    const topLevelParents = new Set(
        units.filter((u) => u.parentOrgUnitPath === '/').map((u) => u.parentOrgUnitId ?? ''),
    );
    topLevelParents.delete('');
    const rootId = topLevelParents.size === 1 ? [...topLevelParents][0] : null;
    if (rootId) pathById.set(rootId, '/');
    return { pathById, rootId };
}

/**
 * Does an org-unit path lie at or under one of `coveredPaths`?
 *
 * The separator matters. A bare `path.startsWith(covered)` reports `/Eng` as
 * covering `/Engineering`, which would mark a whole unrelated unit as
 * SSO-enrolled on a name prefix. Comparison is therefore on whole segments,
 * with `/` — the root — covering everything.
 */
export function orgUnitCovers(coveredPaths: readonly string[], path: string): boolean {
    return coveredPaths.some((covered) =>
        covered === '/' ? true : path === covered || path.startsWith(`${covered}/`),
    );
}

/**
 * One account's `ssoEnrolled`, given what the assignments say and what we could
 * resolve. Pure, because this is the rule the control reports and it has four
 * outcomes that are easy to collapse into three.
 *
 * FAIL-CLOSED ON WHAT WE CANNOT SEE. `false` is a positive claim that an
 * account is not federated, and `sso_enforced` turns it into a FAILED control
 * naming that person. So it is returned only when every SAML assignment was
 * resolved and none covers the account. An unresolved OU target, or any
 * group-targeted assignment, yields `null` — unknown — because this sync does
 * not read group memberships and cannot rule coverage out.
 */
export function googleSsoVerdict(args: {
    coverage: SsoCoverage;
    coveredPaths: readonly string[];
    unresolvedOuTarget: boolean;
    accountOrgUnitPath: string | undefined;
}): boolean | null {
    const { coverage, coveredPaths, unresolvedOuTarget, accountOrgUnitPath } = args;
    if (coverage.customerWide) return true;
    if (!coverage.hasSaml) return false;
    // An account with no reported path sits in the root as far as Google is
    // concerned, but treating an ABSENT field as `/` would turn a projection
    // change into a tenant-wide pass. Unknown instead.
    if (!accountOrgUnitPath) return null;
    if (orgUnitCovers(coveredPaths, accountOrgUnitPath)) return true;
    if (unresolvedOuTarget || coverage.hasGroupTargetedSaml) return null;
    return false;
}

interface GwsDeps {
    /**
     * Injected enumeration for tests.
     *
     * Returns EITHER a bare array (complete, the long-standing shape) or a full
     * `ListAccountsResult`. The union exists so a test can express a TRUNCATED
     * read: this seam used to hardcode `complete: true`, which meant no test
     * could produce the one input the truncation rule exists to handle — so
     * reverting that rule would have reddened nothing. A double that cannot
     * produce the failing input is not a test of the thing.
     */
    listAccounts?: (
        config: Record<string, unknown>,
    ) => Promise<NormalizedIdentityAccount[] | ListAccountsResult>;
    /** Injectable token getter (defaults to a service-account JWT exchange). */
    getAccessToken?: (config: Record<string, unknown>) => Promise<string>;
    /** Injectable SSO-assignment reader (defaults to the Cloud Identity API). */
    listSsoAssignments?: (token: string) => Promise<SsoCoverage>;
    /** Injectable org-unit reader (defaults to the Directory API). */
    listOrgUnits?: (token: string) => Promise<readonly GoogleOrgUnit[]>;
    fetchImpl?: typeof fetch;
}

interface GoogleUser {
    id: string;
    primaryEmail?: string;
    name?: { fullName?: string };
    suspended?: boolean;
    archived?: boolean;
    isAdmin?: boolean;
    isDelegatedAdmin?: boolean;
    isEnrolledIn2Sv?: boolean;
    lastLoginTime?: string | null;
    /**
     * Already on the wire — the users read asks for `projection=full` — and
     * simply never read until #5571.
     */
    orgUnitPath?: string;
}

function mapGoogleStatus(u: GoogleUser): NormalizedIdentityAccount['status'] {
    if (u.archived) return 'DEPROVISIONED';
    if (u.suspended) return 'SUSPENDED';
    return 'ACTIVE';
}

function normalizeGoogleUser(u: GoogleUser): NormalizedIdentityAccount {
    return {
        externalUserId: u.id,
        email: u.primaryEmail || '',
        displayName: u.name?.fullName,
        status: mapGoogleStatus(u),
        // Real Directory-API signals.
        isAdmin: Boolean(u.isAdmin || u.isDelegatedAdmin),
        mfaEnrolled: Boolean(u.isEnrolledIn2Sv),
        // H2 — a blanket `true` made sso_enforced impossible to fail. Per-user
        // SAML SSO assignment is NOT in the basic Directory user object, so
        // report `null` (unknown) until that signal is fetched — sso_enforced is
        // then NOT_APPLICABLE for Google rather than a guaranteed pass.
        ssoEnrolled: null,
        // Google Workspace has no Azure AD Connect equivalent in this model.
        // `null` = not answerable here, per the H2 three-state convention.
        onPremisesSyncEnabled: null,
        groups: [],
        lastActiveAt:
            u.lastLoginTime && u.lastLoginTime !== '1970-01-01T00:00:00.000Z'
                ? new Date(u.lastLoginTime)
                : null,
    };
}

export class GoogleWorkspaceProvider implements ScheduledCheckProvider, IdentitySyncProvider {
    readonly id = 'google-workspace';
    readonly displayName = 'Google Workspace';
    readonly description =
        'Sync the Google Workspace directory and verify 2-Step Verification, dormant admins, admin count, and SSO.';
    readonly supportedChecks = [...IDENTITY_CHECKS];
    // validateConnection performs a real token exchange AND a directory read, so
    // a pass means the domain-wide-delegation grant is live and the impersonated
    // admin is reachable — not merely that the pasted JSON parses.
    readonly liveValidation = true;
    // #3431 — nothing in this repo records a live mapping run for this
    // provider. A claim about the record, not about the vendor.
    readonly mappingVerifiedBy = null;
    readonly setupGuide =
        'Create a service account, enable domain-wide delegation, and authorise its client ID in the Admin console for the Directory + (optional) inbound-SSO read-only scopes. Paste the whole service-account key JSON below and the super-admin it impersonates above. Test connection performs a live token exchange and directory read, so it fails if the delegation has been revoked or the scopes are not authorised.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'domain', label: 'Primary domain', type: 'string', required: true, placeholder: 'acme.com' },
            { key: 'adminEmail', label: 'Admin to impersonate', type: 'string', required: true, placeholder: 'admin@acme.com', description: 'A super-admin the service account impersonates via domain-wide delegation.' },
            { key: 'maxAdmins', label: 'Max active admins', type: 'number', required: false, description: 'Threshold for admin_count_within_threshold (default 5).' },
            { key: 'dormantDays', label: 'Dormant admin threshold (days)', type: 'number', required: false, description: 'Admin considered dormant after this many days idle (default 90).' },
            { key: 'enrichSso', label: 'SAML SSO enrichment', type: 'boolean', required: false, description: 'Read inbound SAML assignments so the SSO check reflects real coverage (default on; needs the cloud-identity.inboundsso.readonly scope).' },
            { key: 'enrichOrgUnits', label: 'Org-unit SSO resolution', type: 'boolean', required: false, description: 'Resolve which org units a SAML assignment covers, so the SSO check can pass for a tenant that enforces SAML through its top-level org unit and can name the accounts a partial rollout leaves out. OFF by default, because it needs ONE MORE scope authorised in your Admin console for this service account: https://www.googleapis.com/auth/admin.directory.orgunit.readonly. It is requested in a token exchange of its own, so leaving it unauthorised costs only this enrichment and never the directory sync. Without it, a SAML assignment scoped to an org unit reads as unknown rather than as coverage.' },
        ],
        secretFields: [
            { key: 'serviceAccountJson', label: 'Service-account JSON', type: 'textarea', required: true, description: 'A domain-wide-delegated service-account key (JSON) — paste the whole file.' },
        ],
    };

    private readonly deps: GwsDeps;
    constructor(deps: GwsDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        if (!config.domain) return { valid: false, error: 'A primary domain is required.' };
        if (!config.adminEmail) return { valid: false, error: 'An admin email to impersonate is required.' };
        const saRaw = secrets.serviceAccountJson;
        if (!saRaw) return { valid: false, error: 'A service-account JSON key is required.' };
        try {
            const sa = typeof saRaw === 'string' ? JSON.parse(saRaw) : saRaw;
            if (!sa.client_email || !sa.private_key) {
                return { valid: false, error: 'Service-account JSON is missing client_email / private_key.' };
            }
        } catch {
            return { valid: false, error: 'Service-account JSON is not valid JSON.' };
        }

        // Everything above is a shape check on a string the operator pasted. It
        // was ALSO the entire implementation — so "Test connection" returned
        // valid on a connection whose domain-wide-delegation grant had been
        // revoked, and the failure only appeared later in a background sync. A
        // validateConnection that cannot fail is worse than none, because it
        // launders an untested connection as verified.
        //
        // Two calls, because they fail for different reasons and an operator
        // needs to know which:
        //   the token exchange proves the DWD grant is live and the key valid;
        //   the directory read proves adminEmail is impersonable and the scope
        //   is actually authorised — a grant can exist with the wrong scopes.
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        try {
            const token = this.deps.getAccessToken
                ? await this.deps.getAccessToken({ ...config, ...secrets })
                : await getGoogleAccessToken({ ...config, ...secrets }, doFetch);

            const url = new URL(`${DIRECTORY_BASE}/users`);
            url.searchParams.set('domain', String(config.domain ?? ''));
            url.searchParams.set('maxResults', '1');
            const res = await doFetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (!res.ok) {
                return {
                    valid: false,
                    error: `Google directory read failed (HTTP ${res.status}). Check that ${String(config.adminEmail ?? 'the admin email')} can be impersonated and the directory scope is authorised.`,
                };
            }
            return { valid: true };
        } catch (err) {
            // IntegrationAuthError is the classified case — a revoked grant now
            // answers 400 invalid_grant and arrives here as that class rather
            // than as an anonymous Error. Its message is already URL-scrubbed by
            // safeUrl and carries only an allowlisted RFC code, so it is safe to
            // surface; an unclassified error is not, so it is not interpolated.
            if (err instanceof IntegrationAuthError) {
                return { valid: false, error: `Google rejected the credentials: ${err.message}` };
            }
            return { valid: false, error: 'Google connection test failed. Check the service-account key, the domain-wide-delegation grant and the authorised scopes.' };
        }
    }

    async listAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        // Bare array (treated as complete) or a full result, so a test can
        // express truncation. The dep type already allowed a result object
        // while this line forced `complete: true` and wrapped it a second time.
        if (this.deps.listAccounts) {
            const injected = await this.deps.listAccounts(config);
            return Array.isArray(injected) ? { accounts: injected, complete: true } : injected;
        }
        return this.fetchGoogleAccounts(config, resumeFrom);
    }

    private async fetchGoogleAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        const token = this.deps.getAccessToken
            ? await this.deps.getAccessToken(config)
            : await getGoogleAccessToken(config);
        const domain = String(config.domain ?? '');
        const out: NormalizedIdentityAccount[] = [];
        /**
         * Each account's org-unit path, kept beside `out` rather than put on
         * `NormalizedIdentityAccount`: it is an input to one check's verdict,
         * not a fact about an identity that anything downstream stores.
         */
        const orgUnitPathById = new Map<string, string>();
        // Google's continuation is an opaque token rather than a URL, so unlike
        // Okta/Entra it cannot redirect our credentialed request anywhere — it
        // is only ever appended as a query parameter to our own base URL.
        let pageToken: string | undefined = resumeFrom ?? undefined;
        do {
            const url = new URL(`${DIRECTORY_BASE}/users`);
            url.searchParams.set('domain', domain);
            url.searchParams.set('maxResults', String(PAGE_SIZE));
            url.searchParams.set('projection', 'full');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const res = await doFetch(url.toString(), {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`Google directory fetch failed (HTTP ${res.status})`);
            const body = (await res.json()) as { users?: GoogleUser[]; nextPageToken?: string };
            for (const u of body.users ?? []) {
                out.push(normalizeGoogleUser(u));
                if (u.orgUnitPath) orgUnitPathById.set(u.id, u.orgUnitPath);
            }
            pageToken = body.nextPageToken;
        } while (pageToken && out.length < MAX_USERS);

        // GAP-4 — per-user SAML SSO is not on the Directory user object, so
        // `normalizeGoogleUser` leaves `ssoEnrolled` null. Derive it from the
        // inbound SAML SSO assignments (Cloud Identity) so `sso_enforced` can
        // fail when SSO is not configured:
        //   • customer-wide SAML assignment → every account is ssoEnrolled
        //   • no SAML assignment at all      → every account is NOT ssoEnrolled (FAIL)
        //   • only OU/group-scoped SAML      → unknown (null → NOT_APPLICABLE),
        //     since mapping an assignment's OU/group to each user needs calls
        //     this sync doesn't make. Opt out with `enrichSso: false`.
        const enrichSso = String((config as { enrichSso?: unknown }).enrichSso ?? 'true').toLowerCase() !== 'false';
        if (enrichSso) {
            try {
                const cov = this.deps.listSsoAssignments
                    ? await this.deps.listSsoAssignments(token)
                    : await fetchSsoCoverage(token, doFetch);
                const value: boolean | null = cov.customerWide ? true : cov.hasSaml ? null : false;
                for (const a of out) a.ssoEnrolled = value;

                // ═══ PER-ACCOUNT, WHEN THE ORG-UNIT READ IS AUTHORISED (#5571) ═══
                //
                // The coarse verdict above cannot tell a tenant-wide rollout
                // from a departmental one, because a customer enforcing SAML
                // for everyone does it through the ROOT org unit — so the
                // assignment carries a `targetOrgUnit` and lands in the
                // "OU-scoped → unknown" bucket. `sso_enforced` then reported
                // NOT_APPLICABLE for ever, and the outcome was inverted with
                // respect to effort: a customer with NO SSO got a clean FAILED,
                // one who had done the work got silence.
                //
                // OPT-IN, because resolving an OU id to a path needs
                // `admin.directory.orgunit.readonly`, and a scope is a question
                // put to the customer — they authorise it in their own Admin
                // console against this service account's client id.
                const enrichOrgUnits =
                    String((config as { enrichOrgUnits?: unknown }).enrichOrgUnits ?? 'false').toLowerCase() === 'true';
                const ouTargets = cov.samlOrgUnitIds ?? [];
                if (enrichOrgUnits && !cov.customerWide && ouTargets.length > 0) {
                    try {
                        // ITS OWN EXCHANGE. See `GWS_ORG_UNIT_SCOPE`: appending
                        // this scope to the sync's own would risk a token
                        // endpoint refusal that `fetchOAuthToken` turns into an
                        // `IntegrationAuthError`, marking the connection
                        // credential-failed and taking the whole sync with it.
                        const ouToken = this.deps.getAccessToken
                            ? await this.deps.getAccessToken(config)
                            : await getGoogleAccessToken(config, doFetch, GWS_ORG_UNIT_SCOPE);
                        const units = this.deps.listOrgUnits
                            ? await this.deps.listOrgUnits(ouToken)
                            : await fetchOrgUnits(ouToken, doFetch);
                        const { pathById } = buildOrgUnitPaths(units);
                        const coveredPaths = ouTargets
                            .map((id) => pathById.get(id))
                            .filter((p): p is string => p !== undefined);
                        const unresolvedOuTarget = coveredPaths.length < ouTargets.length;
                        for (const a of out) {
                            a.ssoEnrolled = googleSsoVerdict({
                                coverage: cov,
                                coveredPaths,
                                unresolvedOuTarget,
                                accountOrgUnitPath: orgUnitPathById.get(a.externalUserId),
                            });
                        }
                    } catch (err) {
                        // The org-unit scope is not authorised, or the read
                        // failed. The coarse verdict above stands: this
                        // enrichment only ever REFINES, so its failure must
                        // never be worse than not having run it.
                        //
                        // SAID, NOT SWALLOWED, and that is what makes this
                        // catch load-bearing rather than decorative. The outer
                        // catch would swallow the same throw and leave the same
                        // verdicts, so without a line here no test could tell
                        // the two apart — and an administrator who ticked the
                        // box and did not authorise the scope in their Admin
                        // console would get silence on the one surface that
                        // could tell them why nothing changed.
                        logger.warn('google-workspace org-unit SSO resolution failed; coarse verdict kept', {
                            component: 'google-workspace',
                            // The reason only. No account, no org unit, no
                            // token: this line is about OUR read failing.
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            } catch {
                // SSO scope not authorised / API blip — leave null (NOT_APPLICABLE).
            }
        }

        // H3 — a still-present nextPageToken means we hit MAX_USERS mid-directory:
        // the enumeration is KNOWN-PARTIAL and must not drive deprovisioning.
        // H3-2 — carry the token so the next run continues from here.
        return { accounts: out, complete: !pageToken, resumeToken: pageToken ?? null };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        try {
            // `complete` is CARRIED, not dropped. The enumeration is capped, so
            // on a directory past the cap this is a slice — and a control that
            // reports PASSED over a slice states a falsehood about the part it
            // never read. `runIdentityCheck` turns a truncated PASS into an
            // ERROR and leaves a truncated FAIL standing, because a violation
            // found in a subset is still a violation.
            const { accounts, complete } = await this.listAccounts(input.connectionConfig);
            const result = runIdentityCheck(input.parsed.checkType, accounts, input.connectionConfig, new Date(), {
                complete,
                accountsRead: accounts.length,
            });
            return { ...result, durationMs: Date.now() - start };
        } catch (err) {
            return {
                status: 'ERROR',
                summary: 'Google Workspace check failed to run.',
                details: {},
                durationMs: Date.now() - start,
                errorMessage: err instanceof Error ? err.message : String(err),
            };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return {
            title: `Google Workspace — ${input.parsed.checkType}`,
            content: result.summary,
            type: 'REPORT',
            category: `google-workspace:${input.parsed.checkType}`,
        };
    }
}

/**
 * The scopes the sync itself needs. Every connection's DWD grant authorises
 * these two, and nothing may be added here without every customer re-authorising
 * in their own Admin console — which is why the org-unit scope is separate.
 */
export const GWS_SYNC_SCOPE =
    'https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/cloud-identity.inboundsso.readonly';

/**
 * The org-unit read's scope, requested in a token exchange OF ITS OWN (#5571).
 *
 * NEVER append this to `GWS_SYNC_SCOPE`. A DWD assertion naming a scope the
 * customer has not authorised can be refused at the token endpoint, and
 * `getGoogleAccessToken` routes through `fetchOAuthToken`, which turns a 400
 * `invalid_grant` into an `IntegrationAuthError` — so the caller MARKS THE
 * CONNECTION as credential-failed. Adding the scope to the shared string would
 * therefore risk taking the whole directory sync, the freshness surface and the
 * leaver pass down for every customer who had not re-authorised, to enrich one
 * check. Its own exchange, inside its own try/catch, can only cost the
 * enrichment.
 */
export const GWS_ORG_UNIT_SCOPE = 'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';

/**
 * Exchange a domain-wide-delegated service account for an access token
 * (JWT bearer grant, impersonating `adminEmail`). Isolated so the live
 * token exchange is the only part requiring real Google credentials.
 */
export async function getGoogleAccessToken(
    config: Record<string, unknown>,
    // Injectable for the same reason entra-id's exchange is: the assertion this
    // builds is only observable from the request body, so without a seam the
    // `exp` margin below cannot be asserted by a test.
    doFetch: typeof fetch = resilientFetch,
    /** Defaults to the sync's own scopes; the org-unit read passes its own. */
    scope: string = GWS_SYNC_SCOPE,
): Promise<string> {
    const crypto = await import('node:crypto');
    const saRaw = (config as { serviceAccountJson?: unknown }).serviceAccountJson;
    const sa = typeof saRaw === 'string' ? JSON.parse(saRaw) : (saRaw as { client_email: string; private_key: string });
    const adminEmail = String(config.adminEmail ?? '');
    const now = Math.floor(Date.now() / 1000);
    // Google rejects an assertion whose `exp` is more than 3600s ahead of ITS
    // clock, so asking for the documented maximum leaves zero margin: the
    // assertion is accepted only while (our clock - Google's) <= request
    // transit. A host running ~a second fast gets
    //   400 {"error":"invalid_grant","error_description":"Invalid JWT: Token
    //        must be a short-lived token (60 minutes) ..."}
    // on EVERY sync, which reads as a revoked grant while the grant is fine.
    // 55 minutes buys 5 minutes of skew tolerance and costs nothing — the token
    // is used immediately and never cached to its expiry.
    const ASSERTION_LIFETIME_SECONDS = 3300;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
        iss: sa.client_email,
        sub: adminEmail,
        // GAP-4 — cloud-identity.inboundsso.readonly is here so the SSO
        // enrichment can read inbound SAML assignments. The DWD grant must
        // authorise both scopes; if the SSO scope is not authorised the
        // assignments fetch 403s and SSO falls back to unknown (NOT_APPLICABLE).
        scope,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + ASSERTION_LIFETIME_SECONDS,
    };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${b64(header)}.${b64(claim)}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key).toString('base64url');
    const assertion = `${signingInput}.${signature}`;
    // resilientFetch, not the global. This was a bare `await fetch(...)`: the
    // DWD token exchange is an outbound call to Google like any other, but it
    // sat outside the timeout + 429 handling every other call in this file goes
    // through (see `deps.fetchImpl ?? resilientFetch` above). Its only caller
    // passes no impl, so it was genuinely unbounded — a hung oauth2.googleapis
    // .com would stall the sync indefinitely, and a 429 there surfaced as a
    // generic failure the queue answered with three full re-syncs.
    //
    // What this does NOT buy, so nobody assumes it: credential revocation still
    // does not mark the connection. OAuth2 signals credential failure with 400,
    // not 401 (RFC 6749 §5.2 — `invalid_grant`), and a revoked DWD grant is the
    // dominant failure here. 400 is in none of resilientFetch's sets (retryable
    // 429/502/503/504, auth 401/403, terminal 404), so the Response passes
    // through and the `!res.ok` throw below is a generic Error — which
    // markAuthFailure deliberately no-ops on. Classifying an OAuth error BODY
    // rather than a status is a separate design question.
    // fetchOAuthToken, not doFetch directly: a revoked domain-wide-delegation
    // grant answers 400 invalid_grant, which resilientFetch passes through. This
    // is what turns that into an IntegrationAuthError so the connection is marked.
    const res = await fetchOAuthToken('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    }, doFetch);
    if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('Google token exchange returned no access_token');
    return json.access_token;
}

const CLOUD_IDENTITY_BASE = 'https://cloudidentity.googleapis.com/v1';

interface InboundSsoAssignment {
    ssoMode?: string;
    targetOrgUnit?: string;
    targetGroup?: string;
}

/**
 * GAP-4 — read the inbound SSO assignments and reduce them to domain-level
 * SAML coverage. A `SAML_SSO` assignment that targets neither an OU nor a
 * group applies to the whole customer.
 */
async function fetchSsoCoverage(token: string, doFetch: typeof fetch): Promise<SsoCoverage> {
    let customerWide = false;
    let hasSaml = false;
    let hasGroupTargetedSaml = false;
    const samlOrgUnitIds = new Set<string>();
    let pageToken: string | undefined;
    do {
        const url = new URL(`${CLOUD_IDENTITY_BASE}/inboundSsoAssignments`);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const res = await doFetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Google SSO assignments fetch failed (HTTP ${res.status})`);
        const body = (await res.json()) as { inboundSsoAssignments?: InboundSsoAssignment[]; nextPageToken?: string };
        for (const a of body.inboundSsoAssignments ?? []) {
            if (a.ssoMode !== 'SAML_SSO') continue;
            hasSaml = true;
            if (!a.targetOrgUnit && !a.targetGroup) customerWide = true;
            // `orgUnits/{id}` on the wire; the Directory API keys org units by
            // the bare id, so strip the collection prefix once, here.
            if (a.targetOrgUnit) samlOrgUnitIds.add(a.targetOrgUnit.replace(/^orgUnits\//, ''));
            if (a.targetGroup) hasGroupTargetedSaml = true;
        }
        pageToken = body.nextPageToken;
    } while (pageToken);
    return { customerWide, hasSaml, samlOrgUnitIds: [...samlOrgUnitIds], hasGroupTargetedSaml };
}

/**
 * The org units, for resolving an assignment's target to a path.
 *
 * `type=all` because an assignment may target a unit at any depth, and
 * `my_customer` because the token already names the customer — passing an id we
 * do not otherwise hold would be a second source of truth for it.
 */
async function fetchOrgUnits(token: string, doFetch: typeof fetch): Promise<GoogleOrgUnit[]> {
    const url = new URL(`${DIRECTORY_BASE}/customer/my_customer/orgunits`);
    url.searchParams.set('type', 'all');
    const res = await doFetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Google org-unit fetch failed (HTTP ${res.status})`);
    const body = (await res.json()) as { organizationUnits?: GoogleOrgUnit[] };
    return body.organizationUnits ?? [];
}
