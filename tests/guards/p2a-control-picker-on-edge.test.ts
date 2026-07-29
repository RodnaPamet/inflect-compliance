/**
 * Epic P2-PR-A — Control picker on edge ratchet.
 *
 * Closes the brief's #11 🟠 "Domain Entity Linking" gap for the edge
 * surface. Pre-P2 the schema's `ProcessEdgeControl.controlId` FK was
 * never written from the canvas — the client always sent
 * `controls: []` on save. Now:
 *
 *   1. The edge load includes `controls` in the response shape and
 *      projects them onto `edge.data.controls` so the inspector's
 *      picker mounts with the persisted selection.
 *   2. The save serialiser reads the controls back via the canonical
 *      `edgeControlsForSave(e)` helper instead of sending `[]`
 *      unconditionally. (There were THREE copies of that serialiser;
 *      P3.1 collapsed them into one shared module, so this now checks
 *      one site instead of three.)
 *   3. `handleEdgeUpdate` accepts a `controls` patch field so the
 *      inspector's Combobox commit lands on the edge's `data`.
 *   4. `ProcessInspector` mounts a `Combobox` in edge mode, fed by
 *      the new `useTenantControls(tenantSlug)` hook.
 *
 * This ratchet locks each touch point so a future refactor that
 * silently reverts to the pre-P2 "always empty" shape gets caught
 * before reviewers do.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P2-PR-A — control picker on edge", () => {
    describe("useTenantControls hook", () => {
        const src = read("src/lib/processes/use-tenant-controls.ts");

        it("exports the hook + a formatControlLabel helper", () => {
            expect(src).toMatch(/export function useTenantControls/);
            expect(src).toMatch(/export function formatControlLabel/);
        });

        it("returns options shape: { id, ref, title }", () => {
            // Locked because the inspector + future entity-linking
            // surfaces all depend on this triple.
            expect(src).toMatch(
                /interface TenantControlOption \{[\s\S]{0,200}id:\s*string;[\s\S]{0,200}ref:\s*string \| null;[\s\S]{0,200}title:\s*string;/,
            );
        });

        it("hits /api/t/<slug>/controls (the canonical tenant route)", () => {
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}\/controls/);
        });

        it("normalises both list-shape AND { controls } wrapper", () => {
            // The Controls API returns one of two shapes depending on
            // pagination — the hook normalises both. Anchor the
            // dispatch so a refactor that drops one branch breaks.
            expect(src).toMatch(/Array\.isArray\(body\)/);
            expect(src).toMatch(/body as \{ controls\?: unknown\[\] \}\)\?\.controls/);
        });
    });

    describe("ProcessInspector — edge mode mounts the picker", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("imports Combobox + the tenant-controls hook", () => {
            expect(src).toMatch(
                /import\s*\{\s*Combobox,\s*type ComboboxOption\s*\}\s*from\s*["']@\/components\/ui\/combobox["']/,
            );
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantControls[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-controls["']/,
            );
        });

        it("exports the EdgeControlRef type", () => {
            expect(src).toMatch(
                /export interface EdgeControlRef \{[\s\S]{0,300}controlKey:\s*string;[\s\S]{0,200}controlId:\s*string \| null;/,
            );
        });

        it("ProcessInspectorProps declares tenantSlug + accepts a controls patch on onEdgeUpdate", () => {
            // `tenantSlug` is optional — node-mode rendered tests
            // don't need it, and the hook short-circuits on empty
            // string for storybook contexts.
            expect(src).toMatch(/tenantSlug\?:\s*string;/);
            expect(src).toMatch(
                /onEdgeUpdate\?:[\s\S]{0,500}controls\?:\s*EdgeControlRef\[\];/,
            );
        });

        it("EdgeInspectorBody mounts the Combobox with testid + label", () => {
            // The picker is the user-visible surface — anchor on
            // the testid the rendered test will hit AND on the
            // Combobox's aria-label so a refactor that drops the
            // hint breaks loudly.
            expect(src).toMatch(
                /data-testid="inspector-edge-control-picker"/,
            );
            // "Linked control" is localized — assert the catalog value + key ref.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const en = require('../../messages/en.json');
            expect(en.automation.inspector.linkedControl).toBe('Linked control');
            expect(src).toMatch(/aria-label=\{t\("linkedControl"\)\}/);
        });

        it("picker is a MULTI-select — several controls can gate one edge (PR-D)", () => {
            // PR-D lifted the one-control-per-edge cap. The Combobox is
            // multi-select and the commit builds an array of EdgeControlRefs.
            expect(src).toMatch(/multiple\s*\n\s*selected=\{selectedControlOptions\}/);
            expect(src).toMatch(/setSelected=\{commitLinkedControls\}/);
        });

        it("commitLinkedControls emits a `controls` array patch (contract with handleEdgeUpdate)", () => {
            // The shape of the patch is the contract with the canvas's
            // handleEdgeUpdate; locking it here means a future "send the raw
            // control id instead" refactor breaks before it ships. An empty
            // selection (clear-all) yields `controls: []` via the same path.
            expect(src).toMatch(
                /onEdgeUpdate\(edge\.id,\s*\{\s*controls:\s*next\s*\}\)/,
            );
            expect(src).toMatch(/const next:\s*EdgeControlRef\[\]\s*=/);
        });
    });

    describe("Canvas — round-trips controls on load + save", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );
        // P3.1 — the graph→PUT projection moved out of the canvas into
        // src/lib/processes/serialize-graph.ts. It existed in FOUR
        // hand-written copies (save / rename / duplicate / diff-snapshot)
        // which had drifted apart; one function is the fix. The invariant
        // this guard protects is unchanged — it has one home now.
        const serializer = read("src/lib/processes/serialize-graph.ts");
        const helperSrc = read("src/lib/processes/edge-controls.ts");

        it("declares the canonical edgeControlsForSave save helper", () => {
            // Lives in `src/lib/processes/edge-controls.ts` rather
            // than inline in PersistedProcessCanvas.tsx so the
            // R32-PR10 file-size floor (≤1900 lines on the canvas)
            // keeps holding as features land.
            expect(helperSrc).toMatch(
                /export function edgeControlsForSave\(e:\s*Edge\):[\s\S]{0,400}EdgeControlWire/,
            );
        });

        it("canvas imports the helper module", () => {
            expect(src).toMatch(
                /import\s*\{\s*edgeControlsForSave\s*\}\s*from\s*["']@\/lib\/processes\/edge-controls["']/,
            );
        });

        it("the save serialiser routes through the helper, not the pre-P2 empty array", () => {
            // The pre-P2 shape was `controls: []` at three call sites
            // (handleSave + duplicate + autosave-snapshot). P3.1 collapsed
            // those three copies into ONE shared projection, so the assertion
            // moved with it — but `controls: []` must not reappear in either
            // file.
            expect(src).not.toMatch(/controls:\s*\[\],/);
            expect(serializer).not.toMatch(/controls:\s*\[\],/);
            expect(serializer).toMatch(/controls:\s*edgeControlsForSave\(e\),?/);
            // …and the canvas must still USE it rather than growing a fourth copy.
            expect(src).toMatch(/serializeGraphForSave\(nodes, edges\)/);
        });

        it("load response shape includes the controls array", () => {
            expect(src).toMatch(
                /controls\?:\s*Array<\{[\s\S]{0,400}controlKey:\s*string;[\s\S]{0,400}controlId:\s*string \| null/,
            );
        });

        it("rehydratedEdges projects controls onto data.controls (only when non-empty)", () => {
            // Anchor on the conditional spread — empty arrays
            // shouldn't bloat data.
            expect(src).toMatch(
                /Array\.isArray\(e\.controls\)\s*&&\s*e\.controls\.length\s*>\s*0[\s\S]{0,400}controls:\s*e\.controls\.map/,
            );
        });

        it("handleEdgeUpdate accepts the controls patch field and writes data.controls", () => {
            expect(src).toMatch(
                /patch:\s*\{[\s\S]{0,800}controls\?:\s*Array<\{[\s\S]{0,300}controlKey:\s*string;/,
            );
            expect(src).toMatch(
                /if\s*\(patch\.controls\s*!==\s*undefined\)[\s\S]{0,400}controls:\s*patch\.controls/,
            );
        });

        it("inspector mount receives tenantSlug", () => {
            expect(src).toMatch(
                /<ProcessInspector[\s\S]{0,300}tenantSlug=\{tenantSlug\}/,
            );
        });
    });
});
