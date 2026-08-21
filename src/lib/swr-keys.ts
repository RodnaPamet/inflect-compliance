/**
 * Epic 69 — typed SWR cache-key registry.
 *
 * Single source of truth for every tenant-scoped SWR cache key the
 * client uses. Without this, adoption of `useTenantSWR` /
 * `useTenantMutation` is one good-intentions PR away from drift —
 * three components writing `/controls`, `/control`, `/Controls` and
 * none of them invalidating each other.
 *
 * Convention
 * ──────────
 *
 *   - Keys are TENANT-RELATIVE paths starting with `/`. The
 *     `/api/t/{slug}` prefix is added by `useTenantSWR` /
 *     `useTenantMutation` from the active TenantContext, so the
 *     same registry entry produces a different cache entry per
 *     tenant naturally.
 *
 *   - Every resource exposes `list()` and (where the API has a
 *     detail route) `detail(id)`. Sub-views are named methods
 *     beneath the resource (`controls.dashboard()`,
 *     `tasks.metrics()`, …) — never deeply nested objects, never
 *     a generic templating DSL.
 *
 *   - Methods return the literal string. The return type is
 *     deliberately `string` — readable, drops straight into the
 *     hook arg list, and composes with the `invalidate: string[]`
 *     option on `useTenantMutation`.
 *
 *   - `CACHE_KEYS` is `as const`, so IDE autocomplete shows every
 *     resource and every method on a single keystroke.
 *
 * Adding a new resource
 * ─────────────────────
 *
 *   1. Either reuse `makeResource('<base>')` for the standard
 *      list + detail pair, OR spell out the methods if the
 *      resource is irregular (no list, multiple detail keys, …).
 *   2. Spread sub-resource methods alongside if the resource has
 *      named views (`{ ...makeResource('x'), summary: () => '/x/summary' }`).
 *   3. NEVER hand-write `/api/t/${slug}/<path>` in a client
 *      component again — reach for `CACHE_KEYS.<resource>.<verb>()`
 *      and let the hook layer prefix.
 *
 * Non-goals (deliberate)
 * ──────────────────────
 *
 *   - This module does NOT do query-string assembly. Pages with
 *     filterable lists pass an extra path suffix or a query
 *     string to the hook directly — collapsing every filtered
 *     view into the registry would explode the surface.
 *   - This module does NOT carry the absolute URL. Keys must work
 *     for any tenant the user is currently scoped to; resolving
 *     them is the hook's job.
 *   - This module does NOT export hooks. It is data only — pages
 *     compose `CACHE_KEYS.<x>.<y>()` with `useTenantSWR` /
 *     `useTenantMutation` themselves.
 */

/**
 * Type alias for tenant-relative cache keys — every method below
 * returns one of these. Pages that hold keys in arrays
 * (`invalidate: [CACHE_KEYS.risks.list(), CACHE_KEYS.tasks.list()]`)
 * can declare the variable as `CacheKey[]` for clarity.
 */
export type CacheKey = string;

/**
 * Standard resource shape — list + detail. The two endpoints almost
 * every CRUD-style resource exposes. Resources without a detail
 * route can spell out just `list()` directly instead of using this
 * factory.
 */
interface ResourceKeys {
    list: () => CacheKey;
    detail: (id: string) => CacheKey;
}

function makeResource(base: string): ResourceKeys {
    return {
        list: () => `/${base}`,
        detail: (id: string) => `/${base}/${id}`,
    };
}

export const CACHE_KEYS = {
    // ─── Compliance core ─────────────────────────────────────────
    controls: {
        ...makeResource('controls'),
        dashboard: () => '/controls/dashboard' as const,
        templates: () => '/controls/templates' as const,
        consistencyCheck: () => '/controls/consistency-check' as const,
        /**
         * Combined detail-page payload — `/controls/{id}/page-data`
         * collapses the prior detail + sync-status waterfall into
         * one round-trip. Used as the single SWR cache key for the
         * detail page; mutations on the detail page invalidate this
         * (not `detail(id)`) since the page never reads the bare
         * detail endpoint.
         */
        pageData: (id: string) => `/controls/${id}/page-data` as const,
        activity: (id: string) => `/controls/${id}/activity` as const,
        // #102 item 1 — per-tab lazy fetches. The detail page's
        // Tasks / Evidence / Mappings tabs each read their own slice
        // on demand instead of off the eager page-data payload.
        tasks: (id: string) => `/controls/${id}/tasks` as const,
        evidence: (id: string) => `/controls/${id}/evidence` as const,
        mappings: (id: string) => `/controls/${id}/requirements` as const,
        // PR-1 — automated-check history for the "Checks" tab.
        executions: (id: string) => `/controls/${id}/executions` as const,
        // R2-P2 — control health synthesis for the Overview.
        health: (id: string) => `/controls/${id}/health` as const,
        /**
         * A control's own test plans. `TestPlansPanel` on the control detail
         * page fetches this endpoint directly (it predates `useTenantSWR`), so
         * today the key exists as the namespace that panel publishes its
         * rendered plan order under (#107) — the control-scoped plan detail at
         * `/controls/{id}/tests/{planId}` reads it back to step between the
         * plans of THAT control, which is a different sibling set from the
         * tenant-wide `/tests` register.
         */
        testPlans: (id: string) => `/controls/${id}/tests/plans` as const,
    },
    risks: makeResource('risks'),
    /**
     * EU AI Act system registry. The list page is server-rendered (its rows
     * arrive as props, never through SWR), so this key is used only as the
     * namespace `AiSystemsClient` publishes its displayed order under; the
     * detail page reads it with a null `listKey` so nothing ever fetches it.
     */
    aiSystems: makeResource('ai-systems'),
    evidence: {
        ...makeResource('evidence'),
        metrics: () => '/evidence/metrics' as const,
        files: () => '/evidence/files' as const,
        /** File-version lineage for one evidence row (newest first). */
        fileVersions: (id: string) => `/evidence/${id}/file-versions` as const,
        retention: () => '/evidence/retention' as const,
    },
    policies: {
        ...makeResource('policies'),
        templates: () => '/policies/templates' as const,
    },
    tasks: {
        ...makeResource('tasks'),
        metrics: () => '/tasks/metrics' as const,
    },
    vendors: {
        ...makeResource('vendors'),
        metrics: () => '/vendors/metrics' as const,
    },
    assets: makeResource('assets'),
    findings: makeResource('findings'),
    // NIS2 Article 23 incident response. `detail(id)` is the per-incident
    // payload (notifications + timeline); mutations on the detail page
    // invalidate it.
    incidents: makeResource('incidents'),
    frameworks: makeResource('frameworks'),
    issues: makeResource('issues'),
    accessReviews: makeResource('access-reviews'),
    // Calendar is a range read-model, not a list/detail resource — the key
    // carries the from/to window so each view caches independently.
    calendar: {
        all: () => '/calendar' as const,
        // The type/category filter is server-side (the loaders skip
        // non-matching sources), so it belongs in the key — a filtered view
        // caches independently and refetches only its slice. The "my
        // deadlines" toggle is NOT here: it filters the fetched events by
        // ownerUserId client-side, so it changes no request. Appending only
        // non-empty params keeps the unfiltered key byte-identical to before.
        range: (
            from: string,
            to: string,
            opts?: { types?: readonly string[]; categories?: readonly string[] },
        ) => {
            let key = `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
            if (opts?.types && opts.types.length > 0) {
                key += `&types=${encodeURIComponent([...opts.types].sort().join(','))}`;
            }
            if (opts?.categories && opts.categories.length > 0) {
                key += `&categories=${encodeURIComponent([...opts.categories].sort().join(','))}`;
            }
            return key;
        },
    },

    // ─── Workflow automation (Automation Epics 1–10) ─────────────
    automation: {
        rules: {
            list: () => '/automation/rules' as const,
            detail: (id: string) => `/automation/rules/${id}` as const,
            executions: (id: string) => `/automation/rules/${id}/executions` as const,
        },
        templates: () => '/automation/templates' as const,
        analytics: () => '/automation/analytics' as const,
        executions: {
            live: () => '/automation/executions/live' as const,
        },
        // VR-9 — AI rule suggestions (Control-page right rail).
        suggestions: () => '/ai/automation-suggestions' as const,
    },

    // ─── Processes / canvas (R25+ · Visual Rule Editor) ──────────
    processes: {
        // VR-10 — cross-map governance meta-graph.
        governanceGraph: () => '/processes/governance-graph' as const,
    },

    // ─── Audit lifecycle ────────────────────────────────────────
    audits: {
        ...makeResource('audits'),
        readiness: () => '/audits/readiness' as const,
        /**
         * The cycle list JOINED with per-cycle readiness scores — one
         * server-side fan-out instead of the old 1+N waterfall, and the
         * only read the cycles page performs. Named here so the
         * create-cycle mutation targets the same string the read does.
         */
        readinessOverview: () => '/audits/readiness/overview' as const,
        cycles: () => '/audits/cycles' as const,
        cycle: (id: string) => `/audits/cycles/${id}` as const,
        packs: () => '/audits/packs' as const,
        // Pack detail and its two sub-feeds. Named here rather than spelled
        // inline at each call site so a mutation's `key` and the read's key
        // are the same string by construction — an optimistic update that
        // lands on a near-miss key silently does nothing.
        pack: (id: string) => `/audits/packs/${id}` as const,
        packShares: (id: string) => `/audits/packs/${id}/shares` as const,
        packShareComments: (id: string) => `/audits/packs/${id}/share-comments` as const,
        auditors: () => '/audits/auditors' as const,
        /**
         * BIA register + one analysis. These two are grouped under `audits`
         * because that is where the SCREEN lives (`/t/{slug}/audits/
         * business-continuity`) — but the API route is NOT nested under
         * `/audits`, it is `/api/t/{slug}/business-continuity`. The keys must
         * follow the API, not the navigation, so they carry no `/audits`
         * prefix. They previously did, which made both keys resolve to a URL
         * with no route behind it: a read would 404 and a mutation would
         * optimistically update an entry nothing renders — the near-miss
         * failure this registry exists to prevent. No caller had exercised
         * them yet, so the correction is behaviour-preserving.
         */
        businessContinuity: () => '/business-continuity' as const,
        bia: (id: string) => `/business-continuity/${id}` as const,
        nis2Gap: () => '/audits/nis2-gap' as const,
        /**
         * Propose-not-commit remediation suggestions for the latest NIS2 run.
         * The criticality floor is a SERVER-side filter, so it belongs in the
         * key — same reasoning as `dashboard.trends(days)`: a mutation keyed
         * on the bare path would target a cache entry the page never reads.
         * Defaults to the lifecycle page's fixed HIGH floor.
         */
        nis2GapRemediations: (minCriticality = 'HIGH') =>
            `/audits/nis2-gap/remediations?minCriticality=${minCriticality}` as const,
    },
    /**
     * NIS2 gap-assessment delegation (assign → respond → review). The feed
     * hangs off the assessment RUN, not the audits root, so it gets its own
     * registry entry rather than a method under `audits` whose path would not
     * start with `/audits`.
     */
    gapAssessments: {
        assignments: (assessmentId: string) =>
            `/gap-assessments/${assessmentId}/assignments` as const,
    },
    /**
     * The respondent's own side of that delegation — ONE assignee's bucket of
     * questions plus their current answers. Same reasoning as `gapAssessments`
     * for living outside `audits`: the route is `/gap-assignments/{id}`, and a
     * key that lies about its path is the near-miss that makes an optimistic
     * update silently target nothing.
     */
    gapAssignments: {
        detail: (assignmentId: string) => `/gap-assignments/${assignmentId}` as const,
    },

    // ─── Dashboards & overview surfaces ─────────────────────────
    //
    // These don't follow the list/detail shape because they're
    // composite read-models, so they get bespoke methods.
    dashboard: {
        home: () => '/dashboard' as const,
        executive: () => '/dashboard/executive' as const,
        // The query window is part of the cache identity: the consumer
        // fetches `?days=<n>` and the key MUST carry the same suffix, or
        // a `mutate(CACHE_KEYS.dashboard.trends())` would target a
        // different (bare) key and never match the live entry. Defaults
        // to the dashboard's fixed 30-day window.
        trends: (days = 30) => `/dashboard/trends?days=${days}` as const,
        postureSummary: () => '/dashboard/posture-summary' as const,
        /** On-demand data for a swappable custom-KPI card (assets/audits/tests). */
        kpi: (key: string) => `/dashboard/kpi/${key}` as const,
    },
    coverage: {
        home: () => '/coverage' as const,
    },
    // Control test plans / runs — the tenant-wide /tests surfaces (PR-Q SWR
    // migration). `detail` is the tenant-wide plan-detail key the leaf
    // /controls/{id}/tests/{planId} page already reads.
    tests: {
        plans: () => '/tests/plans' as const,
        detail: (planId: string) => `/tests/plans/${planId}` as const,
        /**
         * A plan's run history. Today this key is used ONLY as the namespace
         * the plan-detail view publishes its rendered run order under (#107)
         * — the runs themselves arrive embedded in `tests.detail(planId)`,
         * and the run stepper reads with a null `listKey` so nothing ever
         * fetches it. Naming it here anyway keeps the publisher and the
         * reader on one string by construction, which is the whole point of
         * the registry.
         */
        runs: (planId: string) => `/tests/plans/${planId}/runs` as const,
        due: () => '/tests/due' as const,
        dashboard: (periodDays: number) => `/tests/dashboard?period=${periodDays}` as const,
        readiness: () => '/tests/readiness' as const,
        checks: () => '/tests/checks' as const,
    },

    // ─── Integrations ───────────────────────────────────────────
    integrations: {
        /**
         * Practitioner-readable SharePoint connection list (id + name) —
         * `/integrations/sharepoint/connections`, gated by `evidence.upload`.
         * Three components probe this same path (evidence upload modal,
         * policy SharePoint section, audit-pack export button); naming it
         * here keeps them on ONE cache entry as each migrates, instead of
         * three near-miss strings that never dedupe or invalidate each other.
         */
        sharepointConnections: () => '/integrations/sharepoint/connections' as const,
    },

    // ─── Cross-cutting ──────────────────────────────────────────
    auditLog: {
        list: () => '/audit-log' as const,
    },
    notifications: {
        list: () => '/notifications' as const,
        settings: () => '/notification-settings' as const,
    },
    search: {
        query: () => '/search' as const,
    },
    traceability: {
        graph: () => '/traceability' as const,
    },
} as const;

/**
 * Re-exported shape for code that wants the registry's value type
 * (e.g. when threading the registry through a generic helper). Use
 * sparingly — most callers should reach into `CACHE_KEYS.x.y()`
 * directly so the IDE can autocomplete.
 */
export type CacheKeyRegistry = typeof CACHE_KEYS;
