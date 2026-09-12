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
import { deriveEmploymentStatus } from '../hris/employment-status';
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

/**
 * Sequential HTTP requests one run's paging loop can make at the row cap.
 *
 * Derived rather than written down, because it is one of the four numbers the
 * lock lease has to compose against (#2508) and a hand-written 10 would go on
 * reporting the comfortable answer the first time either constant moved.
 *
 * `Math.ceil` is deliberate for the same reason: a page size that no longer
 * divides the cap must round UP, or the derived worst case understates the
 * work by a whole request.
 */
export const WORKDAY_MAX_PAGES_PER_RUN = Math.ceil(WORKDAY_MAX_PER_RUN / WORKDAY_PAGE_SIZE);

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
 * administrator can customise per tenant. That ordering is not spelled out
 * here: it lives in `deriveEmploymentStatus`, which every HRIS provider shares
 * so the rule cannot be re-derived — and re-inverted — one provider at a time.
 * It was fixed here first (#2012); BambooHR carried the same inversion.
 */
export function mapWorkdayStatus(
    row: WorkdayRosterRow,
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    const derived = deriveEmploymentStatus(
        { statusText: row.workerStatus, hireDate: row.hireDate, terminationDate: row.terminationDate },
        now,
    );
    if (derived) return derived;

    // Workday's own last resort, which the shared rule cannot know about:
    // `activeStatus: false` with no dates and no recognised status token is a
    // worker Workday considers inactive for a reason the report did not carry.
    // TERMINATED is the honest read — calling them ACTIVE would hide lingering
    // access.
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
 * Returns `complete: false` + a `resumeToken` when it stopped short with more
 * rows available — the shape the HRIS usecase treats as progress rather than
 * failure. Returns `complete: true` when it reached the end, which is the only
 * state that permits the departure reconcile to run.
 *
 * TWO THINGS CAN STOP IT SHORT, and both take the same exit. The per-run ROW
 * cap (`WORKDAY_MAX_PER_RUN`) bounds how much one pass-leg writes; the
 * `readDeadlineAt` WALL-CLOCK budget bounds how long it may spend reading,
 * which is what keeps the read inside the connection's lock lease (#2508 —
 * see `HrisSyncDeps.readDeadlineAt` for what happens when it does not). They
 * are independent: a throttled provider hits the clock long before the rows.
 */
export async function readWorkdayRoster(
    cfg: WorkdayRosterConfig,
    accessToken: string,
    resumeFrom?: string | null,
    deps: {
        fetchImpl?: typeof fetch;
        /**
         * The clock the read deadline is measured on. Injectable so the
         * deadline is testable without a real ten-minute wait.
         *
         * It is NOT threaded into `mapWorkdayStatus`, which takes its own
         * `now` per row and defaults to the real clock. Status derivation
         * decides ONBOARDING / OFFBOARDING from hire and termination dates,
         * and moving that onto a test-controlled clock is a behaviour change
         * in the most consequential part of this file — out of scope here.
         */
        now?: () => Date;
        /**
         * Epoch ms after which no further PAGE is started. See
         * `HrisSyncDeps.readDeadlineAt`. Absent (or null) means unbounded,
         * which is what every direct-call test and every non-sync caller gets.
         */
        readDeadlineAt?: number | null;
    } = {},
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

    const clock = deps.now ?? (() => new Date());
    const deadlineAt = deps.readDeadlineAt ?? null;
    /**
     * Evaluated BEFORE each page, so a page already in flight always runs to
     * its own timeout. The read-phase budget is sized for that overshoot.
     */
    const readBudgetSpent = (): boolean => deadlineAt !== null && clock().getTime() >= deadlineAt;

    while (employees.length < WORKDAY_MAX_PER_RUN && sawFullPage && !readBudgetSpent()) {
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

    // A short page means the report ended, and THAT VERDICT OUTRANKS THE
    // DEADLINE. Checking the clock first would report a finished roster as
    // partial, store a cursor past the end of the report, and leave the next
    // run reading an empty page to discover what this one already knew — with
    // the departure reconcile deferred a whole scheduled run for nothing.
    if (!sawFullPage) return { employees, complete: true, resumeToken: null };
    // Stopped with the report still going: either the per-run row cap, or the
    // read deadline. Both are progress, and both resume from the same offset —
    // the usecase does not need to tell them apart, because the response to
    // each is identical (store the cursor, continue next run).
    return { employees, complete: false, resumeToken: String(offset) };
}
