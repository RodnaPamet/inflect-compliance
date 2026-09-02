/**
 * Epic P5-PR-B — Structural ratchet for visual diff + restore.
 *
 * Locks the wiring contract so a refactor can't silently strand
 * any of the five surfaces this feature stands on:
 *
 *   1. The pure helper `computeCanvasDiff` exists at
 *      `src/lib/processes/canvas-diff.ts` and exports the
 *      classification union (`added` / `removed` / `moved` /
 *      `modified` / `unchanged`).
 *   2. The repository method `getSnapshotByVersion` exists on
 *      `ProcessMapRepository`.
 *   3. The usecase `restoreProcessMapSnapshot` exists, calls
 *      `assertCanWrite`, and forwards `expectedVersion` to
 *      `replaceGraph` (preserving the P1 optimistic-concurrency
 *      gate).
 *   4. Two new API routes exist and follow the canonical
 *      `withApiErrorHandling` wrapper:
 *      - GET  /api/t/<slug>/processes/<id>/snapshots/<version>
 *      - POST /api/t/<slug>/processes/<id>/snapshots/<version>/restore
 *   5. The canvas wires Diff + Restore on `<CanvasHistorySidebar>`
 *      and mounts `<CanvasDiffOverlay>` when a target version is
 *      selected.
 *
 * Why structural: the diff/restore loop is a coordinated change
 * across helper + repo + usecase + 2 routes + sidebar + overlay
 * + canvas mount. Any single surface drifting silently breaks the
 * loop, but each individual piece compiles fine on its own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("Epic P5-PR-B — visual diff + restore wiring", () => {
    describe("pure helper", () => {
        it("computeCanvasDiff is exported from src/lib/processes/canvas-diff.ts", () => {
            const src = read("src/lib/processes/canvas-diff.ts");
            expect(src).toMatch(/export function computeCanvasDiff/);
        });
        it("the five-class classification union is exported", () => {
            const src = read("src/lib/processes/canvas-diff.ts");
            expect(src).toMatch(/export type DiffClass\s*=/);
            for (const klass of [
                '"added"',
                '"removed"',
                '"moved"',
                '"modified"',
                '"unchanged"',
            ]) {
                expect(src.includes(klass)).toBe(true);
            }
        });
    });

    describe("repository + usecase", () => {
        it("ProcessMapRepository exposes getSnapshotByVersion", () => {
            const src = read(
                "src/app-layer/repositories/ProcessMapRepository.ts",
            );
            expect(src).toMatch(/static async getSnapshotByVersion/);
        });
        it("restoreProcessMapSnapshot exists and forwards expectedVersion", () => {
            const src = read("src/app-layer/usecases/process-map.ts");
            expect(src).toMatch(/export async function restoreProcessMapSnapshot/);
            // Forwards through replaceGraph (so STALE_DATA still gates).
            expect(src).toMatch(/replaceGraph\(/);
            // Guards write authority.
            expect(src).toMatch(/assertCanWrite\(ctx\)/);
        });
        it("getProcessMapSnapshot exists and asserts read authority", () => {
            const src = read("src/app-layer/usecases/process-map.ts");
            expect(src).toMatch(/export async function getProcessMapSnapshot/);
            expect(src).toMatch(/assertCanRead\(ctx\)/);
        });
    });

    describe("API routes", () => {
        it("GET snapshot-by-version route exists + wraps with withApiErrorHandling", () => {
            const src = read(
                "src/app/api/t/[tenantSlug]/processes/[id]/snapshots/[version]/route.ts",
            );
            expect(src).toMatch(/export const GET = withApiErrorHandling/);
            expect(src).toMatch(/getProcessMapSnapshot/);
        });
        it("POST restore route exists + validates body + wraps with withApiErrorHandling", () => {
            const src = read(
                "src/app/api/t/[tenantSlug]/processes/[id]/snapshots/[version]/restore/route.ts",
            );
            expect(src).toMatch(/export const POST = withApiErrorHandling/);
            // `parseJsonBody`, not `withValidatedBody`: the route gained a
            // `requirePermission('processes.edit', …)` gate (#2197), and that
            // wrapper already uses the third argument slot `withValidatedBody`
            // passes the body in. The invariant here is "the body is parsed
            // against the schema", not which helper does it.
            expect(src).toMatch(/parseJsonBody/);
            expect(src).toMatch(/expectedVersion/);
            expect(src).toMatch(/restoreProcessMapSnapshot/);
        });
    });

    describe("sidebar + overlay wiring", () => {
        it("CanvasHistorySidebar exposes onDiffRequest + onRestored + Diff/Restore buttons", () => {
            const src = read(
                "src/components/processes/CanvasHistorySidebar.tsx",
            );
            expect(src).toMatch(/onDiffRequest\?: \(version: number\) => void/);
            expect(src).toMatch(/onRestored\?:\s*\(\) => void/);
            expect(src).toMatch(/data-testid="canvas-history-diff"/);
            expect(src).toMatch(/data-testid="canvas-history-restore"/);
            // Restore goes through the new route.
            expect(src).toMatch(/\/snapshots\/\$\{targetVersion\}\/restore/);
        });
        it("CanvasDiffOverlay primitive exists + colour-keys diff classes", () => {
            const src = read("src/components/processes/CanvasDiffOverlay.tsx");
            expect(src).toMatch(/export function CanvasDiffOverlay/);
            // Uses the pure helper.
            expect(src).toMatch(/computeCanvasDiff/);
            // Renders the four diff tones (no "unchanged" chip in summary).
            for (const tone of ["added", "removed", "moved", "modified"]) {
                expect(src.includes(`case "${tone}":`)).toBe(true);
            }
        });
        it("PersistedProcessCanvas wires sidebar callbacks + mounts overlay", () => {
            const src = read(
                "src/components/processes/PersistedProcessCanvas.tsx",
            );
            // Sidebar callback wires.
            expect(src).toMatch(/onDiffRequest=\{setDiffAgainstVersion\}/);
            expect(src).toMatch(/onRestored=\{[^}]*setReloadCounter/);
            // Overlay mount.
            expect(src).toMatch(/<CanvasDiffOverlay/);
            // Snapshot projection helper exists.
            expect(src).toMatch(/function buildLiveSnapshot/);
        });
    });
});
