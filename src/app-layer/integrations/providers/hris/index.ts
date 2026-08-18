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

/** A roster row normalized across HRIS vendors. */
export interface NormalizedEmployee {
    externalId: string;
    fullName: string;
    workEmail: string;
    /** EmploymentStatus. */
    status: 'ACTIVE' | 'ONBOARDING' | 'OFFBOARDING' | 'TERMINATED' | 'LEAVE';
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

export interface HrisSyncProvider {
    /**
     * @param resumeFrom cursor from a previous partial run of the same pass,
     *   or null/undefined to start a fresh pass. Providers that cannot resume
     *   ignore it and never return a `resumeToken`.
     */
    listEmployees(
        config: Record<string, unknown>,
        resumeFrom?: string | null,
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
 */
export const HRIS_PROVIDERS = ['bamboohr'] as const;

/** Membership test for the usecase guard; the job needs the array for `in`. */
export function isHrisProviderId(id: string): boolean {
    return (HRIS_PROVIDERS as readonly string[]).includes(id);
}

export function isHrisSyncProvider(p: unknown): p is HrisSyncProvider {
    return typeof p === 'object' && p !== null && typeof (p as HrisSyncProvider).listEmployees === 'function';
}

const MAX_EMPLOYEES = 10000;

interface BambooDeps {
    listEmployees?: (config: Record<string, unknown>) => Promise<NormalizedEmployee[]>;
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
 */
function mapBambooStatus(
    row: { status?: string; employmentStatus?: string; hireDate?: string | null; terminationDate?: string | null },
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    const s = (row.status || row.employmentStatus || '').toLowerCase();
    if (s.includes('terminat')) return 'TERMINATED';
    if (s.includes('leave')) return 'LEAVE';
    // Pending termination — still employed, termination scheduled in the future.
    if (row.terminationDate && new Date(row.terminationDate) > now) return 'OFFBOARDING';
    // Pre-hire — start date in the future, or an explicit pre-hire/onboarding status.
    if (row.hireDate && new Date(row.hireDate) > now) return 'ONBOARDING';
    if (s.includes('pre-hire') || s.includes('prehire') || s.includes('onboard')) return 'ONBOARDING';
    return 'ACTIVE';
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
        if (this.deps.listEmployees) return { employees: await this.deps.listEmployees(config), complete: true };
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
            body: JSON.stringify({ fields: ['workEmail', 'firstName', 'lastName', 'status', 'department', 'jobTitle', 'supervisorEmail', 'hireDate', 'terminationDate', 'employeeNumber'] }),
        });
        if (!res.ok) throw new Error(`BambooHR roster fetch failed (HTTP ${res.status})`);
        const body = (await res.json()) as { employees?: Array<Record<string, string>> };
        const rows = body.employees ?? [];
        // H3 — signal truncation instead of silently dropping rows past the cap.
        const complete = rows.length <= MAX_EMPLOYEES;
        const employees = rows.slice(0, MAX_EMPLOYEES).map((r) => ({
            externalId: r.employeeNumber || r.id || r.workEmail,
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
