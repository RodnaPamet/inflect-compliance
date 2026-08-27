/**
 * Shared identity-provider primitives (PR-2).
 *
 * Okta and Google Workspace both normalize their directory into the same
 * `NormalizedIdentityAccount` shape, then run the SAME per-account checks.
 * Keeping the normalized shape + check evaluation here means a third
 * directory provider (Entra ID, JumpCloud, …) is incremental: implement
 * `listAccounts` and reuse `runIdentityCheck`.
 */
import type { CheckResult } from '../../types';

/** A directory account normalized across providers. */
export interface NormalizedIdentityAccount {
    /** Stable id in the provider directory. */
    externalUserId: string;
    email: string;
    displayName?: string;
    /** ACTIVE | SUSPENDED | DEPROVISIONED. */
    status: 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';
    // H2 — `null` means the provider could NOT determine this signal from the
    // data it fetched (e.g. Okta admin membership needs group/role enrichment;
    // MFA factors aren't on the users-list endpoint). A check whose entire
    // active population is `null` for its signal returns NOT_APPLICABLE rather
    // than manufacturing a false PASS from a hardcoded value.
    isAdmin: boolean | null;
    mfaEnrolled: boolean | null;
    /** Whether the account authenticates via federated SSO. `null` = unknown. */
    ssoEnrolled: boolean | null;
    /**
     * Whether this account is mastered ON-PREMISES and projected into the
     * cloud directory by a sync agent (Azure AD Connect).
     *
     * `null` = the provider cannot determine it — the H2 three-state
     * convention used by `isAdmin` / `mfaEnrolled` / `ssoEnrolled` above, and
     * for the same reason: a hardcoded `false` would be a manufactured answer.
     *
     * THIS IS A WRITE-PATH SIGNAL, NOT A POSTURE ONE. Reading a hybrid
     * directory through Graph is completely correct. WRITING to it is not: for
     * a directory-synced account the source of authority is on-prem AD, and
     * Azure AD Connect syncs one way, so a `PATCH accountEnabled: false`
     * against Graph is either refused or silently reverted at the next cycle.
     *
     * An offboarding that does that reports success and then re-enables the
     * account by itself, which is worse than failing, because the audit trail
     * says the leaver was disabled.
     */
    onPremisesSyncEnabled: boolean | null;
    /**
     * Whether the provider ACTUALLY ASKED and got an answer for the field
     * above — as opposed to being unable to determine it.
     *
     * Without this the two meanings of `null` are the same value, and the
     * write-target rail has to refuse both. Graph returns null for a user that
     * is not synced from on-premises, which is every user in a cloud-only
     * tenant; Okta and Google Workspace return null because they genuinely
     * cannot answer. Only the first is safe to write against.
     *
     * Default false — absent means NOT observed, so a provider that says
     * nothing keeps the conservative behaviour it had.
     */
    onPremStateObserved?: boolean;
    /** Group / role names. */
    groups: string[];
    lastActiveAt?: Date | null;
}

/**
 * A provider that can enumerate its directory for the `identity-sync` job.
 * Concrete providers implement this alongside `ScheduledCheckProvider`.
 */
/**
 * H3 — the result of enumerating a directory. `complete` is false when the
 * enumeration hit the `MAX_USERS` cap with MORE pages still available (Okta
 * `link` rel=next / Google `nextPageToken` still set) — i.e. a KNOWN-PARTIAL
 * enumeration. A partial enumeration must NEVER drive the deprovision reconcile
 * (accounts past the cap would be wrongly marked DEPROVISIONED).
 */
export interface ListAccountsResult {
    accounts: NormalizedIdentityAccount[];
    complete: boolean;
    /**
     * Where to pick up when `complete` is false — an opaque, provider-specific
     * continuation (Okta's `link` rel=next URL, Google's `nextPageToken`,
     * Entra's `@odata.nextLink`).
     *
     * Every one of those was already computed at the truncation point and then
     * thrown away, which is why a directory over the cap could never finish: the
     * next run started from page one and stopped at exactly the same place.
     *
     * `null` means the provider cannot resume. Active Directory is the real
     * case — ldapjs paged search uses a server-side cookie tied to the live LDAP
     * connection, so it cannot survive a process boundary. Those directories
     * keep the old behaviour: partial, no reconcile, and loud.
     */
    resumeToken?: string | null;
}

export interface IdentitySyncProvider {
    /**
     * Enumerate the connected directory.
     *
     * `resumeFrom` is a `resumeToken` from a previous partial result. Providers
     * that cannot resume must ignore it and start from the beginning — which is
     * exactly today's behaviour, so ignoring it is safe rather than silently
     * wrong.
     */
    listAccounts(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
    ): Promise<ListAccountsResult>;
}

export function isIdentitySyncProvider(p: unknown): p is IdentitySyncProvider {
    return (
        typeof p === 'object' &&
        p !== null &&
        typeof (p as IdentitySyncProvider).listAccounts === 'function'
    );
}

/** Checks every identity provider supports. */
export const IDENTITY_CHECKS = [
    'mfa_enforced',
    'no_dormant_admins',
    'admin_count_within_threshold',
    'sso_enforced',
] as const;
export type IdentityCheckType = (typeof IDENTITY_CHECKS)[number];

const DEFAULT_DORMANT_DAYS = 90;
const DEFAULT_MAX_ADMINS = 5;

function numConfig(config: Record<string, unknown>, key: string, fallback: number): number {
    const v = config[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return fallback;
}

interface AccountVerdict {
    externalUserId: string;
    email: string;
    passed: boolean;
    reason?: string;
}

/**
 * Evaluate one identity check against a normalized account set.
 *
 * Every check produces per-account verdicts in `details.accounts`, plus
 * `details.passed` / `details.failed` counts. `status` is FAILED when any
 * account fails (or, for admin_count, when the count exceeds the
 * threshold). `now` is injected for deterministic tests.
 */
export function runIdentityCheck(
    checkType: string,
    accounts: NormalizedIdentityAccount[],
    config: Record<string, unknown>,
    now: Date,
): CheckResult {
    const active = accounts.filter((a) => a.status === 'ACTIVE');

    switch (checkType) {
        case 'mfa_enforced': {
            // H2 — only judge accounts whose MFA signal is KNOWN. If none are
            // known (provider doesn't expose it), summarize → NOT_APPLICABLE.
            const known = active.filter((a) => a.mfaEnrolled !== null);
            const verdicts: AccountVerdict[] = known.map((a) => ({
                externalUserId: a.externalUserId,
                email: a.email,
                passed: a.mfaEnrolled === true,
                reason: a.mfaEnrolled ? undefined : 'MFA not enrolled',
            }));
            return summarize('mfa_enforced', verdicts);
        }
        case 'sso_enforced': {
            const known = active.filter((a) => a.ssoEnrolled !== null);
            const verdicts: AccountVerdict[] = known.map((a) => ({
                externalUserId: a.externalUserId,
                email: a.email,
                passed: a.ssoEnrolled === true,
                reason: a.ssoEnrolled ? undefined : 'Not federated via SSO',
            }));
            return summarize('sso_enforced', verdicts);
        }
        case 'no_dormant_admins': {
            // H2 — if admin membership is unknown for the whole population, we
            // cannot identify admins: NOT_APPLICABLE, not a vacuous pass.
            if (active.every((a) => a.isAdmin === null)) {
                return { status: 'NOT_APPLICABLE', summary: 'Admin membership signal unavailable for this provider', details: { check: 'no_dormant_admins' } };
            }
            const dormantDays = numConfig(config, 'dormantDays', DEFAULT_DORMANT_DAYS);
            const cutoff = new Date(now.getTime() - dormantDays * 24 * 60 * 60 * 1000);
            const admins = active.filter((a) => a.isAdmin === true);
            const verdicts: AccountVerdict[] = admins.map((a) => {
                const dormant = !a.lastActiveAt || a.lastActiveAt < cutoff;
                return {
                    externalUserId: a.externalUserId,
                    email: a.email,
                    passed: !dormant,
                    reason: dormant ? `Admin dormant > ${dormantDays}d` : undefined,
                };
            });
            return summarize('no_dormant_admins', verdicts);
        }
        case 'admin_count_within_threshold': {
            if (active.every((a) => a.isAdmin === null)) {
                return { status: 'NOT_APPLICABLE', summary: 'Admin membership signal unavailable for this provider', details: { check: 'admin_count_within_threshold' } };
            }
            const maxAdmins = numConfig(config, 'maxAdmins', DEFAULT_MAX_ADMINS);
            const admins = active.filter((a) => a.isAdmin === true);
            const passed = admins.length <= maxAdmins;
            return {
                status: passed ? 'PASSED' : 'FAILED',
                summary: `${admins.length} active admin(s); threshold ${maxAdmins}`,
                details: {
                    adminCount: admins.length,
                    threshold: maxAdmins,
                    passed: passed ? 1 : 0,
                    failed: passed ? 0 : 1,
                    admins: admins.map((a) => ({ externalUserId: a.externalUserId, email: a.email })),
                },
            };
        }
        default:
            return {
                status: 'ERROR',
                summary: `Unknown identity check: ${checkType}`,
                details: {},
                errorMessage: `Unsupported check ${checkType}`,
            };
    }
}

function summarize(checkType: string, verdicts: AccountVerdict[]): CheckResult {
    const failed = verdicts.filter((v) => !v.passed);
    // H2 — an empty account population is NOT_APPLICABLE, never a pass: a
    // directory that returned zero accounts (or a not-yet-synced connection)
    // has earned no compliance signal.
    const status: CheckResult['status'] =
        verdicts.length === 0 ? 'NOT_APPLICABLE' : failed.length === 0 ? 'PASSED' : 'FAILED';
    return {
        status,
        summary:
            verdicts.length === 0
                ? `No accounts in scope for ${checkType}`
                : failed.length === 0
                ? `${verdicts.length} account(s) pass ${checkType}`
                : `${failed.length}/${verdicts.length} account(s) fail ${checkType}`,
        details: {
            check: checkType,
            passed: verdicts.length - failed.length,
            failed: failed.length,
            // Cap the per-account list to keep resultJson bounded.
            accounts: verdicts.slice(0, 500),
        },
    };
}
