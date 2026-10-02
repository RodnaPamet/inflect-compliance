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

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// Every path this file READS is a TypeScript-alike: the `.json` it touches
// arrives through `require()`, which is a module import, not a text read — so
// it never reaches this seam and needs no separate reader.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

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
        /*
            ═══ RE-POINTED, AND THE GUARANTEE GOT STRONGER (#3079) ═══

            On xyflow, an edge's controls lived in `edge.data.controls` — an
            untyped bag — and `edgeControlsForSave(e)` projected it into the PUT
            shape. The assertions here existed because that projection had been
            three hand-written copies that drifted, and because the pre-P2 shape
            sent `controls: []` from three call sites.

            Here the controls are a VALIDATED BINDING PROP: `T.arrayOf(...)` on
            `process-edge-binding.ts`, with a cap mirroring `.max(64)` on the
            server's `ProcessEdgeInputSchema`. The store refuses a malformed
            control at write time rather than a helper normalising one at save
            time, so the class of bug the projection helper existed to prevent
            is caught a layer earlier and louder.

            The `controls: []` assertion is KEPT as a negative, because that
            regression is still expressible: a serialiser that stopped reading
            the binding prop would quietly send empty arrays and erase every
            control on the map. That is the one failure here that would lose
            DATA rather than a rendering detail, which is why it keeps its teeth.
        */
        const binding = read("src/components/processes/tldraw/process-edge-binding.ts");
        const serializer = read("src/components/processes/tldraw/serializer.ts");
        const adapter = read("src/lib/processes/use-tldraw-selection.ts");
        const workspace = read("src/components/processes/TldrawProcessWorkspace.tsx");

        it("controls are a VALIDATED prop on the binding, not an untyped bag", () => {
            // Replaces "declares the canonical edgeControlsForSave save helper".
            // The binding declares the shape and tldraw validates every write.
            expect(binding).toMatch(/controls:\s*ProcessEdgeControlProp\[\]/);
            expect(binding).toMatch(/controls:\s*T\.arrayOf\(/);
        });

        it("and the per-edge cap mirrors the server's own limit", () => {
            // The detail worth keeping from the helper era: a client that
            // allowed 65 controls would be refused by the server on save, which
            // reads as a mysterious failed save rather than a full edge.
            expect(binding).toMatch(/\.max\(64\)|MAX_[A-Z_]*CONTROLS[A-Z_]*\s*=\s*64/);
        });

        it("the serialiser maps controls BOTH ways, and never sends an empty array", () => {
            // The surviving teeth, and the only assertion here whose regression
            // would destroy data: `controls: []` reaching the PUT erases every
            // control on every edge of the map.
            expect(serializer).not.toMatch(/controls:\s*\[\],/);
            expect(serializer).toMatch(/controls:\s*\(e\.controls \?\? \[\]\)\.map\(/);
            expect(serializer).toMatch(/controls:\s*b\.props\.controls \?\? \[\]/);
        });

        it("the inspector write path accepts the controls patch and writes the binding", () => {
            expect(adapter).toMatch(/controls\?:\s*unknown\[\]/);
            expect(adapter).toMatch(
                /if\s*\(patch\.controls\s*!==\s*undefined\)\s*props\.controls\s*=\s*patch\.controls/,
            );
            // Written to the BINDING, not the line: the binding owns identity
            // and is what the serialiser reads.
            expect(adapter).toMatch(/editor\.updateBinding\(/);
        });

        it("inspector mount receives tenantSlug", () => {
            // Unchanged — the picker fetches the tenant's controls, so without
            // the slug it renders an empty list and looks like the tenant has
            // no controls.
            expect(workspace).toMatch(
                /<ProcessInspector[\s\S]{0,300}tenantSlug=\{tenantSlug\}/,
            );
        });
    });
});
