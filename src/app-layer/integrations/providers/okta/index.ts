/**
 * Okta identity provider (PR-2).
 *
 * A `ScheduledCheckProvider` + `IdentitySyncProvider`: syncs the Okta
 * directory into `ConnectedIdentityAccount` and runs per-account posture
 * checks (`okta.mfa_enforced`, `okta.no_dormant_admins`, …).
 *
 * The `listAccounts` HTTP fetch is injectable so unit tests exercise the
 * check + sync logic without a live Okta org.
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
import { resilientFetch } from '../../http-resilience';

/** Max users pulled per sync — bounds a runaway directory. */
const MAX_USERS = 5000;
const PAGE_LIMIT = 200;
/**
 * GAP-4 — the per-user enrichment (`/factors` + `/roles`) is TWO extra HTTP
 * calls per account. Cap the enriched population so a huge directory can't
 * fan out to 10 000+ Okta calls in one sync; accounts past the cap keep their
 * base (null) signal → the check reports NOT_APPLICABLE for them rather than a
 * false PASS. The cap is logged, never silent.
 */
const MAX_ENRICH = 2000;
/** Bounded concurrency for the enrichment fan-out (Okta rate-limits hard). */
const ENRICH_CONCURRENCY = 8;

interface OktaDeps {
    /** Injectable directory fetch (defaults to the live Okta REST client). */
    listAccounts?: (config: Record<string, unknown>) => Promise<NormalizedIdentityAccount[]>;
    /** Injectable fetch, for validateConnection ping tests. */
    fetchImpl?: typeof fetch;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            await fn(items[idx]);
        }
    });
    await Promise.all(workers);
}

/** Map an Okta user status to the normalized lifecycle enum. */
function mapOktaStatus(status: string): NormalizedIdentityAccount['status'] {
    switch (status) {
        case 'SUSPENDED':
            return 'SUSPENDED';
        case 'DEPROVISIONED':
            return 'DEPROVISIONED';
        default:
            // ACTIVE, PROVISIONED, STAGED, RECOVERY, LOCKED_OUT, PASSWORD_EXPIRED
            return status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED';
    }
}

interface OktaUser {
    id: string;
    status: string;
    created?: string;
    lastLogin?: string | null;
    profile?: { email?: string; login?: string; displayName?: string; firstName?: string; lastName?: string };
    credentials?: { provider?: { type?: string } };
    _embedded?: { factors?: Array<{ status?: string }> };
}

function normalizeOktaUser(u: OktaUser): NormalizedIdentityAccount {
    const profile = u.profile ?? {};
    const name = profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || undefined;
    const providerType = u.credentials?.provider?.type;
    return {
        externalUserId: u.id,
        email: profile.email || profile.login || '',
        displayName: name,
        status: mapOktaStatus(u.status),
        // H2 — admin membership needs group/role enrichment that the users-list
        // endpoint does not carry. Report `null` (unknown) rather than a
        // hardcoded `false` that would make no_dormant_admins /
        // admin_count_within_threshold vacuously pass.
        isAdmin: null,
        // H2 — MFA factors are NOT returned by `/api/v1/users` (they need the
        // per-user `/factors` endpoint or an `expand`). Only report a value when
        // the payload actually includes factors; otherwise `null` (unknown) so
        // mfa_enforced is NOT_APPLICABLE instead of measuring an empty array.
        mfaEnrolled: u._embedded?.factors === undefined
            ? null
            : u._embedded.factors.some((f) => f.status === 'ACTIVE'),
        // Okta federated / social login accounts authenticate via SSO — a real
        // per-account signal from the credentials provider type.
        ssoEnrolled: providerType === 'FEDERATION' || providerType === 'SOCIAL',
        groups: [],
        lastActiveAt: u.lastLogin ? new Date(u.lastLogin) : null,
    };
}

export class OktaProvider implements ScheduledCheckProvider, IdentitySyncProvider {
    readonly id = 'okta';
    readonly displayName = 'Okta';
    readonly description =
        'Sync the Okta directory and verify MFA enrolment, dormant admins, admin count, and SSO federation.';
    readonly supportedChecks = [...IDENTITY_CHECKS];
    // P2 — validateConnection pings the Okta users API (real probe).
    readonly liveValidation = true;
    readonly setupGuide =
        'Create an API token in Okta (Security → API → Tokens) scoped to a read-only admin, and paste it below with your org URL (https://your-org.okta.com). Test connection performs a live directory ping. This connector runs directory/posture checks — it is separate from Okta SSO login.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'orgUrl', label: 'Okta org URL', type: 'string', required: true, placeholder: 'https://acme.okta.com' },
            { key: 'maxAdmins', label: 'Max active admins', type: 'number', required: false, description: 'Threshold for admin_count_within_threshold (default 5).' },
            { key: 'dormantDays', label: 'Dormant admin threshold (days)', type: 'number', required: false, description: 'Admin considered dormant after this many days idle (default 90).' },
            { key: 'enrichPerUser', label: 'Per-user MFA + admin enrichment', type: 'boolean', required: false, description: 'Fetch each user’s factors + roles so MFA / admin checks measure real signals. Disable on very large directories (default on).' },
        ],
        secretFields: [
            { key: 'apiToken', label: 'API token (SSWS)', type: 'string', required: true, description: 'A read-only Okta API token.' },
        ],
    };

    private readonly deps: OktaDeps;
    constructor(deps: OktaDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const orgUrl = String(config.orgUrl ?? '').replace(/\/$/, '');
        const apiToken = String(secrets.apiToken ?? '');
        if (!orgUrl) return { valid: false, error: 'Okta org URL is required.' };
        if (!apiToken) return { valid: false, error: 'An Okta API token is required.' };
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        try {
            const res = await doFetch(`${orgUrl}/api/v1/users?limit=1`, {
                headers: { Authorization: `SSWS ${apiToken}`, Accept: 'application/json' },
            });
            if (!res.ok) return { valid: false, error: `Okta directory ping failed (HTTP ${res.status}).` };
            return { valid: true };
        } catch (err) {
            return { valid: false, error: `Okta connection failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /** Enumerate the Okta directory into normalized accounts. */
    async listAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        // A test/dep injection returns a bare array — treat it as complete.
        if (this.deps.listAccounts) return { accounts: await this.deps.listAccounts(config), complete: true };
        return this.fetchOktaAccounts(config, resumeFrom);
    }

    private async fetchOktaAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult> {
        const orgUrl = String(config.orgUrl ?? '').replace(/\/$/, '');
        const apiToken = String((config as { apiToken?: string }).apiToken ?? '');
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        const out: NormalizedIdentityAccount[] = [];
        // Resume from the previous run's `next` link when we have one. Okta's
        // rel=next URL is absolute and self-contained, so it needs no
        // reconstruction — but it MUST be checked against the configured org,
        // or a tampered stored cursor would point our credentialed request at
        // an arbitrary host.
        let url: string | null =
            resumeFrom && resumeFrom.startsWith(`${orgUrl}/`)
                ? resumeFrom
                : `${orgUrl}/api/v1/users?limit=${PAGE_LIMIT}`;
        while (url && out.length < MAX_USERS) {
            const res: Response = await doFetch(url, {
                headers: { Authorization: `SSWS ${apiToken}`, Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`Okta users fetch failed (HTTP ${res.status})`);
            const users = (await res.json()) as OktaUser[];
            for (const u of users) out.push(normalizeOktaUser(u));
            // Okta paginates via RFC-5988 Link headers (rel="next").
            url = parseNextLink(res.headers.get('link'));
        }

        // GAP-4 — the users-list endpoint carries neither MFA factors nor admin
        // role membership, so `normalizeOktaUser` leaves both null. Enrich each
        // account from the per-user `/factors` + `/roles` endpoints so
        // `mfa_enforced` / `no_dormant_admins` / `admin_count_within_threshold`
        // measure real signals instead of vacuously passing. Opt-out via
        // `enrichPerUser: false` on a directory too large to fan out over.
        const enrichPerUser = String((config as { enrichPerUser?: unknown }).enrichPerUser ?? 'true').toLowerCase() !== 'false';
        if (enrichPerUser) {
            await this.enrichAccounts(orgUrl, apiToken, out, doFetch);
        }

        // H3 — if we stopped with a `next` link still present, we hit MAX_USERS
        // mid-directory: the enumeration is KNOWN-PARTIAL (do not deprovision).
        // H3-2 — carry that link out so the next run continues rather than
        // restarting at page one and stopping in the same place.
        return { accounts: out, complete: url === null, resumeToken: url };
    }

    /**
     * GAP-4 — enrich each account's `mfaEnrolled` (from `/factors`) and
     * `isAdmin` (from `/roles`), bounded-concurrency + capped at MAX_ENRICH.
     * A per-user fetch failure leaves that account's signal at its base value
     * (null) rather than failing the whole sync.
     */
    private async enrichAccounts(
        orgUrl: string,
        apiToken: string,
        accounts: NormalizedIdentityAccount[],
        doFetch: typeof fetch,
    ): Promise<void> {
        const toEnrich = accounts.slice(0, MAX_ENRICH);
        if (accounts.length > MAX_ENRICH) {
            logger.warn('Okta per-user enrichment capped; accounts past the cap keep null (NOT_APPLICABLE) signals', {
                component: 'integration-okta',
                total: accounts.length,
                enriched: MAX_ENRICH,
            });
        }
        const authHeaders = { Authorization: `SSWS ${apiToken}`, Accept: 'application/json' };
        const getJson = async (path: string): Promise<unknown> => {
            const res = await doFetch(`${orgUrl}${path}`, { headers: authHeaders });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        };
        await mapPool(toEnrich, ENRICH_CONCURRENCY, async (acct) => {
            try {
                const [factors, roles] = await Promise.all([
                    getJson(`/api/v1/users/${encodeURIComponent(acct.externalUserId)}/factors`),
                    getJson(`/api/v1/users/${encodeURIComponent(acct.externalUserId)}/roles`),
                ]);
                // Any factor in ACTIVE state means MFA is enrolled.
                if (Array.isArray(factors)) {
                    acct.mfaEnrolled = factors.some((f) => (f as { status?: string }).status === 'ACTIVE');
                }
                // Okta `/roles` returns ADMIN role grants (direct or group-derived).
                // A non-empty set means the account holds an administrator role.
                if (Array.isArray(roles)) {
                    acct.isAdmin = roles.length > 0;
                }
            } catch {
                // Leave base (null) signals — a single flaky user must not fail the sync.
            }
        });
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
                summary: 'Okta check failed to run.',
                details: {},
                durationMs: Date.now() - start,
                errorMessage: err instanceof Error ? err.message : String(err),
            };
        }
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return {
            title: `Okta — ${input.parsed.checkType}`,
            content: result.summary,
            type: 'REPORT',
            category: `okta:${input.parsed.checkType}`,
        };
    }
}

/** Parse the rel="next" URL out of an RFC-5988 Link header. */
export function parseNextLink(header: string | null): string | null {
    if (!header) return null;
    for (const part of header.split(',')) {
        const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (m) return m[1];
    }
    return null;
}
