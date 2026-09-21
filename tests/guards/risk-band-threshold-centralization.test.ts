/**
 * PR-J — risk-band threshold centralization.
 *
 * The two scoring entry points (create / edit) and the risk DISPLAY
 * surfaces (list badge, detail header chip, Overview score card, the
 * guided assessment, the score explainer, the AI-draft badge, the
 * coverage unmapped-risks mini-table) all used to carry their OWN
 * hardcoded ≤5 / ≤12 / ≤18 (and ≥15 / ≥9) band ladder. Those ladders
 * DISAGREED with the tenant's configured `RiskMatrixConfig` bands — a
 * score could read "Medium" on the detail page and "High" in the
 * matrix for the same number on a custom matrix. That is the
 * correctness bug this ratchet locks shut.
 *
 * Rule: every risk-score → band / tone decision on a risk display
 * surface flows through `resolveBandForScore` / `resolveBandTone` in
 * `src/lib/risk-matrix/scoring.ts` (the sole home of band thresholds,
 * which reads the tenant config). No file under the risk UI surfaces
 * may compare a score-like variable to a band-boundary integer.
 *
 * Out of scope (deliberately NOT scanned): server-side org analytics
 * (`portfolio.ts` filters `inherentScore: { gte: 15 }` as a
 * cross-tenant CISO heuristic, not a per-risk display band) and the
 * canonical band DATA in `risk-matrix/defaults.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.join(__dirname, '..', '..');

// The risk display + scoring surfaces the prompt enumerates. Curated
// (not a broad walk) so the ratchet stays precise and never reaches
// into server analytics or unrelated numeric comparisons.
const SCANNED_PATHS = [
    'src/app/t/[tenantSlug]/(app)/risks',
    'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx',
    'src/app-layer/domain/entity-status-mapping.ts',
];

// A score-like variable compared to a legacy band-boundary integer.
// Matches `score <= 12`, `inherentScore > 5`, `residualScore >= 18`, …
const BAND_LADDER_RE =
    /\b(?:score|inherentScore|residualScore|residualScoreValue|riskScore)\s*(?:<=|>=|<|>)\s*(?:5|9|12|14|15|18)\b/;

function isCommentLine(line: string): boolean {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function walk(abs: string, acc: string[]): void {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.next') continue;
            walk(path.join(abs, e.name), acc);
        }
        return;
    }
    if (/\.(ts|tsx)$/.test(abs) && !/\.test\.(ts|tsx)$/.test(abs)) acc.push(abs);
}

function collectFiles(): string[] {
    const files: string[] = [];
    for (const rel of SCANNED_PATHS) walk(path.join(ROOT, rel), files);
    return files;
}

interface Offence {
    file: string;
    line: number;
    text: string;
}

describe('Risk-band threshold centralization (PR-J)', () => {
    it('no risk display surface hardcodes a band-threshold ladder', () => {
        const offences: Offence[] = [];
        for (const abs of collectFiles()) {
            const rel = path.relative(ROOT, abs);
            const lines = codeOf(fs.readFileSync(abs, 'utf-8')).split('\n');
            lines.forEach((line, i) => {
                if (isCommentLine(line)) return;
                if (BAND_LADDER_RE.test(line)) {
                    offences.push({ file: rel, line: i + 1, text: line.trim() });
                }
            });
        }
        // Surface the offending lines directly in the failure diff —
        // resolve the band via resolveBandForScore / resolveBandTone
        // (src/lib/risk-matrix/scoring.ts), which honours the tenant's
        // RiskMatrixConfig, instead of a hardcoded threshold.
        const rendered = offences.map((o) => `${o.file}:${o.line}  ${o.text}`);
        expect(rendered).toEqual([]);
    });

    it('the detector actually catches a band ladder (self-check)', () => {
        // Guard against a detector that silently matches nothing.
        expect(BAND_LADDER_RE.test('if (score <= 12) return "Medium";')).toBe(true);
        expect(BAND_LADDER_RE.test('inherentScore > 5 ? "attention" : "success"')).toBe(true);
        expect(BAND_LADDER_RE.test('score >= 15 ? error : warning')).toBe(true);
        // …and does NOT flag config-driven / unrelated code.
        expect(BAND_LADDER_RE.test('resolveBandTone(score, config.bands)')).toBe(false);
        expect(BAND_LADDER_RE.test('const pct = score / maxScore;')).toBe(false);
    });

    it('the single band resolver home exports the config-driven helpers', () => {
        const src = codeOf(fs.readFileSync(
            path.join(ROOT, 'src/lib/risk-matrix/scoring.ts'),
            'utf-8',
        ));
        expect(src).toMatch(/export function resolveBandForScore/);
        expect(src).toMatch(/export function resolveBandTone/);
    });
});
