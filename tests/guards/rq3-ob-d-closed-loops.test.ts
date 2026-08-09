/**
 * RQ3-OB-D — Closed loops ratchet (arrow identity, accept feedback,
 * adaptive bridge).
 *
 * Three loops RQ2 opened, closed here. Regression classes guarded:
 *
 *   - Arrow identity: the movement arrow must retain per-path risk
 *     TITLES (not collapse to a bare count) and surface them in a
 *     bounded SVG <title>. A "simplify to count" refactor loses the
 *     identity again.
 *   - Accept feedback: the accept response must carry a
 *     server-composed `summary`, and the panel must fire a toast
 *     from THAT response (never from client draft state).
 *   - Adaptive bridge: the bridge copy must branch on `fairAle` —
 *     "Quantify this risk" when un-quantified, "Review the FAIR
 *     analysis" when a loss estimate already exists.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const matrix = read('src/components/risks/RiskMatrix.tsx');
const pureResidual = read('src/lib/risk-residual.ts');
const acceptUsecase = read('src/app-layer/usecases/risk-residual-suggestion.ts');
const panel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');
const detailPage = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');

describe('RQ3-OB-D — arrows name their risks', () => {
    test('the deduped arrow retains the per-path titles list', () => {
        // The dedup map keeps `titles: string[]`, appended per risk.
        expect(matrix).toMatch(/titles: string\[\]/);
        expect(matrix).toMatch(/cur\.titles\.push\(m\.title\)/);
    });

    test('a bounded title composer exists (top N + overflow tail)', () => {
        expect(matrix).toMatch(/export function movementArrowTitle/);
        expect(matrix).toMatch(/export const MOVEMENT_ARROW_TOOLTIP_MAX = 8/);
        expect(matrix).toMatch(/\+\$\{overflow\} more/);
    });

    test('the arrow renders an SVG <title> and opts back into pointer events', () => {
        expect(matrix).toMatch(/<title>\{tooltip\}<\/title>/);
        expect(matrix).toMatch(/pointerEvents: 'auto'/);
    });
});

describe('RQ3-OB-D — accepting deserves an answer', () => {
    test('the pure one-liner leads with the residual score', () => {
        expect(pureResidual).toMatch(/export function describeAcceptedResidual/);
        expect(pureResidual).toMatch(/`Residual \$\{suggestion\.residualScore\} — /);
    });

    test('the accept usecase returns the server-composed summary', () => {
        expect(acceptUsecase).toMatch(/describeAcceptedResidual\(suggestion, combined\.participatingCount\)/);
        expect(acceptUsecase).toMatch(/summary: describeAcceptedResidual/);
    });

    test('the panel fires a toast from the SERVER response, not client state', () => {
        expect(panel).toMatch(/const toast = useToast\(\)/);
        // The summary read comes off the parsed response body.
        expect(panel).toMatch(/body\?\.accepted\?\.summary/);
        expect(panel).toMatch(/toast\.success\(summary/);
    });
});

describe('RQ3-OB-D — the bridge knows where you have been', () => {
    test('AssessmentRisk carries fairAle', () => {
        expect(panel).toMatch(/fairAle\?: number \| null/);
    });

    test('the bridge copy branches on fairAle', () => {
        // The copy now goes through i18n; the branch still keys on fairAle,
        // and the keys resolve to the original English in en.json.
        expect(panel).toMatch(/risk\.fairAle != null\s*\?\s*t\('assessment\.reviewFair'\)\s*:\s*t\('assessment\.quantify'\)/);
        const en = JSON.parse(read('messages/en.json'));
        expect(en.risks.assessment.reviewFair).toBe('Review the FAIR analysis');
        expect(en.risks.assessment.quantify).toBe('Quantify this risk');
    });

    test('the detail page plumbs fairAle into the panel', () => {
        expect(detailPage).toMatch(/fairAle: risk\.fairAle/);
    });
});
