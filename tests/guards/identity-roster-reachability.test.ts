/**
 * An account in the synced-identity roster must be reachable by NAME, and the
 * access-reviews directory gate must keep reading that roster UNFILTERED.
 *
 * Those two sentences are one invariant with two halves, and the second half
 * is the one nothing else would catch.
 *
 * ── Half one: reachability ──
 *
 * `GET /admin/integrations/identity-accounts` caps its response at
 * IDENTITY_ROSTER_PAGE_SIZE and sends no cursor, while a directory sync stores
 * up to 5000 accounts per connection. So position in the list is not a way to
 * find an account, and the admin page is where an operator marks an account
 * never-offboard — "cannot be found" and "cannot be protected" were the same
 * sentence until #2418 added `q`. The filter-toolbar exemption that used to
 * excuse this page claimed the roster was "bounded per-tenant"; the cap was
 * the evidence it is not.
 *
 * Filtering has to happen in SQL. A filter applied to the page already
 * delivered can only hide rows — it cannot reveal the ones the cap cut off —
 * so a client-side search on this page would look identical and fix nothing.
 *
 * ── Half two: the gate's arithmetic ──
 *
 * `AccessReviewsClient` decides whether a directory is unsynced with
 * `accounts.length < IDENTITY_ROSTER_PAGE_SIZE`, and that comparison is valid
 * ONLY over an unfiltered read. Under `?q=` or `?provider=` a short page means
 * "the matches fit", which says nothing about the directory: a filtered page
 * of three would tell the gate that every other provider is unsynced and
 * disable it, blocking a campaign the server would have accepted.
 *
 * The parameters are opt-in precisely so that gate's call keeps meaning what
 * it meant. Nothing in the type system relates a query string to a length
 * comparison in another file, so it is asserted here.
 *
 * Reads are bound to the construct they name (`declarationOf` /
 * `functionBodyOf`), never to the whole file — see
 * docs/implementation-notes/2026-09-02-assertion-reach-ratchets.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { declarationOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const ROUTE = 'src/app/api/t/[tenantSlug]/admin/integrations/identity-accounts/route.ts';
const USECASE = 'src/app-layer/usecases/integrations.ts';
const PAGE = 'src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page.tsx';
const GATE = 'src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx';

describe('the roster is reachable by name, not only by position', () => {
    it('the route reads a search term off the query string and hands it on', () => {
        const get = declarationOf(read(ROUTE), 'GET');

        expect(get).toMatch(/params\.get\('q'\)/);
        // Handed to the usecase, not consumed at the boundary.
        expect(get).toMatch(/listConnectedAccounts\(ctx, \{ provider, q \}\)/);
    });

    it('the usecase applies the term in SQL, over all three identifiers', () => {
        const fn = functionBodyOf(read(USECASE), 'listConnectedAccounts');

        // In the `where`, so Postgres does the narrowing over the WHOLE
        // roster. Filtering the returned page instead would be the bug.
        expect(fn).toMatch(/email: \{ contains: q, mode: 'insensitive' as const \}/);
        expect(fn).toMatch(/displayName: \{ contains: q, mode: 'insensitive' as const \}/);
        // The id an operator copies out of the provider's own console — the
        // only precise handle when two connections carry one human under one
        // email.
        expect(fn).toMatch(/externalUserId: \{ contains: q, mode: 'insensitive' as const \}/);
    });

    it('the usecase keeps the tenant scope beside the search, never instead of it', () => {
        const fn = functionBodyOf(read(USECASE), 'listConnectedAccounts');

        expect(fn).toMatch(/tenantId: ctx\.tenantId/);
    });

    it('the roster page drives that term from the shared toolbar', () => {
        const page = read(PAGE);

        // The exemption in filter-toolbar-coverage.test.ts was removed on the
        // strength of this mount; a page that drops it would silently re-open
        // the reachability hole while that ratchet still passed on a stray
        // import.
        expect(page).toMatch(/<FilterToolbar/);
        expect(page).toMatch(/searchPlaceholder=\{t\('identityAccounts\.searchPlaceholder'\)\}/);
    });

    it('the roster page sends the term to the server rather than filtering in the browser', () => {
        const query = declarationOf(read(PAGE), 'query');

        expect(query).toMatch(/params\.set\('q', q\)/);
        expect(query).toMatch(/params\.set\('provider', provider\)/);
    });
});

describe("the access-reviews directory gate still reads an UNFILTERED roster", () => {
    it('asks for the roster with no query string at all', () => {
        // `accounts.length < IDENTITY_ROSTER_PAGE_SIZE` means "the roster
        // fits" only for an unfiltered read. Adding a parameter here turns
        // that comparison into a count of MATCHES and the gate starts
        // disabling directories that are perfectly well synced.
        const gateRead = declarationOf(read(GATE), 'accountsQuery');

        const arg = /useTenantSWR<IdentityAccountsResponse>\(\s*'([^']*)'/.exec(gateRead);
        expect(arg).not.toBeNull();
        expect(arg?.[1]).toBe('/admin/integrations/identity-accounts');
    });

    it('still compares the row count against the shared cap', () => {
        const flag = declarationOf(read(GATE), 'directoryStatusKnown');

        expect(flag).toMatch(/accounts\.length < IDENTITY_ROSTER_PAGE_SIZE/);
    });
});
