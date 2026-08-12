/**
 * Epic 53 — sanity + URL round-trip for the Tasks, Vendors, and Assets
 * filter configs. These three pages ship static enum filters plus (for
 * Tasks) runtime-derived entity-ref options.
 *
 * i18n: Tasks + Assets filter defs are now `buildXFilterDefs(t, tGroup)`
 * factories (labels resolve through next-intl at render). The tests build
 * them with an en.json-backed resolver so the option VALUES (enum members —
 * the URL/API contract) are asserted against the real catalog. Vendors is
 * still the static-const shape (a follow-on batch).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    filterStateToUrlParams,
    parseUrlToFilterState,
    type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
    assigneeOptionsFromTasks,
    buildTaskFilterDefs,
    buildTaskFilters,
    controlOptionsFromTasks,
    TASK_FILTER_KEYS,
} from '../../src/app/t/[tenantSlug]/(app)/tasks/filter-defs';
import {
    buildVendorFilters,
    buildVendorFilterDefs,
    vendorStatusLabels,
    vendorCriticalityLabels,
    VENDOR_FILTER_KEYS,
} from '../../src/app/t/[tenantSlug]/(app)/vendors/filter-defs';
import {
    ASSET_FILTER_KEYS,
    buildAssetFilterDefs,
    buildAssetFilters,
} from '../../src/app/t/[tenantSlug]/(app)/assets/filter-defs';

// ─── en.json-backed resolvers (label-independent option VALUES) ───────

const EN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf-8'),
) as Record<string, unknown>;
const resolver = (ns: string) => (key: string) => {
    const v = key
        .split('.')
        .reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            (EN as Record<string, unknown>)[ns],
        );
    return typeof v === 'string' ? v : key;
};
const tTasks = resolver('tasks');
const tAssets = resolver('assets');
const tVendors = resolver('vendors');
const tGroup = (k: string) => resolver('common')(`filterGroups.${k}`);

// Enum VALUE sets (the URL/API contract — unchanged by i18n).
// The eight WorkItemStatus values — IN_REVIEW (TP-2) is a real
// reviewer-sign-off state alongside TRIAGED + BLOCKED.
const TASK_STATUS = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED'];
const TASK_TYPE = ['TASK', 'AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT'];
// INFO is a real WorkItemSeverity (automation raises INFO tasks) and is
// now filterable, matching the create form.
const TASK_SEVERITY = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// TP-5 — the universal-inbox source filter offers EXACTLY the
// WorkItemSource enum members (RISK_MONITOR added for KRI-breach +
// risk-appetite-breach spawned tasks).
const TASK_SOURCE = ['MANUAL', 'TEMPLATE', 'POLICY_REVIEW', 'AUDIT', 'INTEGRATION', 'EVIDENCE_EXPIRY', 'RISK_MONITOR'];
const ASSET_TYPE = ['INFORMATION', 'SYSTEM', 'SERVICE', 'DATA_STORE', 'VENDOR', 'PEOPLE_PROCESS', 'APPLICATION', 'INFRASTRUCTURE', 'PROCESS', 'OTHER'];
const ASSET_STATUS = ['ACTIVE', 'RETIRED'];
const ASSET_CRITICALITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// ─── Tasks ───────────────────────────────────────────────────────────

describe('Tasks filter config', () => {
    const taskFilterDefs = buildTaskFilterDefs(tTasks, tGroup);

    it('manages the documented key set', () => {
        expect([...TASK_FILTER_KEYS].sort()).toEqual(
            [
                'assigneeUserId',
                // B2-4 — "whose sign-off is this waiting on": IN_REVIEW
                // *and* that user is the named reviewer. Server-side key,
                // driven by the "Awaiting my review" quick toggle.
                'awaitingReviewBy',
                'controlId',
                'due',
                'severity',
                'source',
                'status',
                'type',
            ].sort(),
        );
    });

    it('status / type / severity / source are multi-select enums with full coverage', () => {
        for (const [key, values] of [
            ['status', TASK_STATUS],
            ['type', TASK_TYPE],
            ['severity', TASK_SEVERITY],
            ['source', TASK_SOURCE],
        ] as const) {
            const def = taskFilterDefs.getFilter(key);
            expect(def.multiple).toBe(true);
            expect((def.options ?? []).map((o) => o.value).sort()).toEqual([...values].sort());
        }
    });

    it('assigneeUserId + controlId start as async (options: null)', () => {
        expect(taskFilterDefs.getFilter('assigneeUserId').options).toBeNull();
        expect(taskFilterDefs.getFilter('controlId').options).toBeNull();
    });

    it('due is single-select with the documented chip values', () => {
        const due = taskFilterDefs.getFilter('due');
        expect(due.multiple).toBe(false);
        expect((due.options ?? []).map((o) => o.value).sort()).toEqual(['next7d', 'overdue']);
    });

    it('assigneeOptionsFromTasks dedupes + sorts by label', () => {
        const opts = assigneeOptionsFromTasks([
            { assigneeUserId: 'u2', assignee: { id: 'u2', name: 'Zoe', email: 'z@a' } },
            { assigneeUserId: 'u1', assignee: { id: 'u1', name: 'Ada', email: 'a@a' } },
            { assigneeUserId: 'u1', assignee: { id: 'u1', name: 'Ada', email: 'a@a' } },
        ]);
        expect(opts.map((o) => o.value)).toEqual(['u1', 'u2']);
        expect(opts[0].displayLabel).toBe('Ada');
    });

    it('controlOptionsFromTasks uses annexId / code as the short displayLabel', () => {
        const opts = controlOptionsFromTasks([
            { controlId: 'c1', control: { id: 'c1', name: 'Scope', annexId: 'A.4.3', code: null } },
            { controlId: 'c2', control: { id: 'c2', name: 'Custom', annexId: null, code: 'CUS-1' } },
        ]);
        expect(opts.find((o) => o.value === 'c1')?.displayLabel).toBe('A.4.3');
        expect(opts.find((o) => o.value === 'c2')?.displayLabel).toBe('CUS-1');
    });

    it('buildTaskFilters swaps entity-ref options without mutating static defs', () => {
        const live = buildTaskFilters(
            [
                {
                    assigneeUserId: 'u1',
                    assignee: { id: 'u1', name: 'Ada', email: 'a@a' },
                    controlId: 'c1',
                    control: { id: 'c1', name: 'Scope', annexId: 'A.4.3', code: null },
                },
            ],
            tTasks,
            tGroup,
        );
        expect(live.find((f) => f.key === 'assigneeUserId')?.options).toHaveLength(1);
        expect(live.find((f) => f.key === 'controlId')?.options).toHaveLength(1);
        // A fresh build keeps the entity-ref defs async (null options).
        expect(buildTaskFilterDefs(tTasks, tGroup).getFilter('assigneeUserId').options).toBeNull();
    });
});

// ─── Vendors ─────────────────────────────────────────────────────────

describe('Vendors filter config', () => {
    const vendorFilterDefs = buildVendorFilterDefs(tVendors, tGroup);
    it('manages the documented key set', () => {
        expect([...VENDOR_FILTER_KEYS].sort()).toEqual(
            ['criticality', 'reviewDue', 'riskRating', 'status'].sort(),
        );
    });

    it('status / criticality / riskRating are multi-select enums', () => {
        expect(vendorFilterDefs.getFilter('status').multiple).toBe(true);
        expect((vendorFilterDefs.getFilter('status').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(vendorStatusLabels(tVendors)).sort(),
        );
        expect((vendorFilterDefs.getFilter('criticality').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(vendorCriticalityLabels(tVendors)).sort(),
        );
        expect((vendorFilterDefs.getFilter('riskRating').options ?? []).map((o) => o.value).sort()).toEqual(
            Object.keys(vendorCriticalityLabels(tVendors)).sort(),
        );
    });

    it('reviewDue carries chip-style values the server understands directly', () => {
        expect((vendorFilterDefs.getFilter('reviewDue').options ?? []).map((o) => o.value).sort()).toEqual(
            ['overdue', 'next30d'].sort(),
        );
    });

    it('buildVendorFilters returns the static set (no runtime derivation)', () => {
        expect(buildVendorFilters(tVendors, tGroup).map((f) => f.key)).toEqual(vendorFilterDefs.filters.map((f) => f.key));
    });
});

// ─── Assets ──────────────────────────────────────────────────────────

describe('Assets filter config', () => {
    const assetFilterDefs = buildAssetFilterDefs(tAssets, tGroup);

    it('manages the documented key set', () => {
        expect([...ASSET_FILTER_KEYS].sort()).toEqual(
            ['criticality', 'status', 'type'].sort(),
        );
    });

    it('type / status / criticality cover the documented enums', () => {
        expect((assetFilterDefs.getFilter('type').options ?? []).map((o) => o.value).sort()).toEqual([...ASSET_TYPE].sort());
        expect((assetFilterDefs.getFilter('status').options ?? []).map((o) => o.value).sort()).toEqual([...ASSET_STATUS].sort());
        expect((assetFilterDefs.getFilter('criticality').options ?? []).map((o) => o.value).sort()).toEqual([...ASSET_CRITICALITY].sort());
    });

    it('buildAssetFilters returns the (localized) static set', () => {
        const live = buildAssetFilters(tAssets, tGroup);
        expect(live.map((f) => f.key).sort()).toEqual(['criticality', 'status', 'type'].sort());
    });
});

// ─── Combined URL round-trip ────────────────────────────────────────

describe('URL round-trip for Tasks / Vendors / Assets', () => {
    it.each([
        ['tasks', TASK_FILTER_KEYS, { status: ['OPEN', 'BLOCKED'], severity: ['CRITICAL'], due: ['overdue'] } as FilterState],
        ['vendors', VENDOR_FILTER_KEYS, { status: ['ACTIVE'], criticality: ['HIGH'], reviewDue: ['next30d'] } as FilterState],
        ['assets', ASSET_FILTER_KEYS, { type: ['SYSTEM'], status: ['ACTIVE'] } as FilterState],
    ])('%s is lossless across serialise/parse', (_name, keys, state) => {
        const parsed = parseUrlToFilterState(filterStateToUrlParams(state), keys);
        expect(parsed).toEqual(state);
    });
});
