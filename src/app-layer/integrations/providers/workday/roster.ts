/**
 * Workday roster read — RaaS, paginated, resumable.
 *
 * Workday exposes employee rosters through Report-as-a-Service: a report an
 * administrator publishes in their own tenant, fetched as JSON over the
 * customer's own host. There is no fixed `/employees` endpoint, so the report
 * PATH is per-connection config, and the field names below are the ones the
 * documented Inflect report template produces.
 *
 * Pagination is Workday's own `Offset`/`Limit` pair rather than an opaque
 * cursor, so the resume token here is just the next offset as a string. Kept
 * opaque at the boundary anyway (`resumeToken`, not `nextOffset`) so a future
 * provider can hand back something structurally different without changing
 * the interface every HRIS provider implements.
 *
 * @module integrations/providers/workday/roster
 */
import { resilientFetch } from '../../http-resilience';
import type { NormalizedEmployee, ListEmployeesResult } from '../hris';
import { assertWorkdayHost } from './host';

/**
 * Rows per RaaS request.
 *
 * Deliberately well below the 10,000 MAX_EMPLOYEES ceiling in the HRIS
 * usecase: a page is what one HTTP round trip carries, the cap is what one
 * SYNC RUN carries, and conflating them is what made the old HRIS path treat
 * "too big" as terminal. A large tenant now walks the roster across several
 * runs, one page at a time.
 */
export const WORKDAY_PAGE_SIZE = 500;

/** Rows a single run will accumulate before handing back a resume token. */
export const WORKDAY_MAX_PER_RUN = 5_000;

/** A row as the documented Inflect RaaS report template emits it. */
interface WorkdayRosterRow {
    employeeId?: string;
    workerId?: string;
    legalName?: string;
    preferredName?: string;
    primaryWorkEmail?: string;
    workerStatus?: string;
    activeStatus?: string | boolean;
    businessTitle?: string;
    organization?: string;
    managerEmail?: string;
    hireDate?: string;
    terminationDate?: string;
}

/**
 * Map a Workday worker to the normalised employment status.
 *
 * The ONBOARDING / OFFBOARDING derivation is not cosmetic — it is the H2
 * lesson from BambooHR restated. Workday reports a scheduled-to-leave worker
 * as active right up to their termination date, and a signed-but-not-started
 * hire as inactive. Collapsing both into ACTIVE/TERMINATED makes
 * `offboarded_access_removed` vacuous for exactly the population it exists to
 * catch: the person who still has access during their notice period.
 *
 * Dates win over the status string, because the status string is the one an
 * administrator can customise per tenant.
 */
export function mapWorkdayStatus(
    row: WorkdayRosterRow,
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    const raw = String(row.workerStatus ?? '').toLowerCase();
    if (raw.includes('terminat')) return 'TERMINATED';
    if (raw.includes('leave')) return 'LEAVE';

    // Pending termination — still employed, last day in the future.
    if (row.terminationDate) {
        const end = new Date(row.terminationDate);
        if (!Number.isNaN(end.getTime())) {
            if (end > now) return 'OFFBOARDING';
            return 'TERMINATED';
        }
    }
    // Pre-hire — start date in the future.
    if (row.hireDate) {
        const start = new Date(row.hireDate);
        if (!Number.isNaN(start.getTime()) && start > now) return 'ONBOARDING';
    }
    if (raw.includes('pre-hire') || raw.includes('prehire') || raw.includes('onboard')) return 'ONBOARDING';

    // `activeStatus: false` with no dates is a worker Workday considers
    // inactive for a reason the report did not carry. TERMINATED is the honest
    // read — calling them ACTIVE would hide lingering access.
    if (row.activeStatus === false || String(row.activeStatus).toLowerCase() === 'false') {
        return 'TERMINATED';
    }
    return 'ACTIVE';
}

function normalise(row: WorkdayRosterRow): NormalizedEmployee | null {
    const workEmail = (row.primaryWorkEmail ?? '').trim();
    // A row with no work email cannot be reconciled against anything — the
    // whole personnel graph is keyed on it. Dropping it is better than
    // inventing a key that will never match.
    if (!workEmail) return null;
    const externalId = row.employeeId || row.workerId || workEmail;
    return {
        externalId,
        fullName: (row.preferredName || row.legalName || workEmail).trim(),
        workEmail,
        status: mapWorkdayStatus(row),
        department: row.organization?.trim() || null,
        jobTitle: row.businessTitle?.trim() || null,
        managerEmail: row.managerEmail?.trim() || null,
        startDate: row.hireDate ? new Date(row.hireDate) : null,
        endDate: row.terminationDate ? new Date(row.terminationDate) : null,
    };
}

export interface WorkdayRosterConfig {
    /** e.g. `wd2-impl-services1.workday.com`. */
    host: string;
    tenant: string;
    /** RaaS report path, e.g. `/ccx/service/customreport2/acme/ISU/Roster`. */
    reportPath: string;
}

/**
 * Read one run's worth of the roster, resuming from `resumeFrom` if given.
 *
 * Returns `complete: false` + a `resumeToken` when it stopped at the per-run
 * cap with more rows available — the shape the HRIS usecase treats as progress
 * rather than failure. Returns `complete: true` when it reached the end, which
 * is the only state that permits the departure reconcile to run.
 */
export async function readWorkdayRoster(
    cfg: WorkdayRosterConfig,
    accessToken: string,
    resumeFrom?: string | null,
    deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<ListEmployeesResult> {
    const doFetch = deps.fetchImpl ?? resilientFetch;
    // assertWorkdayHost, not a string trim. This request sends a LIVE BEARER
    // TOKEN, so an attacker-controlled host is a token handover — worse than
    // the token endpoint, which only leaks the client credentials.
    const host = assertWorkdayHost(cfg.host);
    if (!cfg.reportPath) throw new Error('A Workday RaaS report path is required');

    const startOffset = Number.parseInt(resumeFrom ?? '0', 10);
    // A malformed cursor must not silently restart the pass from zero: that
    // would re-upsert everything and, worse, make a pass that never completes
    // look like one that keeps making progress.
    if (Number.isNaN(startOffset) || startOffset < 0) {
        throw new Error(`Invalid Workday resume cursor: ${resumeFrom}`);
    }

    const employees: NormalizedEmployee[] = [];
    let offset = startOffset;
    let sawFullPage = true;

    while (employees.length < WORKDAY_MAX_PER_RUN && sawFullPage) {
        const url = new URL(`https://${host}${cfg.reportPath.startsWith('/') ? '' : '/'}${cfg.reportPath}`);
        url.searchParams.set('format', 'json');
        url.searchParams.set('Offset', String(offset));
        url.searchParams.set('Limit', String(WORKDAY_PAGE_SIZE));

        const res = await doFetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Workday roster fetch failed (HTTP ${res.status})`);

        const body = (await res.json()) as { Report_Entry?: WorkdayRosterRow[] };
        const rows = body.Report_Entry ?? [];
        for (const row of rows) {
            const e = normalise(row);
            if (e) employees.push(e);
        }
        offset += rows.length;
        // A short page means the report is exhausted. Comparing against the
        // requested Limit rather than counting normalised rows matters: rows
        // dropped for a missing work email would otherwise look like the end
        // of the report and truncate the pass silently.
        sawFullPage = rows.length === WORKDAY_PAGE_SIZE;
    }

    if (!sawFullPage) return { employees, complete: true, resumeToken: null };
    // Stopped at the per-run cap with the report still going.
    return { employees, complete: false, resumeToken: String(offset) };
}
