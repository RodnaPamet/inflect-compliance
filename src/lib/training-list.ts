/**
 * The Training list reads assignments a page at a time, newest first, through
 * a cursor (#5764 item 6). It used to read the first 500 and filter them in the
 * browser, so an assignment past the 500th could not be reached by any filter.
 * The search and the status filter now run in SQL, over every assignment.
 *
 * This module is dependency-free: the client page imports it.
 */

/** Assignments a page holds, on the page and at `GET /training`. */
export const TRAINING_PAGE_SIZE = 100;

/**
 * Longest search term the read acts on; anything beyond is cut rather than
 * refused, as the identity roster does (`IDENTITY_ROSTER_SEARCH_MAX_LENGTH`).
 */
export const TRAINING_SEARCH_MAX_LENGTH = 200;

/** The statuses the list filters by: the stored three, and OVERDUE. */
export const TRAINING_FILTER_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] as const;
export type TrainingFilterStatus = (typeof TRAINING_FILTER_STATUSES)[number];

/**
 * The filters a read applies, normalised: the search trimmed and cut, and the
 * statuses reduced to known values, de-duplicated and in a fixed order, so the
 * same filters always give the same key.
 */
export interface TrainingListFilters {
    q: string;
    statuses: TrainingFilterStatus[];
}

/**
 * Reads `q` and `status` as the filter bar writes them to the URL: `status` is
 * comma-separated, and may also repeat. An unknown status is dropped, never an
 * error, so a hand-edited URL still shows a list.
 */
export function normaliseTrainingFilters(input: {
    q?: string | null;
    status?: string | readonly string[] | null;
}): TrainingListFilters {
    const q = (input.q ?? '').trim().slice(0, TRAINING_SEARCH_MAX_LENGTH);
    const raw = input.status == null ? [] : typeof input.status === 'string' ? [input.status] : input.status;
    const asked = new Set(raw.flatMap((s) => s.split(',')).map((s) => s.trim()));
    const statuses = TRAINING_FILTER_STATUSES.filter((s) => asked.has(s));
    return { q, statuses };
}

/** One string per distinct set of filters. The page re-seeds its list when it changes. */
export function trainingFiltersKey(f: TrainingListFilters): string {
    return JSON.stringify([f.q, f.statuses]);
}

/** The query `GET /training` takes for these filters. */
export function trainingFiltersQuery(f: TrainingListFilters): URLSearchParams {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.statuses.length) p.set('status', f.statuses.join(','));
    return p;
}

/**
 * An assignment's status as it stands today. Nothing writes OVERDUE, so an
 * open assignment past its due date is reported overdue here, the same rule
 * the training check applies (`providers/training/checks.ts`). A stored
 * OVERDUE stays overdue; COMPLETED never is. The server's status filter
 * (`trainingStatusWhere` in `usecases/training.ts`) is this rule in SQL.
 */
export function effectiveTrainingStatus(
    row: { status: string; dueAt: string | Date | null },
    now: Date = new Date(),
): string {
    const open = row.status === 'ASSIGNED' || row.status === 'IN_PROGRESS';
    if (open && row.dueAt !== null && new Date(row.dueAt).getTime() < now.getTime()) return 'OVERDUE';
    return row.status;
}
