/**
 * Audit Coherence S2 (2026-05-22) — structural ratchet locking the
 * three Control Framework & Testing gap closures:
 *
 *   1. Rolling pass-rate metric (`computeControlEffectivenessMap`).
 *   2. `ARCHIVED` terminal state on `TestPlanStatus`.
 *   3. Inline OVERDUE-semantics documentation in `control-test.ts`.
 *
 * Pure static analysis — no DB, no mounts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** Raw file text — only for the one block below that asserts about a COMMENT. */
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments masked: an assertion about code can never be satisfied by prose. */
const read = (rel: string) => codeOf(readRaw(rel));

describe('Audit S2 — Control Framework & Testing', () => {
    describe('schema', () => {
        const enums = read('prisma/schema/enums.prisma');

        it('TestPlanStatus enum carries ARCHIVED', () => {
            expect(enums).toMatch(/enum TestPlanStatus\s*\{[\s\S]*?\bARCHIVED\b[\s\S]*?\}/);
        });

        it('migration SQL exists for the audit S2 changes', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524110000_audit_s2_testplan_archived',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            );
            expect(sql).toMatch(
                /ADD VALUE IF NOT EXISTS 'ARCHIVED'/,
            );
        });
    });

    describe('control-effectiveness usecase', () => {
        const src = read('src/app-layer/usecases/control/test-plans.ts');

        it('exports `computeControlEffectivenessMap` (the live rolling pass-rate metric)', () => {
            // PR-R — the gated single-control getControlEffectiveness wrapper was
            // removed; computeControlEffectivenessMap is the batched source of
            // truth consumed by health / residual / ROI.
            expect(src).toMatch(/export async function computeControlEffectivenessMap/);
        });

        it('declares the `ControlEffectiveness` return shape', () => {
            expect(src).toMatch(/export interface ControlEffectiveness/);
            // The minimum public surface — passRate / total / passes /
            // fails / inconclusive / windowDays.
            expect(src).toMatch(/passRate:\s*number\s*\|\s*null/);
            expect(src).toMatch(/total:\s*number/);
            expect(src).toMatch(/passes:\s*number/);
            expect(src).toMatch(/fails:\s*number/);
            expect(src).toMatch(/inconclusive:\s*number/);
            expect(src).toMatch(/windowDays:\s*number/);
        });

        it('default window is 90 days', () => {
            expect(src).toMatch(/DEFAULT_EFFECTIVENESS_WINDOW_DAYS\s*=\s*90/);
        });

        it('groups completed runs by `[controlId, result]` (PASS/FAIL/INCONCLUSIVE)', () => {
            // Aggregation is the canonical batched `groupBy(by: ['controlId',
            // 'result'], ...)` — the three result classes counted for N controls
            // in one round trip (consumed by health, residual, and ROI).
            expect(src).toMatch(/groupBy\(/);
            expect(src).toMatch(/by:\s*\[['"]controlId['"],\s*['"]result['"]\]/);
        });

        it('reads only COMPLETED runs and only within the window', () => {
            expect(src).toMatch(/status:\s*['"]COMPLETED['"]/);
            expect(src).toMatch(/executedAt:\s*\{\s*gte:\s*cutoff/);
        });

        it('rounds the pass-rate to a 0..100 integer', () => {
            expect(src).toMatch(/Math\.round\([\s\S]{0,80}100\)/);
        });

        it('exposes the canonical batched signature (tenantId + controlIds)', () => {
            // PR-R — the read-permission gate moved to the real call sites
            // (control-roi / control/health / risk-residual-suggestion); this
            // lower-level batched query takes an explicit tenantId + controlIds
            // and is intentionally ungated.
            expect(src).toMatch(
                /export async function computeControlEffectivenessMap\([\s\S]{0,200}tenantId:\s*string,[\s\S]{0,80}controlIds:\s*string\[\]/,
            );
        });
    });

    describe('OVERDUE semantics — documented divergence', () => {
        // DELIBERATELY raw: this block asserts that a rationale COMMENT is
        // present, so masking comments here would break a correct test.
        const src = readRaw('src/app-layer/usecases/control/test-plans.ts');

        it('the inline rationale comment exists', () => {
            // The comment block explains why TestPlanStatus does NOT
            // carry an OVERDUE value — derived live from `nextDueAt`,
            // distinct from RiskTreatmentPlan's persisted OVERDUE.
            expect(src).toMatch(/OVERDUE semantics/);
            expect(src).toMatch(/nextDueAt\s*<\s*now\(\)/);
            // Reference to the divergence vs treatment plans.
            expect(src).toMatch(/RiskTreatmentPlan/);
        });
    });
});
