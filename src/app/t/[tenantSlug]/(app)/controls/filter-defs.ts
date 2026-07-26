/**
 * Epic 53 — Controls list page filter configuration.
 *
 * Declarative filter defs for the Controls list toolbar. Keys map 1:1 onto
 * the API query parameters accepted by `GET /api/t/:slug/controls`:
 *
 *   q             → free-text search (managed by useFilterContext's search slot)
 *   status        → ControlStatus enum (server-side)
 *   ownerUserId   → entity-ref (user IDs; options derived client-side from loaded rows)
 *
 * Two facets are resolved CLIENT-side (over the already-loaded rows), NOT via
 * the server query — see the note on each and ControlsClient's
 * `clientFilteredControls`:
 *
 *   category      → the DERIVED framework-native category (`categorizeControl`,
 *                   e.g. "Access control"), the SAME value the Category COLUMN
 *                   renders — NOT the raw stored `c.category` (an ISO 27002
 *                   theme like "TECHNOLOGICAL"). Options + filtering both use
 *                   the derived value so the picker only offers values a cell
 *                   can actually show (#8a).
 *   applicability → three states matching the column exactly (Applicable /
 *                   Not applicable / Not assessed). The stored enum holds only
 *                   APPLICABLE | NOT_APPLICABLE, so the "Not assessed" backlog
 *                   (applicable, `applicabilityDecidedAt` null) is only
 *                   expressible client-side (#8b).
 *
 * `framework` is intentionally excluded — it would require a subquery across
 * `FrameworkMapping` which the controls API does not expose today. Adding it
 * will be a follow-on server + repo change; left as a migration note.
 *
 * This module is the single source of truth for the Controls filter contract.
 * Do not scatter filter logic back into the page; extend the config instead.
 *
 * i18n (filter-defs factory): display labels resolve through next-intl at
 * render via `buildControlFilters(loaded, t, tGroup)` — `t` scoped to
 * `controls`, `tGroup` to the shared `common.filterGroups`. `buildControlStatusLabels(t)`
 * is the single source of truth for status copy (the client reuses it for
 * badges). The URL-sync KEYS stay static; option VALUES (enum members) are
 * unchanged — only labels are localized.
 */

// Import from concrete sub-modules (not the barrel) so that jest's node env
// can require this file without transitively pulling the tsx components.
// Next.js / bundlers resolve these identically to the barrel re-exports.
import type {
    FilterDef,
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { CircleDot, Tag, UserCircle2, ShieldCheck, Activity } from 'lucide-react';
// Dependency-free taxonomy helper (no `@/` React imports) — safe to require
// from this node-env module. Drives the DERIVED Category filter options (#8a).
import {
    categorizeControl,
    type CategorizableControl,
} from '@/lib/controls/control-taxonomy';

/** Surface-namespace resolver (`useTranslations('controls')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// ─── Labels (resolved at render) ─────────────────────────────────────

/** ControlStatus enum → label. Single source of truth (client reuses it for
 *  status badges). Values are the enum members (unchanged). */
export function buildControlStatusLabels(t: T): Record<string, string> {
    return {
        NOT_STARTED: t('filterEnums.status.NOT_STARTED'),
        PLANNED: t('filterEnums.status.PLANNED'),
        IN_PROGRESS: t('filterEnums.status.IN_PROGRESS'),
        IMPLEMENTING: t('filterEnums.status.IMPLEMENTING'),
        IMPLEMENTED: t('filterEnums.status.IMPLEMENTED'),
        NEEDS_REVIEW: t('filterEnums.status.NEEDS_REVIEW'),
        NOT_APPLICABLE: t('filterEnums.status.NOT_APPLICABLE'),
    };
}

function applicabilityLabels(t: T): Record<string, string> {
    return {
        APPLICABLE: t('filterEnums.applicability.APPLICABLE'),
        NOT_APPLICABLE: t('filterEnums.applicability.NOT_APPLICABLE'),
        // #8b — third state, matching the Applicability COLUMN's "Not assessed"
        // (applicable but `applicabilityDecidedAt` null). Not a stored enum
        // member, so ControlsClient filters it CLIENT-side.
        UNASSESSED: t('filterEnums.applicability.UNASSESSED'),
    };
}

/** ControlHealthVerdict → label. Order matches CONTROL_HEALTH_VERDICTS (the
 *  dashboard tile order); the register facet + tile deep-links share these
 *  verdict values. */
function controlHealthLabels(t: T): Record<string, string> {
    return {
        HEALTHY: t('filterEnums.health.HEALTHY'),
        DEGRADED: t('filterEnums.health.DEGRADED'),
        AT_RISK: t('filterEnums.health.AT_RISK'),
        NOT_APPLICABLE: t('filterEnums.health.NOT_APPLICABLE'),
        UNKNOWN: t('filterEnums.health.UNKNOWN'),
    };
}

// ─── Filter definitions (factory) ────────────────────────────────────
//
// Owner and Category default to `options: null` — FilterSelect treats that as
// "async loading" and the page swaps in derived options at render time.

function controlFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            labelPlural: t('filters.statusPlural'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(buildControlStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        applicability: {
            label: t('filters.applicability'),
            description: t('filters.applicabilityDesc'),
            group: tGroup('attributes'),
            icon: ShieldCheck,
            options: optionsFromEnum(applicabilityLabels(t)),
            resetBehavior: 'clearable',
        },
        ownerUserId: {
            label: t('filters.owner'),
            labelPlural: t('filters.ownerPlural'),
            description: t('filters.ownerDesc'),
            group: tGroup('people'),
            icon: UserCircle2,
            options: null, // filled in at render time from loaded controls
            multiple: true,
            shouldFilter: true, // cmdk filters the (client-derived) label text
            resetBehavior: 'clearable',
        },
        category: {
            label: t('filters.category'),
            labelPlural: t('filters.categoryPlural'),
            description: t('filters.categoryDesc'),
            group: tGroup('attributes'),
            icon: Tag,
            options: null, // filled in at render time from loaded controls
            multiple: true,
            resetBehavior: 'clearable',
        },
        // Health verdict facet — single-select (mirrors the tile deep-links,
        // one verdict at a time). Resolved SERVER-SIDE to an `id: { in }`
        // restriction in listControls (same /controls/health-verdicts data the
        // Health column + dashboard tiles use).
        health: {
            label: t('filters.health'),
            description: t('filters.healthDesc'),
            group: tGroup('attributes'),
            icon: Activity,
            options: optionsFromEnum(controlHealthLabels(t)),
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized control filter defs. `t` = `useTranslations('controls')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildControlFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(controlFilterDefsInput(t, tGroup));
}

// ─── Public API ──────────────────────────────────────────────────────

// The URL-sync KEYS are label-independent — derive them once with an identity
// resolver so callers keep importing a stable `CONTROL_FILTER_KEYS` constant.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const CONTROL_FILTER_KEYS = buildControlFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

// ─── Runtime option builders ─────────────────────────────────────────

interface OwnerLike {
    id: string;
    name?: string | null;
    email?: string | null;
}

/**
 * Build owner options from the controls currently loaded on the page.
 * Dedupes by `owner.id` and sorts by display label. Skips rows with no owner.
 */
export function ownerOptionsFromControls(
    controls: ReadonlyArray<{ owner?: OwnerLike | null }>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const c of controls) {
        const o = c.owner;
        if (!o?.id) continue;
        if (seen.has(o.id)) continue;
        const name = o.name?.trim() || o.email?.trim() || 'Unknown';
        seen.set(o.id, {
            value: o.id,
            label: o.email ? `${name} — ${o.email}` : name,
            displayLabel: name,
        });
    }
    return Array.from(seen.values()).sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

/**
 * Build category options from the controls currently loaded on the page.
 *
 * #8a — the options are the DERIVED framework-native category
 * (`categorizeControl(c).category`, e.g. "Access control"), the SAME value the
 * Category COLUMN renders — NOT the raw stored `c.category` (an ISO 27002 theme
 * like "TECHNOLOGICAL"). Building from the raw column made the picker offer
 * values that never appear in a cell (and the server filtered the raw column,
 * so a pick on the derived-looking label matched nothing). Dedupe on the
 * derived string and surface it as both value and label; ControlsClient filters
 * the loaded rows on this same derived value.
 */
export function categoryOptionsFromControls(
    controls: ReadonlyArray<CategorizableControl>,
): FilterOption[] {
    const seen = new Set<string>();
    for (const c of controls) {
        const cat = categorizeControl(c)?.category?.trim();
        if (cat) seen.add(cat);
    }
    return Array.from(seen)
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
}

/**
 * Produce the Filter[] array that FilterSelect consumes, with `options` on
 * the owner/category defs replaced by the runtime-derived lists. Returns
 * the same `FilterDef[]` shape (options is the only field that changes).
 */
export function buildControlFilters(
    loaded: ReadonlyArray<CategorizableControl & { owner?: OwnerLike | null }>,
    t: T,
    tGroup: TGroup,
): FilterDef[] {
    const ownerOpts = ownerOptionsFromControls(loaded);
    const categoryOpts = categoryOptionsFromControls(loaded);
    return buildControlFilterDefs(t, tGroup).filters.map((f) => {
        if (f.key === 'ownerUserId') return { ...f, options: ownerOpts };
        if (f.key === 'category') return { ...f, options: categoryOpts };
        return f;
    });
}
