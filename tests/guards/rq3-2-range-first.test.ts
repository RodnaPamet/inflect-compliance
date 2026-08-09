/**
 * RQ3-2 — "range-first estimation" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the FAIR panel regrowing raw point inputs for loss/frequency
 *     factors (the false-precision ritual this PR removed): every
 *     factor renders as a min/likely/max triple, the calibrated-
 *     interval legend stays, and the derived PERT mean is shown —
 *     never asked;
 *   - the backward-compatible round-trip breaking: legacy point
 *     values must keep seeding degenerate triples, and the
 *     distributions write path must keep deriving the point columns
 *     from PERT means;
 *   - the engine-safety canonicalisation (sort-on-write) silently
 *     dropped — a mode outside [min, max] would NaN the simulator's
 *     triangular inverse-CDF;
 *   - the stale-triple guard on the legacy point path vanishing —
 *     the simulator would prefer ranges the points have moved past.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const panel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel.tsx');
// The panel's user-facing strings were migrated to next-intl; resolve
// the moved literals against the en catalog so the intent still holds.
const en = JSON.parse(read('messages/en.json')) as {
    risks: { fair: Record<string, string> };
};
const lib = read('src/lib/fair-calibration.ts');
const usecase = read('src/app-layer/usecases/risk.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/[id]/fair/route.ts');
// B2-4 — implementation moved to src/lib/fair-math.ts (the app-layer path
// is now a re-export shim). See tests/guards/no-usecase-imports-in-client.
const calculator = read('src/lib/fair-math.ts');

describe('RQ3-2 — ranges replace point floats in the panel', () => {
    test('every factor renders the min/likely/max triple inputs', () => {
        expect(panel).toMatch(/fair-triple-\$\{k\}-\$\{b\}/);
        expect(panel).toMatch(/bound\(k, 'min', t\('fair\.min'\)\)/);
        expect(panel).toMatch(/bound\(k, 'mode', t\('fair\.likely'\)\)/);
        expect(panel).toMatch(/bound\(k, 'max', t\('fair\.max'\)\)/);
        // the bound labels still read Min/Likely/Max in the default locale
        expect(en.risks.fair.min).toBe('Min');
        expect(en.risks.fair.likely).toBe('Likely');
        expect(en.risks.fair.max).toBe('Max');
    });

    test('no raw point input remains for loss/frequency factors', () => {
        // The point-era field() renderer and its per-field labels are
        // gone; the only Input rendering goes through bound().
        for (const banned of [
            "field('Contact frequency'",
            "field('TEF (override)'",
            "field('PLM (flat override)'",
            "field('Threat capability'",
        ]) {
            expect(panel).not.toContain(banned);
        }
        const inputCount = (panel.match(/<Input\b/g) ?? []).length;
        // 1 = the single bound() PERT-triple renderer for the loss/frequency
        // FACTORS (the guard's concern). +1 (PR-L) = the secondary-loss
        // monetary editor (regulatory fine / reputation / competitive), which
        // are single POINT estimates by nature — not distributions — so a
        // plain Input is correct there and does NOT reintroduce point inputs
        // for the PERT factors this guard protects.
        expect(inputCount).toBe(2);
    });

    test('the calibrated-interval language is the legend', () => {
        // The legend copy moved into the catalog; the panel renders the key.
        expect(panel).toMatch(/t\('fair\.intro'\)/);
        expect(en.risks.fair.intro).toMatch(/90% sure/);
    });

    test('the point estimate is derived (PERT mean) — shown, not asked', () => {
        expect(panel).toMatch(/pertMean/);
        expect(panel).toMatch(/fair-derived-/);
        expect(calculator).toMatch(/export function pertMean/);
        // B3-2: the literal formula `(d.min + 4 * d.mode + d.max) / 6` used
        // to be asserted here. A mathematically identical reordering — or
        // hoisting the weight to a named constant — failed the build, while
        // tests/unit/fair-calculator.test.ts already proves pertMean
        // NUMERICALLY. A source regex cannot check arithmetic; only running
        // it can.
    });

    test('legacy point values migrate as degenerate triples (round-trip)', () => {
        expect(panel).toMatch(/export function seedTriples/);
        expect(panel).toMatch(/min: v, mode: v, max: v/);
        // Sub-factor information folds into the seeds.
        expect(panel).toMatch(/computeTEF\(initial\.contactFrequency, initial\.probabilityOfAction\)/);
        expect(panel).toMatch(/computeVulnerability\(initial\.threatCapability, initial\.controlStrength\)/);
    });
});

describe('RQ3-2 — reflections + warnings cover the triple shape', () => {
    test('reflectTriple exists and calls out wide spreads', () => {
        expect(lib).toMatch(/export function reflectTriple/);
        expect(lib).toMatch(/× spread; anchor it with a reference event/);
    });

    test('validatePertTriple is wired live via validateFairTriples', () => {
        expect(lib).toMatch(/export function validateFairTriples/);
        expect(lib).toMatch(/validatePertTriple\(label, t\)/);
        expect(panel).toMatch(/validateFairTriples\(triples\)/);
    });
});

describe('RQ3-2 — the write path', () => {
    test('the route accepts the five calibrated ranges', () => {
        expect(route).toMatch(/distributions:/);
        for (const f of ['tef', 'vulnerability', 'plm', 'slef', 'slm']) {
            expect(route).toMatch(new RegExp(`${f}: triple`));
        }
    });

    test('the distributions path persists triples + derives the point columns', () => {
        expect(usecase).toMatch(/threatEventFrequency: tef \? pertMean\(tef\) : null/);
        expect(usecase).toMatch(/primaryLossMagnitude: plm \? pertMean\(plm\) : null/);
        expect(usecase).toMatch(/vulnerabilityProbability: vuln \? clamp01\(pertMean\(vuln\)\) : null/);
    });

    test('triples are canonicalised (sorted) before persisting — simulator safety', () => {
        expect(usecase).toMatch(/function normalizeTriple/);
        expect(usecase).toMatch(/\[t\.min, t\.mode, t\.max\]\.sort\(\(a, b\) => a - b\)/);
    });

    test('a legacy numeric point write clears stale stored triples', () => {
        expect(usecase).toMatch(/hasPointWrite/);
        expect(usecase).toMatch(/Prisma\.DbNull/);
    });
});
