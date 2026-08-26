/**
 * Microsoft Entra ID (Azure AD) identity provider.
 *
 * A `ScheduledCheckProvider` + `IdentitySyncProvider` over the Microsoft
 * Graph API. Syncs the Entra directory into `ConnectedIdentityAccount` and
 * runs the shared identity checks (`entra-id.mfa_enforced`,
 * `.no_dormant_admins`, `.admin_count_within_threshold`, `.sso_enforced`).
 *
 * Coverage note — for READING, this connector covers BOTH cloud Azure AD
 * accounts and on-premises Active Directory identities synced up to Entra via
 * Azure AD Connect (hybrid identity). Directory-synced accounts surface here
 * with `onPremisesSyncEnabled: true`.
 *
 * THAT COVERAGE IS READ-ONLY, AND THE DISTINCTION IS LOAD-BEARING.
 *
 * A directory-synced account is MASTERED ON-PREM. Azure AD Connect syncs one
 * way, so a write against Graph — disabling a leaver, say — is either refused
 * or silently reverted at the next cycle. The account reports disabled and then
 * re-enables itself, which is worse than an outright failure because the audit
 * trail says the offboarding succeeded.
 *
 * So `onPremisesSyncEnabled` is carried through to the stored account and
 * consulted by `resolveWriteTarget` (usecases/identity-write-target.ts) before
 * any write. Synced accounts are refused here and retargeted at the LDAPS
 * connector below.
 *
 * There IS a separate on-prem connector — `providers/active-directory` (LDAPS),
 * added 2026-07-15 — for estates whose AD is not projected into Entra. This
 * file previously said no such connector existed, which was true when written
 * and has been false since.
 *
 * Auth is the OAuth2 client-credentials grant against an app registration
 * (directory/tenant id + client id + client secret). Unlike Okta's per-user
 * `/factors` + `/roles` fan-out, Graph exposes BULK enrichment surfaces:
 *   • admin membership → `/directoryRoles?$expand=members` (a handful of calls)
 *   • MFA enrolment    → `/reports/authenticationMethods/userRegistrationDetails`
 *   • SSO federation   → `/domains` (per-domain authenticationType)
 * so a full directory enriches in a bounded, small number of requests.
 *
 * The token exchange + directory fetch are injectable so unit tests exercise
 * the check + sync logic without live Entra credentials — the live path is the
 * only part that needs a real app registration to validate.
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
import { logger } from '@/lib/observability/logger';
import { fetchOAuthToken } from '../../oauth-token-fetch';
import { resilientFetch, IntegrationTerminalError } from '../../http-resilience';

/** Max users pulled per sync — bounds a runaway directory. */
const MAX_USERS = 5000;
/** Graph caps `$top` at 999 for the users collection. */
const PAGE_SIZE = 999;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';

/** The user `$select` set. `signInActivity` needs AuditLog.Read.All + a premium
 *  licence; if the tenant lacks it the request 4xxs and we retry without it. */
const USER_SELECT_FULL =
    'id,displayName,userPrincipalName,mail,accountEnabled,userType,onPremisesSyncEnabled,signInActivity';
const USER_SELECT_BASE =
    'id,displayName,userPrincipalName,mail,accountEnabled,userType,onPremisesSyncEnabled';

interface EntraDeps {
    /** Injectable directory fetch (defaults to the live Graph client). */
    listAccounts?: (config: Record<string, unknown>) => Promise<NormalizedIdentityAccount[]>;
    /** Injectable token getter (defaults to the client-credentials exchange). */
    getAccessToken?: (config: Record<string, unknown>) => Promise<string>;
    /** Injectable fetch, for validateConnection ping tests. */
    fetchImpl?: typeof fetch;
}

interface GraphUser {
    id: string;
    displayName?: string;
    userPrincipalName?: string;
    mail?: string | null;
    accountEnabled?: boolean;
    userType?: string;
    onPremisesSyncEnabled?: boolean | null;
    signInActivity?: { lastSignInDateTime?: string | null } | null;
}

function truthy(v: unknown, dflt: boolean): boolean {
    if (v === undefined || v === null || v === '') return dflt;
    return String(v).toLowerCase() !== 'false';
}

/** Domain suffix of a UPN / email, lower-cased (`a@Acme.com` → `acme.com`). */
function domainOf(upn: string | undefined | null): string | null {
    if (!upn) return null;
    const at = upn.lastIndexOf('@');
    if (at < 0 || at === upn.length - 1) return null;
    return upn.slice(at + 1).toLowerCase();
}

function normalizeGraphUser(u: GraphUser): NormalizedIdentityAccount {
    const email = u.mail || u.userPrincipalName || '';
    return {
        externalUserId: u.id,
        email,
        displayName: u.displayName,
        // Entra has no per-user "deprovisioned" in the live /users collection —
        // deleted users leave the collection (→ reconciled to DEPROVISIONED by
        // the sync when they vanish). A disabled account maps to SUSPENDED.
        status: u.accountEnabled === false ? 'SUSPENDED' : 'ACTIVE',
        // H2 — admin membership + MFA enrolment are NOT on the user object; they
        // need the directory-role / registration-report enrichment below. Report
        // `null` (unknown) until enriched so the admin / MFA checks are
        // NOT_APPLICABLE rather than vacuously passing on a hardcoded false.
        isAdmin: null,
        mfaEnrolled: null,
        // Already in the $select above, and until now discarded. This is the
        // flag that decides whether a leaver write can land here at all: a
        // directory-synced account is mastered on-prem, so disabling it via
        // Graph is reverted by the next Azure AD Connect cycle.
        // `?? null` keeps "Graph omitted the field" distinct from "Graph said
        // false" — an absent property must not read as cloud-only.
        onPremisesSyncEnabled: u.onPremisesSyncEnabled ?? null,
        // H2 — per-user SSO federation is derived from domain authenticationType
        // in the enrichment pass; unknown until then.
        ssoEnrolled: null,
        groups: [],
        lastActiveAt: u.signInActivity?.lastSignInDateTime
            ? new Date(u.signInActivity.lastSignInDateTime)
            : null,
    };
}

export class EntraIdProvider implements ScheduledCheckProvider, IdentitySyncProvider {
    readonly id = 'entra-id';
    readonly displayName = 'Microsoft Entra ID';
    readonly description =
        'Sync the Microsoft Entra ID (Azure AD) directory — including on-prem AD identities synced via Azure AD Connect — and verify MFA registration, dormant admins, admin count, and SSO federation.';
    readonly supportedChecks = [...IDENTITY_CHECKS];
    // validateConnection performs a real client-credentials token exchange + a
    // Graph users ping.
    readonly liveValidation = true;
    readonly setupGuide =
        'In the Microsoft Entra admin center, register an application and grant it the application (not delegated) Microsoft Graph permissions User.Read.All, Directory.Read.All, and AuditLog.Read.All (the last enables MFA-registration + last-sign-in signals; without it those checks report Not applicable). Create a client secret, then paste the Directory (tenant) ID and Application (client) ID below with the secret. Test connection performs a live directory ping. On-prem Active Directory synced to Entra via Azure AD Connect is READ here for posture checks, but accounts mastered on-prem cannot be disabled through Graph — those writes are reverted by the next sync cycle, so offboarding them needs the separate on-prem Active Directory (LDAPS) connector. This connector runs directory/posture checks; it is separate from Entra SSO login. If you also want leaver offboarding to DISABLE accounts here, turn on "Allow offboarding writes" and grant the application permission User.EnableDisableAccount.All — none of the three read permissions above permits a write, Directory.Read.All included, and client-credentials tokens carry exactly what an administrator has already consented, so an existing connection keeps failing every disable until that consent is granted.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'tenantId', label: 'Directory (tenant) ID', type: 'string', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
            { key: 'clientId', label: 'Application (client) ID', type: 'string', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
            { key: 'maxAdmins', label: 'Max active admins', type: 'number', required: false, description: 'Threshold for admin_count_within_threshold (default 5).' },
            { key: 'dormantDays', label: 'Dormant admin threshold (days)', type: 'number', required: false, description: 'Admin considered dormant after this many days idle (default 90).' },
            { key: 'enrichMfa', label: 'MFA registration enrichment', type: 'boolean', required: false, description: 'Read the authentication-methods registration report so the MFA check reflects real enrolment (default on; needs AuditLog.Read.All).' },
            { key: 'enrichFederation', label: 'SSO federation enrichment', type: 'boolean', required: false, description: 'Derive per-user SSO from each domain’s authentication type so the SSO check reflects real federation (default on).' },
            // Defaults OFF, and the writer refuses to construct without an
            // explicit `true`. With client credentials the token exchange asks
            // for `.default`, which is not a request at all — it returns exactly
            // the set an admin has already consented. So there is no way to
            // scope a token down at call time, and the instant a tenant consents
            // Graph write permissions for any reason this application would gain
            // standing power to disable any user in that directory. This flag is
            // the per-connection statement that they asked for that, so a
            // read-only tenant cannot be upgraded by an edit to the copy below.
            { key: 'writesEnabled', label: 'Allow offboarding writes', type: 'boolean', required: false, description: 'Let leaver offboarding DISABLE accounts in this directory. Off by default. Additionally requires an administrator to consent the application permission User.EnableDisableAccount.All — the three read permissions above do not permit a write.' },
        ],
        secretFields: [
            { key: 'clientSecret', label: 'Client secret', type: 'string', required: true, description: 'A client secret for the app registration.' },
        ],
    };

    private readonly deps: EntraDeps;
    constructor(deps: EntraDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const tenantId = String(config.tenantId ?? '').trim();
        const clientId = String(config.clientId ?? '').trim();
        const clientSecret = String(secrets.clientSecret ?? '');
        if (!tenantId) return { valid: false, error: 'A Directory (tenant) ID is required.' };
        if (!clientId) return { valid: false, error: 'An Application (client) ID is required.' };
        if (!clientSecret) return { valid: false, error: 'A client secret is required.' };
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        try {
            const token = this.deps.getAccessToken
                ? await this.deps.getAccessToken({ ...config, ...secrets })
                : await getEntraAccessToken({ ...config, ...secrets }, doFetch);
            const res = await doFetch(`${GRAPH_BASE}/users?$top=1&$select=id`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (!res.ok) return { valid: false, error: `Entra directory ping failed (HTTP ${res.status}).` };
            return { valid: true };
        } catch (err) {
            return { valid: false, error: `Entra connection failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /** Enumerate the Entra directory into normalized accounts. */
    async listAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        // A test/dep injection returns a bare array — treat it as complete.
        if (this.deps.listAccounts) return { accounts: await this.deps.listAccounts(config), complete: true };
        return this.fetchEntraAccounts(config, resumeFrom);
    }

    private async fetchEntraAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        const token = this.deps.getAccessToken
            ? await this.deps.getAccessToken(config)
            : await getEntraAccessToken(config, doFetch);

        const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        const out: NormalizedIdentityAccount[] = [];

        // First page: try with signInActivity; if the tenant can't serve it,
        // fall back to the base select (last-sign-in then reports null → dormant
        // checks treat those admins as never-active, which is fail-closed).
        let select = USER_SELECT_FULL;
        // Resume from the stored @odata.nextLink when we have one. Graph's
        // nextLink is absolute, so it MUST be origin-checked: a tampered stored
        // cursor would otherwise send this request — carrying a Graph bearer
        // token — to an arbitrary host.
        const resuming = Boolean(resumeFrom && resumeFrom.startsWith(`${GRAPH_BASE}/`));
        let url: string | null = resuming
            ? (resumeFrom as string)
            : `${GRAPH_BASE}/users?$top=${PAGE_SIZE}&$select=${select}`;
        // A resumed URL already carries its own $select, so the
        // signInActivity fallback below must not rewrite it from scratch.
        let first = !resuming;
        /**
         * True when this failure is the tenant refusing `signInActivity`, and we
         * have not already dropped it.
         *
         * BOTH SHAPES, and that is the whole point. `resilientFetch` THROWS
         * `IntegrationAuthError` on 401/403 rather than returning the response,
         * so the `!res.ok` branch below could never see a 403 — and 403 is
         * exactly what Graph answers for `signInActivity` on a tenant without
         * Entra ID P1/P2. The fallback existed for that case and was unreachable
         * from it: observed in production as a connection that consented every
         * permission, obtained a valid token, and still failed every sync with
         * `Integration auth failed (403): …/v1.0/users`.
         */
        const isPremiumFieldRefusal = (status: number): boolean =>
            first && select === USER_SELECT_FULL && status >= 400 && status < 500;

        const dropSignInActivity = (status: number): string => {
            logger.warn('Entra users fetch with signInActivity failed; retrying without last-sign-in (needs AuditLog.Read.All + premium)', {
                component: 'integration-entra-id',
                status,
            });
            select = USER_SELECT_BASE;
            return `${GRAPH_BASE}/users?$top=${PAGE_SIZE}&$select=${select}`;
        };

        while (url && out.length < MAX_USERS) {
            let res: Response;
            try {
                res = await doFetch(url, { headers: authHeaders });
            } catch (err) {
                // A thrown auth error on the FIRST page is ambiguous between "the
                // credential is bad" and "this tenant cannot serve signInActivity".
                // Retrying without the premium field disambiguates: a genuinely bad
                // credential throws again on the retry and propagates untouched, so
                // the connection is still marked. Only 4xx is retried — a 5xx or a
                // network throw is not a permissions answer.
                const status = err instanceof IntegrationTerminalError ? err.status : 0;
                if (isPremiumFieldRefusal(status)) {
                    url = dropSignInActivity(status);
                    continue;
                }
                throw err;
            }
            if (!res.ok) {
                if (isPremiumFieldRefusal(res.status)) {
                    url = dropSignInActivity(res.status);
                    continue;
                }
                throw new Error(`Entra users fetch failed (HTTP ${res.status})`);
            }
            first = false;
            const body = (await res.json()) as { value?: GraphUser[]; '@odata.nextLink'?: string };
            for (const u of body.value ?? []) out.push(normalizeGraphUser(u));
            url = body['@odata.nextLink'] ?? null;
        }

        // ── Bulk enrichment (each wrapped so a single failing surface leaves its
        //    signal at null → NOT_APPLICABLE, never fails the whole sync). ──
        const byId = new Map(out.map((a) => [a.externalUserId, a]));

        // Admin membership — authoritative for the whole population when it
        // succeeds (every account is set true/false), so the admin checks run.
        try {
            const adminIds = await fetchAdminUserIds(token, doFetch);
            for (const a of out) a.isAdmin = adminIds.has(a.externalUserId);
        } catch {
            // Leave isAdmin null — admin checks report NOT_APPLICABLE.
        }

        if (truthy(config.enrichMfa, true)) {
            try {
                const mfaById = await fetchMfaRegistration(token, doFetch);
                for (const [id, registered] of mfaById) {
                    const a = byId.get(id);
                    if (a) a.mfaEnrolled = registered;
                }
            } catch {
                // Leave mfaEnrolled null — mfa_enforced reports NOT_APPLICABLE.
            }
        }

        if (truthy(config.enrichFederation, true)) {
            try {
                const federatedDomains = await fetchFederatedDomains(token, doFetch);
                // federatedDomains === null → could not read domains → leave null.
                if (federatedDomains) {
                    for (const a of out) {
                        const dom = domainOf(a.email);
                        // Domain not in the verified set (e.g. guest #EXT#) → unknown.
                        a.ssoEnrolled = dom && federatedDomains.has(dom) ? federatedDomains.get(dom)! : null;
                    }
                }
            } catch {
                // Leave ssoEnrolled null — sso_enforced reports NOT_APPLICABLE.
            }
        }

        // A still-present nextLink means we stopped at MAX_USERS mid-directory:
        // the enumeration is KNOWN-PARTIAL and must not drive deprovisioning.
        // H3-2 — carry it out so the next run continues from here.
        return { accounts: out, complete: url === null, resumeToken: url };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        try {
            const { accounts } = await this.listAccounts(input.connectionConfig);
            const result = runIdentityCheck(input.parsed.checkType, accounts, input.connectionConfig, new Date());
            return { ...result, durationMs: Date.now() - start };
        } catch (err) {
            return {
                status: 'ERROR',
                summary: 'Entra ID check failed to run.',
                details: {},
                durationMs: Date.now() - start,
                errorMessage: err instanceof Error ? err.message : String(err),
            };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return {
            title: `Microsoft Entra ID — ${input.parsed.checkType}`,
            content: result.summary,
            type: 'REPORT',
            category: `entra-id:${input.parsed.checkType}`,
        };
    }
}

/**
 * Exchange the app-registration credentials for a Graph access token via the
 * OAuth2 client-credentials grant. Isolated so the live token exchange is the
 * only part requiring a real Entra app registration.
 */
export async function getEntraAccessToken(
    config: Record<string, unknown>,
    // Defaults to resilientFetch, not the global. Both live callers pass an
    // impl, so this was latent rather than broken — but `getEntraAccessToken`
    // is EXPORTED, so "both callers pass one" is only true of the callers that
    // exist today. That is the argument for fixing the default rather than
    // deleting it.
    //
    // Same caveat as the Google token exchange: this buys the deadline and the
    // 429 handling, NOT auth classification. An expired client secret returns
    // 400 `invalid_client` (RFC 6749 §5.2), which resilientFetch does not
    // classify, so it still surfaces as a generic failure.
    doFetch: typeof fetch = resilientFetch,
): Promise<string> {
    const tenantId = String(config.tenantId ?? '').trim();
    const clientId = String(config.clientId ?? '').trim();
    const clientSecret = String((config as { clientSecret?: unknown }).clientSecret ?? '');
    // Fail BEFORE the request rather than posting an empty credential. Entra
    // answers an empty client_secret with
    //   401 {"error":"invalid_client","error_codes":[7000218],
    //        "error_description":"AADSTS7000218: The request body must contain
    //        client_assertion or client_secret"}
    // — our own malformed request. But resilientFetch converts EVERY 401 into
    // IntegrationAuthError, so that answer marks the connection
    // credential-failed and suppresses the queue's retries. A secret that is
    // missing because it failed to decrypt (rotation race, DEK issue) would
    // therefore be recorded permanently as "your credentials are revoked".
    //
    // A plain Error is deliberate: it neither marks the connection nor bypasses
    // the queue retry, so a transient decrypt failure still gets its attempts.
    // Three wasted attempts on a genuinely unconfigured connection is much
    // cheaper than skipping a sync until the next scheduled run.
    if (!clientSecret) {
        throw new Error('Entra token exchange skipped: clientSecret is missing or failed to decrypt');
    }
    // fetchOAuthToken, not doFetch directly: an expired or rotated client secret
    // answers 400 invalid_client, which resilientFetch passes through. This is
    // what turns that into an IntegrationAuthError so the connection is marked.
    const res = await fetchOAuthToken(`${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://graph.microsoft.com/.default',
        }),
    }, doFetch);
    if (!res.ok) throw new Error(`Entra token exchange failed (HTTP ${res.status})`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('Entra token exchange returned no access_token');
    return json.access_token;
}

interface GraphDirectoryObject { id?: string; '@odata.type'?: string }
interface GraphDirectoryRole { members?: GraphDirectoryObject[] }

/**
 * The set of user object-ids that hold ANY activated directory role (direct
 * grants). `/directoryRoles` only returns activated roles, so a role with
 * members is one that is actually in use. Members can be users, groups, or
 * service principals — only `#microsoft.graph.user` members are admins here.
 */
async function fetchAdminUserIds(token: string, doFetch: typeof fetch): Promise<Set<string>> {
    const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const ids = new Set<string>();
    let url: string | null = `${GRAPH_BASE}/directoryRoles?$expand=members`;
    while (url) {
        const res: Response = await doFetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Entra directoryRoles fetch failed (HTTP ${res.status})`);
        const body = (await res.json()) as { value?: GraphDirectoryRole[]; '@odata.nextLink'?: string };
        for (const role of body.value ?? []) {
            for (const m of role.members ?? []) {
                if (m.id && m['@odata.type'] === '#microsoft.graph.user') ids.add(m.id);
            }
        }
        url = body['@odata.nextLink'] ?? null;
    }
    return ids;
}

interface RegistrationDetail { id?: string; isMfaRegistered?: boolean }

/**
 * Map of user object-id → whether an MFA method is registered, from the
 * authentication-methods user-registration report (a bulk, paginated surface).
 * Requires AuditLog.Read.All; a 403 propagates and the caller degrades to null.
 */
async function fetchMfaRegistration(token: string, doFetch: typeof fetch): Promise<Map<string, boolean>> {
    const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const out = new Map<string, boolean>();
    let url: string | null = `${GRAPH_BASE}/reports/authenticationMethods/userRegistrationDetails?$top=${PAGE_SIZE}`;
    while (url) {
        const res: Response = await doFetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Entra MFA registration report failed (HTTP ${res.status})`);
        const body = (await res.json()) as { value?: RegistrationDetail[]; '@odata.nextLink'?: string };
        for (const d of body.value ?? []) {
            if (d.id) out.set(d.id, Boolean(d.isMfaRegistered));
        }
        url = body['@odata.nextLink'] ?? null;
    }
    return out;
}

interface GraphDomain { id?: string; authenticationType?: string; isVerified?: boolean }

/**
 * Map of verified-domain name → is federated (SSO). `authenticationType` is
 * `'Federated'` (external IdP / AD FS SSO) or `'Managed'` (Entra-native). Only
 * verified domains are included. Returns null if the domains list can't be
 * read at all (→ SSO signal stays unknown for every account).
 */
async function fetchFederatedDomains(token: string, doFetch: typeof fetch): Promise<Map<string, boolean> | null> {
    const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const map = new Map<string, boolean>();
    let url: string | null = `${GRAPH_BASE}/domains`;
    let any = false;
    while (url) {
        const res: Response = await doFetch(url, { headers: authHeaders });
        if (!res.ok) return null;
        any = true;
        const body = (await res.json()) as { value?: GraphDomain[]; '@odata.nextLink'?: string };
        for (const d of body.value ?? []) {
            if (d.id && d.isVerified !== false) map.set(d.id.toLowerCase(), d.authenticationType === 'Federated');
        }
        url = body['@odata.nextLink'] ?? null;
    }
    return any ? map : null;
}
