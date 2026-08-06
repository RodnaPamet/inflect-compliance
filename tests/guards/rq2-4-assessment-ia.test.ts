/**
 * RQ2-4 — guided-assessment IA ratchet.
 *
 * The risk detail page was rationalized from 10 tabs to 8, with a
 * new first-class Assessment surface. The regression classes this
 * guards:
 *
 *   - the Assessment tab silently disappearing (or the panel being
 *     replaced by a bare L/I modal again);
 *   - the demoted tabs creeping back as top-level tabs (the
 *     inherited mappings/tests panels belong under Traceability,
 *     beside the control links they derive from);
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const page = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');

// SCOPE (narrowed 2026-08-06). What remains here is the detail page's
// INFORMATION ARCHITECTURE — which tabs exist, which were demoted under
// Traceability — because that is a property of the page's own composition
// and no panel-level render test can see it. Everything this file used to
// assert about the assessment PANEL moved to
// tests/rendered/risk-assessment-panel.test.tsx, which drives the real
// component. See CLAUDE.md → "Epic-ratchet lifecycle".

describe('RQ2-4 — risk detail IA', () => {
    test('the 8-tab assessment-centric bar (and nothing demoted creeps back)', () => {
        const tabsBlock = page.slice(
            page.indexOf('const tabs:'),
            page.indexOf('];', page.indexOf('const tabs:')),
        );
        for (const key of [
            'overview',
            'assessment',
            'quantification',
            'bowtie',
            'history',
            'tasks',
            'evidence',
            'traceability',
        ]) {
            expect(tabsBlock).toMatch(new RegExp(`key: '${key}'`));
        }
        for (const demoted of ['mappings', 'activity', 'tests']) {
            expect(tabsBlock).not.toMatch(new RegExp(`key: '${demoted}'`));
        }
    });

    test('the page mounts the shell + assessment panel with both bridges', () => {
        expect(page).toMatch(/<EntityDetailLayout/);
        expect(page).toMatch(/<RiskAssessmentPanel/);
        // Quantify + link-controls bridges switch tabs in place.
        expect(page).toMatch(/onQuantify=\{\(\) => setActiveTab\('quantification'\)\}/);
        expect(page).toMatch(/onLinkControls=\{\(\) => setActiveTab\('traceability'\)\}/);
    });

    test('inherited mappings + test plans live under Traceability now', () => {
        const trace = page.slice(
            page.indexOf("activeTab === 'traceability'"),
            page.indexOf("activeTab === 'assessment'"),
        );
        expect(trace).toMatch(/InheritedMappingsPanel/);
        expect(trace).toMatch(/InheritedTestPlansPanel/);
    });

    // B3-4: "the panel speaks the tenant matrix language" is covered by the
    // rendered test's "steppers render the tenant level labels and a live
    // band chip", which asserts the labels a user SEES rather than that
    // three identifiers appear in the file.

    // B3-4: the accept + manual-override request-shape assertions that used
    // to live here are gone. `tests/rendered/risk-assessment-panel.test.tsx`
    // clicks the real buttons and inspects the real request bodies, and its
    // version is STRICTLY STRONGER: it asserts the accept body's keys equal
    // exactly `['justification']`, where this file could only list four
    // field names it hoped were absent. A fifth banned field would have
    // slipped past the regexes and is caught by the rendered test.
});
