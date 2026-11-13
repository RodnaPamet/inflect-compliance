/**
 * The order both leaver reads take (#5142): the most recent departure first.
 *
 * The terminated-worker read and the leaver-candidate read used to be
 * unordered under a cap. TERMINATED employees and their links accumulate —
 * nothing deletes them — so once the history passed the cap, which rows came
 * back was the planner's choice, and this week's leavers could be the ones left
 * out: never offboarded, on a run that reported green. An undated termination
 * sorts FIRST: unknown is not "long ago".
 *
 * A module of its own, with no imports, so the pass and the candidate read
 * share one definition and a test that mocks either still gets the real order.
 */
export const LEAVER_RECENCY_ORDER = [
    { endDate: { sort: 'desc', nulls: 'first' } },
    { updatedAt: 'desc' },
    { id: 'asc' },
] as const;
