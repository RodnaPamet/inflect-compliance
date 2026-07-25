/**
 * Epic 53 — Risks filter config + score range-split URL sync.
 *
 * The filter defs are now built by a factory (`buildRiskFilterDefs(t, tGroup)`)
 * so labels localize through next-intl. These tests resolve labels against the
 * real en.json catalog — the enum VALUES (URL/API contract) are what's pinned;
 * the display labels just have to resolve to the English copy.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    filterStateToUrlParams,
    parseUrlToFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
    buildRiskFilters,
    buildRiskFilterDefs,
    categoryOptionsFromRisks,
    ownerOptionsFromRisks,
    RISK_API_TRANSFORMS,
    RISK_FILTER_KEYS,
} from '../../src/app/t/[tenantSlug]/(app)/risks/filter-defs';
import { toApiSearchParams } from '../../src/lib/filters/url-sync';

// ─── en.json-backed resolvers (mirror the runtime `useTranslations` seams) ──
const EN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf-8'),
) as Record<string, Record<string, unknown>>;

function makeT(ns: string) {
    return (key: string, values?: Record<string, unknown>) => {
        let v = key
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                EN[ns],
            );
        if (typeof v !== 'string') return `${ns}.${key}`;
        if (values) for (const [p, val] of Object.entries(values)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
        return v as string;
    };
}
const t = makeT('risks');
const tGroup = (k: string) => (EN.common as { filterGroups: Record<string, string> }).filterGroups[k] ?? k;
const riskFilterDefs = buildRiskFilterDefs(t, tGroup);
const RISK_STATUS_VALUES = ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED'];

describe('Risks filter config', () => {
    it('manages the documented key set', () => {
        // PR-K added residual score, treatment, quantified, and stale.
        // `cell` is the exact (likelihood, impact) matrix-cell filter the
        // heatmap drill-down sets — `score` (the PRODUCT) cannot express a
        // single cell, so a cell click used to over-select every cell
        // sharing the product.
        expect([...RISK_FILTER_KEYS].sort()).toEqual(
            ['category', 'cell', 'ownerUserId', 'quantified', 'residualScore', 'score', 'stale', 'status', 'treatment'].sort(),
        );
    });

    it('PR-K filters: residualScore is a range; treatment multi-enum; quantified + stale single-select', () => {
        const residual = riskFilterDefs.getFilter('residualScore');
        expect(residual.type).toBe('range');
        expect(residual.hideOperator).toBe(true);

        const treatment = riskFilterDefs.getFilter('treatment');
        expect(treatment.multiple).toBe(true);
        expect((treatment.options ?? []).map((o) => o.value).sort()).toEqual(
            ['AVOID', 'TOLERATE', 'TRANSFER', 'TREAT'].sort(),
        );

        const quantified = riskFilterDefs.getFilter('quantified');
        expect((quantified.options ?? []).map((o) => o.value).sort()).toEqual(['no', 'yes']);

        const stale = riskFilterDefs.getFilter('stale');
        expect((stale.options ?? []).map((o) => o.value)).toEqual(['true']);
    });

    it('status is a multi-select enum covering every RiskStatus value', () => {
        const status = riskFilterDefs.getFilter('status');
        expect(status.multiple).toBe(true);
        expect((status.options ?? []).map((o) => o.value).sort()).toEqual(
            [...RISK_STATUS_VALUES].sort(),
        );
    });

    it('score is a range filter with hidden operator and step=1', () => {
        const score = riskFilterDefs.getFilter('score');
        expect(score.type).toBe('range');
        expect(score.hideOperator).toBe(true);
        expect(score.rangeNumberStep).toBe(1);
        expect(score.formatRangePillLabel?.('5|20')).toBe('Score 5–20');
        expect(score.formatRangePillLabel?.('|20')).toBe('Score —–20');
    });

    it('category + ownerUserId start as async entity-ref filters', () => {
        expect(riskFilterDefs.getFilter('category').options).toBeNull();
        expect(riskFilterDefs.getFilter('ownerUserId').options).toBeNull();
    });

    it('labels resolve to the English catalog copy', () => {
        expect(riskFilterDefs.getFilter('status').label).toBe('Status');
        expect(riskFilterDefs.getFilter('score').label).toBe('Risk score');
        expect(
            (riskFilterDefs.getFilter('status').options ?? []).find((o) => o.value === 'OPEN')?.label,
        ).toBe('Open');
    });
});

describe('Risks runtime option builders', () => {
    it('categoryOptionsFromRisks dedupes and sorts free-form strings', () => {
        const opts = categoryOptionsFromRisks([
            { category: 'Technical' },
            { category: 'Operational' },
            { category: 'Technical' },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['Operational', 'Technical']);
    });

    it('ownerOptionsFromRisks prefers the joined owner relation', () => {
        const opts = ownerOptionsFromRisks([
            {
                ownerUserId: 'u1',
                treatmentOwner: 'Ada (legacy string)',
                owner: { id: 'u1', name: 'Ada Lovelace', email: 'ada@acme.com' },
            },
        ]);
        expect(opts).toHaveLength(1);
        expect(opts[0].value).toBe('u1');
        expect(opts[0].displayLabel).toBe('Ada Lovelace');
        // The joined name wins over the legacy treatmentOwner string.
        expect(opts[0].label).toBe('Ada Lovelace — ada@acme.com');
    });

    it('ownerOptionsFromRisks falls back to treatmentOwner when no join exists', () => {
        const opts = ownerOptionsFromRisks([
            { ownerUserId: 'u9', treatmentOwner: 'Infra team', owner: null },
        ]);
        expect(opts[0].displayLabel).toBe('Infra team');
        expect(opts[0].value).toBe('u9');
    });

    it('ownerOptionsFromRisks dedupes across multiple rows', () => {
        const opts = ownerOptionsFromRisks([
            { ownerUserId: 'u1', owner: { id: 'u1', name: 'Ada', email: 'a@a' } },
            { ownerUserId: 'u1', owner: { id: 'u1', name: 'Ada', email: 'a@a' } },
            { ownerUserId: 'u2', owner: { id: 'u2', name: 'Bjorn', email: 'b@b' } },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['u1', 'u2']);
    });
});

describe('buildRiskFilters', () => {
    it('swaps category + ownerUserId options; score/status untouched', () => {
        const live = buildRiskFilters(
            [{ category: 'Tech', ownerUserId: 'u1', owner: { id: 'u1', name: 'Ada', email: 'a@a' } }],
            t,
            tGroup,
        );
        expect(live.find((f) => f.key === 'category')?.options).toEqual([
            { value: 'Tech', label: 'Tech' },
        ]);
        const ownerOpts = live.find((f) => f.key === 'ownerUserId')?.options;
        expect(ownerOpts?.[0].value).toBe('u1');
        // status options carry the same enum values as the standalone defs.
        expect((live.find((f) => f.key === 'status')?.options ?? []).map((o) => o.value)).toEqual(
            (riskFilterDefs.getFilter('status').options ?? []).map((o) => o.value),
        );
    });
});

describe('Risks URL round-trip + range-split', () => {
    it('UI state: score=min|max carried as a single key in the URL', () => {
        const state: FilterState = {
            status: ['OPEN'],
            score: ['5|20'],
        };
        const params = filterStateToUrlParams(state);
        expect(params.get('status')).toBe('OPEN');
        expect(params.get('score')).toBe('5|20');
        const parsed = parseUrlToFilterState(params, RISK_FILTER_KEYS);
        expect(parsed).toEqual(state);
    });

    it('API fetch: score splits into scoreMin / scoreMax via RISK_API_TRANSFORMS', () => {
        const params = toApiSearchParams(
            { status: ['OPEN'], score: ['5|20'] },
            { search: '', transforms: RISK_API_TRANSFORMS },
        );
        expect(params.get('status')).toBe('OPEN');
        expect(params.get('scoreMin')).toBe('5');
        expect(params.get('scoreMax')).toBe('20');
        // The UI-side key is *not* re-emitted to the API URL.
        expect(params.has('score')).toBe(false);
    });

    it('API fetch: one-sided range still lands on a single API key', () => {
        const params = toApiSearchParams(
            { score: ['|20'] },
            { transforms: RISK_API_TRANSFORMS },
        );
        expect(params.has('scoreMin')).toBe(false);
        expect(params.get('scoreMax')).toBe('20');
    });

    it('API fetch: empty range sentinel "|" produces no API keys', () => {
        const params = toApiSearchParams(
            { score: ['|'] },
            { transforms: RISK_API_TRANSFORMS },
        );
        expect(params.has('scoreMin')).toBe(false);
        expect(params.has('scoreMax')).toBe(false);
    });

    it('filterStateToUrlParams + parseUrlToFilterState is a lossless pair for every managed key', () => {
        const state: FilterState = {
            status: ['OPEN', 'MITIGATING'],
            category: ['Technical'],
            ownerUserId: ['u1'],
            score: ['5|20'],
        };
        const params = filterStateToUrlParams(state);
        const parsed = parseUrlToFilterState(params, RISK_FILTER_KEYS);
        expect(parsed).toEqual(state);
    });
});
