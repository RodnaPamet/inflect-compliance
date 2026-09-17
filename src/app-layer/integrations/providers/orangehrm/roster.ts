/**
 * OrangeHRM roster read — paginated, resumable, and MEASURED against a live
 * instance rather than written from documentation.
 *
 * ═══ EVERY FIELD BELOW WAS READ OFF A RUNNING 5.9, ON 2026-09-17 ═══
 *
 * This module used to say the opposite, in a banner reading "THE FIELD NAMES
 * BELOW ARE UNVERIFIED, AND THAT IS THE WHOLE POINT". That was honest and it
 * was also the entire defect: the mapping was written from OrangeHRM's
 * published v2 docs, the fixtures were written from the same docs, and fifty
 * green tests therefore agreed with the documentation about a payload the
 * product does not emit. #2587 records what a single run against
 * `orangehrm/orangehrm:5.9` found — FIVE mapping defects, of which the first
 * alone meant the connector could not normalise one employee:
 *
 *   1. The list row carries NO `workEmail` and NO `contactDetails`, at any
 *      `model`. Proved by A/B, not inferred: three of four employees HAVE work
 *      emails readable at contact-details, and their list rows carry neither
 *      key. Sibling keys come back as explicit `null`, so an ABSENT key means
 *      absent from the shape.
 *   2. Nor any date. `joinedDate` and the termination record live on
 *      job-details.
 *   3. `terminationId` is the id of a termination REASON, not a date and not a
 *      boolean.
 *   4. The two per-employee paths disagree about plurality, and that is
 *      OrangeHRM's own inconsistency, not a typo here:
 *      `/pim/employee/{id}/contact-details` is SINGULAR and
 *      `/pim/employees/{id}/job-details` is PLURAL. The other spelling 404s.
 *   5. A supervisor entry carries no email either — see
 *      `OrangeHrmEmployeeRow.supervisors`. The manager graph was dead for
 *      exactly the same reason as the employee email, and stayed invisible for
 *      exactly the same reason: the fixture supplied the key the code read.
 *
 * A list row's COMPLETE key set is `empNumber`, `empStatus`, `employeeId`,
 * `firstName`, `jobTitle`, `lastName`, `middleName`, `subunit`, `supervisors`,
 * `terminationId`. The two query parameters this module depends on were
 * checked rather than assumed: `includeEmployees=currentAndPast` is HONOURED
 * (without it terminated employees vanish entirely, which the departure
 * reconcile would read as deletion), and `sortField=employee.empNumber` is
 * HONOURED, which is what makes the offset cursor mean the same thing twice.
 *
 * ═══ SO THE READ COSTS THREE CALLS PER PAGE PLUS TWO PER EMPLOYEE ═══
 *
 * job-details carries BOTH `joinedDate` AND `employeeTerminationRecord`, so
 * enrichment is two calls per employee and not three. At the 5,000-row cap
 * that is ~10,100 requests a run, which is why `ORANGEHRM_ENRICH_CONCURRENCY`
 * exists and why managers are resolved through a run-scoped cache instead of
 * per report.
 *
 * The closing refusal in `readOrangeHrmRoster` is UNCHANGED and still load
 * bearing. It was written to catch a wrong field name, it would have caught
 * defect 1 on the first live run, and the reason to keep it now that the
 * mapping is measured is that the measurement is of ONE instance at ONE
 * version. A 5.10 that moves a field would put this module straight back where
 * it started, and the refusal is what makes that loud instead of silent.
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
import { IntegrationTerminalError, resilientFetch } from '../../http-resilience';
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
 * A row as a live OrangeHRM 5.9 ACTUALLY emits it — see the module docblock
 * for the complete key set and how it was established.
 *
 * Every field stays optional, deliberately. That is no longer a hedge about an
 * unseen payload but a statement about version drift: the shape was measured
 * on one instance at one version, and a required field here would turn a
 * vendor's future rename into a crash rather than a dropped row.
 */
export interface OrangeHrmEmployeeRow {
    /** Internal primary key — what the update API takes. See the module note. */
    empNumber?: number | string | null;
    /** Administrator-typed badge number. Editable, routinely blank. */
    employeeId?: string | null;
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    jobTitle?: { title?: string | null } | null;
    subunit?: { name?: string | null } | null;
    empStatus?: { name?: string | null } | null;
    /**
     * The employee's supervisors. CARRIES NO EMAIL — a live 5.9 returns
     * `{empNumber, firstName, lastName, middleName}` and nothing else, so the
     * manager has to be resolved by `empNumber` through contact-details exactly
     * as the employee's own email is. This module read `s.workEmail` here until
     * #2587, which is the same defect as the one on the row itself and was
     * invisible for the same reason: the fixtures were written from the docs.
     */
    supervisors?: Array<{ empNumber?: number | string | null } | null> | null;
    /**
     * The id of a termination REASON, not a date and not a boolean. Present and
     * non-null exactly when the employee has been terminated; `GET
     * /pim/termination-reasons` maps it to a name. Verified against 5.9.
     *
     * It is a usable "this person is terminated" signal and nothing more — the
     * DATE lives on job-details, which is why enrichment fetches that too.
     */
    terminationId?: number | string | null;
}

/**
 * The fields OrangeHRM does NOT put on the list row, fetched per employee.
 *
 * ═══ WHY THIS TYPE EXISTS AT ALL ═══
 *
 * Measured against a live orangehrm/orangehrm:5.9 on 2026-09-17, not read from
 * documentation — the documentation is what produced the four defects #2587
 * records. A list row's COMPLETE key set is:
 *
 *   empNumber, empStatus, employeeId, firstName, jobTitle,
 *   lastName, middleName, subunit, supervisors, terminationId
 *
 * No `workEmail`. No `contactDetails`. At any `model`, including `detailed`,
 * which adds `jobTitle`/`subunit`/`empStatus`/`supervisors` as keys with null
 * values and no contact data.
 *
 * That was proved by A/B rather than inferred: three of four employees on the
 * test instance HAVE a work email, readable at
 * `/pim/employee/{id}/contact-details`, and their list rows carry neither key.
 * Absence is the response SHAPE, not unfilled data — corroborated by the
 * sibling keys appearing as `null`, since a field the shape includes shows up
 * null rather than missing.
 *
 * `workEmail` is the personnel graph's identity, so without this the connector
 * normalises zero rows and refuses. Enrichment is not an enhancement here; it
 * is the difference between working and not.
 */
export interface OrangeHrmEnrichment {
    /** From `/pim/employee/{id}/contact-details` — note the SINGULAR path. */
    workEmail: string;
    /** From `/pim/employees/{id}/job-details` — note the PLURAL path. */
    joinedDate: string | null;
    /** Also from job-details. `{id, date}` when terminated, `{null, null}` otherwise. */
    terminationDate: string | null;
    /**
     * The first supervisor's work email, resolved through contact-details by
     * their `empNumber` — see `OrangeHrmEmployeeRow.supervisors`. Null when the
     * employee has no supervisor, or the supervisor carries no work email.
     */
    managerEmail: string | null;
}


/** The work email, from either place OrangeHRM might carry it. */


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
    enrichment: Pick<OrangeHrmEnrichment, 'joinedDate' | 'terminationDate'>,
    now: Date = new Date(),
): NormalizedEmployee['status'] {
    // TWO independent termination signals, and they come from different calls.
    // `terminationId` is on the LIST row and says THAT someone is terminated;
    // the DATE is on job-details. Either alone is enough to refuse ACTIVE —
    // which matters, because a job-details call that failed must not be able to
    // resurrect a terminated employee.
    const terminated = row.terminationId != null || enrichment.terminationDate != null;
    const derived = deriveEmploymentStatus(
        {
            statusText: row.empStatus?.name,
            hireDate: enrichment.joinedDate,
            terminationDate: enrichment.terminationDate,
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
    if (terminated) return 'TERMINATED';
    return 'ACTIVE';
}

function normalise(row: OrangeHrmEmployeeRow, enrichment: OrangeHrmEnrichment): NormalizedEmployee | null {
    const workEmail = enrichment.workEmail.trim();
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
        status: mapOrangeHrmStatus(row, enrichment),
        department: row.subunit?.name?.trim() || null,
        jobTitle: row.jobTitle?.title?.trim() || null,
        // Resolved by empNumber through contact-details, because a supervisor
        // entry carries no email. OrangeHRM returns supervisors as a LIST — an
        // employee may have several. The personnel graph holds one manager, so
        // the first is taken and the rest are dropped; picking arbitrarily
        // among several would be worse than picking the first consistently.
        managerEmail: enrichment.managerEmail,
        startDate: enrichment.joinedDate ? new Date(enrichment.joinedDate) : null,
        endDate: enrichment.terminationDate ? new Date(enrichment.terminationDate) : null,
    };
}

/**
 * Per-employee calls issued in parallel. Not a tuning knob picked by feel: at
 * the 5,000-row cap this phase is 10,000 requests, and sequential at even 50ms
 * apiece is over eight minutes — past any read deadline the lock lease allows.
 * Eight is low enough not to look like an attack to a single-tenant HR box and
 * high enough that the clock is no longer the binding constraint.
 */
export const ORANGEHRM_ENRICH_CONCURRENCY = 8;

/**
 * Fetch the fields the list response does not carry, for one employee.
 *
 * ═══ A FAILED CALL IS NOT AN EMPTY FIELD ═══
 *
 * This throws on a non-OK response rather than returning a blank. The two are
 * easy to conflate and their consequences are opposite: an employee with no
 * work email is a legitimate drop (contractors exist), while a contact-details
 * call that 500s and is read as "no email" drops a real employee from the
 * roster — and a roster missing employees, reported complete, is what the
 * departure reconcile turns into terminations.
 *
 * Throwing costs the run its remaining pages and keeps the cursor, so the next
 * attempt resumes. That is the cheap failure. The other one disables accounts.
 */
async function fetchEnrichment(
    host: string,
    accessToken: string,
    empNumber: string,
    doFetch: typeof fetch,
): Promise<OrangeHrmEnrichment> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const base = `https://${host}${ORANGEHRM_WEB_ROOT}/api/v2/pim`;

    // SINGULAR `employee` here and PLURAL `employees` below. That is OrangeHRM's
    // own inconsistency, verified on 5.9 — the plural form of this one 404s,
    // and this module previously documented the plural as fact.
    const [workEmail, jobRes] = await Promise.all([
        fetchWorkEmail(host, accessToken, empNumber, doFetch),
        doFetch(`${base}/employees/${encodeURIComponent(empNumber)}/job-details`, { headers }),
    ]);
    if (!jobRes.ok) {
        throw new Error(`OrangeHRM job-details fetch failed for employee ${empNumber} (HTTP ${jobRes.status})`);
    }

    const job = ((await jobRes.json()) as {
        data?: { joinedDate?: string | null; employeeTerminationRecord?: { date?: string | null } | null };
    }).data ?? {};

    return {
        workEmail,
        joinedDate: job.joinedDate ?? null,
        // `{id: null, date: null}` on an active employee, `{id, date}` on a
        // terminated one — both observed on 5.9.
        terminationDate: job.employeeTerminationRecord?.date ?? null,
        // Filled in by the caller: resolving it needs the run-scoped cache, so
        // that a manager with thirty reports costs one request and not thirty.
        managerEmail: null,
    };
}

/**
 * One employee's work email, from the SINGULAR contact-details path.
 *
 * ═══ 404 IS TOLERATED, AND IT ARRIVES TWO DIFFERENT WAYS ═══
 *
 * Why tolerate it at all: supervisor resolution passes an `empNumber` read from
 * a list page fetched moments earlier, so a 404 means the record was deleted in
 * between. Failing a 5,000-employee run over that race would be a worse answer
 * than recording no manager for one person. Every other status still throws —
 * see the note on `fetchEnrichment`.
 *
 * Why there are TWO branches for one condition: the production `doFetch` is
 * `resilientFetch`, which classifies 404 as TERMINAL and THROWS
 * `IntegrationTerminalError` rather than handing back a response
 * (`http-resilience.ts`, `TERMINAL_STATUS` / the `kind === 'terminal'` arm). A
 * status check alone is therefore dead code under the real wiring — it only
 * ever fires for an injected `fetchImpl` that returns the response verbatim,
 * which is what the tests do. This function had exactly that defect when it was
 * written: a docblock promising a tolerance the deployed connector did not have.
 *
 * The `status` check is NOT redundant, so do not "simplify" it away — drop it
 * and every test double has to start throwing vendor-specific error types to
 * exercise a branch the vendor reaches by status.
 *
 * The catch matches 404 ALONE and rethrows everything else. That is load
 * bearing: `IntegrationAuthError extends IntegrationTerminalError`, so a
 * `instanceof` check without the status test would swallow a 401/403 — turning
 * a revoked credential into "this employee has no manager", silently, for the
 * whole roster.
 */
async function fetchWorkEmail(
    host: string,
    accessToken: string,
    empNumber: string,
    doFetch: typeof fetch,
): Promise<string> {
    let res: Response;
    try {
        res = await doFetch(
            `https://${host}${ORANGEHRM_WEB_ROOT}/api/v2/pim/employee/${encodeURIComponent(empNumber)}/contact-details`,
            { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
        );
    } catch (e) {
        // 404 only. `IntegrationAuthError` is a subclass, so the status test is
        // what keeps a revoked credential from reading as "no manager".
        if (e instanceof IntegrationTerminalError && e.status === 404) return '';
        throw e;
    }
    if (res.status === 404) return '';
    if (!res.ok) {
        throw new Error(`OrangeHRM contact-details fetch failed for employee ${empNumber} (HTTP ${res.status})`);
    }
    const contact = ((await res.json()) as { data?: { workEmail?: string | null } }).data ?? {};
    return (contact.workEmail ?? '').trim();
}

/**
 * Map with a fixed number of in-flight promises, preserving input order, and
 * STOPPING when told to.
 *
 * ═══ WHY THE STOP CHECK IS WHAT KEEPS THE LOCK LEASE HONEST ═══
 *
 * `sync-transaction.ts` derives the read-phase budget as the deadline plus
 * exactly ONE `MAX_HTTP_REQUEST_MS` — "the one request that may still be in
 * flight when it passes" — and that derivation assumed a page IS one request.
 * Enrichment broke the assumption: a 50-row page issues up to 100 enrichment
 * requests and up to 50 supervisor lookups, so a page entered one millisecond
 * before the deadline could run fourteen further request-times past it and
 * overrun the 30-minute lock lease.
 *
 * The fix restores the original invariant rather than renegotiating the budget,
 * and it works because the fan-out is PARALLEL: a batch of `limit` requests
 * costs ONE request-time in wall clock, not `limit` of them. Checking
 * `shouldStop` before claiming each new item means that once the deadline
 * passes, no new work starts and the pool drains — so the overshoot is again
 * the single longest in-flight request, which is precisely what the budget
 * already allows for.
 *
 * Indices are claimed in ascending order, so everything completed forms a
 * PREFIX of `items`. That is load-bearing for the caller: a positional resume
 * cursor is only meaningful if the rows consumed are a prefix.
 */
async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
    shouldStop: () => boolean = () => false,
): Promise<{ results: R[]; processed: number }> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next;
            // THE FIRST BATCH ALWAYS RUNS, and that exception is what keeps the
            // pass finite. Consulting the clock before any work would let a run
            // that entered already past its deadline claim nothing, finish with
            // `keep === 0`, and hand back the cursor it was given — a run that
            // makes no progress, forever, every time. The original code had this
            // property for free (the deadline was checked between PAGES, so a
            // page that started always completed); it has to be stated once the
            // check moves inside.
            //
            // It costs nothing in overshoot: the batch is issued in parallel, so
            // `limit` requests cost ONE request-time — exactly the single
            // in-flight request the budget in `sync-transaction.ts` already
            // allows for.
            if (i >= limit && shouldStop()) return;
            next += 1;
            if (i >= items.length) return;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    // The dense prefix. `fn` may legitimately resolve to null, which is not
    // `undefined`, so a hole here means "never claimed" and nothing else.
    let processed = 0;
    while (processed < items.length && results[processed] !== undefined) processed += 1;
    return { results, processed };
}

/**
 * The resume cursor, which has TWO shapes and must keep accepting both.
 *
 * `<offset>` is the legacy form and is what is sitting in
 * `IntegrationConnection.syncCursor` for every connection mid-pass at the
 * moment this ships. Rejecting it would turn a routine deploy into a pass that
 * restarts from zero — re-upserting the whole roster and, worse, making a pass
 * that never completes look like one making progress.
 *
 * `<offset>@<highWater>` is the current form. See `readOrangeHrmRoster` for
 * what the high-water mark buys.
 *
 * A malformed cursor THROWS rather than defaulting to zero, which is the same
 * reasoning as before: silently restarting is indistinguishable from progress.
 */
export function parseResumeCursor(raw?: string | null): { offset: number; lastEmpNumber: number | null } {
    if (raw == null || raw === '') return { offset: 0, lastEmpNumber: null };
    const [offsetPart, markPart, ...rest] = raw.split('@');
    const offset = Number.parseInt(offsetPart, 10);
    if (rest.length || Number.isNaN(offset) || offset < 0) {
        throw new Error(`Invalid OrangeHRM resume cursor: ${raw}`);
    }
    if (markPart === undefined) return { offset, lastEmpNumber: null };
    const mark = Number.parseInt(markPart, 10);
    if (Number.isNaN(mark) || mark < 0) throw new Error(`Invalid OrangeHRM resume cursor: ${raw}`);
    return { offset, lastEmpNumber: mark };
}

/** Inverse of {@link parseResumeCursor}; omits the mark when there is none. */
export function formatResumeCursor(offset: number, lastEmpNumber: number | null): string {
    return lastEmpNumber === null ? String(offset) : `${offset}@${lastEmpNumber}`;
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

    const cursor = parseResumeCursor(resumeFrom);
    /**
     * Where to re-enter the list, and it is deliberately BEHIND where the last
     * run stopped.
     *
     * An offset is a position in a list that can change under us. If rows are
     * deleted from PIM between two runs of one pass, the tail shifts LEFT and
     * re-entering at the same offset lands PAST the next unread employee —
     * skipping them silently. A skipped employee is never stamped this pass,
     * and when the pass finally completes the departure reconcile reads
     * "not stamped" as "left the company" and marks them TERMINATED, which is
     * what makes them a candidate for a real directory disable.
     *
     * OrangeHRM offers no keyset pagination to fix this properly — measured,
     * not assumed: `empNumber=N` is an EQUALITY filter and there is no range
     * operator, so "give me everyone after N" cannot be expressed.
     *
     * So the cursor carries a HIGH-WATER MARK alongside the offset, and resume
     * backs off one whole page and re-reads it. Rows at or below the mark are
     * discarded as already-consumed, which makes the re-read free of
     * duplicates; and the backed-off page is what covers the shift. The
     * guarantee this buys is bounded and worth stating exactly: no employee is
     * skipped unless MORE THAN ORANGEHRM_PAGE_SIZE rows were deleted ahead of
     * the cursor between two runs of the same pass. Today's guarantee is that
     * ONE deletion is enough to lose someone.
     */
    const startOffset = cursor.lastEmpNumber === null
        ? cursor.offset
        : Math.max(0, cursor.offset - ORANGEHRM_PAGE_SIZE);

    const employees: NormalizedEmployee[] = [];
    /**
     * The largest `empNumber` this pass has finished with, carried in the
     * cursor. Rows at or below it have been consumed and are skipped on resume.
     */
    let highWater = cursor.lastEmpNumber;
    /**
     * empNumber -> work email, for the WHOLE run rather than one page.
     *
     * Every employee's own enrichment populates it, so resolving a manager is
     * usually free: the supervisor is an employee too, and on any page but the
     * first they have often already been fetched. The cache is what keeps the
     * manager graph from multiplying the request count — a manager with thirty
     * reports is one call, not thirty — and it is deliberately NOT shared
     * across runs, because an email that changed between runs would otherwise
     * be served from a cache nothing invalidates.
     */
    const emailByEmpNumber = new Map<string, string>();
    let offset = startOffset;
    let sawFullPage = true;
    /**
     * Did the read budget cut a page short mid-way?
     *
     * Tracked separately from `sawFullPage` because the two mean opposite
     * things to the caller and one of them is destructive. A short PAGE means
     * the roster ended — `complete: true`, which releases the departure
     * reconcile. A TRUNCATED page means the opposite: there is more roster and
     * we ran out of time. Routing truncation through `sawFullPage` would
     * report a partially-read roster as a finished one and mark every
     * unreached employee TERMINATED.
     */
    let truncatedMidPage = false;
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
        // `model=detailed` does NOT carry contact details — measured, see the
        // module docblock. It is still requested because it is what supplies
        // `jobTitle`, `subunit`, `empStatus` and `supervisors` as keys at all;
        // the default model omits them.
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

        // Already consumed by an earlier run of this pass. Safe to compare by
        // `empNumber` ONLY because the request pins
        // `sortField=employee.empNumber&sortOrder=ASC`, which a live 5.9
        // honours — without a stable total order this test would discard rows
        // that had simply been reordered.
        const consumedThrough = highWater;
        const fresh =
            consumedThrough === null
                ? rows
                : rows.filter((r) => {
                      const n = Number(r.empNumber);
                      // A row with no usable empNumber cannot be compared, so it
                      // is NOT discarded — enrichment drops it a few lines down
                      // for its own reason, and silently eating it here would
                      // hide that.
                      return !Number.isFinite(n) || n > consumedThrough;
                  });
        const skipped = rows.length - fresh.length;

        // ENRICHMENT, per employee, because the list response carries neither
        // the work email nor the dates. Bounded concurrency; a row with no
        // usable empNumber cannot be enriched and is dropped here rather than
        // sent to a URL with an empty path segment.
        const { results: enriched, processed } = await mapWithConcurrency(
            fresh,
            ORANGEHRM_ENRICH_CONCURRENCY,
            async (row) => {
                const empNumber = row.empNumber == null ? '' : String(row.empNumber).trim();
                if (!empNumber) return null;
                const enrichment = await fetchEnrichment(host, accessToken, empNumber, doFetch);
                emailByEmpNumber.set(empNumber, enrichment.workEmail);
                return { row, enrichment };
            },
            readBudgetSpent,
        );

        // MANAGERS, second — after the loop above has filled the cache with
        // this page's own emails, so a supervisor who is also on this page
        // costs nothing. Only the supervisors still unknown are fetched, and
        // only for the rows enrichment actually reached.
        const supervisorOf = (row: OrangeHrmEmployeeRow): string =>
            (row.supervisors ?? [])
                .map((sup) => (sup?.empNumber == null ? '' : String(sup.empNumber).trim()))
                .find(Boolean) ?? '';
        const reached = enriched.slice(0, processed);
        const unknown = [
            ...new Set(
                reached
                    .filter((item) => item !== null)
                    .map((item) => supervisorOf(item.row))
                    .filter((id) => id && !emailByEmpNumber.has(id)),
            ),
        ];
        const { results: fetchedEmails } = await mapWithConcurrency(
            unknown,
            ORANGEHRM_ENRICH_CONCURRENCY,
            (id) => fetchWorkEmail(host, accessToken, id, doFetch),
            readBudgetSpent,
        );
        unknown.forEach((id, i) => {
            if (fetchedEmails[i] !== undefined) emailByEmpNumber.set(id, fetchedEmails[i]);
        });

        // How far this page is USABLE. A row whose supervisor lookup the budget
        // cut short is not "an employee with no manager" — it is an employee we
        // did not finish reading, and emitting it with a null manager would
        // write a wrong fact rather than an incomplete one. So the prefix stops
        // at the first such row and the cursor resumes there.
        let keep = 0;
        while (keep < processed) {
            const item = reached[keep];
            const supervisor = item ? supervisorOf(item.row) : '';
            if (supervisor && !emailByEmpNumber.has(supervisor)) break;
            keep += 1;
        }

        for (let i = 0; i < keep; i += 1) {
            const item = reached[i];
            if (!item) continue;
            const supervisor = supervisorOf(item.row);
            const managerEmail = (supervisor && emailByEmpNumber.get(supervisor)) || null;
            const e = normalise(item.row, { ...item.enrichment, managerEmail });
            if (e) employees.push(e);
        }
        // The high-water mark advances over everything CONSUMED, which is not
        // the same as everything emitted: a row dropped for having no work
        // email was still read, and re-reading it next run would not change
        // that. Taken before the offset arithmetic so an early `continue` can
        // never leave the two disagreeing.
        for (let i = 0; i < keep; i += 1) {
            const n = Number(reached[i]?.row.empNumber);
            if (Number.isFinite(n) && (highWater === null || n > highWater)) highWater = n;
        }
        // Only what was consumed. `rows.length` here would skip every row the
        // budget cut short, and the departure reconcile reads a skipped
        // employee as a departed one. `skipped` counts toward it because those
        // rows WERE consumed — by an earlier run.
        offset += skipped + keep;
        // Counted over CONSUMED rows, for the same reason: the closing refusal
        // compares this against `employees.length`, and counting rows the
        // budget never enriched would make a truncated page look like a page
        // of employees with no work email.
        rowsSeen += keep;
        if (keep < fresh.length) truncatedMidPage = true;
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
     * The mapping IS checked against a live instance now, so the likely cause
     * has changed rather than gone away: not a guess this module never tested,
     * but a vendor upgrade that moved the field out from under a mapping
     * measured at 5.9. The consequence of shrugging that off is unchanged, and
     * it is not a quiet no-op.
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
                'everyone having left. Every row was enriched from /pim/employee/{id}/contact-details, so ' +
                'this means the instance has no work emails recorded rather than that the mapping is wrong ' +
                '(see providers/orangehrm/roster.ts).',
        );
    }
    if (rowsSeen > employees.length) {
        logger.warn('orangehrm roster dropped rows with no work email', {
            component: 'orangehrm',
            rowsSeen,
            normalised: employees.length,
        });
    }

    // TRUNCATION OUTRANKS EVERYTHING. A page the budget cut short leaves rows
    // unread at a known offset; it is the one state that must never be
    // reported complete, because `complete: true` is what releases the
    // departure reconcile over everyone this run did not touch.
    if (truncatedMidPage) return { employees, complete: false, resumeToken: formatResumeCursor(offset, highWater) };
    // A short page means the roster ended, and THAT VERDICT OUTRANKS THE
    // DEADLINE. Checking the clock first would report a finished roster as
    // partial, store a cursor past the end of it, and defer the departure
    // reconcile a whole scheduled run to discover what this run already knew.
    if (!sawFullPage) return { employees, complete: true, resumeToken: null };
    // Stopped with the roster still going: either the per-run row cap or the
    // read deadline. Both are progress and both resume from the same offset.
    return { employees, complete: false, resumeToken: formatResumeCursor(offset, highWater) };
}
