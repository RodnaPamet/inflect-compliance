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
 *   - the panel drifting off the tenant's matrix language or the
 *     RQ2-2 "propose, don't overwrite" contract (accept POST must
 *     never carry score values).
 */

import * as fs from 'fs';
import * as path from 'path';
import { declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const page = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const panel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');

// B3-2: the two blocks below used to slice from one declaration to the NEXT
// ONE BY NAME — `panel.indexOf('const acceptSuggestion')` to
// `panel.indexOf('const saveResidualOverride')`. Swapping the order of two
// unrelated functions produced a backwards slice, which is silently empty,
// so the `not.toMatch` assertions passed vacuously; renaming the neighbour
// broke the build outright.

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

    test('the panel speaks the tenant matrix language', () => {
        // Levels are labelled from RiskMatrixConfig, bands resolved
        // via the canonical resolver — not hardcoded vocab. The config
        // is supplied by the parent as a prop (no independent re-fetch).
        expect(panel).toMatch(/matrixConfig: RiskMatrixConfigShape/);
        expect(panel).toMatch(/levelLabels/);
        expect(panel).toMatch(/resolveBandForScore/);
    });

    test('accept stays propose-don’t-overwrite: the POST body carries only a justification', () => {
        const acceptBlock = declarationOf(panel, 'acceptSuggestion');
        expect(acceptBlock).toMatch(/JSON\.stringify\(\{ justification/);
        for (const banned of ['residualScore', 'residualLikelihood', 'residualImpact', 'effectiveness']) {
            expect(acceptBlock).not.toMatch(new RegExp(`${banned}\\s*:`));
        }
    });

    test('manual residual override sends decomposed dims + justification — never a rollup score', () => {
        const overrideBlock = declarationOf(panel, 'saveResidualOverride');
        expect(overrideBlock).toMatch(/residualLikelihood,/);
        expect(overrideBlock).toMatch(/residualImpact,/);
        expect(overrideBlock).toMatch(/scoreJustification/);
        expect(overrideBlock).not.toMatch(/residualScore\s*:/);
    });
});
