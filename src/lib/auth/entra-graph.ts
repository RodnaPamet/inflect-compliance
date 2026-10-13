/**
 * Microsoft Graph helpers for the Entra ID integration (EI-1).
 *
 * The `groups` claim in an Entra ID token is omitted when a user belongs to
 * more than ~200 groups (Entra sets a `_claim_names.groups` overage indicator
 * instead). In that case we fetch the full membership from Graph. Kept pure +
 * dependency-light (a single `fetchImpl`) so the cursor-pagination loop is
 * exhaustively unit-testable without network.
 */

import { graphHeaders } from '@/lib/http/graph-headers';

// Typed `microsoft.graph.group` cast on the memberOf collection so Graph
// returns ONLY security/M365 groups — `/me/memberOf` is heterogeneous and would
// otherwise mix in directoryRoles + administrativeUnits, whose ids would then
// leak into the group list. Server-side filtering beats a client `@odata.type`
// guess (which `$select=id` can omit).
const GRAPH_MEMBER_OF =
    'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$select=id&$top=999';
const GRAPH_GROUP =
    'https://graph.microsoft.com/v1.0/groups';

export interface GraphGroupRef {
    id: string;
}

type FetchImpl = typeof fetch;

interface GraphMemberOfPage {
    value?: Array<{ id?: string; '@odata.type'?: string }>;
    '@odata.nextLink'?: string;
}

/**
 * Fetch the signed-in user's full group membership via Graph.
 * Follows `@odata.nextLink` cursor pagination and de-duplicates ids. The
 * `microsoft.graph.group` cast in the URL makes Graph return ONLY groups —
 * directoryRoles / administrativeUnits that the bare `memberOf` collection
 * surfaces are excluded server-side, so their ids never leak into the list.
 *
 * Returns `[]` on any non-OK response or transport error — a Graph outage must
 * never block sign-in; the caller treats an empty list as "no groups resolved".
 */
export async function fetchUserGroupsFromGraph(
    accessToken: string,
    fetchImpl: FetchImpl = fetch,
    maxPages = 20,
): Promise<GraphGroupRef[]> {
    const seen = new Set<string>();
    const out: GraphGroupRef[] = [];
    let url: string | undefined = GRAPH_MEMBER_OF;
    let pages = 0;

    while (url && pages < maxPages) {
        pages++;
        let res: Response;
        try {
            res = await fetchImpl(url, {
                headers: graphHeaders(accessToken, { Accept: 'application/json' }),
            });
        } catch {
            return out;
        }
        if (!res.ok) return out;
        const page = (await res.json()) as GraphMemberOfPage;
        for (const item of page.value ?? []) {
            if (item.id && !seen.has(item.id)) {
                seen.add(item.id);
                out.push({ id: item.id });
            }
        }
        url = page['@odata.nextLink'];
    }
    return out;
}

export interface GraphGroupLookup {
    id: string;
    displayName: string;
}

/**
 * Resolve a single group's display name (Settings → group-mapping lookup).
 * Returns null on any failure — display name is cosmetic, never load-bearing.
 */
export async function lookupGroupFromGraph(
    accessToken: string,
    objectId: string,
    fetchImpl: FetchImpl = fetch,
): Promise<GraphGroupLookup | null> {
    let res: Response;
    try {
        res = await fetchImpl(
            `${GRAPH_GROUP}/${encodeURIComponent(objectId)}?$select=id,displayName`,
            { headers: graphHeaders(accessToken, { Accept: 'application/json' }) },
        );
    } catch {
        return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; displayName?: string };
    if (!body.id) return null;
    return { id: body.id, displayName: body.displayName ?? body.id };
}
