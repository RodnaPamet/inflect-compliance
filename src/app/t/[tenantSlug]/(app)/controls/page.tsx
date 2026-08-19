import { getTenantCtx } from '@/app-layer/context';
import { listControls } from '@/app-layer/usecases/control';
import { cachedSsrPayload } from '@/lib/cache/ssr-cache';
import { ControlsClient } from './ControlsClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at the most-relevant SSR_PAGE_LIMIT rows so
// the initial HTML payload + DB query stay bounded as tenants
// accumulate controls. The Epic 69 SWR client immediately fetches
// the unbounded list in the background (the existing API GET path),
// and SWR's keepPreviousData swaps it in transparently. UX is
// "first 100 instantly, rest within ~500 ms" — never a blank flash.
// Mirrors the PR #146 Tasks pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Controls — Server Component.
 * Fetches controls list server-side (with URL filters applied),
 * delegates all interaction to client island.
 */
export default async function ControlsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // Build filters from searchParams for server-side data fetch.
    // Keys here must stay in sync with the Controls filter config
    // (`src/app/t/[tenantSlug]/(app)/controls/filter-defs.ts`) so SSR and
    // client filter state agree on the first paint.
    const filters: Record<string, string> = {};
    // `ids` (consistency deep-link) + `health` (verdict facet) are server-side
    // filters too — the register's SSR read must apply them so the first paint
    // is already restricted (and the client's fallbackData matches).
    // `category` is NOT in this list: the Category column shows a DERIVED
    // value (`categorizeControl` — ISO Annex clause → domain, else framework
    // prefix, else the stored string), and the server can only match the raw
    // stored column. Passing it through here matched raw-against-derived and
    // returned ~0 rows on a hard nav, while the same URL filtered correctly
    // after a client-side navigation. The client owns that facet; see the
    // note on `clientFilteredControls` in ControlsClient.
    // `due` + `evidence` are the controls-dashboard drill-downs. They are here
    // for the same reason as `ids`/`health`: a card links straight to this URL,
    // so a hard navigation must land already filtered. Omitting them would show
    // the full list on first paint and then silently narrow once the client
    // rehydrated — the card's number and the visible rows disagreeing for the
    // moment the reader is looking at them.
    for (const key of ['q', 'status', 'applicability', 'ownerUserId', 'ids', 'health', 'due', 'evidence']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    // SSR payload cache — only the unfiltered list (the common load) is
    // cached per-tenant; filtered loads bypass (their data is already
    // covered by the list-cache layer). Tenant-version-keyed, so any write
    // invalidates it. See docs/response-caching.md.
    const fetchControls = () =>
        listControls(ctx, Object.keys(filters).length > 0 ? filters : undefined, { take: SSR_PAGE_LIMIT });
    const controls =
        Object.keys(filters).length > 0
            ? await fetchControls()
            : await cachedSsrPayload({ tenantId: ctx.tenantId, route: 'controls', ttlSeconds: 30, compute: fetchControls });

    return (
        <ControlsClient
            initialControls={JSON.parse(JSON.stringify(controls))}
            initialFilters={filters}
            tenantSlug={tenantSlug}
            permissions={ctx.permissions}
            appPermissions={{
                controls: ctx.appPermissions.controls,
                tasks: { edit: ctx.appPermissions.tasks.edit },
            }}
        />
    );
}
