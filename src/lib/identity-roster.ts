/**
 * The page size of the synced identity-account roster.
 *
 * `GET /api/t/{slug}/admin/integrations/identity-accounts` returns at most
 * this many rows (`listConnectedAccounts` passes it as the `take`). It is a
 * hard cap, not a cursor page — there is no "next" link and no `truncated`
 * flag on the response.
 *
 * That matters to READERS, not just to the route, which is why the number
 * lives here rather than as a literal in the usecase. A capped list can only
 * answer "is this provider present?" — never "is it absent?", because the
 * missing rows are indistinguishable from rows that were cut. The directory
 * gate in the access-reviews create modal is the consumer that has to care:
 * it disables a directory it believes is unsynced, so if it read absence off
 * a truncated roster it would block a campaign the server would have
 * accepted. It compares the row count against this constant and stands down
 * when the roster might be short.
 *
 * Both sides import this so the comparison cannot drift out of sync with the
 * cap it is comparing against. The module is deliberately dependency-free —
 * a client component imports it, so it must not drag Prisma into the bundle.
 */
export const IDENTITY_ROSTER_PAGE_SIZE = 500;
