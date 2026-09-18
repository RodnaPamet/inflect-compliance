/**
 * HRIS provider (PR-4) — BambooHR reference implementation.
 *
 * A directory-sync provider for the personnel roster. Registered for its
 * connection config + validate UI; the `hris-sync` job calls `listEmployees`.
 * It runs no scheduled checks itself (the personnel checks route to the
 * `personnel` provider), so `supportedChecks` is empty.
 *
 * `listEmployees` is injectable so the sync is unit-tested without a live
 * BambooHR account. Structure a Gusto / Rippling / Workday provider the same
 * way.
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../../types';
import { resilientFetch } from '../../http-resilience';
// Imported, not re-exported. A provider that needs the rule imports it from
// `providers/hris/employment-status` — one canonical path, so "which import of
// deriveEmploymentStatus is the real one" is never a question anybody has to ask.
import { deriveEmploymentStatus, type EmploymentStatusValue } from './employment-status';

/** A roster row normalized across HRIS vendors. */
export interface NormalizedEmployee {
    /**
     * Best-effort provenance id. NOT an address.
     *
     * BambooHR puts `employeeNumber` (a customer-entered payroll field) here,
     * or the work email when there is none; Workday puts `employeeId` /
     * `workerId` / the work email, drawn from a report template the customer
     * authors. Neither addresses an HRIS update API. `hrisRecordId` does.
     */
    externalId: string;
    /**
     * The HRIS's OWN row id, or null/absent when the provider cannot supply
     * one — which is the honest answer for most rows and for every Workday
     * row.
     *
     * OPTIONAL BECAUSE IT IS UNKNOWABLE, not because it is unimportant. A
     * provider that has no row id must leave this null rather than reach for
     * `externalId` or the work email: an HRIS update addressed by work email
     * would be addressed by the value the JML write-back exists to CREATE,
     * which is circular by construction
     * (docs/jml-hris-write-back-design.md, Decision 3).
     *
     * Nothing reads it yet. It is persisted now so that when a write-back
     * pass exists it has a subject — Phase 0 of that document's phasing, and
     * the one piece everything else is blocked on.
     */
    hrisRecordId?: string | null;
    fullName: string;
    workEmail: string;
    /** EmploymentStatus. */
    status: EmploymentStatusValue;
    department?: string | null;
    jobTitle?: string | null;
    /** Manager's work email — resolved to managerEmployeeId during sync. */
    managerEmail?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
}

/**
 * H3 — `complete` is false when the roster hit the `MAX_EMPLOYEES` cap with
 * more rows available. A truncated roster must NOT drive the departed-employee
 * reconcile (rows past the cap would be wrongly marked TERMINATED).
 */
export interface ListEmployeesResult {
    employees: NormalizedEmployee[];
    complete: boolean;
    /**
     * Opaque cursor to continue THIS pass on the next scheduled run.
     *
     * Set only alongside `complete: false`, and only by providers that can
     * genuinely resume across a process boundary. Its presence is what turns a
     * truncated roster from a permanent failure into progress — see the two
     * branches in usecases/hris-sync.
     *
     * Absent (or null) means "truncated and cannot resume", which stays a loud
     * non-retryable error: re-reading would truncate at the same place.
     */
    resumeToken?: string | null;
}

/**
 * Side channels the sync gives a provider, beyond reading the roster.
 *
 * Exists because of ROTATING CREDENTIALS, which a static-API-key provider does
 * not have and an OAuth2 one cannot live without. `listEmployees` receives a
 * plain config object and returns a roster, so a provider that refreshes an
 * access token mid-call has nowhere to put the new refresh token — and every
 * OAuth2 provider worth the name invalidates the predecessor on rotation.
 *
 * Without this the failure is on a delay and reads as somebody else's problem:
 * day 1 the stored access token is valid and the sync passes; day 2 it has
 * expired, the provider refreshes, gets a fresh pair, uses it for that run and
 * discards it; day 3 the stored refresh token is the one rotation already
 * invalidated, and the connection reports revoked credentials — two days after
 * the code that lost them ran, with a green execution in between.
 *
 * A CALLBACK rather than a `rotatedSecret` on the result, deliberately. A
 * returned value is only persisted if the call returns, and the interesting
 * case is precisely the one where the roster read throws AFTER the token
 * rotated: the old refresh token is already dead, so losing the new one costs
 * the connection. Persisting at the moment of rotation is the only ordering
 * that survives it. `providers/sharepoint/token.ts` takes the same `persist`
 * callback for the same reason.
 */
export interface HrisSyncDeps {
    /**
     * Merge `patch` into the connection's stored secret and persist it now.
     *
     * A PATCH, not a replacement: the provider is handed config and secrets
     * merged into one object and cannot tell which key came from where, so
     * asking it for the whole secret would write config fields into
     * `secretEncrypted`. The sync owns that split and does the merge.
     */
    persistSecret?: (patch: Record<string, unknown>) => Promise<void>;

    /**
     * Wall-clock instant (epoch ms) after which the provider must not START
     * another request for this run.
     *
     * WHY A READ HAS A DEADLINE AT ALL (#2508). The run holds a
     * per-connection lease (`SYNC_LOCK_TTL_MS`), and that lease is the only
     * thing making it the sole writer. A read that outlives the lease does not
     * get aborted: `acquireSyncLock` reaps the stale lease and a SECOND run
     * starts against the same connection. The two then share `syncCursor` and
     * `syncPassStartedAt`, and whichever completes its pass first clears both
     * and reconciles against its own `passStartedAt` — terminating employees
     * the other has not reached, which the other upserts back. That is the
     * flip-and-flip-back corruption `jobs/hris-sync.ts` documents.
     *
     * A PROVIDER THAT REACHES THIS MUST STOP AND RETURN `complete: false` WITH
     * A `resumeToken`. Returning `complete: false` and NO token lands in the
     * usecase's permanently-non-retryable arm, which would convert a throttled
     * provider into a connection that can never finish a pass — worse than the
     * overlap this is closing.
     *
     * CHECK IT BETWEEN REQUESTS, never mid-flight: abandoning a page already
     * in progress throws away the rows it carries and costs the run its
     * progress. The budget in `sync-transaction.ts` is sized for exactly that,
     * allowing one full request to complete after the instant passes.
     *
     * Optional, and safely ignored by a provider that issues a single request
     * (BambooHR): its worst case is one `MAX_HTTP_REQUEST_MS` and already fits
     * inside the budget.
     */
    readDeadlineAt?: number;
}

export interface HrisSyncProvider {
    /**
     * @param resumeFrom cursor from a previous partial run of the same pass,
     *   or null/undefined to start a fresh pass. Providers that cannot resume
     *   ignore it and never return a `resumeToken`.
     * @param deps side channels — see HrisSyncDeps. Optional so a provider
     *   with static credentials, and every existing test double, ignores it.
     */
    listEmployees(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
        deps?: HrisSyncDeps,
    ): Promise<ListEmployeesResult>;
}

/**
 * The provider ids the HRIS sync path will act on.
 *
 * ONE list, deliberately. It was two — `['bamboohr']` in jobs/hris-sync.ts and
 * `new Set(['bamboohr'])` in usecases/hris-sync.ts — sitting either side of a
 * job/usecase boundary and required to agree. Missing either half gives a
 * provider that registers but never syncs (absent from the job's dispatch
 * query) or one that syncs but is refused by the usecase guard. Both fail
 * silently: nothing errors, the provider simply does nothing.
 *
 * It lives here rather than in either consumer so neither owns it, and so
 * adding a provider is one edit in the same directory as the provider.
 *
 * `orangehrm` is in it DELIBERATELY, and the consequence is the point. When it
 * shipped as an internal fixture (#2548) leaving it out would have been the
 * tempting way to keep it out of everyone's way. It would also have taken it
 * outside `assertSoleEnabledHrisConnection`, whose refusal reads this same list
 * — buying a second enabled HRIS alongside a real one, and with it the nightly
 * roster flip-flop that ends in a directory disable. Membership here is what
 * made it safe to enable at all, and is why the rule still holds now that it is
 * a supported connector.
 */
export const HRIS_PROVIDERS = ['bamboohr', 'workday', 'orangehrm'] as const;

/** Membership test for the usecase guard; the job needs the array for `in`. */
export function isHrisProviderId(id: string): boolean {
    return (HRIS_PROVIDERS as readonly string[]).includes(id);
}

export function isHrisSyncProvider(p: unknown): p is HrisSyncProvider {
    return typeof p === 'object' && p !== null && typeof (p as HrisSyncProvider).listEmployees === 'function';
}

const MAX_EMPLOYEES = 10000;

interface BambooDeps {
    /**
     * Injected roster for tests. Returns EITHER a bare array (complete) or a
     * full `ListEmployeesResult`.
     *
     * The union matters because the real path VARIES what this seam pinned:
     * `fetchBambooRoster` sets `complete = rows.length <= MAX_EMPLOYEES`, so a
     * roster over the cap returns `complete: false`. While this seam hardcoded
     * `true`, that branch was inexpressible through it — and `complete` is the
     * flag that releases the departure reconcile, i.e. the one that decides
     * whether everyone unseen is marked TERMINATED.
     */
    listEmployees?: (config: Record<string, unknown>) => Promise<NormalizedEmployee[] | ListEmployeesResult>;
    fetchImpl?: typeof fetch;
}

/**
 * Map a BambooHR row to the normalized employment status.
 *
 * H2 — the old mapping only ever emitted ACTIVE/LEAVE/TERMINATED, so
 * `onboarding_complete_within_sla` (keys on ONBOARDING) was permanently
 * vacuous and a mid-offboarding employee (scheduled termination, still
 * employed) mapped to ACTIVE — hiding their lingering access from
 * `offboarded_access_removed`. Derive ONBOARDING (pre-hire / future start) and
 * OFFBOARDING (pending termination) from the hire/termination dates + status.
 *
 * The ORDERING is not this file's to decide: `deriveEmploymentStatus` owns the
 * rule that dates beat the status string, for every HRIS provider. This mapper
 * had the inversion Workday was fixed for in #2012 — it returned on `terminat`
 * before ever reading `terminationDate`, so an employee whose BambooHR status
 * read "Terminated — Notice" with a last day a month out came back TERMINATED
 * and the JML leaver pass would have disabled them mid-notice-period.
 *
 * All that remains here is choosing WHICH of BambooHR's two status fields
 * speaks, and what an absent opinion means. BambooHR has no third signal, so
 * ACTIVE is the honest default rather than a guess.
 */
function mapBambooStatus(
    row: { status?: string; employmentStatus?: string; hireDate?: string | null; terminationDate?: string | null },
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    return (
        deriveEmploymentStatus(
            {
                statusText: row.status || row.employmentStatus,
                hireDate: row.hireDate,
                terminationDate: row.terminationDate,
            },
            now,
        ) ?? 'ACTIVE'
    );
}

export class BambooHrProvider implements ScheduledCheckProvider, HrisSyncProvider {
    readonly id = 'bamboohr';
    readonly displayName = 'BambooHR';
    readonly description = 'Sync the employee roster from BambooHR into the personnel hub.';
    readonly supportedChecks: string[] = [];
    // P2 — validateConnection only checks field presence (no live BambooHR call).
    readonly liveValidation = false;
    readonly setupGuide =
        'Generate a BambooHR API key (your profile → API Keys) and provide it with your company subdomain (the part before .bamboohr.com). Test connection validates field shape only — it does not call BambooHR live.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'subdomain', label: 'BambooHR company subdomain', type: 'string', required: true, placeholder: 'acme' },
        ],
        secretFields: [
            { key: 'apiKey', label: 'API key', type: 'string', required: true, description: 'A read-only BambooHR API key.' },
        ],
    };

    private readonly deps: BambooDeps;
    constructor(deps: BambooDeps = {}) {
        this.deps = deps;
    }

    async validateConnection(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<ConnectionValidationResult> {
        if (!config.subdomain) return { valid: false, error: 'A BambooHR subdomain is required.' };
        if (!secrets.apiKey) return { valid: false, error: 'A BambooHR API key is required.' };
        return { valid: true };
    }

    async listEmployees(config: Record<string, unknown>): Promise<ListEmployeesResult> {
        if (this.deps.listEmployees) {
            const injected = await this.deps.listEmployees(config);
            return Array.isArray(injected) ? { employees: injected, complete: true } : injected;
        }
        return this.fetchBambooRoster(config);
    }

    private async fetchBambooRoster(config: Record<string, unknown>): Promise<ListEmployeesResult> {
        const subdomain = String(config.subdomain ?? '');
        const apiKey = String((config as { apiKey?: string }).apiKey ?? '');
        const doFetch = this.deps.fetchImpl ?? resilientFetch;
        // BambooHR: Basic auth with apiKey as username, any password.
        const auth = Buffer.from(`${apiKey}:x`).toString('base64');
        const url = `https://api.bamboohr.com/api/gateway.php/${subdomain}/v1/reports/custom?format=JSON`;
        const res = await doFetch(url, {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
            // `id` is BambooHR's own row id and the ONLY field here that can
            // address an update API. It is requested explicitly rather than
            // relied on arriving unasked — which is what the mapper below used
            // to do, in a fallback term that could therefore never be reached.
            body: JSON.stringify({ fields: ['id', 'workEmail', 'firstName', 'lastName', 'status', 'department', 'jobTitle', 'supervisorEmail', 'hireDate', 'terminationDate', 'employeeNumber'] }),
        });
        if (!res.ok) throw new Error(`BambooHR roster fetch failed (HTTP ${res.status})`);
        const body = (await res.json()) as { employees?: Array<Record<string, string>> };
        const rows = body.employees ?? [];
        // H3 — signal truncation instead of silently dropping rows past the cap.
        const complete = rows.length <= MAX_EMPLOYEES;
        const employees = rows.slice(0, MAX_EMPLOYEES).map((r) => ({
            // `r.id` USED TO SIT BETWEEN THESE TWO TERMS, and removing it is
            // load-bearing rather than tidy. Requesting `id` and LEAVING the
            // term in place would repoint `externalId` at the row id for every
            // row with no employeeNumber, on the next sync — rewriting a column
            // already on disk. Deleting it first is what makes requesting the
            // field a no-op for existing data; the row id goes to
            // `hrisRecordId`, which nothing has ever written.
            //
            // WHAT IS NOT KNOWN, and must not be written down as if it were:
            // whether BambooHR returns `id` for rows that did not request it.
            // docs/jml-hris-write-back-design.md Open Question 2 is explicit
            // that this is unresolved and says to check against a real tenant;
            // there is no BambooHR tenant to check (see issue #2548). So the
            // historical contents of `externalId` on employeeNumber-less rows
            // are UNKNOWN — they may be row ids. What makes that tolerable is
            // not the premise but the column's reach: nothing reads
            // `externalId`. listEmployees' projection omits it, getEmployee has
            // no production caller, no .tsx references it and no Employee query
            // filters on it. Were it read anywhere, this deletion would need a
            // backfill decision rather than a comment.
            externalId: r.employeeNumber || r.workEmail,
            // Null, never a fallback. See NormalizedEmployee.hrisRecordId.
            hrisRecordId: r.id || null,
            fullName: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.workEmail,
            workEmail: r.workEmail || '',
            status: mapBambooStatus(r),
            department: r.department || null,
            jobTitle: r.jobTitle || null,
            managerEmail: r.supervisorEmail || null,
            startDate: r.hireDate ? new Date(r.hireDate) : null,
            endDate: r.terminationDate ? new Date(r.terminationDate) : null,
        })).filter((e) => e.workEmail);
        return { employees, complete };
    }

    // HRIS runs no scheduled checks — personnel checks route to the personnel provider.
    async runCheck(): Promise<CheckResult> {
        return { status: 'ERROR', summary: 'BambooHR runs no scheduled checks.', details: {}, errorMessage: 'no checks' };
    }
    mapResultToEvidence(_input: CheckInput, _result: CheckResult): EvidencePayload | null {
        return null;
    }
}
