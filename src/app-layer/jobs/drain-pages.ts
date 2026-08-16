/**
 * `drainPages` — read every row of a fan-out set, in pages.
 *
 * ## The defect this replaces
 *
 * Three cron dispatchers selected their work with a bare `take: 1000` and then
 * logged `connections: connections.length`. At the cap those two facts are
 * indistinguishable: an operator reading `connections: 1000` cannot tell a
 * true total from a truncated one. Tenants past the boundary never synced,
 * indefinitely, under a green job run — the failure reports success.
 *
 * A cap is the right tool when the work is genuinely unbounded and dropping
 * the tail is acceptable. Neither holds here. These selects are id-only
 * (`{ id, tenantId }`), so the whole set is cheap to hold; and the tail is
 * other people's tenants, which is never acceptable to drop silently.
 *
 * ## Why a helper rather than three loops
 *
 * The D1 guardrail flags a `findMany` inside a loop, and rightly — a per-row
 * read is the shape it exists to prevent. Cursor pagination is the opposite
 * (one query per PAGE, not per row), so it needs an escape marker. Putting the
 * loop here means one marker in one reviewed place instead of three scattered
 * ones, each of which a future reader would have to re-adjudicate.
 *
 * The marker must sit on the loop's opening line or the matched read line —
 * the scan reads those two lines, not a comment block above them.
 *
 * @example
 *   const connections = await drainPages((cursor) =>
 *       prisma.integrationConnection.findMany({
 *           where: { provider: { in: PROVIDERS }, isEnabled: true },
 *           select: { id: true, tenantId: true },
 *           orderBy: { id: 'asc' },
 *           take: 500,
 *           ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
 *       }),
 *   );
 */

/** Default page size. Bounds memory per round-trip, never the result set. */
export const DRAIN_PAGE_SIZE = 500;

/**
 * Call `fetchPage` until it returns a short page, concatenating the results.
 *
 * `fetchPage` must order by `id` and apply the cursor — this helper cannot
 * enforce that, so a caller that forgets the `orderBy` gets a non-deterministic
 * page walk. The example above is the shape to copy.
 *
 * @param fetchPage receives the last id of the previous page, or `undefined`
 *   for the first page.
 * @param pageSize must match the `take` inside `fetchPage`; a mismatch makes
 *   the short-page check either loop forever or stop early.
 */
export async function drainPages<T extends { id: string }>(
    fetchPage: (cursor: string | undefined) => Promise<T[]>,
    pageSize: number = DRAIN_PAGE_SIZE,
): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;

    for (;;) { // guardrail-allow: n+1 — one query per PAGE, not per row
        const page = await fetchPage(cursor);
        if (page.length === 0) break;
        out.push(...page);
        if (page.length < pageSize) break;
        cursor = page[page.length - 1].id;
    }

    return out;
}
