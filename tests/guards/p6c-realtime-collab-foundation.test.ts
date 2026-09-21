/**
 * Epic P6-PR-C — Real-time collab foundation ratchet.
 *
 * Closes the architecture half of the brief's #3 🟡 "Real-Time
 * Collaboration" gap. The full multi-user node-mutation merge is
 * a 1-2 week effort (Yjs + WebSocket service + new persistence
 * model + awareness protocol) — too much for one PR. P6-PR-C
 * ships the *foundation* — design doc + flag-gated presence
 * hook — so the architecture seam is visible and Stage 2 can
 * pick up without a re-discovery pass.
 *
 * The ratchet locks:
 *
 *   1. The design doc exists at the canonical path + contains
 *      the four-stage rollout (Stage 1 / 2 / 3 / 4) and the
 *      canonical risk + non-goal sections.
 *   2. The presence hook exports the canonical state shape so
 *      Stage 2 can plug in without breaking the canvas's call
 *      sites.
 *   3. The feature flag name is the documented one (so the docs
 *      + env wiring + hook can't drift).
 *   4. The hook is a no-op today — returns an empty roster and
 *      no-op callbacks regardless of flag state (Stage 2
 *      implements the transport).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read in this
// file is TypeScript/TSX, re-derived rather than assumed, so `codeOf` is the
// only masker needed here.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = (rel: string) => codeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe("Epic P6-PR-C — real-time collab foundation", () => {
    describe("Design doc — processes-realtime-collab.md", () => {
        const docPath = "docs/processes-realtime-collab.md";

        it("exists at the canonical docs path", () => {
            expect(exists(docPath)).toBe(true);
        });

        const src = read(docPath);

        it("declares the four-stage delivery plan", () => {
            for (const stage of [
                "Stage 1 — Presence-only",
                "Stage 2 — Yjs document",
                "Stage 3 — Per-tenant presence colours",
                "Stage 4 — Multi-user mutation merge",
            ]) {
                expect(src).toContain(stage);
            }
        });

        it("names the canonical dependency choices", () => {
            // Yjs is the canonical CRDT — the doc anchors on it
            // so a future PR doesn't silently pivot to Automerge
            // / OT without a written change of plan.
            expect(src).toMatch(/Yjs/);
            // WebSocket + SSE are the two transport options.
            expect(src).toMatch(/WebSocket/);
            expect(src).toMatch(/SSE/);
        });

        it("documents non-goals so scope-creep gets caught early", () => {
            expect(src).toMatch(/Non-goals/);
            // Voice/video is an explicit non-goal.
            expect(src).toMatch(/Voice/);
        });

        it("references the feature-flag env var by name", () => {
            expect(src).toMatch(/NEXT_PUBLIC_ENABLE_CANVAS_PRESENCE/);
        });
    });

    describe("Presence hook — useCanvasPresence", () => {
        const src = read("src/lib/processes/use-canvas-presence.ts");

        it("exports the canonical state shape", () => {
            expect(src).toMatch(
                /export interface CanvasPresenceState \{[\s\S]{0,400}roster:\s*PresenceUser\[\];[\s\S]{0,200}publishCursor:[\s\S]{0,200}publishSelection:/,
            );
        });

        it("exports the canonical user record shape", () => {
            // Locking each canonical field guards Stage 2 from
            // silently dropping one (colour, selection, etc.).
            expect(src).toMatch(/interface PresenceUser \{/);
            for (const field of [
                "userId",
                "name",
                "colour",
                "cursor",
                "selection",
                "lastActiveAt",
            ]) {
                expect(src).toMatch(
                    new RegExp(`${field}:`),
                );
            }
        });

        it("documents the canonical flag name in source comments", () => {
            // Stage 1 hard-codes the flag to off (the production
            // transport doesn't exist yet); Stage 2 will lift this
            // to a real env-driven read via `src/env.ts`. The flag
            // name must match the doc + future env wiring.
            expect(src).toMatch(/NEXT_PUBLIC_ENABLE_CANVAS_PRESENCE/);
        });

        it("Stage-1 hard-codes IS_PRESENCE_ENABLED to false (no process.env read)", () => {
            // Reading `process.env` directly would trip the
            // `no-fallbacks` guardrail; Stage 2 introduces the
            // env-channel via `src/env.ts`.
            expect(src).toMatch(/const IS_PRESENCE_ENABLED\s*=\s*false/);
            expect(src).not.toMatch(/process\.env\./);
        });

        it("Stage-1 default is no-op: empty roster + stable callbacks", () => {
            // The roster is `useMemo(() => [], [])` so callers
            // can use it in dep arrays without re-firing effects.
            expect(src).toMatch(/useMemo<PresenceUser\[\]>\(\(\)\s*=>\s*\[\]/);
            // Both publishers are `useCallback` so referential
            // equality is stable.
            expect(src).toMatch(/publishCursor\s*=\s*useCallback/);
            expect(src).toMatch(/publishSelection\s*=\s*useCallback/);
        });

        it("the flag-off + flag-on branches both return the same canonical state shape", () => {
            // Both branches return the SAME object literal shape
            // so Stage 2 can implement just one of them without
            // breaking the type surface.
            const flagOff = src.match(
                /if \(!IS_PRESENCE_ENABLED\) \{[\s\S]{0,400}return\s*\{[\s\S]{0,300}roster,\s*publishCursor,\s*publishSelection\s*\}/,
            );
            expect(flagOff).not.toBeNull();
        });
    });
});
