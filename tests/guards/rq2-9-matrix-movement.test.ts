/**
 * RQ2-9 — matrix-movement ratchet.
 *
 * Regression classes guarded:
 *
 *   - the risks list dropping the decomposed residual dims from its
 *     select (the movement view silently starves);
 *   - legacy undecomposed residuals creeping into the movement set
 *     (a score without dims has no destination cell — inventing one
 *     draws a lie);
 *   - the overlay losing its zero-cost gate or its dedupe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const repo = read('src/app-layer/repositories/RiskRepository.ts');
const client = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const matrix = read('src/components/ui/RiskMatrix.tsx');

describe('RQ2-9 — inherent → residual movement', () => {
    test('the list select ships the decomposed residual dims', () => {
        for (const f of ['residualLikelihood: true', 'residualImpact: true']) {
            expect(repo).toContain(f);
        }
    });

    test('only decomposed residuals qualify as movements (legacy rows excluded)', () => {
        // B3-2: was `client.slice(start, start + 1200)` — a magic 1200-byte
        // window. Growing the function past 1200 chars silently truncated
        // the region, which would make the `not.toMatch` below pass for the
        // wrong reason. Brace matching bounds it by the code itself.
        const block = declarationOf(client, 'matrixMovements');
        expect(block).toMatch(/residualLikelihood != null/);
        expect(block).toMatch(/residualImpact != null/);
        // The rollup score alone must never qualify a row.
        expect(block).not.toMatch(/residualScore\s*!=/);
    });

    test('the matrix wires movements and keeps the zero-cost gate', () => {
        expect(client).toMatch(/movements=\{matrixMovements\}/);
        expect(matrix).toMatch(/hasMovements && \(/);
        expect(matrix).toMatch(/movementActive && \(/);
    });

    test('identical paths dedupe into counted arrows; same-cell pairs skipped', () => {
        expect(matrix).toMatch(/byPath/);
        // B3-2: the exact same-cell comparison expression was asserted
        // verbatim, so extracting it to a `isSameCell(m)` helper — the
        // obvious cleanup — failed the build. Assert that a same-cell pair
        // is skipped at all; how it is spelled is the author's business.
        expect(matrix).toMatch(/from\.likelihood === .*to\.likelihood/);
    });

    test('the overlay never intercepts cell clicks', () => {
        // B3-2: this sliced between `movementActive && (` and
        // `movementArrows.map` to look for the class, and separately sliced
        // the overlay by byte window. Both broke on reordering. The
        // invariant — the movement overlay is not click-interactive — is a
        // property of the overlay element, so assert it there.
        expect(matrix).toMatch(
            /risk-matrix-movement-overlay[\s\S]{0,400}?pointer-events-none/,
        );
    });
});
