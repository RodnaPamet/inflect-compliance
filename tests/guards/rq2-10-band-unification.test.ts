/**
 * RQ2-10 — band-unification ratchet.
 *
 * One sentence of truth: a risk's severity band comes from the
 * tenant's `RiskMatrixConfig` via `resolveBandForScore` — never
 * from a hardcoded threshold ladder. Pre-RQ2-10 the product had
 * FOUR independent ladders (RisksClient Level column, PDF register
 * summary, `getRiskLevel` percentages, `getRiskScoreBand` statics)
 * that silently disagreed the moment a tenant customised bands.
 *
 * This ratchet:
 *   1. pins the two unified surfaces (risks list Level column, PDF
 *      register) to the canonical resolver with zero inline
 *      thresholds;
 *   2. FREEZES the two known legacy holdouts at their current call
 *      sites — `getRiskLevel` (risk-scoring.ts) and
 *      `getRiskScoreBand` (entity-status-mapping.ts) may not gain
 *      new importers. Migrating one off ⇒ lower its cap here in the
 *      same diff.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const pdf = read('src/app-layer/reports/pdf/riskRegister.ts');

/**
 * `execFileSync` (argv form) — bypasses the shell so neither the
 * scan-root path nor the symbol name can be interpreted as shell
 * tokens. Silences CodeQL's
 * `js/shell-command-injection-from-environment`.
 */
function srcImportersOf(symbol: string): string[] {
    let stdout: string;
    try {
        stdout = execFileSync(
            'grep',
            ['-rl', symbol, path.join(ROOT, 'src'), '--include=*.ts', '--include=*.tsx'],
            { encoding: 'utf-8' },
        );
    } catch (e) {
        const err = e as { status: number; stdout?: string };
        if (err.status === 1) stdout = err.stdout ?? '';
        else throw e;
    }
    return stdout.split('\n').filter(Boolean).map((p) => path.relative(ROOT, p)).sort();
}

describe('RQ2-10 — unified surfaces', () => {
    test('the risks list Level column resolves from tenant bands, with no inline ladder', () => {
        expect(risksClient).toMatch(/resolveBandForScore\(score, matrixConfig\.bands\)/);
        // The old ladder shape is gone for good.
        expect(risksClient).not.toMatch(/score <= 5\b/);
        expect(risksClient).not.toMatch(/score <= 12\b/);
        expect(risksClient).not.toMatch(/score <= 18\b/);
    });

    test('the PDF register buckets by tenant bands, with no inline ladder', () => {
        expect(pdf).toMatch(/getRiskMatrixConfig\(ctx\)/);
        expect(pdf).toMatch(/resolveBandForScore\(r\.score, matrix\.bands\)/);
        expect(pdf).not.toMatch(/score >= 15/);
        expect(pdf).not.toMatch(/score >= 8/);
        // Band names render from config, not literals.
        expect(pdf).not.toMatch(/'High \(/);
        expect(pdf).not.toMatch(/'Medium \(/);
    });
});

describe('RQ2-10 — legacy ladders are frozen', () => {
    test('getRiskLevel (fixed-percentage ladder) gains no new importers', () => {
        const importers = srcImportersOf('getRiskLevel').filter(
            (p) => p !== 'src/lib/risk-scoring.ts',
        );
        // Frozen holdouts at unification time (each carries fixed
        // thresholds that pre-date the configurable matrix; migrating
        // one ⇒ remove it here in the same diff):
        //  - none. RisksClient migrated in this PR; the remaining
        //    `getRiskLevel` references in src are the definition file.
        expect(importers).toEqual([]);
    });

    test('getRiskScoreBand (static band map) is fully retired', () => {
        // PR-J migrated the last holdout — the risk detail page — onto
        // the config-driven resolveBandForScore / resolveBandTone, and
        // deleted the static `getRiskScoreBand` ladder from
        // entity-status-mapping.ts. The symbol no longer exists anywhere
        // in src. See tests/guards/risk-band-threshold-centralization.test.ts
        // for the forward ratchet that keeps every risk display surface
        // config-driven.
        expect(srcImportersOf('getRiskScoreBand')).toEqual([]);
    });
});
