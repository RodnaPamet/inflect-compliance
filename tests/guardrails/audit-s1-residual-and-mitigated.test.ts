/**
 * Audit Coherence S1 (2026-05-22) — structural ratchet locking the
 * three gap closures: residual score, MITIGATED enum, ownership-
 * transfer audit event.
 *
 * The unit + integration tests verify runtime behaviour; this
 * structural test guards the SCHEMA + the strategy-mapping so a
 * future "simplify" PR doesn't quietly revert the audit findings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { braceBlockAfter } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit S1 — Risk lifecycle & treatment plans', () => {
    describe('schema', () => {
        const enums = read('prisma/schema/enums.prisma');
        const compliance = readPrismaSchema();

        it('RiskStatus enum carries MITIGATED', () => {
            // Match the enum block + the literal value inside.
            expect(enums).toMatch(/enum RiskStatus\s*\{[\s\S]*?\bMITIGATED\b[\s\S]*?\}/);
        });

        it('Risk model carries `residualScore` (nullable Int)', () => {
            // `residualScore Int?` is declared by Risk AND RiskSnapshot, so
            // the whole-schema form held with the column absent from Risk —
            // the model this test names.
            expect(braceBlockAfter(compliance, 'model Risk\\s*\\{'))
                .toMatch(/residualScore\s+Int\?/);
        });

        it('Risk model carries `residualScoreSetAt` (nullable DateTime)', () => {
            expect(compliance).toMatch(/residualScoreSetAt\s+DateTime\?/);
        });

        it('migration SQL exists for the audit S1 changes', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524100000_audit_s1_risk_residual_and_mitigated',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            );
            expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'MITIGATED'/);
            expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "residualScore"/);
        });
    });

    describe('usecase wiring', () => {
        const src = read('src/app-layer/usecases/risk-treatment-plan.ts');

        it('riskStatusForCompletedStrategy maps MITIGATE → MITIGATED (not CLOSED)', () => {
            // Match: case 'MITIGATE': return 'MITIGATED'
            expect(src).toMatch(
                /case\s+['"]MITIGATE['"]\s*:\s*\n?\s*return\s+['"]MITIGATED['"]/,
            );
            // Defensive — the old CLOSED return should be gone for MITIGATE.
            expect(src).not.toMatch(
                /case\s+['"]MITIGATE['"]\s*:\s*\n?\s*return\s+['"]CLOSED['"]/,
            );
        });

        it('residualForCompletedStrategy is defined and covers all 4 strategies (RQ2-2 derivation)', () => {
            // RQ2-2 replaced the divisor-era
            // `residualScoreForCompletedStrategy` with the control-
            // derived `residualForCompletedStrategy`: AVOID → semantic
            // zero, MITIGATE → derived from linked-control
            // effectiveness, TRANSFER/ACCEPT → no auto-write (null).
            expect(src).toMatch(/function residualForCompletedStrategy/);
            expect(src).toMatch(/strategy === 'AVOID'/);
            expect(src).toMatch(/strategy !== 'MITIGATE'/);
            expect(src).toMatch(/loadResidualSuggestion/);
            // Status mapping still covers all four strategies.
            expect(src).toMatch(/case\s+['"]MITIGATE['"]/);
            expect(src).toMatch(/case\s+['"]ACCEPT['"]/);
            expect(src).toMatch(/case\s+['"]TRANSFER['"]/);
            expect(src).toMatch(/case\s+['"]AVOID['"]/);
        });

        it('completePlan reads `score` + `residualScore` from the risk for the residual computation', () => {
            // The risk read needs both fields; without them the
            // residual write would be undefined behaviour.
            expect(src).toMatch(/score:\s*true/);
            expect(src).toMatch(/residualScore:\s*true/);
        });

        it('completePlan writes the derived decomposed residual + residualScoreSetAt on the risk update', () => {
            expect(src).toMatch(/residualLikelihood:\s*derived\.residualLikelihood/);
            expect(src).toMatch(/residualImpact:\s*derived\.residualImpact/);
            expect(src).toMatch(/residualScore:\s*derived\.residualScore/);
            expect(src).toMatch(/residualScoreSetAt:\s*now/);
        });

        it('transferTreatmentPlanOwnership is exported', () => {
            expect(src).toMatch(
                /export async function transferTreatmentPlanOwnership/,
            );
        });

        it('transferTreatmentPlanOwnership emits the dedicated audit action', () => {
            expect(src).toMatch(/['"]TREATMENT_PLAN_OWNERSHIP_TRANSFERRED['"]/);
        });

        it('transferTreatmentPlanOwnership audit row carries before/after + reason', () => {
            // The audit log call inside the function must structure
            // the from/to user pair + the rationale.
            expect(src).toMatch(/before:\s*\{\s*ownerUserId:/);
            expect(src).toMatch(/after:\s*\{[\s\S]*ownerUserId:[\s\S]*reason:/);
        });
    });

    describe('schema input', () => {
        const src = read(
            'src/app-layer/schemas/risk-treatment-plan.schemas.ts',
        );

        it('TransferOwnershipSchema requires newOwnerUserId + reason', () => {
            expect(src).toMatch(/export const TransferOwnershipSchema/);
            expect(src).toMatch(/newOwnerUserId:/);
            // `reason` uses the TextField alias (the non-empty + max
            // length + trim shape).
            expect(src).toMatch(/reason:\s*TextField/);
        });
    });
});
