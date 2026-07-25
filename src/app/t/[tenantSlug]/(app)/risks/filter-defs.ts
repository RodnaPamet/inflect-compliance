/**
 * Epic 53 — Risks list page filter configuration.
 *
 * URL-synchronised filter defs backing the Risks toolbar. Keys align with
 * `RiskQuerySchema` except for `score`, which is a *UI-side* range token
 * (`"min|max"`) that splits into `scoreMin` / `scoreMax` on the API boundary.
 *
 *   q            → free-text search (`useFilterContext`'s search slot)
 *   status       → RiskStatus (OPEN | MITIGATING | MITIGATED | ACCEPTED | CLOSED)
 *   category     → free-form string (options derived from loaded rows)
 *   ownerUserId  → entity-reference (options derived from loaded rows)
 *   score        → range token; server consumes scoreMin + scoreMax
 *
 * i18n (filter-defs factory): the display labels are no longer static English.
 * `buildRiskFilterDefs(t, tGroup)` resolves every label / description /
 * option-label through next-intl at render — `t` scoped to `risks`, `tGroup`
 * scoped to the shared `common.filterGroups`. The URL-sync KEYS and API
 * TRANSFORMS stay static (labels never touch them); `RISK_FILTER_KEYS` is
 * derived once with an identity resolver. Option VALUES (the enum keys) are
 * unchanged — only their rendered label is localized — so URL state + the
 * server contract are byte-stable.
 */

import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { rangeSplitTransform, type FilterApiTransform } from '@/lib/filters/url-sync';
import { CircleDot, Tag, Activity, UserCircle2, ShieldCheck, Coins } from 'lucide-react';
import {
    TREATMENT_DECISION_VALUES,
    TREATMENT_DECISION_META,
} from '@/lib/risk-treatment-vocabulary';

/** Surface-namespace resolver (`useTranslations('risks')`). */
type T = (key: string, values?: Record<string, unknown>) => string;
/** Shared filter-group resolver (`useTranslations('common.filterGroups')`). */
type TGroup = (key: string) => string;

// ─── Labels (resolved at render) ─────────────────────────────────────

// RiskStatus enum → label. Values are the enum members (unchanged); labels
// reuse the existing `risks.bulkStatus.*` copy (Open/Mitigating/…).
function riskStatusLabels(t: T): Record<string, string> {
    return {
        OPEN: t('bulkStatus.open'),
        MITIGATING: t('bulkStatus.mitigating'),
        MITIGATED: t('bulkStatus.mitigated'),
        ACCEPTED: t('bulkStatus.accepted'),
        CLOSED: t('bulkStatus.closed'),
    };
}

// TreatmentDecision enum → label. Values are the enum members; labels reuse
// the canonical `risks.treatment*` vocabulary (Mitigate/Accept/Transfer/Avoid).
function riskTreatmentLabels(t: T): Record<string, string> {
    return Object.fromEntries(
        TREATMENT_DECISION_VALUES.map((v) => [v, t(TREATMENT_DECISION_META[v].labelKey)]),
    );
}

// Quantified toggle — has an ALE (FAIR or legacy SLE×ARO) vs not.
function riskQuantifiedLabels(t: T): Record<string, string> {
    return { yes: t('filters.quantifiedYes'), no: t('filters.quantifiedNo') };
}

// Stale/overdue toggle — the server runs the multi-signal detector.
function riskStaleLabels(t: T): Record<string, string> {
    return { true: t('filters.staleYes') };
}

function riskFilterDefsInput(t: T, tGroup: TGroup) {
    return {
        status: {
            label: t('filters.status'),
            description: t('filters.statusDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(riskStatusLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        category: {
            label: t('filters.category'),
            description: t('filters.categoryDesc'),
            group: tGroup('attributes'),
            icon: Tag,
            options: null, // derived from loaded risks
            multiple: true,
            resetBehavior: 'clearable',
        },
        ownerUserId: {
            label: t('filters.owner'),
            labelPlural: t('filters.ownerPlural'),
            description: t('filters.ownerDesc'),
            group: tGroup('people'),
            icon: UserCircle2,
            options: null, // derived from loaded risks
            multiple: true,
            shouldFilter: true,
            resetBehavior: 'clearable',
        },
        score: {
            label: t('filters.score'),
            description: t('filters.scoreDesc'),
            group: tGroup('quantitative'),
            icon: Activity,
            options: null,
            type: 'range',
            hideOperator: true,
            rangeNumberStep: 1,
            formatRangeBound: (n) => String(n),
            formatRangePillLabel: (token) => {
                const [min, max] = token.split('|');
                const fmt = (raw: string) => (raw === '' ? '—' : raw);
                return t('filters.scorePill', { min: fmt(min), max: fmt(max) });
            },
            resetBehavior: 'clearable',
        },
        // Exact (likelihood, impact) matrix cell(s), as `L{l}xI{i}` tokens.
        // The heatmap drill-down uses THIS, not the `score` range: score is
        // the PRODUCT, so a `score=12` range also drags in every other cell
        // with the same product (2×6, 3×4, 4×3, 6×2). Set programmatically by
        // the heatmap / collision callout; renders as a clearable pill.
        cell: {
            label: t('filters.cell'),
            description: t('filters.cellDesc'),
            group: tGroup('quantitative'),
            icon: Activity,
            options: null,
            multiple: true,
            resetBehavior: 'clearable',
        },
        // PR-K — after-controls posture: residual score range so a reviewer
        // can slice the register by residual band, not just inherent.
        residualScore: {
            label: t('filters.residualScore'),
            description: t('filters.residualScoreDesc'),
            group: tGroup('quantitative'),
            icon: Activity,
            options: null,
            type: 'range',
            hideOperator: true,
            rangeNumberStep: 1,
            formatRangeBound: (n) => String(n),
            formatRangePillLabel: (token) => {
                const [min, max] = token.split('|');
                const fmt = (raw: string) => (raw === '' ? '—' : raw);
                return t('filters.scorePill', { min: fmt(min), max: fmt(max) });
            },
            resetBehavior: 'clearable',
        },
        // PR-K — treatment decision (Mitigate/Accept/Transfer/Avoid).
        treatment: {
            label: t('filters.treatment'),
            description: t('filters.treatmentDesc'),
            group: tGroup('attributes'),
            icon: ShieldCheck,
            options: optionsFromEnum(riskTreatmentLabels(t)),
            multiple: true,
            resetBehavior: 'clearable',
        },
        // PR-K — quantified (has an ALE) vs not. Single-select toggle.
        quantified: {
            label: t('filters.quantified'),
            description: t('filters.quantifiedDesc'),
            group: tGroup('quantitative'),
            icon: Coins,
            options: optionsFromEnum(riskQuantifiedLabels(t)),
            resetBehavior: 'clearable',
        },
        // PR-K — stale/overdue, driven by the real multi-signal detector
        // (server resolves the stale id set; see the risks GET route).
        stale: {
            label: t('filters.stale'),
            description: t('filters.staleDesc'),
            group: tGroup('attributes'),
            icon: CircleDot,
            options: optionsFromEnum(riskStaleLabels(t)),
            resetBehavior: 'clearable',
        },
    } satisfies Record<string, FilterDefInput>;
}

/** Build the localized risk filter defs. `t` = `useTranslations('risks')`,
 *  `tGroup` = `useTranslations('common.filterGroups')`. Memoize per render. */
export function buildRiskFilterDefs(t: T, tGroup: TGroup) {
    return createTypedFilterDefs()(riskFilterDefsInput(t, tGroup));
}

// The URL-sync KEYS are label-independent — derive them once with an identity
// resolver so callers keep importing a stable `RISK_FILTER_KEYS` constant.
const IDENTITY: T = (k) => k;
const IDENTITY_GROUP: TGroup = (k) => k;
export const RISK_FILTER_KEYS = buildRiskFilterDefs(IDENTITY, IDENTITY_GROUP).filterKeys;

// ─── URL → API transforms ───────────────────────────────────────────

/**
 * Map UI keys to API params. Most keys pass through; `score` splits into
 * `scoreMin` + `scoreMax`. Used by the page when building the fetch URL.
 */
export const RISK_API_TRANSFORMS: Record<string, FilterApiTransform> = {
    score: rangeSplitTransform('scoreMin', 'scoreMax'),
    residualScore: rangeSplitTransform('residualScoreMin', 'residualScoreMax'),
    // treatment + quantified pass through as-is (key === API param).
};

// ─── Runtime option builders ────────────────────────────────────────

interface RiskLike {
    category?: string | null;
    ownerUserId?: string | null;
    treatmentOwner?: string | null;
    owner?: { id: string; name?: string | null; email?: string | null } | null;
}

/**
 * Build category options from loaded risks. Free-form strings: dedupe + sort.
 */
export function categoryOptionsFromRisks(
    risks: ReadonlyArray<RiskLike>,
): FilterOption[] {
    const seen = new Set<string>();
    for (const r of risks) {
        const cat = r.category?.trim();
        if (cat) seen.add(cat);
    }
    return Array.from(seen)
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));
}

/**
 * Build owner options from loaded risks. Prefers the joined `owner`
 * relation (id + name) when present; falls back to the `treatmentOwner`
 * free-text when that's all the server included.
 */
export function ownerOptionsFromRisks(
    risks: ReadonlyArray<RiskLike>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const r of risks) {
        const ownerRel = r.owner;
        if (ownerRel?.id && !seen.has(ownerRel.id)) {
            const name = ownerRel.name?.trim() || ownerRel.email?.trim() || 'Unknown';
            seen.set(ownerRel.id, {
                value: ownerRel.id,
                label: ownerRel.email ? `${name} — ${ownerRel.email}` : name,
                displayLabel: name,
            });
            continue;
        }
        // Legacy data: treatmentOwner is a free-text display string with no id.
        // Use the text as the option value so filtering remains idempotent.
        if (!ownerRel && r.ownerUserId) {
            if (seen.has(r.ownerUserId)) continue;
            seen.set(r.ownerUserId, {
                value: r.ownerUserId,
                label: r.treatmentOwner || r.ownerUserId,
                displayLabel: r.treatmentOwner || r.ownerUserId,
            });
        }
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/** Build the render-ready filter list (defs + derived category/owner options). */
export function buildRiskFilters(
    risks: ReadonlyArray<RiskLike>,
    t: T,
    tGroup: TGroup,
) {
    const defs = buildRiskFilterDefs(t, tGroup);
    const categoryOpts = categoryOptionsFromRisks(risks);
    const ownerOpts = ownerOptionsFromRisks(risks);
    return defs.filters.map((f) => {
        if (f.key === 'category') return { ...f, options: categoryOpts };
        if (f.key === 'ownerUserId') return { ...f, options: ownerOpts };
        return f;
    });
}
