/**
 * Epic 55 Prompt 4 — framework + taxonomy picker migration.
 *
 * Asserts that every targeted native `<select>` has been replaced with
 * the shared `<Combobox>` and wired through `<FormField>`.
 *
 * Scope:
 *   1. Framework selector  — /audits/cycles/page.tsx  (#fw-select)
 *   2. Risk template picker — NewRiskModal.tsx        (#risk-template-select)
 *   3. Control linker      — UploadEvidenceModal.tsx  (#control-select)
 *   4. Control linker      — NewEvidenceTextModal.tsx (#text-evidence-control-select)
 *
 * Per surface we verify:
 *   - <Combobox> is imported and rendered.
 *   - The surface no longer contains a native <select ...id="..."> for
 *     the migrated picker.
 *   - The Combobox carries the preserved id (for E2E selectors) and a
 *     `name` attribute (for native <form onSubmit> serialisation).
 *   - `matchTriggerWidth` + `caret` are set so the trigger feels like
 *     a form field rather than a floating button.
 *   - Inside modals we also set `forceDropdown` (avoids Vaul Drawer
 *     nested inside the Modal's own Drawer on mobile).
 *   - The surface composes <FormField> around the Combobox so labels /
 *     descriptions / errors stay consistent with the rest of Epic 55.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. The raw reader is kept and the JSON path still uses it: a
// catalogue is PARSED as data, never matched as text, so masking it would only
// corrupt the parse. Text assertions go through the masked reader.
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../');
function readRaw(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function read(rel: string): string {
    return codeOf(readRaw(rel));
}

const CYCLES_SRC = read('src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx');
const RISK_MODAL_SRC = read('src/app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx');
const UPLOAD_SRC = read(
    'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
);
const TEXT_EV_SRC = read(
    'src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
);
// #5018 — the evidence forms' control picker is one shared, multi-select
// field. The two modals render it by id; the Combobox lives here.
const EVIDENCE_FIELDS_SRC = read(
    'src/app/t/[tenantSlug]/(app)/evidence/_form/EvidenceFormFields.tsx',
);
// The control field alone: the category field beside it is a Combobox too.
const EVIDENCE_CONTROLS_FIELD = functionBodyOf(EVIDENCE_FIELDS_SRC, 'EvidenceControlsField');

interface MigrationSurface {
    label: string;
    src: string;
    pickerId: string;
    name: string;
    insideModal: boolean;
}

const SURFACES: MigrationSurface[] = [
    {
        label: 'audits/cycles — framework picker',
        src: CYCLES_SRC,
        pickerId: 'fw-select',
        name: 'frameworkKey',
        insideModal: false,
    },
    {
        label: 'NewRiskModal — template picker',
        src: RISK_MODAL_SRC,
        pickerId: 'risk-template-select',
        name: 'templateId',
        insideModal: true,
    },
];

describe('Epic 55 — framework + taxonomy picker migration', () => {
    describe.each(SURFACES)('$label', (surface) => {
        it('imports <Combobox> + ComboboxOption', () => {
            expect(surface.src).toMatch(
                /from ["']@\/components\/ui\/combobox["']/,
            );
            expect(surface.src).toMatch(/<Combobox\b/);
            expect(surface.src).toMatch(/ComboboxOption/);
        });

        it('imports <FormField>', () => {
            expect(surface.src).toMatch(
                /from ["']@\/components\/ui\/form-field["']/,
            );
            expect(surface.src).toMatch(/<FormField\b/);
        });

        it(`no longer renders a native <select id="${surface.pickerId}">`, () => {
            const selectRe = new RegExp(
                `<select[^>]*\\bid=["']${surface.pickerId}["']`,
            );
            expect(surface.src).not.toMatch(selectRe);
        });

        it(`Combobox preserves id="${surface.pickerId}" for existing E2E selectors`, () => {
            const re = new RegExp(`id=["']${surface.pickerId}["']`);
            expect(surface.src).toMatch(re);
        });

        it(`Combobox carries name="${surface.name}" for native form serialisation`, () => {
            const re = new RegExp(`name=["']${surface.name}["']`);
            expect(surface.src).toMatch(re);
        });

        it('uses matchTriggerWidth + caret so it reads as a form field', () => {
            expect(surface.src).toMatch(/matchTriggerWidth/);
            expect(surface.src).toMatch(/caret\b/);
        });

        if (surface.insideModal) {
            it('uses forceDropdown (no nested Vaul Drawer inside Modal)', () => {
                expect(surface.src).toMatch(/forceDropdown/);
            });
        }
    });
});

// ─── audits/cycles framework options ─────────────────────────────

describe('audits/cycles — framework options', () => {
    // #4129 — this block used to pin FW_OPTIONS (later DEFAULT_FW_OPTIONS):
    // ISO 27001 and NIS2 options written into the page, offered before the
    // real list loaded and in its place when the read failed — whether or not
    // the workspace used either framework. They were the defect, so they are
    // gone, and the picker is the in-use read alone.
    // tests/rendered/audits-role-gates.test.tsx drives the form against it.
    it('reads the frameworks in use and carries each one’s version as meta', () => {
        expect(CYCLES_SRC).toMatch(/CACHE_KEYS\.frameworks\.inUse\(\)/);
        expect(CYCLES_SRC).toMatch(/meta:\s*\{\s*version:\s*f\.version \?\? ''\s*\}/);
        expect(CYCLES_SRC).not.toMatch(/value:\s*['"]ISO27001['"]/);
    });
});

// ─── Risk template picker ───────────────────────────────────────

describe('NewRiskModal — templateOptions', () => {
    it('projects the fetched templates into ComboboxOption shape', () => {
        expect(RISK_MODAL_SRC).toMatch(/templateOptions\s*=\s*useMemo/);
        expect(RISK_MODAL_SRC).toMatch(/tmpl\.category\s*\?\s*`\$\{tmpl\.title\}/);
    });

    it('forwards the loading state to the Combobox', () => {
        expect(RISK_MODAL_SRC).toMatch(
            /loading=\{templatesQuery\.isLoading\}/,
        );
    });

    it('preserves the applyTemplate business logic on selection', () => {
        expect(RISK_MODAL_SRC).toMatch(
            /setSelected=\{\(option\)\s*=>\s*\{[\s\S]{0,120}applyTemplate\(option\?\.value\s*\?\?\s*['"]['"]\)/,
        );
    });
});

// ─── Control linker — the evidence forms' shared field (#5018) ──

describe('Evidence forms — control linker', () => {
    it('is one multi-select Combobox inside a FormField, shared by the forms', () => {
        expect(EVIDENCE_FIELDS_SRC).toMatch(/from ["']@\/components\/ui\/combobox["']/);
        expect(EVIDENCE_FIELDS_SRC).toMatch(/from ["']@\/components\/ui\/form-field["']/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/<FormField\b/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/<Combobox<true, EvidenceControlOption>/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/\bmultiple\b/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/matchTriggerWidth/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/forceDropdown/);
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(/caret\b/);
    });

    it('folds annex id, code and name into the option label', () => {
        expect(EVIDENCE_CONTROLS_FIELD).toMatch(
            /`\$\{c\.annexId \|\| c\.code \|\| tx\('formFields\.customControl'\)\}: \$\{c\.name\}`/,
        );
    });

    it.each([
        ['UploadEvidenceModal', () => UPLOAD_SRC, 'control-select'],
        ['NewEvidenceTextModal', () => TEXT_EV_SRC, 'text-evidence-control-select'],
    ])('%s renders the shared field under its existing E2E id', (_name, src, id) => {
        expect(src()).toMatch(new RegExp(`<EvidenceControlsField\\s+id=["']${id}["']`));
        expect(src()).not.toMatch(/controlSearch|filteredControls/);
    });
});

// ─── Cross-cutting: no stale ids / no leftover native selects ───

describe('Epic 55 Prompt 4 — no stale native selects for the migrated pickers', () => {
    it('UploadEvidenceModal no longer has a control-search-input', () => {
        expect(UPLOAD_SRC).not.toMatch(/id=["']control-search-input["']/);
    });

    it('all four migrated surfaces reference the Combobox id for E2E parity', () => {
        for (const surface of SURFACES) {
            const re = new RegExp(`id=["']${surface.pickerId}["']`);
            expect(surface.src).toMatch(re);
        }
    });
});
