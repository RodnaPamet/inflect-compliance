/**
 * Epic 55 Prompt 6 — status/lifecycle/enum migration contract.
 *
 * Asserts the primitive-fit across the four migrated surfaces:
 *   1. tasks/new                  → Combobox hideSearch × 3 (type/severity/priority)
 *   2. controls/NewControlModal   → Combobox × 2 (category/frequency, freq hideSearch)
 *   3. risks/NewRiskModal         → Combobox × 1 (category)
 *   4. vendors/new                → RadioGroup × 1 (status) + Combobox hideSearch × 2
 *
 * Primitive rules verified:
 *   - ≤3 user-choice options with all-visible semantics  → RadioGroup.
 *   - 4–7 enum options where search adds no value        → Combobox `hideSearch`.
 *   - ≥8 options OR dynamic list                         → Combobox with search.
 *
 * Every migrated control preserves its legacy id for E2E parity and
 * its `name` attribute for native `<form onSubmit>` serialisation.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// Modal-form P1 (2026-05-24) — the `/tasks/new` and `/vendors/new`
// pages were decomposed into page wrapper + extracted form hook +
// extracted field component. The Epic 55 structural assertions lock
// the migration SHAPE, not the specific file the import / id /
// constant ended up in. Concatenate the relevant files so the
// assertions resolve correctly post-extraction.
const TASK_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/tasks/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm.ts');
const CONTROL_MODAL_SRC = read(
    'src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx',
);
const RISK_MODAL_SRC = read(
    'src/app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx',
);
const VENDORS_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/vendors/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/NewVendorModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/_form/NewVendorFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/_form/useNewVendorForm.ts');

// ─── 1. tasks/new — type / severity / priority ────────────────────

describe('tasks/new — type / severity / priority Combobox', () => {
    it('imports Combobox', () => {
        expect(TASK_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    const PICKER_IDS = [
        'task-type-select',
        'task-severity-select',
        'task-priority-select',
    ];

    it.each(PICKER_IDS)('no native <select id="%s">', (id) => {
        expect(TASK_NEW_SRC).not.toMatch(
            new RegExp(`<select[^>]*\\bid=["']${id}["']`),
        );
    });

    it.each(PICKER_IDS)(
        'Combobox preserves id="%s" for E2E parity',
        (id) => {
            expect(TASK_NEW_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        },
    );

    it('uses hideSearch — these are ≤5-option enums with no search value', () => {
        // All three pickers should have hideSearch; count at least 3
        // occurrences of the hideSearch flag across the file.
        const hits = TASK_NEW_SRC.match(/hideSearch/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(3);
    });

    it('type/severity/priority pickers build ComboboxOption[] via next-intl factories', () => {
        // The options moved from static `X_OPTIONS: ComboboxOption[]` maps to
        // `buildXOptions(t): ComboboxOption[]` factories that resolve labels
        // through next-intl. The typed ComboboxOption[] return shape is preserved.
        expect(TASK_NEW_SRC).toMatch(
            /buildTypeOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
        expect(TASK_NEW_SRC).toMatch(
            /buildSeverityOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
        expect(TASK_NEW_SRC).toMatch(
            /buildPriorityOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
    });
});

// ─── 2. NewControlModal — category + frequency ────────────────────

describe('NewControlModal — category + frequency Comboboxes', () => {
    it('imports Combobox', () => {
        expect(CONTROL_MODAL_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it.each(['control-category-input', 'control-frequency-input'])(
        'no native <select id="%s">',
        (id) => {
            expect(CONTROL_MODAL_SRC).not.toMatch(
                new RegExp(`<select[^>]*\\bid=["']${id}["']`),
            );
        },
    );

    it.each(['control-category-input', 'control-frequency-input'])(
        'Combobox preserves id="%s"',
        (id) => {
            expect(CONTROL_MODAL_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        },
    );

    it('category Combobox uses search (10 options); frequency uses hideSearch (7)', () => {
        // Category has `searchPlaceholder` (migrated to next-intl); frequency has `hideSearch`.
        expect(CONTROL_MODAL_SRC).toMatch(
            /id=["']control-category-input["'][\s\S]{0,800}searchPlaceholder=\{t\('new\.categorySearch'\)\}/,
        );
        const enControls = JSON.parse(read('messages/en.json')).controls;
        expect(enControls.new.categorySearch).toMatch(/^Search categories/);
        expect(CONTROL_MODAL_SRC).toMatch(
            /id=["']control-frequency-input["'][\s\S]{0,800}hideSearch/,
        );
    });

    it('uses forceDropdown inside the modal (no nested Vaul Drawer)', () => {
        const hits = CONTROL_MODAL_SRC.match(/forceDropdown/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(2);
    });

    it('CATEGORY_OPTIONS + FREQUENCY_OPTIONS are typed ComboboxOption[] (no stale string[] shape)', () => {
        // Both are now built via i18n factories returning ComboboxOption[]
        // (labels resolve through next-intl). Category options come from the
        // shared ISO-27002 theme vocabulary (buildCategoryOptions).
        expect(CONTROL_MODAL_SRC).toMatch(
            /buildFrequencyOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
        expect(CONTROL_MODAL_SRC).toMatch(
            /buildCategoryOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
    });
});

// ─── 4. NewRiskModal — category ───────────────────────────────────

describe('NewRiskModal — category Combobox', () => {
    it('no native <select id="risk-category">', () => {
        expect(RISK_MODAL_SRC).not.toMatch(
            /<select[^>]*\bid=["']risk-category["']/,
        );
    });

    it('Combobox preserves id="risk-category" + name="category"', () => {
        expect(RISK_MODAL_SRC).toMatch(
            /<Combobox[\s\S]{0,500}id=["']risk-category["']/,
        );
        expect(RISK_MODAL_SRC).toMatch(
            /<Combobox[\s\S]{0,500}name=["']category["']/,
        );
    });

    it('projects the categories into ComboboxOption[] in the shared module', () => {
        // B2-7 — the projection moved out of this modal. It was declared
        // here AND in [riskId]/page.tsx with the same eight values in a
        // different line layout, so the create modal and the edit page
        // could drift apart: a category you can create but cannot re-select.
        const shared = read('src/app/t/[tenantSlug]/(app)/risks/_shared/risk-options.ts');
        expect(shared).toMatch(
            /RISK_CATEGORY_OPTIONS:\s*ComboboxOption\[\]\s*=\s*RISK_CATEGORIES\.map/,
        );
    });

    it('the shared list is the single source of truth for risk categories', () => {
        // B2-8 — the DECLARATION moved to `@/lib/risk/categories` so the
        // client form schema can validate against it without `lib/`
        // importing from a route module. The invariant this test protects
        // is unchanged: one list, and the shared module surfaces it.
        // Asserting the declaration *site* would have failed on that move
        // while the single-source property still held.
        const lib = read('src/lib/risk/categories.ts');
        expect(lib).toMatch(/export const RISK_CATEGORIES\s*=\s*\[/);
        const shared = read('src/app/t/[tenantSlug]/(app)/risks/_shared/risk-options.ts');
        expect(shared).toMatch(/RISK_CATEGORIES/);
        expect(shared).not.toMatch(/const RISK_CATEGORIES\s*=\s*\[/);
        // …and neither consumer re-declares its own copy.
        expect(RISK_MODAL_SRC).not.toMatch(/const CATEGORIES\s*=\s*\[/);
        const detail = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
        expect(detail).not.toMatch(/const CATEGORIES\s*=\s*\[/);
    });
});

// ─── 5. vendors/new — status RadioGroup + criticality/dataAccess Combobox ─

describe('vendors/new — mixed primitives (RadioGroup + Combobox)', () => {
    it('imports Combobox + RadioGroup + Label', () => {
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/radio-group["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/label["']/,
        );
    });

    it('vendor status uses RadioGroup (2-option user choice, all-visible)', () => {
        expect(VENDORS_NEW_SRC).toMatch(
            /<RadioGroup[\s\S]{0,300}id=["']vendor-status-select["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(/<RadioGroupItem\b/);
    });

    it('no native <select> for any of the 3 enum pickers', () => {
        for (const id of [
            'vendor-status-select',
            'vendor-criticality-select',
            'vendor-data-access',
        ]) {
            expect(VENDORS_NEW_SRC).not.toMatch(
                new RegExp(`<select[^>]*\\bid=["']${id}["']`),
            );
        }
    });

    it('criticality + dataAccess use Combobox hideSearch (4–5 option enums)', () => {
        // Modal-form P1 — window widened from 500→900 because the
        // extracted field component spreads each Combobox's selected/
        // setSelected callbacks across multi-line indented bodies; the
        // ratchet's intent (the Combobox carries `hideSearch`) doesn't
        // care about formatting density.
        expect(VENDORS_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,900}id=["']vendor-criticality-select["'][\s\S]{0,900}hideSearch/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,900}id=["']vendor-data-access["'][\s\S]{0,900}hideSearch/,
        );
    });

    it('DATA_ACCESS_OPTIONS drops the phantom empty-value row (Combobox treats null via placeholder)', () => {
        // Legacy had `{ value: '', label: '— None —' }` as an option.
        // Combobox carries this via `placeholder="— None —"` instead.
        expect(VENDORS_NEW_SRC).toMatch(
            /DATA_ACCESS_OPTIONS:\s*ComboboxOption\[\]\s*=\s*\[\s*\{\s*value:\s*['"]NONE['"]/,
        );
        // The "— None —" affordance rides the Combobox placeholder — either an
        // inline literal OR (i18n-migrated) `placeholder={t('key')}` whose
        // en.json value is "— None —". Resolve the vendor placeholder keys
        // against the catalog so the affordance is still locked.
        const literalNone = /placeholder=["']— None —["']/.test(VENDORS_NEW_SRC);
        let i18nNone = false;
        if (!literalNone) {
            const vendors = (
                JSON.parse(read('messages/en.json')) as Record<string, unknown>
            ).vendors as Record<string, unknown> | undefined;
            const keys = [
                ...VENDORS_NEW_SRC.matchAll(
                    /placeholder=\{t\(['"]([\w.]+)['"]\)\}/g,
                ),
            ].map((m) => m[1]);
            i18nNone = keys.some(
                (k) =>
                    k
                        .split('.')
                        .reduce<unknown>(
                            (o, seg) =>
                                o && typeof o === 'object'
                                    ? (o as Record<string, unknown>)[seg]
                                    : undefined,
                            vendors,
                        ) === '— None —',
            );
        }
        expect(literalNone || i18nNone).toBe(true);
    });
});

// ─── 6. Cross-cutting drift sentinels ─────────────────────────────

describe('Epic 55 Prompt 6 — drift sentinels', () => {
    it('every migrated picker also carries a `name` attribute for form serialisation', () => {
        for (const [src, ids] of [
            [TASK_NEW_SRC, ['type', 'severity', 'priority']],
            [CONTROL_MODAL_SRC, ['category', 'frequency']],
            [RISK_MODAL_SRC, ['category']],
            [VENDORS_NEW_SRC, ['criticality', 'dataAccess']],
        ] as const) {
            for (const name of ids) {
                expect(src).toMatch(
                    new RegExp(`name=["']${name}["']`),
                );
            }
        }
    });

    it('RadioGroup is only used where semantically appropriate (vendor status, 2 options)', () => {
        // Only vendors/new should use <RadioGroup> among the four
        // migrated surfaces; the others should stay on <Combobox>.
        expect(VENDORS_NEW_SRC).toMatch(/<RadioGroup\b/);
        expect(TASK_NEW_SRC).not.toMatch(/<RadioGroup\b/);
        expect(CONTROL_MODAL_SRC).not.toMatch(/<RadioGroup\b/);
        expect(RISK_MODAL_SRC).not.toMatch(/<RadioGroup\b/);
    });
});
