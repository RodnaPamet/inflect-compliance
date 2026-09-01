/**
 * PR-D polish — Structural ratchet for live entity status sync.
 *
 * Three concerns:
 *
 *   1. **Option types carry `status`.** Controls + Risks + Assets
 *      option types each gain a `status: string | null` field, and
 *      each hook's API-response normaliser extracts it.
 *   2. **Hooks accept a `pollMs` option.** When set, the hook
 *      revalidates the cache on the supplied cadence. Background
 *      revalidation failures preserve the last-good state (don't
 *      blank the canvas's status badges on a transient blip).
 *   3. **Inspector wires the polling + renders a status chip.**
 *      `NodeLinkedEntityPicker` uses `ENTITY_STATUS_POLL_MS = 30000`
 *      and renders `[data-testid="inspector-node-entity-status"]`
 *      next to the picker label when a status is known.
 *
 * Why structural: the three hooks are siblings — a refactor that
 * adds the option to one but not the others would silently break
 * the parity invariant the inspector relies on.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { callExpressionOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("PR-D polish — live entity status sync", () => {
    const hookFiles = [
        "src/lib/processes/use-tenant-controls.ts",
        "src/lib/processes/use-tenant-risks.ts",
        "src/lib/processes/use-tenant-assets.ts",
    ];

    describe("1. Option types carry status", () => {
        it.each(hookFiles)("%s — option type has a `status: string | null` field", (file) => {
            const src = read(file);
            // Each option type declaration must include the status
            // field. The interface name varies per file
            // (TenantControlOption / TenantRiskOption / TenantAssetOption)
            // — match the common shape.
            expect(src).toMatch(
                /export interface Tenant\w+Option\s*\{[\s\S]*?status:\s*string \| null/,
            );
        });

        it.each(hookFiles)("%s — fetch normaliser extracts status from the API row", (file) => {
            const src = read(file);
            // Normaliser must accept `status?: unknown` on the row
            // type AND assign `status: typeof row.status === "string" ? row.status : null`.
            expect(src).toMatch(/status\?:\s*unknown/);
            expect(src).toMatch(
                /status:\s*typeof row\.status === "string" \? row\.status : null/,
            );
        });
    });

    describe("2. Hooks accept pollMs option", () => {
        it.each(hookFiles)("%s — hook signature accepts an `options?: { pollMs?: number }` second arg", (file) => {
            const src = read(file);
            expect(src).toMatch(/pollMs\?:\s*number/);
            // Each hook reads `options?.pollMs ?? 0`.
            expect(src).toMatch(/const pollMs = options\?\.pollMs \?\? 0/);
        });

        it.each(hookFiles)("%s — the poll interval passes the REVALIDATION flag", (file) => {
            const src = read(file);
            // The setInterval callback must call runFetch with the
            // revalidation flag set, so a transient error returns early
            // and leaves the cached options — rather than blanking the
            // canvas's status chips on a single 500.
            //
            // BOUND to the call, not grepped over the file. This assertion
            // used to be three unanchored regexes — `/setInterval\(/`,
            // `/runFetch\(true\)/`, `/runFetch\(false\)/` — and none of
            // them bound a call to its call site. Flipping the interval to
            // `runFetch(false)` AND leaving a stray `runFetch(true)`
            // anywhere else in the file satisfied all three: 20/20 green
            // with every poll taking the initial-fetch branch. Note the
            // second half of that mutation is what makes it the real proof
            // — flipping the interval ALONE also turned the old suite red,
            // but only by tripping a different regex, which attributes the
            // failure to the wrong thing. See #2238.
            const interval = callExpressionOf(src, "setInterval");
            expect(interval).toMatch(/runFetch\(true\)/);
            expect(interval).not.toMatch(/runFetch\(false\)/);

            // The cold load is the other side of the same flag: it passes
            // `false` so the FIRST failure does surface to the consumer.
            // Asserted on the source with the interval REMOVED, so this
            // half cannot be satisfied by the interval's own call.
            const outsideTheInterval = src.replace(interval, "");
            expect(outsideTheInterval).toMatch(/void runFetch\(false\);/);
        });

        it.each(hookFiles)("%s — exports a find* helper for one-id lookup", (file) => {
            const src = read(file);
            expect(src).toMatch(/export function findTenant\w+\(/);
        });
    });

    describe("3. Inspector wires the polling + status chip", () => {
        const inspector = () =>
            read("src/components/processes/ProcessInspector.tsx");

        it("declares the 30s poll cadence at module scope", () => {
            expect(inspector()).toMatch(
                /const ENTITY_STATUS_POLL_MS = 30_000/,
            );
        });

        it("imports the three find* helpers", () => {
            const src = inspector();
            expect(src).toMatch(/findTenantControl/);
            expect(src).toMatch(/findTenantRisk/);
            expect(src).toMatch(/findTenantAsset/);
        });

        it("passes pollMs to all three hooks", () => {
            const src = inspector();
            for (const hook of [
                "useTenantControls",
                "useTenantRisks",
                "useTenantAssets",
            ]) {
                expect(src).toMatch(
                    new RegExp(
                        `${hook}\\(slug,\\s*\\{\\s*pollMs:\\s*ENTITY_STATUS_POLL_MS\\s*\\}\\)`,
                    ),
                );
            }
        });

        it("renders the status chip when a status is known", () => {
            const src = inspector();
            expect(src).toMatch(
                /data-testid="inspector-node-entity-status"/,
            );
            // The chip should hide cleanly when status is null
            // (no chip → null guard above the render).
            expect(src).toMatch(/liveStatus &&/);
        });

        it("entityStatusTone maps the common statuses to semantic tones", () => {
            const src = inspector();
            // Lock the canonical mapping — these three colour-coded
            // branches (success / info / error) form the chip's
            // visual contract. Off-tone or wrong-branch additions
            // are caught here.
            expect(src).toMatch(/function entityStatusTone/);
            expect(src).toMatch(/"DONE"\s*\|\|\s*s === "MITIGATED"\s*\|\|\s*s === "ACTIVE"/);
            expect(src).toMatch(/"IN_PROGRESS"\s*\|\|\s*s === "OPEN"/);
            expect(src).toMatch(
                /"BLOCKED"\s*\|\|\s*s === "REJECTED"\s*\|\|\s*s === "DECOMMISSIONED"/,
            );
        });
    });
});
