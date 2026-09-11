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
 *
 * ── WHAT THE CAP IS, AND IS NOT, SINCE THE ROSTER GAINED SEARCH (#2418) ──
 *
 * The roster is NOT bounded per tenant. A directory sync stores up to
 * MAX_USERS = 5000 accounts per CONNECTION per run (see the four provider
 * clients under `src/app-layer/integrations/providers/`), a tenant may hold
 * several connections, and a directory larger than that is synced across
 * several runs — so ten times this cap is an ordinary size, and the roster
 * page has rendered a truncation warning since #2412 precisely because it
 * fires. The filter-toolbar exemption that used to call the roster "bounded
 * per-tenant" was asserting the opposite of what this constant exists for.
 *
 * So the cap is a PAGE SIZE, not a reachability limit: the route accepts `q`
 * (email / display name / external user id) and `provider`, both applied in
 * SQL, so an operator reaches an account by naming it rather than by scrolling
 * to it. Raising the number was rejected as the fix — it would flip the
 * directory gate below from failing open to DISABLING options for every tenant
 * sitting between 500 and the new number, trading a visible truncation for a
 * silent behaviour change in a different feature.
 *
 * ── THE ONE RULE THE GATE'S COMPARISON DEPENDS ON ──
 *
 * `accounts.length < IDENTITY_ROSTER_PAGE_SIZE` means "the roster fits, so
 * absence is real" ONLY for an UNFILTERED read. Under a `q` or `provider`
 * filter a short page means "the MATCHES fit", which says nothing about the
 * directory — a filtered page of 3 would tell the gate every other provider is
 * unsynced and disable it. The access-reviews gate therefore reads this route
 * with no query string at all, and must keep doing so; `tests/guards/
 * identity-roster-reachability.test.ts` holds that line.
 */
export const IDENTITY_ROSTER_PAGE_SIZE = 500;

/**
 * Longest search term the roster route will act on; anything beyond is
 * truncated rather than rejected.
 *
 * A `contains` term is interpolated into an ILIKE, so an unbounded one is
 * work the database does per row for no operator benefit — no directory
 * identifier this searches (email, display name, external user id) comes near
 * this length. Clamping rather than erroring keeps a fat-fingered paste from
 * turning the roster into an error page: the operator sees the results for
 * what they meant to type.
 */
export const IDENTITY_ROSTER_SEARCH_MAX_LENGTH = 200;
