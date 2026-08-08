/**
 * RQ3-8 — "Mitigation ROI: what does €1 of control buy?" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the model losing its honest-null contract (a fabricated 0×
 *     ratio for an un-priced or un-quantified control would surface
 *     as "free value", inviting buyers to spend more);
 *   - the schema dropping `Control.annualCost` (the field that
 *     makes the ratio computable in the first place);
 *   - the loader regressing into a per-control loop (N+1 on a
 *     leaderboard widget pulls the page);
 *   - the best-value endpoint losing its `take:` bound or growing
 *     a mutation verb (it is GET, leaderboard-shaped, capped);
 *   - the UI gap nudge disappearing (a verdict that is not ok
 *     MUST render `describeRoiGap` text — never silently render
 *     nothing).
 */

import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const pure = read('src/lib/control-roi.ts');
const usecase = read('src/app-layer/usecases/control/roi.ts');
const roiRoute = read('src/app/api/t/[tenantSlug]/controls/[controlId]/roi/route.ts');
const bestValueRoute = read('src/app/api/t/[tenantSlug]/controls/best-value/route.ts');
const schema = readPrismaSchema();
const updateSchema = read('src/lib/schemas/index.ts');
const card = read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/_components/ControlRoiCard.tsx');
const leaderboard = read('src/app/t/[tenantSlug]/(app)/controls/_components/BestValueControls.tsx');
const editModal = read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/_modals/EditControlModal.tsx');
// The ROI card's user-facing copy moved to next-intl; resolve moved
// literals against the en catalog.
const enControls = JSON.parse(read('messages/en.json')).controls as {
    roi: Record<string, string>;
};

describe('RQ3-8 — the model holds its honest-null contract', () => {
    test('every non-ok branch carries a typed reason — never a fabricated number', () => {
        // The three reason sentinels each exist as string literals.
        expect(pure).toMatch(/'NO_COST'/);
        expect(pure).toMatch(/'NO_EFFECTIVENESS'/);
        expect(pure).toMatch(/'NO_QUANT_RISKS'/);
        // Every failure path returns `ok: false` with a reason, not
        // an `aleProtected: 0` row.
        expect(pure).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'NO_COST'/);
        expect(pure).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'NO_EFFECTIVENESS'/);
        expect(pure).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'NO_QUANT_RISKS'/);
    });

    test('rankByRoi drops non-ok verdicts (no synthetic-zero contamination)', () => {
        // The filter that keeps only ok-verdicts MUST be present —
        // a future "stable order" refactor must not slot un-priced
        // controls in at the bottom with roi=0.
        expect(pure).toMatch(/\.filter\(.*verdict\.ok.*\)/);
        expect(pure).toMatch(/\.sort\(\(a, b\) => b\.result\.roiMultiple - a\.result\.roiMultiple\)/);
        expect(pure).toMatch(/\.slice\(0, limit\)/);
    });

    test('describeRoiGap covers all three reasons', () => {
        expect(pure).toMatch(/case 'NO_COST':/);
        expect(pure).toMatch(/case 'NO_EFFECTIVENESS':/);
        expect(pure).toMatch(/case 'NO_QUANT_RISKS':/);
    });
});

describe('RQ3-8 — the schema slot exists', () => {
    test('Control.annualCost is a nullable Float (matches the existing money-field pattern)', () => {
        expect(schema).toMatch(/annualCost\s+Float\?/);
    });

    test('UpdateControlSchema accepts annualCost (nullable, non-negative)', () => {
        expect(updateSchema).toMatch(/annualCost: z\.number\(\)\.nonnegative\(\)\.optional\(\)\.nullable\(\)/);
    });
});

describe('RQ3-8 — the loader stays batched + bounded', () => {
    test('the portfolio loader issues ONE findMany over the register, with a take: bound', () => {
        // The leaderboard fetch is bounded — no unbounded findMany.
        expect(usecase).toMatch(/db\.control\.findMany/);
        expect(usecase).toMatch(/take:\s*\d+/);
        // Hard cap exists so a caller cannot pass `limit: 1e6`.
        expect(usecase).toMatch(/BEST_VALUE_HARD_CAP/);
    });

    test('no awaited db read inside a loop (no N+1 on the leaderboard path)', () => {
        // Mirrors the RQ2-8 / RQ3-7 brace-aware helper — match
        // loop HEADERS, walk to matching close brace, scan the body.
        const NO_AWAIT_DB_IN_LOOP = (src: string): boolean => {
            const headerRe = /\b(?:for|while)\s*\(/g;
            let m: RegExpExecArray | null;
            while ((m = headerRe.exec(src)) !== null) {
                const i = m.index;
                const brace = src.indexOf('{', i);
                if (brace === -1) break;
                let depth = 1;
                let j = brace + 1;
                for (; j < src.length && depth > 0; j++) {
                    if (src[j] === '{') depth++;
                    else if (src[j] === '}') depth--;
                }
                const body = src.slice(brace + 1, j - 1);
                if (/await\s+db\./.test(body)) return false;
                headerRe.lastIndex = brace + 1;
            }
            return true;
        };
        expect(NO_AWAIT_DB_IN_LOOP(usecase)).toBe(true);
    });
});

describe('RQ3-8 — the endpoints stay read-only', () => {
    test('the single-control roi endpoint is GET-only', () => {
        expect(roiRoute).toMatch(/export const GET = withApiErrorHandling/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(roiRoute).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });

    test('the best-value endpoint is GET-only and reads the limit param', () => {
        expect(bestValueRoute).toMatch(/export const GET = withApiErrorHandling/);
        expect(bestValueRoute).toMatch(/searchParams\.get\('limit'\)/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(bestValueRoute).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });
});

describe('RQ3-8 — the UI honours honest-null', () => {
    test('the detail card renders the typed gap nudge when verdict is not ok', () => {
        expect(card).toMatch(/describeRoiGap/);
        expect(card).toMatch(/data-testid="control-roi-gap"/);
        // The "ROI is null on purpose" line is part of the contract —
        // it tells the buyer the absence is honest, not a bug.
        // (migrated to next-intl — the card renders the key, the copy
        // lives in the catalog.)
        expect(card).toMatch(/roi\.gapSubline/);
        expect(enControls.roi.gapSubline).toMatch(/ROI is null on purpose/);
    });

    test('the leaderboard renders an empty-state, never a zero-row list', () => {
        expect(leaderboard).toMatch(/data-testid="best-value-controls-empty"/);
        // Honest-null shape: when the API returns [], we say so — we
        // do NOT render `<ol/>` with placeholder rows.
        expect(leaderboard).toMatch(/data\.length === 0/);
    });

    test('the edit modal exposes annualCost so the buyer can price the control', () => {
        expect(editModal).toMatch(/annualCost: string/);
        expect(editModal).toMatch(/data-testid="edit-annual-cost-input"/);
    });
});
