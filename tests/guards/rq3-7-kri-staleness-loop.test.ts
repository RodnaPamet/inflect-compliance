/**
 * RQ3-7 — "KRI ⇄ assessment loop: sensors finally update beliefs"
 * ratchet.
 *
 * RQ-6's KRIs were sensors wired to nothing — a breached indicator
 * changed no conclusion anywhere. This ratchet locks the loop shut:
 *
 *   - SIGNAL_MOVED is a first-class staleness reason in the pure
 *     detector, gated on a KRI breach NEWER than the last assessment
 *     (no-noise: a stale breach the belief already absorbed doesn't
 *     fire; un-breaching clears it);
 *   - the staleness loader feeds the breach signal from the KRI
 *     readings, batched (no per-risk read);
 *   - the Assessment tab carries the re-assess nudge;
 *   - the KRI page deep-links a breached, risk-linked KRI to that
 *     risk's Assessment tab, and the detail page honours `?tab=`.
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
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
// The user-facing copy lives in the i18n catalogue, not in the component, so it
// is READ RAW and PARSED — `codeOf` lexes TypeScript and a JSON catalogue is not
// that language. See the nudge assertion below for why this matters.
const messages = JSON.parse(readRaw('messages/en.json')) as Record<string, any>;

const lib = read('src/lib/risk-staleness.ts');
const loader = read('src/app-layer/usecases/risk-staleness.ts');
const kriUsecase = read('src/app-layer/usecases/key-risk-indicator.ts');
const breachRoute = read('src/app/api/t/[tenantSlug]/risks/[id]/kri-breaches/route.ts');
const assessmentPanel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');
const kriPage = read('src/app/t/[tenantSlug]/(app)/risks/kri/page.tsx');
const detailPage = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');

describe('RQ3-7 — SIGNAL_MOVED is a first-class staleness reason', () => {
    test('the pure detector adds the reason + its signal + description', () => {
        expect(lib).toMatch(/'SIGNAL_MOVED'/);
        expect(lib).toMatch(/latestKriBreachAt: Date \| null/);
        expect(lib).toMatch(/reasons\.push\('SIGNAL_MOVED'\)/);
        expect(lib).toMatch(/a key risk indicator breached since the last assessment/);
    });

    test('the no-noise gate: breach must be newer than the last assessment', () => {
        // Either never assessed (live signal against no conclusion) or
        // the breach post-dates the most recent assessment.
        expect(lib).toMatch(/signals\.lastAssessedAt === null \|\|\s*signals\.latestKriBreachAt > signals\.lastAssessedAt/);
    });
});

describe('RQ3-7 — the loader feeds the breach signal, batched', () => {
    test('latest currently-RED KRI reading per risk, via groupBy (no per-risk read)', () => {
        expect(loader).toMatch(/loadLatestKriBreaches/);
        expect(loader).toMatch(/kriReading\.groupBy/);
        expect(loader).toMatch(/ragStatus !== 'RED'/);
        expect(loader).toMatch(/latestKriBreachAt: latestKriBreachByRisk\.get\(r\.id\)/);
    });
});

describe('RQ3-7 — the loop surfaces in the UI', () => {
    test('the KRI usecase exposes per-risk breaches for the nudge', () => {
        expect(kriUsecase).toMatch(/export async function getRiskKriBreaches/);
        expect(kriUsecase).toMatch(/ragStatus: 'RED'/);
        expect(breachRoute).toMatch(/getRiskKriBreaches/);
        expect(breachRoute).toMatch(/export const GET = withApiErrorHandling/);
    });

    test('the Assessment tab renders the re-assess nudge from the breach signal', () => {
        expect(assessmentPanel).toMatch(/kri-breaches/);
        expect(assessmentPanel).toMatch(/kri-reassess-nudge/);
        // The panel must REFERENCE the copy, and the copy must SAY to re-assess.
        //
        // This was one assertion, `expect(assessmentPanel).toMatch(/re-assess/i)`,
        // and it was satisfied ONLY by comments (#2246 Class A). Every occurrence
        // of "re-assess" in RiskAssessmentPanel.tsx is a comment — two `//` lines
        // and one `{/* */}` block; the sole code artefact is the testid
        // `kri-reassess-nudge`, which has no hyphen and so never matched. The copy
        // is `t('assessment.kriNudge')`, i.e. it lives in the catalogue, so that
        // assertion was structurally incapable of checking what it named. Masking
        // the read seam is what surfaced it.
        //
        // Split in two so each half can fail for its own reason: unwire the nudge
        // from the key and the first fails; reword the copy so it no longer tells
        // the user to re-assess and the second fails.
        expect(assessmentPanel).toMatch(/t\('assessment\.kriNudge'\)/);
        expect(messages.risks.assessment.kriNudge).toMatch(/re-assess/i);
    });

    test('the KRI page deep-links a breached, risk-linked KRI to the assessment tab', () => {
        expect(kriPage).toMatch(/riskId: string \| null/);
        expect(kriPage).toMatch(/k\.latestReading\?\.ragStatus === 'RED'/);
        expect(kriPage).toMatch(/\/risks\/\$\{k\.riskId\}\?tab=assessment/);
        expect(kriPage).toMatch(/kri-reassess-link-/);
    });

    test('the risk detail page honours the ?tab= deep-link', () => {
        expect(detailPage).toMatch(/useSearchParams/);
        expect(detailPage).toMatch(/searchParams\?\.get\('tab'\)/);
        expect(detailPage).toMatch(/useState<Tab>\(initialTab\)/);
    });
});
