/**
 * Epic 55 Prompt 7 — hardening pass contract.
 *
 * Locks in the final migration batch and the architectural doc that
 * guides future contributors:
 *
 *   1. findings/FindingsClient   — severity + type Combobox hideSearch.
 *   2. clauses/ClausesBrowser    — status Combobox hideSearch.
 *   3. policies/new              — category Combobox with search.
 *   4. tasks/new                 — remaining findingSource / gapType /
 *                                  linkEntityType selects migrated.
 *   5. docs/combobox-form-strategy.md exists + covers the decision tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
import { codeOf } from '../helpers/source-blocks';
import { headingLines, mdSection } from '../helpers/markdown-regions';

// #2246 Class A — the mask goes at the READ SEAM, so an assertion cannot be
// satisfied by a comment instead of the code it names. Every read here is TSX.
function readRaw(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function read(rel: string): string {
    return codeOf(readRaw(rel));
}
// #2727 diagnosed the strategy doc correctly and stopped one step short.
// Its assertions' SUBJECT is the document's SHAPE — `## Migrated surfaces`,
// `## Deferred surfaces`, `Adding a new surface — checklist` — so `mdCodeOf`,
// which keeps a document's CODE and blanks its PROSE, deletes exactly the
// thing under test. Measured: all four of those needles go to ZERO through it.
// (The read before that was worse than either choice: `codeOf`, a TypeScript
// lexer, on a markdown file — masked at the call site, prose intact.)
//
// So the fix is the OTHER route — NARROW the read to the region the test
// names, with `tests/helpers/markdown-regions.ts`. The whole document is still
// read once for the size check; each assertion below binds to its own region.
// Measured against the live doc, raw → region:
//
//   the six primitives, in `### ` heading lines under `## When to use each
//     primitive`:   11→1  7→1  3→1  7→1  4→1  3→1
//   `epic55-native-select-ratchet.test.ts` in `## Guardrails`:   3→1
//   the four `##` structure needles, in the level-2 heading lines:  1→1 each
//
// Nothing reaches zero, and the primitives are the point: `<Combobox>`
// appeared ELEVEN times across the document, so the heading naming it could
// be deleted outright and any of the other ten kept this green.
const STRATEGY_HEADING = 'When to use each primitive';

// The severity + type Comboboxes moved from the inline FindingsClient
// form into the CreateFindingModal (2026-06-05). Assert against the
// joined surface — the modal is where the pickers live now.
const FINDINGS_SRC =
    read('src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx');
const CLAUSES_SRC = read(
    'src/app/t/[tenantSlug]/(app)/clauses/ClausesBrowser.tsx',
);
// Modal-form P1 (2026-05-24) — page wrappers decomposed into
// page + extracted form module. Structural assertions resolve
// against the joined surface.
const POLICIES_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/policies/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/NewPolicyModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/_form/useNewPolicyForm.ts');
const TASKS_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/tasks/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm.ts');
const STRATEGY_DOC = readRaw('docs/combobox-form-strategy.md');

// ─── findings severity + type ───────────────────────────────────

describe('findings/FindingsClient — severity + type', () => {
    it('imports Combobox', () => {
        expect(FINDINGS_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it('no native <select> remains', () => {
        expect(FINDINGS_SRC).not.toMatch(/<select\b/);
    });

    it('exposes finding-severity + finding-type ids', () => {
        expect(FINDINGS_SRC).toMatch(/id=["']finding-severity["']/);
        expect(FINDINGS_SRC).toMatch(/id=["']finding-type["']/);
    });

    it('both use hideSearch (≤5 options)', () => {
        const hits = FINDINGS_SRC.match(/hideSearch/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(2);
    });
});

// ─── clauses status ─────────────────────────────────────────────

describe('clauses/ClausesBrowser — status', () => {
    it('imports Combobox', () => {
        expect(CLAUSES_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it('no native <select> remains', () => {
        expect(CLAUSES_SRC).not.toMatch(/<select\b/);
    });

    it('Combobox preserves id="clause-status-select"', () => {
        expect(CLAUSES_SRC).toMatch(
            /<Combobox[\s\S]{0,500}id=["']clause-status-select["']/,
        );
    });

    it('re-runs its options memo when the i18n bundle changes', () => {
        // The option labels come from t('notStarted') etc., so the
        // array must rebuild when `t` swaps locale.
        expect(CLAUSES_SRC).toMatch(/useMemo[\s\S]{0,400}\[t\]/);
    });

    it('passes the status through to updateStatus() as before', () => {
        expect(CLAUSES_SRC).toMatch(
            /setSelected=\{\(o\)\s*=>\s*\{\s*if\s*\(o\)\s*updateStatus\(selected\.id,\s*o\.value\)/,
        );
    });
});

// ─── policies/new category ──────────────────────────────────────

describe('policies/new — category', () => {
    it('imports Combobox + declares POLICY_CATEGORIES as ComboboxOption[]', () => {
        expect(POLICIES_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
        expect(POLICIES_NEW_SRC).toMatch(
            /POLICY_CATEGORIES:\s*ComboboxOption\[\]/,
        );
    });

    it('no native <select> remains', () => {
        expect(POLICIES_NEW_SRC).not.toMatch(/<select\b/);
    });

    it('Combobox uses search (10 options) and preserves id="policy-category-select"', () => {
        expect(POLICIES_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,500}id=["']policy-category-select["']/,
        );
        // searchPlaceholder migrated to next-intl; assert the key + en value.
        expect(POLICIES_NEW_SRC).toMatch(
            /searchPlaceholder=\{t\('new\.categorySearch'\)\}/,
        );
        const enCat = JSON.parse(read('messages/en.json')).policies.new
            .categorySearch as string;
        expect(enCat).toMatch(/^Search categories/);
    });
});

// ─── tasks/new remaining selects ────────────────────────────────

describe('tasks/new — findingSource / gapType / linkEntityType', () => {
    it('zero native <select> remain in tasks/new', () => {
        expect(TASKS_NEW_SRC).not.toMatch(/<select\b/);
    });

    it('preserves finding-source-select / gap-type-select / link-entity-type ids', () => {
        for (const id of [
            'finding-source-select',
            'gap-type-select',
            'link-entity-type',
        ]) {
            expect(TASKS_NEW_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        }
    });

    it('option arrays are typed ComboboxOption[] (no leftover sentinel empty rows)', () => {
        // Moved from static `X_OPTIONS: ComboboxOption[]` maps to
        // `buildXOptions(t): ComboboxOption[]` next-intl factories.
        expect(TASKS_NEW_SRC).toMatch(/buildFindingOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/);
        expect(TASKS_NEW_SRC).toMatch(/buildGapTypeOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/);
        expect(TASKS_NEW_SRC).toMatch(
            /buildLinkEntityOptions\s*=\s*\([^)]*\):\s*ComboboxOption\[\]/,
        );
        // The old sentinel row `{ value: '', label: '— Select source —' }`
        // should be gone; Combobox owns the unset state via placeholder.
        expect(TASKS_NEW_SRC).not.toMatch(
            /\{\s*value:\s*['"]['"]\s*,\s*label:\s*['"]—\s*Select source/,
        );
    });
});

// ─── Strategy doc ───────────────────────────────────────────────

describe('docs/combobox-form-strategy.md', () => {
    it('exists and is non-trivial', () => {
        expect(STRATEGY_DOC.length).toBeGreaterThan(2000);
    });

    it('documents each primitive with a "When to use" section', () => {
        // Bound to the `###` HEADING LINES inside the section this test is
        // named for — which is what "documents each primitive with a section"
        // means. Against the whole document the assertion was satisfied by any
        // passing mention anywhere in it.
        const primitiveHeadings = headingLines(
            mdSection(STRATEGY_DOC, STRATEGY_HEADING),
            3,
        );
        for (const heading of [
            '<Combobox>',
            '<Combobox hideSearch>',
            '<RadioGroup>',
            '<UserCombobox>',
            '<Switch>',
            '<Checkbox>',
        ]) {
            expect(primitiveHeadings).toContain(heading);
        }
    });

    it('lists both migrated surfaces and deferred surfaces', () => {
        // The subject is the level-2 STRUCTURE, so the read is the level-2
        // heading lines: a sentence or a table cell naming a section no longer
        // stands in for the section existing.
        const structure = headingLines(STRATEGY_DOC, 2);
        expect(structure).toMatch(/## Migrated surfaces/i);
        expect(structure).toMatch(/## Deferred surfaces/i);
        expect(structure).toMatch(/## Out of scope/i);
    });

    it('references the ratchet guardrail so contributors find it', () => {
        // Three mentions exist document-wide; the one that makes contributors
        // find it is the one under `## Guardrails`.
        expect(mdSection(STRATEGY_DOC, 'Guardrails')).toContain(
            'epic55-native-select-ratchet.test.ts',
        );
    });

    it('includes the contributor checklist', () => {
        expect(headingLines(STRATEGY_DOC, 2)).toMatch(
            /Adding a new surface — checklist/,
        );
    });
});
