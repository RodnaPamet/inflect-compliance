/**
 * RQ2-7 — calibration-aids ratchet (re-grounded by RQ3-2's
 * range-first panel: the aids now cover calibrated min/likely/max
 * triples instead of point floats — same contracts, new shape).
 *
 * Regression classes guarded:
 *
 *   - the FAIR panel dropping its reflections / warnings / priors
 *     wiring (raw floats again — garbage-in one typo away);
 *   - warnings mutating from advisory into blocking (the save
 *     button must never couple to the validator output);
 *   - the reflection map silently losing a factor (the TS switch in
 *     reflectTriple is exhaustive over FairFactorKey — this test
 *     pins the panel-side coverage);
 *   - accepted AI suggestions losing their AI-source provenance
 *     event (RQ2-1 would silently mis-attribute them again).
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const panel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel.tsx');
const lib = read('src/lib/fair-calibration.ts');
const suggestions = read('src/app-layer/usecases/risk-suggestions.ts');
const detailPage = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');

describe('RQ2-7 — the FAIR panel speaks human', () => {
    test('every calibrated range renders a live reflection', () => {
        expect(panel).toMatch(/reflectTriple/);
        expect(panel).toMatch(/fair-reflection-/);
        // The factorGroup() helper is the single range renderer —
        // every factor flows through it.
        expect(panel).toMatch(/FAIR_FACTOR_KEYS\.map\(\(k\) => factorGroup\(k\)\)/);
    });

    test('warnings are wired and advisory-only (save never couples to them)', () => {
        expect(panel).toMatch(/validateFairTriples/);
        expect(panel).toMatch(/fair-calibration-warnings/);
        // The save button's disabled state depends on `saving` ONLY.
        expect(panel).toMatch(/disabled=\{saving\}/);
        expect(panel).not.toMatch(/disabled=\{[^}]*warnings/);
    });

    test('category priors are wired from the detail page', () => {
        expect(panel).toMatch(/getCategoryPrior/);
        expect(detailPage).toMatch(/category=\{risk\.category\}/);
    });

    test('the reflection switch is exhaustive over the panel factor set', () => {
        // Every FairFactorKey the panel renders must carry a switch
        // arm in reflectTriple (TS enforces exhaustiveness; this pins
        // the union ↔ panel pairing).
        for (const f of ['tef', 'vulnerability', 'plm', 'slef', 'slm']) {
            expect(lib).toMatch(new RegExp(`case '${f}':`));
        }
        expect(panel).toMatch(/FAIR_FACTOR_KEYS/);
        expect(panel).toMatch(/FAIR_FACTOR_LABELS/);
    });
});

describe('RQ2-7 — AI provenance', () => {
    test('applySession records an AI-source inherent event per created risk', () => {
        expect(suggestions).toMatch(/import \{ recordScoreEvent \} from '\.\/risk-score-events'/);
        expect(suggestions).toMatch(/source:\s*'AI'/);
        expect(suggestions).toMatch(/kind:\s*'INHERENT'/);
    });

    test('validators stay pure (no DB, no ctx import in the lib)', () => {
        expect(lib).not.toMatch(/from '@\/lib\/db/);
        expect(lib).not.toMatch(/RequestContext/);
        expect(lib).not.toMatch(/prisma/i);
    });
});
