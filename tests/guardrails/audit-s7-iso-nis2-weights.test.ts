/**
 * Audit Coherence S7 (2026-05-27) — structural ratchet locking the
 * per-tenant weight override seam for ISO27001 + NIS2.
 *
 * S5 (2026-05-22) shipped `loadEffectiveWeights(ctx, frameworkKey,
 * defaults)` + a `Tenant.readinessWeightsJson` column, BUT only the
 * GENERIC fallback function (`computeGenericReadiness`) routed
 * through the helper. `computeISO27001Readiness` and
 * `computeNIS2Readiness` continued to read the hardcoded
 * `ISO_WEIGHTS` / `NIS2_WEIGHTS` constants directly — the
 * operator-facing override silently ignored the two frameworks the
 * product actually ships.
 *
 * S7 closes the half-built seam: both functions now `await
 * loadEffectiveWeights(ctx, 'ISO27001', ISO_WEIGHTS)` /
 * `(ctx, 'NIS2', NIS2_WEIGHTS)` and the multiplication sites use
 * the loaded `weights` local rather than the raw constants.
 *
 * The ratchet asserts THREE things:
 *
 *   1. Each `computeX` function contains a `loadEffectiveWeights`
 *      call with its framework key.
 *   2. The multiplication sites use `weights.X` (not the raw
 *      constant). The defaults still exist as fallbacks and as
 *      module-level exports; the test pins that NO line in the
 *      ISO or NIS2 function body multiplies through
 *      `ISO_WEIGHTS.X` / `NIS2_WEIGHTS.X` directly.
 *   3. The breakdown returned to callers reports the EFFECTIVE
 *      weight (the override's `weights.X`), not the static
 *      default — so a per-tenant override is visible in the
 *      response payload.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { codeOf, functionBodyOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");
// Comments masked at the read seam: an assertion about a multiplication site
// must not be satisfiable by prose that merely names `weights.coverage`.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("Audit S7 — ISO + NIS2 routed through loadEffectiveWeights", () => {
    const src = () => read("src/app-layer/usecases/audit-readiness/scoring.ts");

    // Bounded by the function's own braces. The previous hand-rolled slice
    // ended at the `// ─── NIS2 Scoring` COMMENT, which both anchors the guard
    // on prose and cannot survive comment masking.
    function isoBody(): string {
        return functionBodyOf(src(), "computeISO27001Readiness");
    }

    function nis2Body(): string {
        return functionBodyOf(src(), "computeNIS2Readiness");
    }

    describe("computeISO27001Readiness", () => {
        it("awaits loadEffectiveWeights('ISO27001', ISO_WEIGHTS)", () => {
            expect(isoBody()).toMatch(
                /const weights = await loadEffectiveWeights\(\s*ctx,\s*['"]ISO27001['"],\s*ISO_WEIGHTS\s*\)/,
            );
        });
        it("multiplication sites use `weights.X`, not `ISO_WEIGHTS.X`", () => {
            const body = isoBody();
            // The five weighted dimensions.
            for (const key of [
                "coverage",
                "implementation",
                "evidence",
                "tasks",
                "issues",
            ]) {
                expect(body).toMatch(new RegExp(`\\* weights\\.${key}\\b`));
                expect(body).not.toMatch(
                    new RegExp(`\\* ISO_WEIGHTS\\.${key}\\b`),
                );
            }
        });
        it("breakdown reports effective weights (`weight: weights.X`)", () => {
            const body = isoBody();
            for (const key of [
                "coverage",
                "implementation",
                "evidence",
                "tasks",
                "issues",
            ]) {
                expect(body).toMatch(new RegExp(`weight:\\s*weights\\.${key}\\b`));
                expect(body).not.toMatch(
                    new RegExp(`weight:\\s*ISO_WEIGHTS\\.${key}\\b`),
                );
            }
        });
    });

    describe("computeNIS2Readiness", () => {
        it("awaits loadEffectiveWeights('NIS2', NIS2_WEIGHTS)", () => {
            expect(nis2Body()).toMatch(
                /const weights = await loadEffectiveWeights\(\s*ctx,\s*['"]NIS2['"],\s*NIS2_WEIGHTS\s*\)/,
            );
        });
        it("multiplication sites use `weights.X`, not `NIS2_WEIGHTS.X`", () => {
            const body = nis2Body();
            for (const key of [
                "coverage",
                "evidence",
                "policies",
                "issues",
            ]) {
                expect(body).toMatch(new RegExp(`\\* weights\\.${key}\\b`));
                expect(body).not.toMatch(
                    new RegExp(`\\* NIS2_WEIGHTS\\.${key}\\b`),
                );
            }
        });
        it("breakdown reports effective weights (`weight: weights.X`)", () => {
            const body = nis2Body();
            for (const key of [
                "coverage",
                "evidence",
                "policies",
                "issues",
            ]) {
                expect(body).toMatch(new RegExp(`weight:\\s*weights\\.${key}\\b`));
                expect(body).not.toMatch(
                    new RegExp(`weight:\\s*NIS2_WEIGHTS\\.${key}\\b`),
                );
            }
        });
    });

    describe("Defaults are still exported (the override fallback)", () => {
        it("ISO_WEIGHTS + NIS2_WEIGHTS are still declared + exported", () => {
            const s = src();
            expect(s).toMatch(/const ISO_WEIGHTS\s*=/);
            expect(s).toMatch(/const NIS2_WEIGHTS\s*=/);
            // The defaults double as fallbacks AND as module exports
            // for unit tests that want to assert the resolved shape.
            expect(s).toMatch(/export\s*\{[\s\S]*?ISO_WEIGHTS[\s\S]*?NIS2_WEIGHTS/);
        });
    });
});
