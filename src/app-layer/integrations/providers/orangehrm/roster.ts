/**
 * OrangeHRM roster read — paginated, resumable, and loud about a mapping it
 * cannot verify.
 *
 * ═══ THE FIELD NAMES BELOW ARE UNVERIFIED, AND THAT IS THE WHOLE POINT ═══
 *
 * `OrangeHrmEmployeeRow` is written from OrangeHRM 5.x's published REST API v2
 * PIM employee payload. NOBODY HAS RUN THIS AGAINST A LIVE INSTANCE. Issue
 * #2548 exists precisely because this repo has no HR system it can write to and
 * read back, so every HRIS field mapping in it — BambooHR's included — is an
 * assertion rather than an observation. Writing another unverified mapping and
 * then quietly trusting it would reproduce the defect the issue is about.
 *
 * Two things follow from saying so out loud rather than hoping.
 *
 * FIRST, the shape is tolerant where the uncertainty is real. The work email is
 * the one field the whole personnel graph is keyed on, and it is also the one
 * field the v2 list endpoint may not carry at all: OrangeHRM exposes contact
 * details under `/pim/employees/{empNumber}/contact-details`, and whether
 * `workEmail` also rides along on the list response — with `model=detailed`, or
 * at all — is exactly the class of question Open Question 2 in
 * `docs/jml-hris-write-back-design.md` asks about BambooHR's `id`. So
 * `normalise` reads it from either place and neither is assumed.
 *
 * SECOND, and this is the part that matters: GUESSING THE FIELD NAME WRONG
 * FAILS LOUDLY. See `readOrangeHrmRoster`'s closing refusal.
 *
 * ═══ `empNumber` IS THE ADDRESS; `employeeId` IS THE PROVENANCE ═══
 *
 * OrangeHRM carries two identifiers and they are not interchangeable, so they
 * go to the two different fields `NormalizedEmployee` now has for them.
 *
 *   `empNumber`   the internal primary key — what
 *                 `/api/v2/pim/employees/{empNumber}` takes, so it is the
 *                 handle an update is addressed BY.      → `hrisRecordId`
 *   `employeeId`  the badge number an HR administrator types. Editable,
 *                 routinely blank, the exact analogue of BambooHR's
 *                 `employeeNumber`.                      → `externalId`
 *
 * THIS IS THE FIRST PROVIDER WHERE `hrisRecordId` IS KNOWN BY CONSTRUCTION,
 * and that is the point of the whole module. BambooHR sets it from `r.id`,
 * whose presence on rows that did not request the field is Open Question 2 —
 * unresolved, and unresolvable without a tenant to check. Workday has no row
 * id at all and correctly leaves it null. OrangeHRM publishes `empNumber` as a
 * first-class field of the list payload, so a write-back pass rehearsed here
 * has a subject that is not a guess.
 *
 * `hrisRecordId` is null when `empNumber` is absent — NEVER a fallback to the
 * badge number or the work email. An update addressed by work email would be
 * addressed by the value the JML write-back exists to CREATE, which is
 * circular by construction (`docs/jml-hris-write-back-design.md`, Decision 3).
 *
 * @module integrations/providers/orangehrm/roster
 */
import { logger } from '@/lib/observability/logger';
import { resilientFetch } from '../../http-resilience';
import type { NormalizedEmployee, ListEmployeesResult } from '../hris';
import { deriveEmploymentStatus } from '../hris/employment-status';
import { assertOrangeHrmHost } from './host';
import { ORANGEHRM_WEB_ROOT } from './token';

/**
 * Rows per request.
 *
 * OrangeHRM's v2 list endpoints cap `limit` at 50, so this is the vendor's
 * number rather than a choice. Kept well below the 10,000 `MAX_EMPLOYEES`
 * ceiling in the HRIS usecase for the reason `providers/workday/roster.ts`
 * spells out: a page is what one HTTP round trip carries, the cap is what one
 * SYNC RUN carries, and conflating them is what made the old HRIS path treat
 * "too big" as terminal.
 */
export const ORANGEHRM_PAGE_SIZE = 50;

/** Rows a single run will accumulate before handing back a resume token. */
export const ORANGEHRM_MAX_PER_RUN = 5_000;

/**
 * Sequential requests one run's paging loop makes to reach the row cap WHEN
 * EVERY ROW NORMALISES.
 *
 * Derived rather than written down, and `Math.ceil` rather than a division,
 * for the reasons `WORKDAY_MAX_PAGES_PER_RUN` gives: it is one of the numbers
 * the lock lease has to compose against (#2508), and a hand-written figure goes
 * on reporting the comfortable answer after either constant moves.
 *
 * IT IS A FLOOR. The loop's row test counts NORMALISED employees, so a roster
 * carrying email-less rows pages PAST this. The read deadline, not this number,
 * is what actually bounds wall-clock time — a row-count cap cannot, because it
 * does not bound REQUESTS.
 *
 * Note this is 100 where Workday's is 10, purely because OrangeHRM's page cap
 * is 50 against Workday's 500. A hundred sequential round trips is a lot of
 * wall clock for one lease, which is the concrete reason `readDeadlineAt` is
 * honoured here rather than treated as optional the way BambooHR's single
 * request can treat it.
 */
export const ORANGEHRM_MAX_PAGES_PER_RUN = Math.ceil(ORANGEHRM_MAX_PER_RUN / ORANGEHRM_PAGE_SIZE);

/**
 * A row as OrangeHRM 5.x's v2 PIM employee list is documented to emit it.
 *
 * Every field optional, deliberately: see the module docblock. A required
 * field here would be a claim about a payload nobody has seen.
 */
export interface OrangeHrmEmployeeRow {
    /** Internal primary key — what the update API takes. See the module note. */
    empNumber?: number | string | null;
    /** Administrator-typed badge number. Editable, routinely blank. */
    employeeId?: string | null;
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    /** Present on some deployments' list payload; absent on others. */
    workEmail?: string | null;
    /** The other place it may live — see the module note. */
    contactDetails?: { workEmail?: string | null } | null;
    jobTitle?: { title?: string | null } | null;
    subunit?: { name?: string | null } | null;
    empStatus?: { name?: string | null } | null;
    supervisors?: Array<{ workEmail?: string | null } | null> | null;
    joinedDate?: string | null;
    /**
     * OrangeHRM records a termination as a nested record rather than a bare
     * date. `null` is an employee who has not been terminated.
     */
    employeeTerminationRecord?: { date?: string | null } | null;
}

/** The work email, from either place OrangeHRM might carry it. */
function workEmailOf(row: OrangeHrmEmployeeRow): string {
    return (row.workEmail ?? row.contactDetails?.workEmail ?? '').trim();
}

/**
 * Map an OrangeHRM employee to the normalised employment status.
 *
 * The ONBOARDING / OFFBOARDING derivation is not cosmetic — collapsing both
 * into ACTIVE/TERMINATED makes `offboarded_access_removed` vacuous for exactly
 * the population it exists to catch, the person still holding access through
 * their notice period.
 *
 * The ordering — dates beat the status string — is NOT decided here. It lives
 * in `deriveEmploymentStatus`, which every HRIS provider shares so the rule
 * cannot be re-derived, and re-inverted, one provider at a time. Workday had
 * that inversion (#2012) and BambooHR carried it independently; this is the
 * third provider and the reason the rule has an owner.
 */
export function mapOrangeHrmStatus(
    row: OrangeHrmEmployeeRow,
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    const termination = row.employeeTerminationRecord ?? null;
    const derived = deriveEmploymentStatus(
        {
            statusText: row.empStatus?.name,
            hireDate: row.joinedDate,
            terminationDate: termination?.date,
        },
        now,
    );
    if (derived) return derived;

    // OrangeHRM's own last resort, which the shared rule cannot know about: a
    // termination RECORD exists but carries no usable date. The employee has
    // been terminated in the HR system and the date is the part that is
    // missing, so TERMINATED is the honest read — calling them ACTIVE would
    // hide lingering access, which is the harm this whole mapping exists to
    // surface.
    if (termination) return 'TERMINATED';
    return 'ACTIVE';
}

function normalise(row: OrangeHrmEmployeeRow): NormalizedEmployee | null {
    const workEmail = workEmailOf(row);
    // A row with no work email cannot be reconciled against anything — the
    // whole personnel graph is keyed on it. Dropping it beats inventing a key
    // that will never match.
    if (!workEmail) return null;

    const empNumber = row.empNumber == null ? '' : String(row.empNumber).trim();
    const fullName = [row.firstName, row.middleName, row.lastName]
        .map((p) => (p ?? '').trim())
        .filter(Boolean)
        .join(' ');

    return {
        // The badge number, mirroring BambooHR's `employeeNumber || workEmail`.
        // NOT `empNumber`: `externalId` is provenance, not an address, and the
        // address has a field of its own on the line below.
        externalId: (row.employeeId ?? '').trim() || workEmail,
        // Null, never a fallback. See NormalizedEmployee.hrisRecordId and the
        // module docblock — this is the one field OrangeHRM exists to supply
        // honestly.
        hrisRecordId: empNumber || null,
        fullName: fullName || workEmail,
        workEmail,
        status: mapOrangeHrmStatus(row),
        department: row.subunit?.name?.trim() || null,
        jobTitle: row.jobTitle?.title?.trim() || null,
        // OrangeHRM returns supervisors as a LIST — an employee may have
        // several. The personnel graph holds one manager, so the first is
        // taken and the rest are dropped; picking arbitrarily among several
        // would be worse than picking the first consistently.
        managerEmail: (row.supervisors ?? []).map((s) => (s?.workEmail ?? '').trim()).find(Boolean) ?? null,
        startDate: row.joinedDate ? new Date(row.joinedDate) : null,
        endDate: row.employeeTerminationRecord?.date ? new Date(row.employeeTerminationRecord.date) : null,
    };
}

export interface OrangeHrmRosterConfig {
    /** Instance host — bare hostname or full URL; validated against the allowlist. */
    host: string;
}

/**
 * Read one run's worth of the roster, resuming from `resumeFrom` if given.
 *
 * Returns `complete: false` + a `resumeToken` when it stopped short with rows
 * still available — the shape the HRIS usecase treats as progress rather than
 * failure. `complete: true` is the only state that permits the departure
 * reconcile to run, so it is a claim about having seen the WHOLE roster and
 * nothing here may round up to it.
 *
 * TWO THINGS STOP IT SHORT and both take the same exit: the per-run ROW cap,
 * and the `readDeadlineAt` wall-clock budget that keeps the read inside the
 * connection's lock lease (#2508). They are independent — a throttled instance
 * hits the clock long before the rows — and the usecase does not need to tell
 * them apart, because the response to each is identical.
 */
export async function readOrangeHrmRoster(
    cfg: OrangeHrmRosterConfig,
    accessToken: string,
    resumeFrom?: string | null,
    deps: {
        fetchImpl?: typeof fetch;
        /** Injectable so the deadline is testable without a real wait. */
        now?: () => Date;
        /**
         * Epoch ms after which no further PAGE is started. See
         * `HrisSyncDeps.readDeadlineAt`. Absent means unbounded, which is what
         * every direct-call test gets.
         */
        readDeadlineAt?: number | null;
    } = {},
): Promise<ListEmployeesResult> {
    const doFetch = deps.fetchImpl ?? resilientFetch;
    // assertOrangeHrmHost, not a string trim. This request sends a LIVE BEARER
    // TOKEN, so an attacker-controlled host is a token handover.
    const host = assertOrangeHrmHost(cfg.host);

    const startOffset = Number.parseInt(resumeFrom ?? '0', 10);
    // A malformed cursor must not silently restart the pass from zero: that
    // would re-upsert everything and, worse, make a pass that never completes
    // look like one that keeps making progress.
    if (Number.isNaN(startOffset) || startOffset < 0) {
        throw new Error(`Invalid OrangeHRM resume cursor: ${resumeFrom}`);
    }

    const employees: NormalizedEmployee[] = [];
    let offset = startOffset;
    let sawFullPage = true;
    /** Rows the API returned this run, before normalisation dropped any. */
    let rowsSeen = 0;

    const clock = deps.now ?? (() => new Date());
    const deadlineAt = deps.readDeadlineAt ?? null;
    /**
     * Evaluated BEFORE each page, never mid-flight: abandoning a page already
     * in progress throws away the rows it carries and costs the run its
     * progress. The budget in `sync-transaction.ts` is sized for exactly that
     * overshoot.
     */
    const readBudgetSpent = (): boolean => deadlineAt !== null && clock().getTime() >= deadlineAt;

    while (employees.length < ORANGEHRM_MAX_PER_RUN && sawFullPage && !readBudgetSpent()) {
        const url = new URL(`https://${host}${ORANGEHRM_WEB_ROOT}/api/v2/pim/employees`);
        url.searchParams.set('limit', String(ORANGEHRM_PAGE_SIZE));
        url.searchParams.set('offset', String(offset));
        // `model=detailed` is what MAY carry the contact details; requesting it
        // costs nothing if the deployment ignores it, and not requesting it
        // guarantees the work email is absent.
        url.searchParams.set('model', 'detailed');
        // Past employees are wanted, not filtered out: a terminated employee
        // absent from the roster is indistinguishable from a deleted one, and
        // the departure reconcile treats absence as deletion.
        url.searchParams.set('includeEmployees', 'currentAndPast');
        // A stable order, so a cursor means the same thing across requests.
        url.searchParams.set('sortField', 'employee.empNumber');
        url.searchParams.set('sortOrder', 'ASC');

        const res = await doFetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`OrangeHRM roster fetch failed (HTTP ${res.status})`);

        const body = (await res.json()) as { data?: OrangeHrmEmployeeRow[] };
        const rows = body.data ?? [];
        rowsSeen += rows.length;
        for (const row of rows) {
            const e = normalise(row);
            if (e) employees.push(e);
        }
        offset += rows.length;
        // A short page means the roster is exhausted. Comparing against the
        // requested limit rather than counting NORMALISED rows matters: rows
        // dropped for a missing work email would otherwise look like the end of
        // the roster and truncate the pass silently.
        sawFullPage = rows.length === ORANGEHRM_PAGE_SIZE;
    }

    /**
     * ═══ THE REFUSAL THAT MAKES THE UNVERIFIED MAPPING SAFE ═══
     *
     * The API answered with rows and not one of them produced an employee. On
     * a mapping nobody has checked against a live instance, the overwhelmingly
     * likely cause is that `workEmail` is not where this module guessed it is —
     * and the consequence of shrugging that off is not a quiet no-op.
     *
     * An empty roster reported `complete: true` is a claim that the whole
     * roster was seen. The usecase acts on it: on any run after the first of a
     * pass, `passSawRows` is already true via `syncPassStartedAt`, so the
     * departure reconcile RUNS and marks every employee it has not touched this
     * pass TERMINATED. TERMINATED is what makes someone a candidate for a real
     * directory disable on the 05:00 leaver pass.
     *
     * So the failure mode of a wrong field name is mass wrongful termination,
     * arriving a run later than the mistake and looking like an HR data problem
     * rather than a mapping one. Throwing costs a loud ERROR on the execution
     * row, names the cause, and keeps the cursor for the next attempt.
     *
     * Scoped to "the whole RUN normalised nothing", not "this page did": a real
     * roster can legitimately contain a page of contractors with no work email.
     */
    if (rowsSeen > 0 && employees.length === 0) {
        throw new Error(
            `OrangeHRM returned ${rowsSeen} employee row(s) and none carried a work email. ` +
                'Refusing to report a complete-but-empty roster: the departure reconcile reads that as ' +
                'everyone having left. Check whether this instance exposes workEmail on the PIM list ' +
                'response (see providers/orangehrm/roster.ts).',
        );
    }
    if (rowsSeen > employees.length) {
        logger.warn('orangehrm roster dropped rows with no work email', {
            component: 'orangehrm',
            rowsSeen,
            normalised: employees.length,
        });
    }

    // A short page means the roster ended, and THAT VERDICT OUTRANKS THE
    // DEADLINE. Checking the clock first would report a finished roster as
    // partial, store a cursor past the end of it, and defer the departure
    // reconcile a whole scheduled run to discover what this run already knew.
    if (!sawFullPage) return { employees, complete: true, resumeToken: null };
    // Stopped with the roster still going: either the per-run row cap or the
    // read deadline. Both are progress and both resume from the same offset.
    return { employees, complete: false, resumeToken: String(offset) };
}
