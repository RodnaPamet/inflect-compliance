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
import { codeOf } from '../helpers/source-blocks';

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
    {
        label: 'UploadEvidenceModal — control linker',
        src: UPLOAD_SRC,
        pickerId: 'control-select',
        name: 'controlId',
        insideModal: true,
    },
    {
        label: 'NewEvidenceTextModal — control linker',
        src: TEXT_EV_SRC,
        pickerId: 'text-evidence-control-select',
        name: 'controlId',
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

describe('audits/cycles — FW_OPTIONS shape', () => {
    it('exposes a FW_OPTIONS constant typed as ComboboxOption<{ version: string }>[]', () => {
        expect(CYCLES_SRC).toMatch(/FW_OPTIONS:\s*ComboboxOption<\{\s*version:\s*string\s*\}>\[\]/);
    });

    it('carries ISO27001 and NIS2 entries with full-text labels', () => {
        expect(CYCLES_SRC).toMatch(/value:\s*['"]ISO27001['"]/);
        expect(CYCLES_SRC).toMatch(/value:\s*['"]NIS2['"]/);
        expect(CYCLES_SRC).toMatch(/ISO\/IEC 27001:2022/);
        expect(CYCLES_SRC).toMatch(/NIS2 Directive \(EU 2022\/2555\)/);
    });

    it('passes meta.version through for downstream payload shaping', () => {
        expect(CYCLES_SRC).toMatch(/meta:\s*\{\s*version:\s*['"]2022['"]/);
        expect(CYCLES_SRC).toMatch(
            /meta:\s*\{\s*version:\s*['"]EU_2022_2555['"]/,
        );
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

// ─── Control linker — UploadEvidenceModal ───────────────────────

describe('UploadEvidenceModal — control linker', () => {
    it('drops the external controlSearch state (Combobox owns search)', () => {
        expect(UPLOAD_SRC).not.toMatch(/controlSearch/);
    });

    it('drops the external filteredControls memo', () => {
        expect(UPLOAD_SRC).not.toMatch(/filteredControls/);
    });

    it('projects controls into ComboboxOption with annex/code/name folded into label', () => {
        expect(UPLOAD_SRC).toMatch(/controlOptions\s*=\s*useMemo/);
        expect(UPLOAD_SRC).toMatch(
            /`\$\{c\.annexId \|\| c\.code \|\| 'Custom'\}: \$\{c\.name\}`/,
        );
    });

    it('surfaces the control count in the FormField description', () => {
        // The control-count description migrated to next-intl; assert the
        // key branch is wired and the en value still reads "Search across …".
        expect(UPLOAD_SRC).toMatch(
            /controls\.length\s*===\s*0[\s\S]{0,160}searchControlsDesc/,
        );
        const en = JSON.parse(readRaw('messages/en.json')) as {
            evidence: { upload: Record<string, string> };
        };
        expect(en.evidence.upload.searchControlsDesc).toMatch(/Search across/);
    });
});

// ─── Control linker — NewEvidenceTextModal ──────────────────────

describe('NewEvidenceTextModal — control linker', () => {
    it('projects controls into ComboboxOption', () => {
        expect(TEXT_EV_SRC).toMatch(/controlOptions\s*=\s*useMemo/);
        expect(TEXT_EV_SRC).toMatch(
            /`\$\{c\.annexId \|\| c\.code \|\| 'Custom'\}: \$\{c\.name\}`/,
        );
    });

    it('wires setSelected into the update(controlId) reducer', () => {
        expect(TEXT_EV_SRC).toMatch(
            /setSelected=\{\(option\)\s*=>\s*[\s\S]{0,80}update\(['"]controlId['"],\s*option\?\.value\s*\?\?\s*['"]['"]\)/,
        );
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
