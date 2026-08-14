/**
 * Epic 53 — Evidence filter config + URL sync integration.
 */

import {
    filterStateToUrlParams,
    parseUrlToFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildEvidenceFilters,
    buildEvidenceFilterDefs,
    controlOptionsFromControls,
    EVIDENCE_FILTER_KEYS,
    evidenceStatusLabels,
    evidenceTypeLabels,
} from '../../src/app/t/[tenantSlug]/(app)/evidence/filter-defs';
import { toApiSearchParams } from '../../src/lib/filters/url-sync';

// en.json-backed resolvers (mirror the runtime `useTranslations` seams).
const EN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf-8'),
) as Record<string, Record<string, unknown>>;
function makeT(ns: string) {
    return (key: string) => {
        const v = key
            .split('.')
            .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN[ns]);
        return typeof v === 'string' ? v : `${ns}.${key}`;
    };
}
const t = makeT('evidence');
const tGroup = (k: string) => (EN.common as { filterGroups: Record<string, string> }).filterGroups[k] ?? k;
const evidenceFilterDefs = buildEvidenceFilterDefs(t, tGroup);

describe('Evidence filter config', () => {
    it('manages exactly the keys the API understands (+ status widening)', () => {
        // B8 follow-up added `folder` to the Evidence filter set
        // when evidence folders shipped. The API GET route +
        // EvidenceListFilters + repository where-builder all honour
        // `folder` end-to-end (see b8-followup-evidence-folders ratchet).
        // EP-3 added `category` to the Evidence filter set (the API GET
        // route + EvidenceListFilters + repository where-builder honour
        // `category` end-to-end). `freshness` is the EP-2 review-currency
        // refinement — a server-side predicate since R1-2a.
        // R1-2b added `tab` (the retention bucket), previously written by a
        // ToggleGroup outside the filter system entirely.
        expect([...EVIDENCE_FILTER_KEYS].sort()).toEqual(
            ['category', 'controlId', 'folder', 'freshness', 'status', 'tab', 'type'].sort(),
        );
    });

    /**
     * R1-2b — the retention bucket is a filter, not a second filtering
     * mechanism.
     *
     * It used to be a ToggleGroup writing `?tab=` through `useUrlFilters`,
     * parallel to the filter bar: no pill, uncounted by "Clear all", and
     * invisible to anything reading filter state. These assert the three
     * properties that made it worth folding in — it is registered, it is
     * single-select (the buckets partition the tenant), and it offers exactly
     * the three buckets the server's `evidenceRetentionTabWhere` answers.
     */
    it('tab is a single-select retention filter offering exactly the server buckets', () => {
        const tab = evidenceFilterDefs.getFilter('tab');
        expect(tab.multiple).toBe(false);
        expect((tab.options ?? []).map((o) => o.value).sort()).toEqual(
            ['active', 'archived', 'expiring'],
        );
    });

    it('tab survives a URL round-trip, so ?tab= deep links keep working', () => {
        // The deep link predates the ToggleGroup and outlives it. This is the
        // property that let the control be deleted without breaking links.
        const state = parseUrlToFilterState(
            new URLSearchParams('tab=archived'),
            [...EVIDENCE_FILTER_KEYS],
        );
        expect(state.tab).toEqual(['archived']);
        expect(filterStateToUrlParams(state).get('tab')).toBe('archived');
    });

    it('type / status are multi-select enum filters with static options', () => {
        const type = evidenceFilterDefs.getFilter('type');
        const status = evidenceFilterDefs.getFilter('status');
        expect(type.multiple).toBe(true);
        expect(status.multiple).toBe(true);
        expect((type.options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(evidenceTypeLabels(t)).sort(),
        );
        expect((status.options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(evidenceStatusLabels(t)).sort(),
        );
    });

    it('controlId is an entity-ref filter (async options, shouldFilter=true)', () => {
        const control = evidenceFilterDefs.getFilter('controlId');
        expect(control.options).toBeNull();
        expect(control.shouldFilter).toBe(true);
    });

    it('every filter carries group + clearable reset behaviour', () => {
        for (const f of evidenceFilterDefs.filters) {
            expect(f.group).toBeDefined();
            expect(f.resetBehavior).toBe('clearable');
        }
    });
});

describe('controlOptionsFromControls', () => {
    it('builds a label with the annex/code prefix and a short display label', () => {
        const opts = controlOptionsFromControls([
            { id: 'c1', name: 'Information Classification', annexId: 'A.5.12' },
            { id: 'c2', name: 'Custom policy', code: 'CUST-1' },
            { id: 'c3', name: 'No prefix' },
        ]);
        expect(opts[0].label).toBe('A.5.12: Information Classification');
        expect(opts[0].displayLabel).toBe('A.5.12');
        expect(opts.find((o) => o.value === 'c2')?.displayLabel).toBe('CUST-1');
        expect(opts.find((o) => o.value === 'c3')?.label).toBe('No prefix');
    });

    it('dedupes by id and sorts alphabetically', () => {
        const opts = controlOptionsFromControls([
            { id: 'zz', name: 'Zulu', annexId: 'Z.1' },
            { id: 'aa', name: 'Alpha', annexId: 'A.1' },
            { id: 'aa', name: 'Alpha duplicate', annexId: 'A.1' },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['aa', 'zz']);
    });
});

describe('buildEvidenceFilters', () => {
    it('injects control options without mutating the static defs', () => {
        const live = buildEvidenceFilters([{ id: 'c1', name: 'ISMS Scope', annexId: 'A.4.3' }], [], t, tGroup);
        const control = live.find((f) => f.key === 'controlId');
        expect(control?.options).toHaveLength(1);
        // Static defs still null — a new array was constructed.
        expect(evidenceFilterDefs.getFilter('controlId').options).toBeNull();
    });
});

describe('Evidence URL round-trip', () => {
    it('roundtrips filter state → URL → state', () => {
        const initial: FilterState = {
            type: ['FILE'],
            status: ['APPROVED', 'SUBMITTED'],
            controlId: ['c1', 'c2'],
        };
        const params = filterStateToUrlParams(initial);
        expect(params.get('type')).toBe('FILE');
        expect(params.get('status')).toBe('APPROVED,SUBMITTED');
        expect(params.get('controlId')).toBe('c1,c2');

        const parsed = parseUrlToFilterState(params, EVIDENCE_FILTER_KEYS);
        expect(parsed).toEqual(initial);
    });

    it('API fetch params include q and filter state together', () => {
        const state: FilterState = { type: ['LINK'] };
        const params = toApiSearchParams(state, { search: 'soc2' });
        expect(params.get('type')).toBe('LINK');
        expect(params.get('q')).toBe('soc2');
    });

    it('unmanaged URL keys are stripped by parseUrlToFilterState', () => {
        const raw = new URLSearchParams({
            type: 'FILE',
            irrelevant: 'skip-me',
        });
        const parsed = parseUrlToFilterState(raw, EVIDENCE_FILTER_KEYS);
        expect(parsed.type).toEqual(['FILE']);
        expect(parsed).not.toHaveProperty('irrelevant');
    });
});
