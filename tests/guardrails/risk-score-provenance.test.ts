/**
 * RQ2-1 — score-provenance pairing ratchet.
 *
 * The provenance ledger is only trustworthy if EVERY score-changing
 * write also appends a `RiskScoreEvent` in the same transaction. A
 * future "quick fix" that updates `score`/`residualScore` without an
 * event silently breaks explainability (RQ2-3), staleness detection
 * (RQ2-8), and the audit narrative. These structural checks make
 * that regression class fail CI:
 *
 *   1. The two files that own score writes import + call
 *      `recordScoreEvent`.
 *   2. The residual rollup in `updateRisk` is DERIVED via
 *      `calculateRiskScore` — never accepted raw from the caller.
 *   3. The both-or-neither residual contract exists at both layers
 *      (Zod refine + usecase throw).
 *   4. The migration ships RLS (tenant_isolation + insert policy +
 *      superuser_bypass + FORCE) and the MIGRATION-source backfill.
 *   5. Application code never writes `source: 'MIGRATION'` — that
 *      provenance is reserved for the backfill SQL.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MAX_REDUCTION } from '@/lib/risk-residual';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const riskUsecase = read('src/app-layer/usecases/risk.ts');
const planUsecase = read('src/app-layer/usecases/risk-treatment-plan.ts');
const eventsUsecase = read('src/app-layer/usecases/risk-score-events.ts');
const zodSchemas = read('src/lib/schemas/index.ts');
const migration = read('prisma/migrations/20260611100000_rq2_1_score_events/migration.sql');

describe('RQ2-1 — every score write is paired with a provenance event', () => {
    test('risk.ts imports recordScoreEvent and calls it at every scoring site (create, template, update×2)', () => {
        expect(riskUsecase).toMatch(/import \{ recordScoreEvent \} from '\.\/risk-score-events'/);
        const calls = riskUsecase.match(/recordScoreEvent\(/g) ?? [];
        // createRisk + createRiskFromTemplate + updateRisk INHERENT +
        // updateRisk RESIDUAL = 4. Growing is fine; shrinking is the
        // regression this guards.
        expect(calls.length).toBeGreaterThanOrEqual(4);
    });

    test('risk-treatment-plan.ts pairs the residualScore write with a PLAN-source event', () => {
        expect(planUsecase).toMatch(/import \{ recordScoreEvent \} from '\.\/risk-score-events'/);
        expect(planUsecase).toMatch(/source:\s*'PLAN'/);
    });

    test('updateRisk derives residualScore via calculateRiskScore (never accepts a raw rollup)', () => {
        expect(riskUsecase).toMatch(
            /calculateRiskScore\(data\.residualLikelihood,\s*data\.residualImpact,\s*maxScale\)/,
        );
        // The update payload type must NOT accept a caller-supplied
        // residualScore (derived-only contract).
        const updateSig = riskUsecase.slice(
            riskUsecase.indexOf('export async function updateRisk'),
            riskUsecase.indexOf('export async function deleteRisk'),
        );
        expect(updateSig).not.toMatch(/residualScore\?:/);
    });

    test('both-or-neither residual contract enforced at Zod AND usecase layers', () => {
        expect(zodSchemas).toMatch(/residualLikelihood and residualImpact must be supplied together/);
        expect(riskUsecase).toMatch(/residualLikelihood and residualImpact must be supplied together/);
    });

    test('migration carries RLS (isolation + insert + bypass + FORCE) and the backfill', () => {
        expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(migration).toMatch(/CREATE POLICY tenant_isolation ON "RiskScoreEvent"/);
        expect(migration).toMatch(/CREATE POLICY tenant_isolation_insert ON "RiskScoreEvent"/);
        expect(migration).toMatch(/CREATE POLICY superuser_bypass ON "RiskScoreEvent"/);
        // Backfill: INHERENT anchor for every risk + RESIDUAL anchor
        // for divisor-era residual scores.
        expect(migration).toMatch(/'INHERENT'::"RiskScoreEventKind"/);
        expect(migration).toMatch(/'RESIDUAL'::"RiskScoreEventKind"/);
        expect(migration).toMatch(/'MIGRATION'::"RiskScoreEventSource"/);
        expect(migration).toMatch(/WHERE "residualScore" IS NOT NULL/);
    });

    test('application code never writes MIGRATION-source events (reserved for backfill SQL)', () => {
        // The seam's input type excludes it…
        expect(eventsUsecase).toMatch(/Exclude<RiskScoreEventSource, 'MIGRATION'>/);
        // …and no usecase passes the literal.
        for (const src of [riskUsecase, planUsecase, eventsUsecase]) {
            expect(src).not.toMatch(/source:\s*'MIGRATION'/);
        }
    });

    test('ledger writes happen on the in-flight transaction handle (db param), not a fresh client', () => {
        // recordScoreEvent's signature takes PrismaTx; no prisma
        // import means it can't open its own connection.
        expect(eventsUsecase).toMatch(/recordScoreEvent\(\s*db:\s*PrismaTx/);
        expect(eventsUsecase).not.toMatch(/from '@\/lib\/prisma'/);
    });
});

describe('RQ2-2 — control-derived residual (divisors stay dead)', () => {
    const residualLib = read('src/lib/risk-residual.ts');
    const suggestionUsecase = read('src/app-layer/usecases/risk-residual-suggestion.ts');
    const route = read('src/app/api/t/[tenantSlug]/risks/[id]/residual-suggestion/route.ts');

    test('the divisor-era formula cannot return', () => {
        // Identifier gone…
        expect(planUsecase).not.toMatch(/residualScoreForCompletedStrategy/);
        // …and the arbitrary-constant shapes too.
        expect(planUsecase).not.toMatch(/Math\.floor\([A-Za-z.]+ \/ 5\)/);
        expect(planUsecase).not.toMatch(/Math\.floor\([A-Za-z.]+ \/ 10\)/);
        // completePlan derives via the shared loader instead.
        expect(planUsecase).toMatch(/loadResidualSuggestion/);
    });

    test('accepted suggestions land as DERIVED-source ledger events', () => {
        expect(suggestionUsecase).toMatch(/source:\s*'DERIVED'/);
    });

    test('accept recomputes server-side — the route body carries no score values', () => {
        // The POST schema accepts ONLY a justification; any future
        // field that smells like a client-asserted number fails here.
        expect(route).toMatch(/justification:\s*z\.string\(\)/);
        for (const banned of ['residualScore', 'residualLikelihood', 'residualImpact', 'effectiveness']) {
            expect(route).not.toMatch(new RegExp(`${banned}\\s*:\\s*z\\.`));
        }
    });

    test('the combination formula is layered (1 − ∏(1 − e)) with the documented cap', () => {
        // B3-2: this asserted the source TEXT of the constant declaration
        // (`MAX_REDUCTION = 0.8`) and of the accumulator statement
        // (`Survival *= 1 - e`). Neither can tell layered multiplication
        // from addition — only running it can, and
        // tests/unit/risk-residual.test.ts does exactly that ("three 60%
        // preventive controls cap at MAX_REDUCTION (0.8), not 93.6%"), which
        // is the whole point of the formula. Assert the exported value here
        // and leave the arithmetic to the arithmetic test.
        expect(MAX_REDUCTION).toBe(0.8);
    });

    test('the derived rollup goes through calculateRiskScore (one scoring seam)', () => {
        expect(residualLib).toMatch(/calculateRiskScore\(residualLikelihood,\s*residualImpact,\s*maxScale\)/);
    });
});
