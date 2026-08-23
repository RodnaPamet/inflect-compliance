/**
 * Unified tenant-scoped global search usecase.
 *
 * Replaces the per-entity fan-out the command palette used to do
 * client-side. Every read happens inside `runInTenantContext` so
 * RLS is the load-bearing isolation guarantee; the explicit
 * `tenantId` filter on each query is defence-in-depth (matches
 * every other usecase in this layer).
 *
 * Design notes:
 *
 *   - **Eight parallel queries** (control / risk / policy /
 *     evidence / asset / task / test plan, plus the global
 *     framework catalogue). Same fan-out the client used to do;
 *     just consolidated server-side so one round-trip replaces
 *     eight.
 *   - **Per-domain permission skipping.** Each query only runs
 *     when `ctx.appPermissions.<domain>.view` is true. A denied
 *     domain is SKIPPED rather than refused: the caller gets the
 *     domains they can see, and the corresponding
 *     `meta.perTypeCounts` entry stays 0 so the response never
 *     claims results it withheld. See
 *     `policies/discovery.policies.ts` for why skipping beats an
 *     all-or-nothing refusal, and for the degenerate case (no
 *     domain viewable at all) that still throws.
 *   - **Per-type cap before sort.** Each underlying query is
 *     bounded at `perTypeLimit * 3` rows so the substring filter
 *     never scans an unbounded table. The post-sort step then
 *     enforces the actual `perTypeLimit` after ranking selects
 *     the best ones.
 *   - **Frameworks are global, and still gated.** No tenant filter
 *     on the query — callers can find ISO27001 before installing
 *     it. It is nonetheless skipped for a role without
 *     `frameworks.view`, and NOT because the catalogue is
 *     confidential: it is public standards text, identical for
 *     every tenant, so withholding it buys nothing. It is skipped
 *     because every framework hit is a link into
 *     `/t/<slug>/frameworks/<key>`, and that page has refused
 *     `frameworks.view: false` since 2026-08-23. Returning a row
 *     whose only affordance is a 403 is worse than returning no
 *     row.
 *   - **Evidence has no detail page.** Hits link to the evidence
 *     LIST (the existing per-row drawer opens from there).
 */

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { prisma } from '@/lib/prisma';
import {
    assertAnyDomainViewable,
    canViewDomain,
    type ViewableDomain,
} from '../policies/discovery.policies';
import { capPerType, computeRankScore, sortHits } from '@/lib/search/rank';
import {
    DEFAULT_PER_TYPE_LIMIT,
    MAX_QUERY_LENGTH,
    MIN_QUERY_LENGTH,
    SEARCH_TYPE_DEFAULTS,
    type SearchHit,
    type SearchHitType,
    type SearchResponse,
} from '@/lib/search/types';

export interface GetUnifiedSearchOptions {
    /** Override the per-type cap (test hook + future power-user surfaces). */
    perTypeLimit?: number;
}

/**
 * Which `PermissionSet` domain governs each searchable type. `Record`
 * over the full `SearchHitType` union on purpose: adding a hit type
 * without deciding what permission gates it is a compile error, not a
 * silently-ungated query.
 */
const SEARCH_DOMAINS: Record<SearchHitType, ViewableDomain> = {
    control: 'controls',
    risk: 'risks',
    policy: 'policies',
    evidence: 'evidence',
    asset: 'assets',
    task: 'tasks',
    // ControlTestPlan — the `tests` domain, not `controls`. A role can
    // legitimately see controls without seeing their test programme.
    test: 'tests',
    framework: 'frameworks',
};

export async function getUnifiedSearch(
    ctx: RequestContext,
    rawQuery: string,
    options: GetUnifiedSearchOptions = {},
): Promise<SearchResponse> {
    // Was `if (!ctx.role) throw forbidden('Authentication required')` — a
    // branch `getTenantCtx` makes unreachable. The real decision is
    // per-domain, below; this covers only the case where NOTHING is
    // viewable, which no built-in role can reach.
    assertAnyDomainViewable(
        ctx,
        Object.values(SEARCH_DOMAINS),
        'searchable records in this tenant',
    );
    const canSearch = (type: SearchHitType): boolean =>
        canViewDomain(ctx, SEARCH_DOMAINS[type]);

    const limit = options.perTypeLimit ?? DEFAULT_PER_TYPE_LIMIT;
    // The `perTypeLimit * 3` headroom on each query lets ranking
    // promote a strong substring match over a weak prefix match
    // — without it, the DB might hand us the first N alphabetical
    // matches and discard better ones we never saw.
    const dbLimit = limit * 3;

    const trimmed = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed.length < MIN_QUERY_LENGTH) {
        return emptyResponse(trimmed, limit);
    }

    const tenantId = ctx.tenantId;
    const tenantSlug = ctx.tenantSlug ?? '';

    // Postgres ILIKE is case-insensitive and can use a btree
    // index for prefix matches; Prisma's `mode: 'insensitive'`
    // generates the same SQL. Each `contains` produces a
    // `WHERE field ILIKE %q%`.
    const contains = trimmed;

    type Row<T> = T & { id: string };

    const allHits: SearchHit[] = [];

    await runInTenantContext(ctx, async (db) => {
        const [controls, risks, policies, evidence, assets, tasks, tests] = await Promise.all([
            !canSearch('control')
                ? Promise.resolve([])
                : db.control.findMany({
                      where: {
                          tenantId,
                          OR: [
                              { name: { contains, mode: 'insensitive' } },
                              { code: { contains, mode: 'insensitive' } },
                          ],
                      },
                      select: { id: true, code: true, name: true, status: true },
                      take: dbLimit,
                  }),
            !canSearch('risk')
                ? Promise.resolve([])
                : db.risk.findMany({
                      where: {
                          tenantId,
                          OR: [
                              { title: { contains, mode: 'insensitive' } },
                              { category: { contains, mode: 'insensitive' } },
                          ],
                      },
                      select: {
                          id: true,
                          title: true,
                          category: true,
                          status: true,
                          score: true,
                      },
                      take: dbLimit,
                  }),
            !canSearch('policy')
                ? Promise.resolve([])
                : db.policy.findMany({
                      where: {
                          tenantId,
                          title: { contains, mode: 'insensitive' },
                      },
                      select: { id: true, title: true, status: true },
                      take: dbLimit,
                  }),
            !canSearch('evidence')
                ? Promise.resolve([])
                : db.evidence.findMany({
                      where: {
                          tenantId,
                          title: { contains, mode: 'insensitive' },
                      },
                      select: { id: true, title: true, type: true },
                      take: dbLimit,
                  }),
            // Asset search — matches against `name` and the optional
            // `externalRef` field. `externalRef` is the canonical
            // place users put external system IDs / asset tags
            // (`patent1`, `srv-prod-04`, etc.), so it's the field
            // the "I'm looking for that specific asset" use case
            // depends on.
            !canSearch('asset')
                ? Promise.resolve([])
                : db.asset.findMany({
                      where: {
                          tenantId,
                          OR: [
                              { name: { contains, mode: 'insensitive' } },
                              { externalRef: { contains, mode: 'insensitive' } },
                          ],
                      },
                      select: {
                          id: true,
                          name: true,
                          type: true,
                          status: true,
                          externalRef: true,
                      },
                      take: dbLimit,
                  }),
            // Task search — `title` + `key` (the optional public-facing
            // task identifier like "TASK-42").
            //
            // `description` USED to be in this OR and was removed on
            // 2026-08-24 as a dead clause. `Task.description` is in the
            // Epic B encryption manifest
            // (`src/lib/security/encrypted-fields.ts`), so the column
            // holds AES-GCM ciphertext under a random IV. An ILIKE
            // against it cannot match the plaintext the user typed, for
            // any input — a guaranteed-empty predicate that still cost
            // a scan of the column on every keystroke. `TaskRepository`
            // had already reached the same conclusion; the manifest
            // carries the note next to the field list.
            !canSearch('task')
                ? Promise.resolve([])
                : db.task.findMany({
                      where: {
                          tenantId,
                          OR: [
                              { title: { contains, mode: 'insensitive' } },
                              { key: { contains, mode: 'insensitive' } },
                          ],
                      },
                      select: {
                          id: true,
                          title: true,
                          status: true,
                          severity: true,
                          key: true,
                      },
                      take: dbLimit,
                  }),
            // Test search — ControlTestPlan, not ControlTestRun.
            // Plans have a `name` field (runs don't); users looking
            // for "a test" typically mean "the plan that tests
            // control X". Each plan is tied to a control via
            // `controlId` (we fetch the control's code for the href
            // and subtitle).
            // (`ControlTestPlan.description` is NOT in the encryption
            // manifest — unlike `Task.description` above — so this
            // clause does match plaintext and stays.)
            !canSearch('test')
                ? Promise.resolve([])
                : db.controlTestPlan.findMany({
                      where: {
                          tenantId,
                          OR: [
                              { name: { contains, mode: 'insensitive' } },
                              { description: { contains, mode: 'insensitive' } },
                          ],
                      },
                      select: {
                          id: true,
                          name: true,
                          status: true,
                          controlId: true,
                          control: { select: { code: true, name: true } },
                      },
                      take: dbLimit,
                  }),
        ]);

        for (const c of controls as Row<{
            code: string | null;
            name: string;
            status: string;
        }>[]) {
            allHits.push(buildControlHit(c, trimmed, tenantSlug));
        }
        for (const r of risks as Row<{
            title: string;
            category: string | null;
            status: string;
            score: number;
        }>[]) {
            allHits.push(buildRiskHit(r, trimmed, tenantSlug));
        }
        for (const p of policies as Row<{ title: string; status: string }>[]) {
            allHits.push(buildPolicyHit(p, trimmed, tenantSlug));
        }
        for (const e of evidence as Row<{ title: string; type: string }>[]) {
            allHits.push(buildEvidenceHit(e, trimmed, tenantSlug));
        }
        for (const a of assets as Row<{
            name: string;
            type: string;
            status: string;
            externalRef: string | null;
        }>[]) {
            allHits.push(buildAssetHit(a, trimmed, tenantSlug));
        }
        for (const t of tasks as Row<{
            title: string;
            status: string;
            severity: string;
            key: string | null;
        }>[]) {
            allHits.push(buildTaskHit(t, trimmed, tenantSlug));
        }
        for (const t of tests as Row<{
            name: string;
            status: string;
            controlId: string;
            control: { code: string | null; name: string };
        }>[]) {
            allHits.push(buildTestHit(t, trimmed, tenantSlug));
        }
    });

    // Frameworks are global rows (no tenantId). Read them with the
    // bare prisma client; the search is still scoped to a logged-
    // in tenant member by the route's `getTenantCtx` gate above.
    //
    // Skipped for a role without `frameworks.view` — see the header
    // note. The reason is coherence with the destination page, not
    // confidentiality of the catalogue.
    if (canSearch('framework')) {
        const frameworks = await prisma.framework.findMany({
            where: {
                OR: [
                    { key: { contains, mode: 'insensitive' } },
                    { name: { contains, mode: 'insensitive' } },
                ],
            },
            select: { id: true, key: true, name: true, version: true },
            take: dbLimit,
        });
        for (const f of frameworks) {
            allHits.push(buildFrameworkHit(f, trimmed, tenantSlug));
        }
    }

    // Rank + cap. Capping happens AFTER sort so a strong substring
    // match within a kind survives even when the DB returned more
    // rows than the cap.
    const sorted = sortHits(allHits);
    const { kept, perTypeCounts, truncated } = capPerType(sorted, limit);

    return {
        hits: kept,
        meta: {
            query: trimmed,
            perTypeCounts,
            truncated,
            perTypeLimit: limit,
        },
    };
}

// ─── Per-type hit builders ─────────────────────────────────────────────

function emptyResponse(query: string, limit: number): SearchResponse {
    return {
        hits: [],
        meta: {
            query,
            perTypeCounts: {
                control: 0,
                risk: 0,
                policy: 0,
                evidence: 0,
                framework: 0,
                asset: 0,
                task: 0,
                test: 0,
            },
            truncated: false,
            perTypeLimit: limit,
        },
    };
}

function buildControlHit(
    row: { id: string; code: string | null; name: string; status: string },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.control;
    return {
        type: 'control',
        id: row.id,
        title: row.code ? `${row.code} — ${row.name}` : row.name,
        subtitle: null,
        badge: row.status,
        href: `/t/${slug}/controls/${row.id}`,
        score: computeRankScore(query, {
            type: 'control',
            title: row.name,
            code: row.code,
        }),
        ...meta,
    };
}

function buildRiskHit(
    row: { id: string; title: string; category: string | null; status: string; score: number },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.risk;
    return {
        type: 'risk',
        id: row.id,
        title: row.title,
        subtitle: row.category ? `${row.category} · Score ${row.score}` : `Score ${row.score}`,
        badge: row.status,
        href: `/t/${slug}/risks/${row.id}`,
        score: computeRankScore(query, {
            type: 'risk',
            title: row.title,
            subtitle: row.category,
        }),
        ...meta,
    };
}

function buildPolicyHit(
    row: { id: string; title: string; status: string },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.policy;
    return {
        type: 'policy',
        id: row.id,
        title: row.title,
        subtitle: null,
        badge: row.status,
        href: `/t/${slug}/policies/${row.id}`,
        score: computeRankScore(query, { type: 'policy', title: row.title }),
        ...meta,
    };
}

function buildEvidenceHit(
    row: { id: string; title: string; type: string },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.evidence;
    return {
        type: 'evidence',
        id: row.id,
        title: row.title,
        subtitle: null,
        badge: row.type,
        // Evidence has no dedicated detail route — hits land on the
        // list page and the existing per-row drawer opens from there.
        href: `/t/${slug}/evidence`,
        score: computeRankScore(query, { type: 'evidence', title: row.title }),
        ...meta,
    };
}

function buildAssetHit(
    row: {
        id: string;
        name: string;
        type: string;
        status: string;
        externalRef: string | null;
    },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.asset;
    // Title leads with externalRef when present (that's typically
    // what the user typed to find the asset — `patent1`,
    // `srv-prod-04`); falls back to plain name otherwise.
    const title = row.externalRef
        ? `${row.externalRef} — ${row.name}`
        : row.name;
    return {
        type: 'asset',
        id: row.id,
        title,
        subtitle: row.type,
        badge: row.status,
        href: `/t/${slug}/assets/${row.id}`,
        score: computeRankScore(query, {
            type: 'asset',
            title: row.name,
            code: row.externalRef,
        }),
        ...meta,
    };
}

function buildTaskHit(
    row: {
        id: string;
        title: string;
        status: string;
        severity: string;
        key: string | null;
    },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.task;
    // Title leads with the public-facing task key when present
    // (`TASK-42` or whatever pattern the tenant uses). Falls back
    // to plain title otherwise.
    const title = row.key ? `${row.key} — ${row.title}` : row.title;
    return {
        type: 'task',
        id: row.id,
        title,
        subtitle: row.severity,
        badge: row.status,
        href: `/t/${slug}/tasks/${row.id}`,
        score: computeRankScore(query, {
            type: 'task',
            title: row.title,
            code: row.key,
        }),
        ...meta,
    };
}

function buildTestHit(
    row: {
        id: string;
        name: string;
        status: string;
        controlId: string;
        control: { code: string | null; name: string };
    },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.test;
    // Subtitle: the control this test plan covers (code first if
    // present so the eye can match "test for AC-2" intuitively).
    const controlLabel = row.control.code
        ? `${row.control.code} · ${row.control.name}`
        : row.control.name;
    return {
        type: 'test',
        id: row.id,
        title: row.name,
        subtitle: controlLabel,
        badge: row.status,
        // Test plans live inside the control detail page — no
        // standalone test-plan detail route. Hit lands on the
        // control's `tests` tab.
        href: `/t/${slug}/controls/${row.controlId}/tests`,
        score: computeRankScore(query, {
            type: 'test',
            title: row.name,
            subtitle: row.control.name,
        }),
        ...meta,
    };
}

function buildFrameworkHit(
    row: { id: string; key: string; name: string; version: string | null },
    query: string,
    slug: string,
): SearchHit {
    const meta = SEARCH_TYPE_DEFAULTS.framework;
    // Use the framework KEY as the hit id — every other surface
    // (URLs, the framework picker) keys frameworks by `key` not
    // `id`. Keeps the contract consistent across the codebase.
    return {
        type: 'framework',
        id: row.key,
        title: `${row.key} — ${row.name}`,
        subtitle: row.version,
        badge: null,
        href: `/t/${slug}/frameworks/${encodeURIComponent(row.key)}`,
        score: computeRankScore(query, {
            type: 'framework',
            title: row.name,
            code: row.key,
        }),
        ...meta,
    };
}

// Re-export the shape so route + clients have one import path.
export type { SearchHit, SearchResponse } from '@/lib/search/types';

// Test-only export so structural assertions can verify the
// expected union of types without re-deriving it.
export const __SEARCHABLE_TYPES__: ReadonlyArray<SearchHitType> = [
    'control',
    'risk',
    'policy',
    'evidence',
    'framework',
    'asset',
    'task',
    'test',
];
